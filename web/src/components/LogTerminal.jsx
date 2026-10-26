// Nhật ký Claude kiểu màn CRT: nạp lịch sử qua /events?after=, nhận dòng mới qua SSE 'log', bù khi nối lại.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSSE } from '../hooks/useSSE.js';
import { RUN_LABEL, fmtNum, fmtTime } from '../lib/format.js';
import { Sk, SkZone } from './Skeleton.jsx';

const CAP = 3000; // giữ tối đa ~3000 dòng trên màn hình
const PAGE = 1000;
const MAX_PAGES = 60;

const KIND_TAG = {
  init: 'Khởi động',
  thinking: 'Suy nghĩ',
  text: 'Claude',
  tool: 'Công cụ',
  tool_result: 'Kết quả',
  denied: 'Bị chặn',
  structured: 'Kết quả bước',
  rate_limit: 'Giới hạn',
  result: 'Hoàn tất',
  raw: 'raw',
  stderr: 'stderr',
  status: 'Trạng thái',
  check: 'Kiểm tra',
  error: 'Lỗi',
};

function pretty(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function firstLine(s, n = 160) {
  const t = String(s || '');
  const nl = t.indexOf('\n');
  const one = nl >= 0 ? t.slice(0, nl) : t;
  return one.length > n ? `${one.slice(0, n)}…` : one + (nl >= 0 ? ' …' : '');
}

// Một dòng nhật ký; tool_result/tool/structured thu gọn được (chỉ hiện chữ thuần, không render HTML).
function EventLine({ ev }) {
  const kind = ev.kind || 'raw';
  const p = ev.payload || {};
  let cls = `ev k-${kind}`;
  if ((kind === 'tool_result' || kind === 'result') && p.is_error) cls += ' bad';
  if (kind === 'check') {
    if (p.passed === false) cls += ' bad';
    else if (p.passed == null) cls += ' skip';
  }
  let tag = KIND_TAG[kind] || String(kind);
  if (kind === 'tool' && p.name) tag = String(p.name);
  const text = ev.text ?? '';
  let body;
  if (kind === 'tool_result') {
    const long = text.length > 160 || text.includes('\n');
    body = long ? (
      <details>
        <summary>{firstLine(text)}</summary>
        <pre>{text}</pre>
      </details>
    ) : (
      text || <span className="dim">(trống)</span>
    );
  } else if (kind === 'tool' && p.input && typeof p.input === 'object' && Object.keys(p.input).length) {
    body = (
      <details>
        <summary>{text}</summary>
        <pre>{pretty(p.input)}</pre>
      </details>
    );
  } else if (kind === 'structured' && p.input) {
    body = (
      <details>
        <summary>{text}</summary>
        <pre>{pretty(p.input)}</pre>
      </details>
    );
  } else {
    body = text;
  }
  return (
    <div className={cls}>
      <span className="ts">{fmtTime(ev.ts)}</span>
      <span className="kd" title={kind}>
        {tag}
      </span>
      <span className="tx">{body}</span>
    </div>
  );
}

// Terminal nhật ký cho một lượt; run = RunSummary (state 'running' → nhận live).
export default function LogTerminal({ run, offline = false }) {
  const runId = run?.id;
  const live = run?.state === 'running';
  const logRef = useRef(null);
  const atBottom = useRef(true);
  const store = useRef({ list: [], seen: new Set(), hidden: 0, maxSeq: 0, pending: [] });
  const raf = useRef(0);
  const [, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showJump, setShowJump] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const merge = useCallback((events) => {
    const s = store.current;
    let added = 0;
    let unordered = false;
    for (const ev of events) {
      const seq = Number(ev?.seq);
      if (!Number.isFinite(seq) || s.seen.has(seq)) continue;
      s.seen.add(seq);
      if (seq < s.maxSeq) unordered = true;
      else s.maxSeq = seq;
      s.list.push(ev);
      added += 1;
    }
    if (!added) return 0;
    if (unordered) s.list.sort((a, b) => a.seq - b.seq);
    if (s.list.length > CAP) {
      const drop = s.list.length - CAP;
      s.list.splice(0, drop);
      s.hidden += drop;
    }
    return added;
  }, []);

  const flush = useCallback(() => {
    raf.current = 0;
    const s = store.current;
    if (!s.pending.length) return;
    const batch = s.pending;
    s.pending = [];
    if (merge(batch)) setTick((t) => t + 1);
  }, [merge]);

  const backfill = useCallback(
    async (signal) => {
      if (!runId) return;
      let after = store.current.maxSeq;
      for (let i = 0; i < MAX_PAGES; i += 1) {
        const r = await api.runEvents(runId, after, PAGE, { signal });
        const evs = r?.events || [];
        if (merge(evs)) setTick((t) => t + 1);
        if (evs.length < PAGE) break;
        after = Number(evs[evs.length - 1].seq) || after;
      }
    },
    [runId, merge],
  );

  // Đổi lượt → xóa màn, nạp lịch sử từ đầu.
  useEffect(() => {
    store.current = { list: [], seen: new Set(), hidden: 0, maxSeq: 0, pending: [] };
    atBottom.current = true;
    setShowJump(false);
    setError(null);
    setTick((t) => t + 1);
    if (!runId) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const ac = new AbortController();
    backfill(ac.signal)
      .then(() => setLoading(false))
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setError(e);
        setLoading(false);
      });
    return () => ac.abort();
  }, [runId, backfill, attempt]);

  // Lượt vừa kết thúc → bù một lần để chắc có đủ dòng cuối (result/check).
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) backfill().catch(() => {});
    wasLive.current = live;
  }, [live, backfill]);

  useSSE((msg) => {
    if (!runId) return;
    if (msg.type === 'log' && msg.data?.runId === runId) {
      store.current.pending.push(msg.data.event);
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    } else if (msg.type === 'reconnect') {
      backfill().catch(() => {});
    }
  });
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  // Tự cuộn xuống cuối, trừ khi người dùng đã cuộn lên xem dòng cũ.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  });

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottom.current = bottom;
    if (bottom) setShowJump(false);
  };

  const jump = () => {
    const el = logRef.current;
    if (!el) return;
    atBottom.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };

  const s = store.current;
  const onAir = live && !offline; // mất SSE thì không hiện 'trực tiếp' / con trỏ
  const lamp = onAir ? 'live' : live || run?.state === 'failed' ? 'off' : '';
  return (
    <div className="term">
      <div className="term-h">
        <i className={`lamp ${lamp}`} />
        <span>
          Nhật ký Claude · lượt {run?.n ?? '—'} · {onAir ? 'trực tiếp' : live ? 'mất kết nối — đang nối lại' : RUN_LABEL[run?.state] || run?.state || ''}
        </span>
        <span className="mono" title={runId || ''}>
          {fmtNum(s.list.length + s.hidden)} dòng · {runId ? runId.slice(0, 8) : ''}
        </span>
      </div>
      <div ref={logRef} className="log" onScroll={onScroll} role="log" aria-live="off" aria-label="Nhật ký Claude">
        {s.hidden > 0 ? <div className="note-l">… đã ẩn {fmtNum(s.hidden)} dòng cũ (chỉ giữ {fmtNum(CAP)} dòng gần nhất)</div> : null}
        {s.list.map((ev) => (
          <EventLine key={ev.seq} ev={ev} />
        ))}
        {loading && s.list.length === 0 ? (
          <SkZone className="sk-log" label="Đang nạp nhật ký">
            {['62%', '84%', '48%', '76%', '90%', '55%', '70%', '40%'].map((w, i) => (
              <div key={i} className="ev">
                <Sk w="5.5em" />
                <Sk w="4em" />
                <Sk w={w} />
              </div>
            ))}
          </SkZone>
        ) : null}
        {!loading && !error && s.list.length === 0 ? (
          <div className="note-l">{live ? 'Đang chờ Claude gửi dòng đầu tiên…' : 'Lượt này không có dòng nhật ký nào.'}</div>
        ) : null}
        {error ? (
          <div className="note-l" role="alert">
            Không nạp được nhật ký: {error.message}{' '}
            <button type="button" className="linkbtn" onClick={() => setAttempt((a) => a + 1)}>
              Thử lại
            </button>
          </div>
        ) : null}
        {onAir ? <span className="cursor" aria-hidden="true" /> : null}
      </div>
      {showJump ? (
        <div className="to-bottom">
          <button type="button" className="btn sm" onClick={jump}>
            ↓ Mới nhất
          </button>
        </div>
      ) : null}
    </div>
  );
}
