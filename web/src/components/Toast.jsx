// Thông báo nổi ngắn (toast) dùng chung qua context.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastCtx = createContext(() => {});

// Bọc app để mọi nơi gọi được toast(msg, kind).
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const toast = useCallback((msg, kind = 'info', ms = 3200) => {
    if (!msg) return;
    seq.current += 1;
    const id = seq.current;
    setItems((xs) => [...xs.slice(-3), { id, msg: String(msg), kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'err' ? Math.max(ms, 6000) : ms);
  }, []);
  const value = useMemo(() => toast, [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : t.kind === 'ok' ? ' ok' : ''}`}>
            {t.msg}
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
