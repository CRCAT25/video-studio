// Dải báo bản mới (Release GitHub): Cập nhật ngay trong app, xong thì nhắc khởi động lại. "Để sau" ẩn tới bản kế tiếp.
import { useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';

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
  const [skip, setSkip] = useState(readSkip);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  if (!u || (!u.newer && u.state === 'idle')) return null;
  if (u.state === 'idle' && skip === u.latest) return null;

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
  // Chạy nền: server thoát rồi launchd mở lại → chờ /api/health trả version mới rồi tải lại trang.
  const restart = act(async () => {
    await api.updateRestart();
    setRestarting(true);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const h = await api.health().catch(() => null);
      if (h?.version && h.version !== u.current) return window.location.reload();
    }
    setRestarting(false);
    toast('App chưa mở lại — chạy: video-studio service restart', 'err');
  });

  let body;
  let acts = null;
  if (u.state === 'running' || restarting) {
    body = (
      <>
        <span className="spinner" aria-hidden="true" /> {restarting ? 'Đang khởi động lại…' : 'Đang cập nhật…'}
      </>
    );
  } else if (u.state === 'done') {
    body = u.canRestart ? <>Đã tải bản v{u.latest}. Khởi động lại để dùng.</> : (
      <>
        Đã tải bản v{u.latest}. Tắt app (Ctrl+C ở terminal) rồi chạy lại <code>video-studio</code>.
      </>
    );
    if (u.canRestart) {
      acts = (
        <button type="button" className="btn sm primary" onClick={restart} disabled={busy || running > 0} title={running > 0 ? 'Đợi các bước đang chạy xong' : undefined}>
          Khởi động lại
        </button>
      );
    }
  } else if (u.state === 'error') {
    body = (
      <>
        Cập nhật lỗi.{' '}
        <details className="upd-log">
          <summary>Chi tiết</summary>
          <pre>{u.log}</pre>
        </details>
      </>
    );
    acts = (
      <button type="button" className="btn sm" onClick={update} disabled={busy}>
        Thử lại
      </button>
    );
  } else {
    body = (
      <>
        Có bản mới <b>v{u.latest}</b> <span className="muted">(đang dùng v{u.current})</span>
        {u.url ? (
          <>
            {' · '}
            <a href={u.url} target="_blank" rel="noopener noreferrer">
              Xem thay đổi
            </a>
          </>
        ) : null}
      </>
    );
    acts = (
      <>
        <button type="button" className="btn sm" onClick={later}>
          Để sau
        </button>
        <button type="button" className="btn sm primary" onClick={update} disabled={busy}>
          Cập nhật
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
