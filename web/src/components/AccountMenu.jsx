// Menu tài khoản ở đầu trang: mở bảng Claude, chọn ngôn ngữ, giao diện sáng/tối và đăng xuất — gom lại cho đầu trang gọn.
import { useEffect, useId, useRef, useState } from 'react';
import { Sk } from './Skeleton.jsx';
import { LANGS, useLang, useT } from '../lib/i18n.jsx';

function Tick() {
  return (
    <svg className="menu-tick" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

// st = {text, lamp, bad, loading}; mở bảng Claude bằng onAccount.
export default function AccountMenu({ st, theme, onTheme, onAccount, canLogout, onLogout, onReset }) {
  const t = useT();
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const btn = useRef(null);
  const menu = useRef(null);
  const id = useId();

  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };

  // Bấm ra ngoài → đóng; mở menu → focus mục đầu.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrap.current?.contains(e.target)) close(false);
    };
    document.addEventListener('mousedown', onDown, true);
    menu.current?.querySelector('[role^="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const onKey = (e) => {
    const items = [...menu.current.querySelectorAll('[role^="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const pick = (fn) => () => {
    close();
    fn();
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`acc-btn${st.bad ? ' bad' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={t('Tài khoản và cài đặt')}
        aria-label={`${t('Tài khoản và cài đặt')}: Claude ${st.text}`}
      >
        <i className={`lamp ${st.lamp}`} />
        <span className="hide-m">Claude</span>
        <span className="acc-st" aria-busy={st.loading || undefined}>{st.loading ? <Sk w="6.5em" /> : st.text}</span>
        <svg className="menu-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open ? (
        <div ref={menu} id={id} className="menu" role="menu" aria-label={t('Tài khoản và cài đặt')} onKeyDown={onKey}>
          <button type="button" role="menuitem" className="menu-it" onClick={pick(onAccount)}>
            <i className={`lamp ${st.lamp}`} />
            <span className="menu-lb">{t('Tài khoản Claude')}</span>
            <span className={`menu-meta${st.bad ? ' bad' : ''}`}>{st.text}</span>
          </button>
          <div className="menu-sep" role="separator" />
          <div className="menu-grp" role="presentation">{t('Ngôn ngữ')}</div>
          {LANGS.map((l) => (
            <button key={l.value} type="button" role="menuitemradio" aria-checked={lang === l.value} className="menu-it" onClick={pick(() => setLang(l.value))}>
              <span className="menu-lb">{l.label}</span>
              {lang === l.value ? <Tick /> : null}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <div className="menu-grp" role="presentation">{t('Giao diện')}</div>
          {[
            ['light', t('Sáng')],
            ['dark', t('Tối')],
          ].map(([v, label]) => (
            <button key={v} type="button" role="menuitemradio" aria-checked={theme === v} className="menu-it" onClick={pick(() => theme !== v && onTheme())}>
              <span className="menu-lb">{label}</span>
              {theme === v ? <Tick /> : null}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-it menu-danger" onClick={pick(onReset)} title={t('Xóa dữ liệu và đưa app về như mới cài')}>
            <span className="menu-lb">{t('Đặt lại toàn bộ…')}</span>
          </button>
          {canLogout ? (
            <>
              <div className="menu-sep" role="separator" />
              <button type="button" role="menuitem" className="menu-it" onClick={pick(onLogout)} title={t('Đăng xuất khỏi Video Studio (không đăng xuất Google / Claude)')}>
                <span className="menu-lb">{t('Đăng xuất')}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
