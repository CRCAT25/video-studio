// Sidebar Trợ lý AI: chat với claude (tài khoản đang đăng nhập), trợ lý thao tác trên trang qua pageAgent.
// Hook useAssistant đặt ở Shell để lệnh từ trợ lý vẫn chạy khi sidebar đang đóng.
import { DRAG_TYPE, MAX_IMAGES, fromUrl, isTextFile, textAttachment, textFromUrl, toAttachment } from '../lib/chatImages.js';
import { useFocus } from '../lib/focus.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSSE } from '../hooks/useSSE.js';
import { runTool } from '../lib/pageAgent.js';
import Progress from './Progress.jsx';
import Select from './Select.jsx';
import { SkLines, SkZone } from './Skeleton.jsx';
import { T, getLang, intlLocale, tr, useT } from '../lib/i18n.jsx';

const OPEN_KEY = 'vs-ai-open';
const TAB_ID = Math.random().toString(36).slice(2, 12); // mỗi tab một mã: chỉ tab gửi câu mới làm thao tác

function readOpen() {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
const W_KEY = 'vs-ai-w';
const W_MIN = 350;
const W_DEF = 380;
const clampW = (w) => Math.max(W_MIN, Math.min(Math.round(w) || W_DEF, Math.max(W_MIN, Math.floor(window.innerWidth * 0.7))));
function readW() {
  try {
    return clampW(Number(window.localStorage.getItem(W_KEY)) || W_DEF);
  } catch {
    return W_DEF;
  }
}
function storeW(w) {
  try {
    window.localStorage.setItem(W_KEY, String(w));
  } catch {
    /* storage bị chặn — chỉ không nhớ */
  }
}
function applyW(w) {
  document.documentElement.style.setProperty('--ai-w', `${w}px`);
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
          out = { text: tr('Lỗi khi thao tác: {m}', { m: e?.message || e }), isError: true, label: null };
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

  const send = (text, extra) => api.assistantSend(text, TAB_ID, getLang(), extra).then(apply);
  const stop = () => api.assistantStop().then(apply);
  const reset = () => {
    ask?.resolve(false);
    return api.assistantReset().then(apply);
  };
  const openChat = (id) => {
    ask?.resolve(false);
    return api.assistantOpen(id).then(apply);
  };
  const removeChat = (id) => api.assistantRemove(id).then(apply);
  const settings = (body) => api.assistantSettings(body).then(apply);
  const compact = () => api.assistantCompact().then(apply);
  const answer = (ok) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return { open, setOpen, data, error, ask, answer, send, stop, reset, openChat, removeChat, settings, compact, reload: load };
}

// Một dòng trong cuộc chat.
function Msg({ m }) {
  if (m.role === 'user') return (
      <div className="ai-msg ai-user">
        {m.images?.length ? <div className="ai-imgnames">{m.images.map((n, i) => <span key={i}>📎 {n}</span>)}</div> : null}
        {m.text}
      </div>
    );
  if (m.role === 'action') return <div className={`ai-msg ai-act${m.failed ? ' bad' : ''}`}>{m.text}</div>;
  if (m.role === 'note') return <div className="ai-msg ai-note">{tr(m.text)}</div>;
  if (m.role === 'error') return <div className="ai-msg ai-err">{tr(m.text)}</div>;
  return <div className="ai-msg ai-bot">{m.text}</div>;
}

const MODEL_OPTS = [
  { value: '', label: T('Model mặc định') },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const EFFORT_OPTS = [
  { value: '', label: T('Effort mặc định') },
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v })),
];

const EXAMPLES = [T('Tạo dự án mới, video dài 60 giây'), T('Mở trang Quy trình'), T('Dự án nào đang chờ tôi?')];

