// Dải báo bản mới (Release GitHub): Cập nhật ngay trong app, xong thì nhắc khởi động lại. "Để sau" ẩn tới bản kế tiếp.
// Mã trên máy đổi sau khi server chạy (stale: build lại, git pull…) → cũng nhắc khởi động lại.
import { useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';
import { useT } from '../lib/i18n.jsx';

const SKIP_KEY = 'vs.update.skip';
const readSkip = () => {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
};

// u = trạng thái /api/update; running = số bước đang chạy (khởi động lại sẽ dừng chúng).
export default function UpdateBanner({ u, running = 0 }) {
  const toast = useToast();
  const t = useT();
  const [skip, setSkip] = useState(readSkip);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  if (!u || (!u.newer && u.state === 'idle' && !u.stale)) return null;
  if (u.state === 'idle' && !u.stale && skip === u.latest) return null;

  const later = () => {
    try {
      localStorage.setItem(SKIP_KEY, u.latest);
    } catch {
      /* bỏ qua */
    }
    setSkip(u.latest);
  };
  const act = (fn) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const update = act(() => api.updateStart());
  // Chạy nền: server thoát rồi launchd mở lại → chờ /api/health báo server mới (boot/version khác) rồi tải lại trang.
  const restart = act(async () => {
    const before = await api.health().catch(() => null);
    await api.updateRestart();
    setRestarting(true);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const h = await api.health().catch(() => null);
      if (h && ((h.boot && h.boot !== before?.boot) || (h.version && h.version !== u.current))) return window.location.reload();
    }
    setRestarting(false);
    toast(t('App chưa mở lại — chạy: video-studio service restart'), 'err');
  });

  let body;
  let acts = null;
  if (u.state === 'running' || restarting) {
    body = (
      <>
        <span className="spinner" aria-hidden="true" /> {restarting ? t('Đang khởi động lại…') : t('Đang cập nhật…')}
      </>
    );
  } else if (u.state === 'done' || u.stale) {
    const what = u.state === 'done' ? t('Đã tải bản v{v}.', { v: u.latest }) : t('App vừa được cập nhật trên máy.');
    body = u.canRestart ? <>{what} {t('Khởi động lại để dùng.')}</> : (
      <>
        {what} {t('Tắt app (Ctrl+C ở terminal) rồi chạy lại')} <code>video-studio</code>.
      </>
    );
    if (u.canRestart) {
      acts = (
        <button type="button" className="btn sm primary" onClick={restart} disabled={busy || running > 0} title={running > 0 ? t('Đợi các bước đang chạy xong') : undefined}>
          {t('Khởi động lại')}
        </button>
      );
    }
  } else if (u.state === 'error') {
    body = (
      <>
        {t('Cập nhật lỗi.')}{' '}
        <details className="upd-log">
          <summary>{t('Chi tiết')}</summary>
          <pre>{u.log}</pre>
        </details>
      </>
    );
    acts = (
      <button type="button" className="btn sm" onClick={update} disabled={busy}>
        {t('Thử lại')}
      </button>
    );
  } else {
    body = (
      <>
        {t('Có bản mới')} <b>v{u.latest}</b> <span className="muted">({t('đang dùng v{v}', { v: u.current })})</span>
        {u.url ? (
          <>
            {' · '}
            <a href={u.url} target="_blank" rel="noopener noreferrer">
              {t('Xem thay đổi')}
            </a>
          </>
        ) : null}
      </>
    );
    acts = (
      <>
        <button type="button" className="btn sm" onClick={later}>
          {t('Để sau')}
        </button>
        <button type="button" className="btn sm primary" onClick={update} disabled={busy}>
          {t('Cập nhật')}
        </button>
      </>
    );
  }
  return (
    <div className="upd" role="status">
      <div className="card upd-in">
        <div className="upd-msg">{body}</div>
        {acts ? <span className="doctor-acts">{acts}</span> : null}
      </div>
    </div>
  );
}
