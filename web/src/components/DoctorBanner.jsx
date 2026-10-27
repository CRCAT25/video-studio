// Thông báo khi môi trường thiếu (doctor.problems) hoặc không gọi được server.
import { useState } from 'react';
import { tr, useT } from '../lib/i18n.jsx';

// Hiện danh sách vấn đề + nút "Kiểm tra lại" (gọi doctor?refresh=1); chưa đăng nhập → thêm nút mở bảng Tài khoản.
export default function DoctorBanner({ doctor, error, onRefresh, onAccount }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const problems = [];
  if (error) problems.push(error);
  if (doctor && Array.isArray(doctor.problems)) problems.push(...doctor.problems);
  if (problems.length === 0) return null;
  const refresh = async () => {
    setBusy(true);
    try {
      await onRefresh?.();
    } finally {
      setBusy(false);
    }
  };
  const needLogin = !!doctor?.claude?.found && !doctor?.auth?.loggedIn;
  return (
    <div className="doctor" role="alert">
      <div className="card">
        <div className="doctor-in">
          <i className="lamp" />
          <div>
            <div className="tt">{t('Chưa sẵn sàng để chạy')}</div>
            <ul>
              {problems.map((p, i) => (
                <li key={i}>{tr(String(p))}</li>
              ))}
            </ul>
          </div>
          <span className="doctor-acts">
            {needLogin && onAccount ? (
              <button type="button" className="btn sm primary" onClick={onAccount}>
                {t('Đăng nhập Claude')}
              </button>
            ) : null}
            <button type="button" className="btn sm" onClick={refresh} disabled={busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : '↻'} {t('Kiểm tra lại')}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
