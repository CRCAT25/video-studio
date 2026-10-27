// Thanh tiến độ dùng chung: có `value` (0–100) thì hiện %, không có thì chạy qua lại (không xác định); kèm số giây đã trôi.
import { useEffect, useState } from 'react';

function mmss(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Progress({ value = null, label = '', elapsed = true }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!elapsed) return undefined;
    const id = setInterval(() => setSec((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [elapsed]);
  const known = typeof value === 'number';
  const pct = known ? Math.max(0, Math.min(100, Math.round(value))) : null;
  return (
    <div className="prog">
      <div className="prog-top">
        <span>{label}</span>
        <span className="prog-num">{known ? `${pct}%` : ''}{known && elapsed ? ' · ' : ''}{elapsed ? mmss(sec) : ''}</span>
      </div>
      <div className={`prog-bar${known ? '' : ' ind'}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined}>
        <i style={known ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}
