// Kết nối SSE dùng chung cho cả app: một EventSource('/api/stream'), nhiều nơi đăng ký nghe.
import { useEffect, useRef, useSyncExternalStore } from 'react';

const subs = new Set();
const statusSubs = new Set();
let es = null;
let status = 'connecting'; // connecting | open | reconnecting
let opened = false;
let retryTimer = null;

function setStatus(s) {
  if (s === status) return;
  status = s;
  for (const fn of statusSubs) fn();
}

function emit(msg) {
  for (const fn of [...subs]) {
    try {
      fn(msg);
    } catch (e) {
      console.warn('SSE handler lỗi', e);
    }
  }
}

function parse(ev) {
  try {
    return JSON.parse(ev.data);
  } catch {
    return null;
  }
}

function connect() {
  if (es || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  clearTimeout(retryTimer);
  retryTimer = null;
  es = new EventSource('/api/stream');
  es.onopen = () => {
    const again = opened;
    opened = true;
    setStatus('open');
    if (again) emit({ type: 'reconnect' });
  };
  es.addEventListener('hello', (ev) => emit({ type: 'hello', data: parse(ev) }));
  es.addEventListener('change', (ev) => {
    const d = parse(ev);
    if (d) emit({ type: 'change', data: d });
  });
  es.addEventListener('account', (ev) => {
    const d = parse(ev);
    if (d) emit({ type: 'account', data: d });
  });
  es.addEventListener('youtube', () => emit({ type: 'youtube' }));
  es.addEventListener('google-setup', () => emit({ type: 'google-setup' }));
  es.addEventListener('log', (ev) => {
    const d = parse(ev);
    if (d && d.event) emit({ type: 'log', data: d });
  });
  es.onerror = () => {
    setStatus('reconnecting');
    // Trình duyệt tự nối lại khi CONNECTING; nếu đã CLOSED (vd. 401/500) thì tự thử lại sau 5 giây.
    if (es && es.readyState === 2) {
      es.close();
      es = null;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 5000);
    }
  };
}

// Đăng ký nhận sự kiện SSE ({type:'hello'|'change'|'log'|'account'|'youtube'|'google-setup'|'reconnect', data}); trả hàm hủy.
export function subscribeSSE(fn) {
  subs.add(fn);
  connect();
  return () => subs.delete(fn);
}

// Hook nghe SSE; handler luôn là bản mới nhất (không cần đưa vào deps).
export function useSSE(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeSSE((msg) => ref.current?.(msg)), []);
}

// Hook trả trạng thái kết nối SSE: 'connecting' | 'open' | 'reconnecting'.
export function useSSEStatus() {
  return useSyncExternalStore(
    (cb) => {
      statusSubs.add(cb);
      connect();
      return () => statusSubs.delete(cb);
    },
    () => status,
    () => status,
  );
}