// Sidebar bên phải; loggedIn=false → hướng dẫn đăng nhập Claude (onAccount mở bảng Tài khoản).
export default function AssistantPanel({ a, loggedIn, onAccount }) {
  const t = useT();
  const focus = useFocus();
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    applyW(readW());
    const onWin = () => applyW(readW());
    window.addEventListener('resize', onWin);
    return () => window.removeEventListener('resize', onWin);
  }, []);
  // Kéo mép trái: sang trái = rộng hơn, sang phải = hẹp lại (tối thiểu 350px); thả chuột thì nhớ độ rộng.
  const startResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = clampW(parseFloat(document.documentElement.style.getPropertyValue('--ai-w')) || W_DEF);
    let w = startW;
    setDragging(true);
    document.body.classList.add('ai-resizing');
    const move = (ev) => {
      w = clampW(startW + (startX - ev.clientX));
      applyW(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('ai-resizing');
      setDragging(false);
      storeW(w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const [text, setText] = useState('');
  const [imgs, setImgs] = useState([]); // ảnh đính kèm chờ gửi
  const [over, setOver] = useState(false);
  const fileIn = useRef(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const list = useRef(null);
  const input = useRef(null);
  const [hist, setHist] = useState(null); // null = đóng; mảng = danh sách cuộc chat
  const [menu, setMenu] = useState(false);
  const { data, error, ask } = a;
  const busy = !!data?.busy;
  const msgs = data?.messages || [];
  const compacting = busy && msgs[msgs.length - 1]?.role === 'note' && msgs[msgs.length - 1]?.text === 'Đang nén cuộc trò chuyện…';

  // Tin mới / thẻ hỏi → cuộn xuống cuối.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, ask, busy]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Thêm ảnh (từ máy, dán, thả hoặc kéo từ Đầu ra); quá số lượng thì báo.
  const addImages = async (jobs) => {
    setErr(null);
    const room = MAX_IMAGES - imgs.length;
    if (jobs.length > room) setErr(t('Tối đa {n} ảnh mỗi tin.', { n: MAX_IMAGES }));
    const got = [];
    for (const job of jobs.slice(0, Math.max(0, room))) {
      try {
        got.push(await job());
      } catch {
        setErr(t('Không đọc được ảnh này.'));
      }
    }
    if (got.length) setImgs((v) => [...v, ...got].slice(0, MAX_IMAGES));
  };
  const addFiles = (files) => {
    const list = [...files];
    const jobs = list.flatMap((f) => (/^image\//.test(f.type) ? [() => toAttachment(f, f.name)] : isTextFile(f) ? [() => textAttachment(f, f.name)] : []));
    if (list.length && !jobs.length) setErr(t('Chỉ đính kèm được ảnh, tệp chữ hoặc video kéo từ Đầu ra.'));
    return addImages(jobs);
  };
  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      try {
        const it = JSON.parse(raw);
        if (it.kind === 'video') addImages([async () => ({ kind: 'video', name: it.name, projectId: it.projectId, path: it.path })]);
        else if (it.kind === 'text') addImages([() => textFromUrl(it.src, it.name)]);
        else addImages([() => fromUrl(it.src, it.name)]);
        return;
      } catch {
        /* rơi xuống nhánh file */
      }
    }
    addFiles(e.dataTransfer.files);
  };

  const submit = async (e) => {
    e?.preventDefault();
    const typed = text.trim();
    if ((!typed && !imgs.length) || busy || sending) return;
    const q0 = typed || t('Xem tệp đính kèm.');
    const q = focus ? `[${t('Ảnh đang chọn')}: ${focus.name} — ${t('dự án')} ${focus.projectId}, ${t('đường dẫn')} ${focus.path}]\n${q0}` : q0;
    setSending(true);
    setErr(null);
    try {
      await a.send(q, {
        images: imgs.filter((i) => i.kind === 'image').map(({ name, mime, data }) => ({ name, mime, data })),
        files: imgs.filter((i) => i.kind === 'text').map(({ name, text }) => ({ name, text })),
        videos: imgs.filter((i) => i.kind === 'video').map(({ projectId, path }) => ({ projectId, path })),
      });
      setText('');
      setImgs([]);
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

  const showHist = () =>
    act(async () => {
      setMenu(false);
      if (hist) return setHist(null);
      setHist((await api.assistantChats()).chats);
    });
  const pickChat = (id) =>
    act(async () => {
      await a.openChat(id);
      setHist(null);
    });
  const delChat = (id) =>
    act(async () => {
      await a.removeChat(id);
      setHist((await api.assistantChats()).chats);
    });

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (hist || menu) {
        setHist(null);
        setMenu(false);
      } else a.setOpen(false);
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
          {t('Thử lại')}
        </button>
      </div>
    );
  } else if (data && !data.available) {
    body = (
      <div className="ai-list">
        <p className="note">{t('Trợ lý AI chưa bật trên server này.')}</p>
      </div>
    );
  } else {
    body = (
      <div className="ai-list" ref={list} role="log" aria-live="polite" aria-label={t('Cuộc trò chuyện')}>
        {!msgs.length ? (
          <div className="ai-empty">
            <svg className="ai-spark" viewBox="-20 -20 40 40" aria-hidden="true">
              {Array.from({ length: 12 }, (_, i) => (
                <line key={i} x1="0" y1="-5" x2="0" y2={-(11 + ((i * 7) % 5) * 1.6)} transform={`rotate(${i * 30})`} />
              ))}
            </svg>
            <p className="note">{t('Nhờ trợ lý thao tác trên trang này. Dùng gói Claude bạn đang đăng nhập.')}</p>
            <div className="ai-ex">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="chip" onClick={() => setText(t(x))}>
                  {t(x)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m) => <Msg key={m.id} m={m} />)
        )}
        {busy && !ask ? (
          compacting ? (
            <div className="ai-msg ai-note"><Progress label={t('Đang nén cuộc trò chuyện…')} /></div>
          ) : (
            <div className="ai-msg ai-note ai-wait">
              <span className="spinner" aria-hidden="true" /> {t('Đang làm…')}
            </div>
          )
        ) : null}
        {ask ? (
          <div className="ai-ask" role="alertdialog" aria-label={t('Trợ lý xin phép')}>
            <div>
              {t('Cho phép trợ lý:')} <b>{ask.desc}</b>?
            </div>
            <div className="ai-ask-acts">
              <button type="button" className="btn sm" onClick={() => a.answer(false)}>
                {t('Không')}
              </button>
              <button type="button" className="btn sm primary" onClick={() => a.answer(true)} autoFocus>
                {t('Cho phép')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const ready = data?.available;
  return (
    <aside className={`ai-panel${a.open ? '' : ' closing'}`} aria-label={t('Trợ lý AI')} onKeyDown={onKey}>
      <div
        className={`ai-resize${dragging ? ' drag' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('Kéo để đổi độ rộng')}
        onPointerDown={startResize}
        onDoubleClick={() => {
          applyW(W_DEF);
          storeW(W_DEF);
        }}
      />
      <div className="ai-head">
        <div className="ai-head-acts">
          {ready ? (
            <>
              <button type="button" className={`ai-ic${hist ? ' on' : ''}`} onClick={showHist} aria-label={t('Lịch sử trò chuyện')} title={t('Lịch sử trò chuyện')}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4.5l3 1.8" />
                </svg>
              </button>
              <button type="button" className="ai-ic" onClick={() => act(a.reset).then(() => setHist(null))} aria-label={t('Cuộc mới')} title={t('Cuộc mới')} disabled={!msgs.length}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4.5H7.5A3 3 0 0 0 4.5 7.5v6a3 3 0 0 0 3 3H9v3l4-3h3.5a3 3 0 0 0 3-3V12M18 3v5M15.5 5.5h5" />
                </svg>
              </button>
              <div className="ai-menu-wrap">
                <button type="button" className="ai-ic" onClick={() => setMenu((v) => !v)} aria-label={t('Thêm')} aria-expanded={menu} title={t('Thêm')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="3" />
                  </svg>
                </button>
                {menu ? (
                  <div className="ai-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!data?.canCompact}
                      title={t('Nén ngữ cảnh để cuộc trò chuyện dài hơn')}
                      onClick={() => {
                        setMenu(false);
                        act(a.compact);
                      }}
                    >
                      {t('Nén cuộc trò chuyện (compact)')}
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
          <button type="button" className="ai-ic" onClick={() => a.setOpen(false)} aria-label={t('Đóng Trợ lý AI')} title={t('Đóng (Esc)')}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>
      {hist ? (
        <div className="ai-hist" role="list" aria-label={t('Lịch sử trò chuyện')}>
          {hist.map((c) => (
            <div key={c.id} className={`ai-hist-row${c.current ? ' cur' : ''}`} role="listitem">
              <button type="button" className="ai-hist-open" onClick={() => pickChat(c.id)} disabled={busy}>
                <span className="ai-hist-t">{c.title || t('Cuộc mới')}</span>
                <span className="ai-hist-d">{new Date(c.updatedAt).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })}</span>
              </button>
              <button type="button" className="ai-ic" onClick={() => delChat(c.id)} disabled={busy} aria-label={t('Xóa')} title={t('Xóa')}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {loggedIn === false ? (
        <div className="ai-list">
          <p className="note">{t('Cần đăng nhập Claude Code để dùng trợ lý.')}</p>
          <button type="button" className="btn sm primary" onClick={onAccount}>
            {t('Đăng nhập Claude')}
          </button>
        </div>
      ) : (
        body
      )}
      {err ? <div className="ai-msg ai-err ai-fe">{err}</div> : null}
      <form
        className={`ai-form${over ? ' over' : ''}`}
        onSubmit={submit}
        onDragOver={(e) => {
          if (loggedIn === false) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
        }}
        onDrop={onDrop}
      >
        <div className="ai-box">
          {focus ? (
            <div className="ai-focus" title={focus.path}>
              <img src={focus.src} alt="" />
              <span>{t('Đang chọn')}: <b>{focus.name}</b></span>
            </div>
          ) : null}
          {imgs.length ? (
            <div className="ai-atts">
              {imgs.map((im, i) => (
                <span key={i} className="ai-att" title={im.name}>
                  {im.url ? <img src={im.url} alt={im.name} /> : <span className="ai-kind">{im.kind === 'video' ? '🎬' : '📄'}<i>{im.name}</i></span>}
                  <button type="button" aria-label={t('Bỏ ảnh')} onClick={() => setImgs((v) => v.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={input}
            rows={2}
            value={text}
            maxLength={4000}
            placeholder={t('Bạn muốn trợ lý làm gì?')}
            aria-label={t('Tin nhắn cho trợ lý')}
            disabled={!ready || loggedIn === false}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const fs = [...e.clipboardData.files].filter((f) => /^image\//.test(f.type));
              if (fs.length) {
                e.preventDefault();
                addFiles(fs);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
            }}
          />
          <div className="ai-box-row">
            <div className="ai-opts">
            <input ref={fileIn} type="file" accept="image/*,text/*,.md,.json,.srt,.vtt,.csv,.log,.yaml,.yml" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" className="ai-clip" aria-label={t('Đính kèm ảnh hoặc tệp chữ')} title={t('Đính kèm ảnh hoặc tệp chữ')} disabled={!ready || busy || loggedIn === false || imgs.length >= MAX_IMAGES} onClick={() => fileIn.current?.click()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 11.5l-7.8 7.8a5 5 0 01-7-7L13 4.5a3.3 3.3 0 014.7 4.7L9.9 17a1.7 1.7 0 01-2.4-2.4l7.4-7.4" />
              </svg>
            </button>
              <Select size="sm" value={data?.model || ''} options={MODEL_OPTS.map((o) => ({ ...o, label: t(o.label) }))} label={t('Model')} disabled={!ready || busy} onChange={(v) => act(() => a.settings({ model: v || null }))} />
              <Select size="sm" value={data?.effort || ''} options={EFFORT_OPTS.map((o) => ({ ...o, label: t(o.label) }))} label={t('Effort')} disabled={!ready || busy} onChange={(v) => act(() => a.settings({ effort: v || null }))} />
            </div>
            {busy ? (
              <button type="button" className="ai-send stop" onClick={() => act(a.stop)} aria-label={t('Dừng')} title={t('Dừng')}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </svg>
              </button>
            ) : (
              <button type="submit" className="ai-send" disabled={!ready || (!text.trim() && !imgs.length) || sending || loggedIn === false} aria-label={t('Gửi')} title={t('Gửi')}>
                {sending ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 19V6M6.5 11.5L12 6l5.5 5.5" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
      </form>
    </aside>
  );
}
