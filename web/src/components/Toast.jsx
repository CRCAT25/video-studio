// Thông báo nổi ngắn (toast) dùng chung qua context.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastCtx = createContext(() => {});
const OUT_MS = 240;

// Biểu tượng theo loại: ok = dấu tick, err = dấu chấm than, info = chữ i.
const ICONS = {
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  err: <path d="M12 7v6M12 17h.01" />,
  info: <path d="M12 11v6M12 7h.01" />,
};

// Bọc app để mọi nơi gọi được toast(msg, kind).
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const dismiss = useCallback((id) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x)));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), OUT_MS);
  }, []);
  const toast = useCallback((msg, kind = 'info', ms = 3200) => {
    if (!msg) return;
    seq.current += 1;
    const id = seq.current;
    const life = kind === 'err' ? Math.max(ms, 6000) : ms;
    setItems((xs) => [...xs.slice(-3), { id, msg: String(msg), kind, life }]);
    // Chạy hiệu ứng thoát (.out) rồi mới gỡ khỏi danh sách.
    setTimeout(() => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x))), life);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), life + OUT_MS);
  }, []);
  const value = useMemo(() => toast, [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast${t.kind === 'err' ? ' err' : t.kind === 'ok' ? ' ok' : ''}${t.out ? ' out' : ''}`}
            style={{ '--life': `${t.life}ms` }}
            onClick={() => dismiss(t.id)}
          >
            <span className="ti" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                {ICONS[t.kind] || ICONS.info}
              </svg>
            </span>
            <span className="tm">{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// Lấy hàm toast(msg, kind='info'|'ok'|'err', ms).
export function useToast() {
  return useContext(ToastCtx);
}
