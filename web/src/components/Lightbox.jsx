// Xem ảnh lớn ngay trong trang: Esc / bấm nền để đóng, ← → chuyển ảnh, có nút tải.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { DownloadIcon } from './icons.jsx';
import { useT } from '../lib/i18n.jsx';

export default function Lightbox({ items, index, onIndex, onClose }) {
  const t = useT();
  const n = items.length;
  const cur = items[index];

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft' && n > 1) onIndex((index + n - 1) % n);
      else if (e.key === 'ArrowRight' && n > 1) onIndex((index + 1) % n);
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // khóa cuộn trang phía sau
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [index, n, onIndex, onClose]);

  if (!cur) return null;
  return createPortal(
    <div className="lb" role="dialog" aria-modal="true" aria-label={cur.name} onClick={onClose}>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-name">
          {cur.name} <span className="dim">{index + 1}/{n}</span>
        </span>
        <a className="btn primary lb-btn" href={cur.src} download={cur.file}>
          <DownloadIcon /> {t('Tải')}
        </a>
        <button type="button" className="btn lb-btn" onClick={onClose} autoFocus>
          {t('Đóng (Esc)')}
        </button>
      </div>
      {n > 1 ? (
        <button type="button" className="lb-nav prev" aria-label={t('Ảnh trước')} onClick={(e) => { e.stopPropagation(); onIndex((index + n - 1) % n); }}>
          ‹
        </button>
      ) : null}
      <img src={cur.src} alt={cur.name} onClick={(e) => e.stopPropagation()} />
      {n > 1 ? (
        <button type="button" className="lb-nav next" aria-label={t('Ảnh sau')} onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % n); }}>
          ›
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
