// Sidebar Trợ lý AI: chat với claude (tài khoản đang đăng nhập), trợ lý thao tác trên trang qua pageAgent.
// Hook useAssistant đặt ở Shell để lệnh từ trợ lý vẫn chạy khi sidebar đang đóng.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSSE } from '../hooks/useSSE.js';
import { runTool } from '../lib/pageAgent.js';
import { SkLines, SkZone } from './Skeleton.jsx';

const OPEN_KEY = 'vs-ai-open';
const TAB_ID = Math.random().toString(36).slice(2, 12); // mỗi tab một mã: chỉ tab gửi câu mới làm thao tác

function readOpen() {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
function storeOpen(v) {
  try {
    window.localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {
    /* storage bị chặn — chỉ không nhớ */
  }
}

// Trạng thái trợ lý + thực thi lệnh tool gửi tới tab này; trả dữ liệu và hành động cho panel.
export function useAssistant() {
  const [open, setOpenState] = useState(readOpen);
  const [data, setData] = useState(null); // {available, busy, messages}
  const [error, setError] = useState(null);
  const [ask, setAsk] = useState(null); // {desc, resolve} — thẻ xin phép đang chờ
  const queue = useRef(Promise.resolve());

  const setOpen = useCallback((v) => {
    setOpenState((cur) => {
      const next = typeof v === 'function' ? v(cur) : v;
      storeOpen(next);
      return next;
    });
  }, []);

  // Trạng thái {busy, messages, rev} từ SSE hoặc send/stop/reset → giữ available; rev cũ hơn (về muộn) thì bỏ.
  const apply = useCallback((st) => setData((cur) => (cur?.rev != null && st.rev != null && st.rev < cur.rev ? cur : { ...cur, available: true, ...st })), []);

  const load = useCallback(async () => {
    try {
      setData(await api.assistant());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Chạy lần lượt từng lệnh (không chồng thao tác); cần xin phép thì báo server giữ lệnh rồi hiện thẻ.
  const exec = useCallback(
    (cmd) => {
      queue.current = queue.current.then(async () => {
        const confirm = (desc) => {
          api.assistantResult(cmd.id, { hold: true }).catch(() => {});
          setOpen(true);
          return new Promise((resolve) => setAsk({ desc, resolve }));
        };
        let out;
        try {
          out = await runTool(cmd, { confirm });
        } catch (e) {
          out = { text: `Lỗi khi thao tác: ${e?.message || e}`, isError: true, label: null };
        } finally {
          setAsk(null);
        }
        await api.assistantResult(cmd.id, out).catch(() => {});
      });
    },
    [setOpen],
  );

  useSSE((msg) => {
    if (msg.type === 'reconnect') {
      load();
      return;
    }
    if (msg.type !== 'assistant') return;
    const d = msg.data;
    if (d.kind === 'state') apply(d.state);
    else if (d.kind === 'tool' && d.tabId === TAB_ID) exec(d);
  });

  // Lượt kết thúc (Dừng / lỗi) trong lúc đang hỏi → bỏ thẻ, coi như không cho phép.
  const busy = !!data?.busy;
  useEffect(() => {
    if (!busy && ask) ask.resolve(false);
  }, [busy, ask]);

  const send = (text) => api.assistantSend(text, TAB_ID).then(apply);
  const stop = () => api.assistantStop().then(apply);
  const reset = () => {
    ask?.resolve(false);
    return api.assistantReset().then(apply);
  };
  const answer = (ok) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return { open, setOpen, data, error, ask, answer, send, stop, reset, reload: load };
}

// Một dòng trong cuộc chat.
function Msg({ m }) {
  if (m.role === 'user') return <div className="ai-msg ai-user">{m.text}</div>;
  if (m.role === 'action') return <div className={`ai-msg ai-act${m.failed ? ' bad' : ''}`}>{m.text}</div>;
  if (m.role === 'note') return <div className="ai-msg ai-note">{m.text}</div>;
  if (m.role === 'error') return <div className="ai-msg ai-err">{m.text}</div>;
  return <div className="ai-msg ai-bot">{m.text}</div>;
}

const EXAMPLES = ['Tạo dự án mới, video dài 60 giây', 'Mở trang Quy trình', 'Dự án nào đang chờ tôi?'];

// Sidebar bên phải; loggedIn=false → hướng dẫn đăng nhập Claude (onAccount mở bảng Tài khoản).
export default function AssistantPanel({ a, loggedIn, onAccount }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const list = useRef(null);
  const input = useRef(null);
  const { data, error, ask } = a;
  const busy = !!data?.busy;
  const msgs = data?.messages || [];

  // Tin mới / thẻ hỏi → cuộn xuống cuối.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, ask, busy]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy || sending) return;
    setSending(true);
    setErr(null);
    try {
      await a.send(t);
      setText('');
    } catch (x) {
      setErr(x.message);
    } finally {
      setSending(false);
    }
  };
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr(x.message);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      a.setOpen(false);
    }
  };

  let body;
  if (!data && !error) {
    body = (
      <SkZone className="ai-list">
        <SkLines n={3} />
      </SkZone>
    );
  } else if (error && !data) {
    body = (
      <div className="ai-list">
        <div className="ai-msg ai-err">{error.message}</div>
        <button type="button" className="btn sm" onClick={a.reload}>
          Thử lại
        </button>
      </div>
    );
  } else if (data && !data.available) {
    body = (
      <div className="ai-list">
        <p className="note">Trợ lý AI chưa bật trên server này.</p>
      </div>
    );
  } else {
    body = (
      <div className="ai-list" ref={list} role="log" aria-live="polite" aria-label="Cuộc trò chuyện">
        {!msgs.length ? (
          <div className="ai-empty">
            <p className="note">Nhờ trợ lý thao tác trên trang này. Dùng gói Claude bạn đang đăng nhập.</p>
            <div className="ai-ex">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="chip" onClick={() => setText(x)}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m) => <Msg key={m.id} m={m} />)
        )}
        {busy && !ask ? (
          <div className="ai-msg ai-note ai-wait">
            <span className="spinner" aria-hidden="true" /> Đang làm…
          </div>
        ) : null}
        {ask ? (
          <div className="ai-ask" role="alertdialog" aria-label="Trợ lý xin phép">
            <div>
              Cho phép trợ lý: <b>{ask.desc}</b>?
            </div>
            <div className="ai-ask-acts">
              <button type="button" className="btn sm" onClick={() => a.answer(false)}>
                Không
              </button>
              <button type="button" className="btn sm primary" onClick={() => a.answer(true)} autoFocus>
                Cho phép
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const ready = data?.available;
  return (
    <aside className="ai-panel" aria-label="Trợ lý AI" onKeyDown={onKey}>
      <div className="ai-head">
        <b>Trợ lý AI</b>
        <div className="ai-head-acts">
          {ready && msgs.length ? (
            <button type="button" className="btn sm" onClick={() => act(a.reset)} title="Xóa cuộc trò chuyện, bắt đầu lại">
              Cuộc mới
            </button>
          ) : null}
          <button type="button" className="btn sm ai-x" onClick={() => a.setOpen(false)} aria-label="Đóng Trợ lý AI" title="Đóng (Esc)">
            ×
          </button>
        </div>
      </div>
      {loggedIn === false ? (
        <div className="ai-list">
          <p className="note">Cần đăng nhập Claude Code để dùng trợ lý.</p>
          <button type="button" className="btn sm primary" onClick={onAccount}>
            Đăng nhập Claude
          </button>
        </div>
      ) : (
        body
      )}
      {err ? <div className="ai-msg ai-err ai-fe">{err}</div> : null}
      <form className="ai-form" onSubmit={submit}>
        <textarea
          ref={input}
          rows={2}
          value={text}
          maxLength={4000}
          placeholder="Bạn muốn trợ lý làm gì?"
          aria-label="Tin nhắn cho trợ lý"
          disabled={!ready || loggedIn === false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
        />
        {busy ? (
          <button type="button" className="btn danger" onClick={() => act(a.stop)}>
            Dừng
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!ready || !text.trim() || sending || loggedIn === false}>
            {sending ? <span className="spinner" aria-hidden="true" /> : null}
            Gửi
          </button>
        )}
      </form>
    </aside>
  );
}
