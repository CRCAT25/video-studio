// Ô chọn khoảng ngày cho số liệu YouTube (giống Studio): 7 / 28 / 90 / 365 ngày hoặc tùy chọn ngày bắt đầu–kết thúc.
// value = "7"|"28"|"90"|"365"|"YYYY-MM-DD_YYYY-MM-DD" (gửi thẳng lên server ?range=). Nhớ lựa chọn trong localStorage.
import { useState } from 'react';
import Select from './Select.jsx';

export const PRESETS = ['7', '28', '90', '365'];
const KEY = 'vs.yt.range';
const CUSTOM = 'custom';
const MIN_DATE = '2005-02-14';
const MAX_SPAN = 1096;
const RE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

// Ngày địa phương YYYY-MM-DD, lệch n ngày.
function ymd(n = 0) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const spanDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
// "2026-10-03" → "03/10/26".
const dmy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;

// Khoảng ngày hợp lệ phía trình duyệt (server kiểm lại); kết thúc muộn nhất là hôm qua.
export function validRange(v) {
  if (PRESETS.includes(v)) return true;
  const m = RE.exec(String(v || ''));
  return !!m && m[1] <= m[2] && m[1] >= MIN_DATE && m[2] <= ymd(-1) && spanDays(m[1], m[2]) <= MAX_SPAN;
}

// Nhãn ngắn: "28 ngày" / "01/09/26 – 30/09/26".
export function rangeLabel(v) {
  if (PRESETS.includes(v)) return `${v} ngày`;
  const m = RE.exec(String(v || ''));
  return m ? `${dmy(m[1])} – ${dmy(m[2])}` : '28 ngày';
}

export function savedRange() {
  try {
    const v = localStorage.getItem(KEY);
    return validRange(v) ? v : '28';
  } catch {
    return '28';
  }
}
export function saveRange(v) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* trình duyệt chặn lưu */
  }
}

const OPTIONS = [...PRESETS.map((p) => ({ value: p, label: `${p} ngày qua` })), { value: CUSTOM, label: 'Tùy chọn…' }];

export default function RangePicker({ value, onChange, disabled = false }) {
  const custom = RE.exec(value || '');
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(custom?.[1] || ymd(-28));
  const [to, setTo] = useState(custom?.[2] || ymd(-1));
  const draft = `${from}_${to}`;
  const ok = validRange(draft);
  const set = (v) => {
    saveRange(v);
    onChange(v);
  };
  const pick = (v) => {
    if (v === CUSTOM) return setEditing(true);
    setEditing(false);
    set(v);
  };
  const apply = (e) => {
    e.preventDefault();
    if (!ok) return;
    setEditing(false);
    set(draft);
  };
  const opts = custom ? OPTIONS.map((o) => (o.value === CUSTOM ? { ...o, label: rangeLabel(value) } : o)) : OPTIONS;

  return (
    <div className="yt-range">
      <div className="yt-range-sel">
        <Select label="Khoảng ngày" value={editing || custom ? CUSTOM : value} options={opts} onChange={pick} disabled={disabled} />
      </div>
      {editing ? (
        <form className="yt-range-c" onSubmit={apply}>
          <input type="date" aria-label="Từ ngày" value={from} min={MIN_DATE} max={to || ymd(-1)} onChange={(e) => setFrom(e.target.value)} />
          <span className="muted">–</span>
          <input type="date" aria-label="Đến ngày" value={to} min={from || MIN_DATE} max={ymd(-1)} onChange={(e) => setTo(e.target.value)} />
          <button type="submit" className="btn sm primary" disabled={!ok} title={ok ? undefined : 'Tối đa 3 năm, kết thúc muộn nhất là hôm qua'}>
            Áp dụng
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>
            Hủy
          </button>
        </form>
      ) : null}
    </div>
  );
}
