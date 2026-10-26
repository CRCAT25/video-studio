// Thông báo khi môi trường thiếu (doctor.problems) hoặc không gọi được server.
import { useState } from 'react';

// Hiện danh sách vấn đề + nút "Kiểm tra lại" (gọi doctor?refresh=1); chưa đăng nhập → thêm nút mở bảng Tài khoản.
export default function DoctorBanner({ doctor, error, onRefresh, onAccount }) {
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
            <div className="tt">Chưa sẵn sàng để chạy</div>
            <ul>
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
          <span className="doctor-acts">
            {needLogin && onAccount ? (
              <button type="button" className="btn sm primary" onClick={onAccount}>
                Đăng nhập Claude
              </button>
            ) : null}
            <button type="button" className="btn sm" onClick={refresh} disabled={busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : '↻'} Kiểm tra lại
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
