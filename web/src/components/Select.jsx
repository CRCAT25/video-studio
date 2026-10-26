// Ô chọn tự vẽ (thay <select> gốc): nút + danh sách nổi, có chấm màu / chữ phụ / nhãn, nhóm, bàn phím đầy đủ.
// options = [{value, label, meta?, dot?, badges?: [{text, tone?}], icon?, group?}]; onChange(value).
// Mọi ô chọn trong app dùng component này (không dùng <select> gốc) để giao diện đồng nhất; size="sm" cho hàng chật.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

const GAP = 4;
const MAX_H = 320;

// Nội dung 1 dòng (dùng cho cả nút và danh sách).
function Line({ o }) {
  return (
    <>
      {o.dot !== undefined ? <i className="sel-dot" style={{ background: o.dot || 'var(--idle)' }} aria-hidden="true" /> : null}
      {o.icon ? <span className="sel-ic" aria-hidden="true">{o.icon}</span> : null}
      <span className="sel-lb">{o.label}</span>
      {o.meta ? <span className="sel-meta">{o.meta}</span> : null}
      {(o.badges || []).map((b) => (
        <span key={b.text} className={`sel-badge${b.tone ? ` ${b.tone}` : ''}`}>
          {b.text}
        </span>
      ))}
    </>
  );
}

export default function Select({ value, options = [], onChange, disabled = false, placeholder = 'Chọn…', label, id, size, className = '' }) {
  const autoId = useId();
  const btnId = id || `${autoId}-b`;
  const listId = `${autoId}-l`;
  const btn = useRef(null);
  const list = useRef(null);
  const typed = useRef({ s: '', t: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState(null);

  const idx = options.findIndex((o) => o.value === value);
  const cur = options[idx];

  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const pick = (i) => {
    const o = options[i];
    if (o && o.value !== value) onChange?.(o.value);
    close();
  };
  const show = (at = idx) => {
    if (disabled || !options.length) return;
    setActive(at < 0 ? 0 : at);
    setOpen(true);
  };

  // Đặt danh sách dưới nút (không đủ chỗ thì lật lên trên); position:fixed để không bị hộp thoại cắt.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - GAP - 8;
      const above = r.top - GAP - 8;
      const up = below < Math.min(MAX_H, 200) && above > below;
      const maxH = Math.min(MAX_H, up ? above : below);
      setPos({ left: r.left, minWidth: r.width, maxWidth: window.innerWidth - r.left - 8, maxHeight: maxH, ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Bấm ra ngoài → đóng (không lấy lại focus).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!btn.current?.contains(e.target) && !list.current?.contains(e.target)) close(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  // Giữ dòng đang chọn trong tầm nhìn.
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, pos]);

  // Gõ chữ để nhảy tới dòng bắt đầu bằng chữ đó.
  const typeahead = (ch) => {
    const now = Date.now();
    const t = typed.current;
    t.s = now - t.t > 700 ? ch : t.s + ch;
    t.t = now;
    const q = t.s.toLowerCase();
    const from = open ? active : idx;
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + (t.s.length > 1 ? k - 1 : k) + n) % n;
      if (String(options[i].label).toLowerCase().startsWith(q)) return i;
    }
    return -1;
  };

  const onKey = (e) => {
    const n = options.length;
    if (!n || disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        show(idx < 0 ? 0 : idx);
      } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const i = typeahead(k);
        if (i >= 0) onChange?.(options[i].value);
      }
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // không đóng luôn hộp thoại chứa nó
      close();
    } else if (k === 'Tab') {
      close(false);
    } else if (k === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(n - 1, a + 1));
    } else if (k === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (k === 'Home' || k === 'PageUp') {
      e.preventDefault();
      setActive(0);
    } else if (k === 'End' || k === 'PageDown') {
      e.preventDefault();
      setActive(n - 1);
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      pick(active);
    } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const i = typeahead(k);
      if (i >= 0) setActive(i);
    }
  };

  let lastGroup;
  return (
    <div className={`sel${size ? ` ${size}` : ''}${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={btn}
        id={btnId}
        type="button"
        className="sel-btn"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
      >
        <span className="sel-val">{cur ? <Line o={cur} /> : <span className="sel-ph">{placeholder}</span>}</span>
        <svg className="sel-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && pos ? (
        <ul ref={list} id={listId} className="sel-list" role="listbox" aria-labelledby={btnId} style={pos} onMouseDown={(e) => e.preventDefault()}>
          {options.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return [
              head ? (
                <li key={`g-${head}`} className="sel-grp" role="presentation">
                  {head}
                </li>
              ) : null,
              <li
                key={o.value}
                id={`${listId}-${i}`}
                data-i={i}
                data-value={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`sel-opt${i === active ? ' act' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={(e) => {
                  e.preventDefault(); // nằm trong <label>: không để label bấm lại nút
                  pick(i);
                }}
              >
                <Line o={o} />
                <svg className="sel-tick" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              </li>,
            ];
          })}
        </ul>
      ) : null}
    </div>
  );
}

// Hồ sơ Chrome chọn lần trước (dùng chung giữa các trang); DEFAULT_BROWSER = trình duyệt mặc định.
export const DEFAULT_BROWSER = '__default__';
const PROFILE_KEY = 'vs.chromeProfile';
export function savedProfile() {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}
export function saveProfile(v) {
  try {
    localStorage.setItem(PROFILE_KEY, v);
  } catch {
    /* trình duyệt chặn lưu */
  }
}

// Tùy chọn cho ô "mở trong hồ sơ Chrome": chấm màu hồ sơ, tên, thư mục mờ, nhãn "Gần nhất" / "Đang mở";
// cuối là trình duyệt mặc định (kèm tên nếu biết, vd. Safari).
export function profileOptions(profiles = [], defaultValue, browser = null) {
  const badges = (p) => [p.lastUsed && { text: 'Gần nhất' }, p.open && { text: 'Đang mở', tone: 'ok' }].filter(Boolean);
  return [
    ...profiles.map((p) => ({ value: p.dir, label: p.name, meta: p.dir, dot: p.color || null, badges: badges(p), group: 'Chrome' })),
    { value: defaultValue, label: browser ? `Trình duyệt mặc định (${browser})` : 'Trình duyệt mặc định', icon: <GlobeIcon />, group: 'Khác' },
  ];
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12" />
    </svg>
  );
}
