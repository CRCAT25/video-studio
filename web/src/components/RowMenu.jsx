import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../lib/i18n.jsx';

// Menu "…" cuối mỗi hàng của mọi danh sách: gom các thao tác theo dòng (xem, sửa, xóa…) vào một chỗ.
export default function RowMenu({ label, items }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const btn = useRef(null);
  const menu = useRef(null);
  const id = useId();
  const [pos, setPos] = useState(null);
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  // Bảng cuộn ngang sẽ cắt menu absolute → đặt menu theo tọa độ cố định của nút; cuộn/đổi cỡ thì đóng.
  const toggle = () => {
    if (!open) {
      const r = btn.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      setPos({ right: Math.max(8, window.innerWidth - r.right), ...(below < 220 ? { top: 'auto', bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
    }
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return undefined;
    const since = Date.now();
    const shut = () => close(false);
    const onScroll = (e) => {
      // Chỉ đóng khi thứ chứa nút cuộn (trang/bảng); vùng không liên quan cuộn thì bỏ qua.
      // Trang đang cuộn mượt tới dòng vừa bấm "…" thì chưa đóng.
      if (Date.now() - since < 600) return;
      const el = e.target;
      const holds = el === document || el === document.documentElement || (el.contains && el.contains(wrap.current));
      if (holds && !menu.current?.contains(el)) close(false);
    };
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrap.current?.contains(e.target)) close(false);
    };
    document.addEventListener('mousedown', onDown, true);
    menu.current?.querySelector('[role^="menuitem"]')?.focus({ preventScroll: true });
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);
  const onKey = (e) => {
    const items = [...menu.current.querySelectorAll('[role^="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const go = (n) => {
      e.preventDefault();
      items[n]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') close(false);
    else if (e.key === 'ArrowDown') go((i + 1) % items.length);
    else if (e.key === 'ArrowUp') go((i - 1 + items.length) % items.length);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };
  const pick = (fn) => () => {
    close();
    fn();
  };
  return (
    <div className="menu-wrap yt-rowmenu" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="btn sm"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={t('Thao tác')}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </svg>
      </button>
      {open ? (
        <div ref={menu} id={id} className="menu yt-rowpop" style={pos} role="menu" aria-label={label} onKeyDown={onKey}>
          {items.map((it, i) =>
            it.sep ? (
              <div key={i} className="menu-sep" role="separator" />
            ) : (
              <button key={i} type="button" role="menuitem" className={`menu-it${it.danger ? ' menu-danger' : ''}`} onClick={pick(it.onClick)} disabled={it.disabled} title={it.title} data-ai={it.ai}>
                <span className="menu-lb">{it.label}</span>
                {it.external ? (
                  <svg className="menu-tick" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 3h4v4M13 3L7.5 8.5M12 9v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7" />
                  </svg>
                ) : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
