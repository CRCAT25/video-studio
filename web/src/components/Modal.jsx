// Hộp thoại có vạch cảnh báo: Esc / bấm nền để đóng, tự focus phần tử đầu, giữ Tab trong hộp, phần còn lại inert, trả focus khi đóng.
import { useEffect, useId, useRef } from 'react';
import { useT } from '../lib/i18n.jsx';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Đặt inert cho mọi anh em của các tổ tiên từ nền hộp thoại lên tới body (trừ vùng thông báo và sidebar Trợ lý AI); trả hàm gỡ.
function inertOutside(bg) {
  const touched = [];
  for (let node = bg; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sib of node.parentElement.children) {
      if (sib === node || sib.inert || sib.matches('script,style,.toasts,.ai-panel,[aria-live]')) continue;
      sib.inert = true;
      touched.push(sib);
    }
  }
  return () => touched.forEach((el) => { el.inert = false; });
}

// Hiển thị hộp thoại; paid = viền đỏ (bước tốn tiền); wide = rộng hơn.
export default function Modal({ title, lead, onClose, wide = false, paid = false, children, busy = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const titleId = useId();
  const t = useT();

  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const restore = el ? inertOutside(el.parentElement) : () => {};
    const first = el?.querySelector('[data-autofocus]') || el?.querySelector('input,select,textarea,button:not(.x)');
    if (first) first.focus();
    const onKey = (e) => {
      if (e.target?.closest?.('.ai-panel')) return; // phím gõ trong sidebar Trợ lý AI không đụng tới hộp thoại
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      // bẫy Tab: đi vòng trong hộp thoại
      const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
      if (!items.length) return;
      const a = items[0];
      const z = items[items.length - 1];
      const cur = document.activeElement;
      if (!el.contains(cur)) {
        e.preventDefault();
        (e.shiftKey ? z : a).focus();
      } else if (e.shiftKey && cur === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && cur === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const ov = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = ov;
      restore();
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, []);

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose?.();
      }}
    >
      <div ref={ref} className={`modal card pad${wide ? ' wide' : ''}${paid ? ' paid-m' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button type="button" className="x" aria-label={t('Đóng')} title={t('Đóng (Esc)')} onClick={() => !busy && onClose?.()}>
          ✕
        </button>
        <h2 id={titleId}>{title}</h2>
        {lead ? <p className="lead">{lead}</p> : null}
        {children}
      </div>
    </div>
  );
}
