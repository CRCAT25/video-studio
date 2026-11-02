// Dán link YouTube bất kỳ để AI "xem" (khung hình + lời + phân tích) làm tham khảo cho dự án mới.
// value = {watchId, title} | {channelId, videoId} | null; chỉ đổi value khi là kiểu watch.
import { useState } from 'react';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

export default function WatchVideo({ value, onChange, disabled = false }) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const watched = value?.watchId ? value : null;

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.watchVideo(url.trim());
      onChange({ watchId: r.id, title: r.title });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ref-pick">
      <div className="ref-bar">
        <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('Dán link YouTube cần bắt chước')} aria-label={t('Dán link YouTube cần bắt chước')} disabled={disabled || busy} />
        <button type="button" className="btn" onClick={go} disabled={disabled || busy || !url.trim()}>{busy ? t('Đang xem…') : t('Xem video')}</button>
      </div>
      {err ? <div className="err-note" role="alert">{err.message}</div> : null}
      {watched ? (
        <div className="hint">
          {t('Đã xem: {title}', { title: watched.title })} · <button type="button" className="btn sm ghost" onClick={() => onChange(null)} disabled={disabled}>{t('Bỏ video này')}</button>
        </div>
      ) : (
        <span className="hint">{t('AI tải bản thấp tạm thời, cắt khung hình, đọc lời rồi viết phân tích phong cách (tốn token, mất vài phút). Video tải về được xóa ngay.')}</span>
      )}
    </div>
  );
}
