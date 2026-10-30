// Biểu đồ cột theo ngày / tuần / tháng (một chuỗi số liệu YouTube): cột ≤24px bo 4px đầu, lưới mảnh, tooltip theo cột, bảng số thay thế.
import { useEffect, useRef, useState } from 'react';
import { fmtNum } from '../lib/format.js';
import { T, intlLocale, tr } from '../lib/i18n.jsx';

const H = 180;
const PAD = { top: 12, right: 8, bottom: 24, left: 44 };

// Số gọn cho trục: 1200 → "1,2K".
export function compact(n) {
  const v = Number(n) || 0;
  const f = (x) => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: x < 10 ? 1 : 0 }).format(x);
  if (Math.abs(v) >= 1e6) return `${f(v / 1e6)}M`;
  if (Math.abs(v) >= 1e3) return `${f(v / 1e3)}K`;
  return f(v);
}

// Mốc trục y tròn số: 0..max chia ~4 khoảng.
function ticks(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

// "2026-10-03" → "03/10".
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dayName = (d) => new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
// Nhãn trục và tooltip theo đơn vị cột.
// Theo giờ: date = 'YYYY-MM-DDTHH' (giờ máy).
const hh = (d) => Number(d.slice(11, 13));
const axisLabel = (d, unit) => (unit === 'hour' ? `${hh(d.date)}h` : unit === 'month' ? `${d.date.slice(5, 7)}/${d.date.slice(2, 4)}` : dm(d.date));
const tipLabel = (d, unit) =>
  unit === 'hour'
    ? `${hh(d.date)}:00–${(hh(d.date) + 1) % 24}:00 ${dm(d.date)}`
    : unit === 'month' ? tr('Tháng {m}/{y}', { m: Number(d.date.slice(5, 7)), y: d.date.slice(0, 4) }) : unit === 'week' ? `${dm(d.date)} – ${dm(d.end || d.date)}` : `${dayName(d.date)} ${dm(d.date)}`;
const UNIT = { hour: T('giờ'), day: T('ngày'), week: T('tuần'), month: T('tháng') };

// days = [{date, end?, ...}], unit = 'hour'|'day'|'week'|'month', field = khóa số liệu, label = tên số liệu, fmt? = định dạng giá trị tooltip/bảng.
export default function YtChart({ days = [], unit = 'day', field, label, fmt = fmtNum }) {
  const wrap = useRef(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // null = chưa có số (bỏ trống cột, tooltip ghi rõ).
  const raw = days.map((d) => d[field]);
  const vals = raw.map((v) => Number(v) || 0);
  const show = (i) => (raw[i] == null ? tr('Chưa có số') : fmt(vals[i]));
  const t = ticks(Math.max(0, ...vals));
  const top = t[t.length - 1] || 1;
  const iw = w - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const band = days.length ? iw / days.length : iw;
  const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v) => PAD.top + ih - (v / top) * ih;
  // Nhãn ngày thưa: mỗi 7 ngày (đủ chỗ trên màn hẹp).
  const every = unit === 'hour' ? (band < 14 ? 12 : 6) : band < 14 ? 7 : band < 22 ? 4 : 2;
  const hv = hover != null ? days[hover] : null;

  return (
    <figure className="ytc">
      <div className="ytc-plot" ref={wrap} onPointerLeave={() => setHover(null)}>
        <svg width={w} height={H} role="img" aria-label={tr('{label} theo {u}, {n} {u}', { label, u: tr(UNIT[unit]), n: days.length })}>
          {t.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} className="ytc-grid" />
              <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="ytc-ax">
                {compact(v)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const v = vals[i];
            const x = PAD.left + i * band + (band - bw) / 2;
            const h = Math.max(0, y(0) - y(v));
            const r = Math.min(4, bw / 2, h);
            const y0 = y(0);
            // Cột bo 4px ở đầu, vuông ở đáy.
            const path = h > 0 ? `M${x},${y0}V${y0 - h + r}Q${x},${y0 - h} ${x + r},${y0 - h}H${x + bw - r}Q${x + bw},${y0 - h} ${x + bw},${y0 - h + r}V${y0}Z` : '';
            return (
              <g key={d.date}>
                {path ? <path d={path} className={`ytc-bar${hover === i ? ' on' : ''}`} /> : null}
                <rect
                  x={PAD.left + i * band}
                  y={PAD.top}
                  width={band}
                  height={ih}
                  className="ytc-hit"
                  tabIndex={0}
                  aria-label={`${tipLabel(d, unit)}: ${show(i)}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
                {i % every === 0 ? (
                  <text x={PAD.left + i * band + band / 2} y={H - 6} textAnchor="middle" className="ytc-ax">
                    {axisLabel(d, unit)}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line x1={PAD.left} x2={w - PAD.right} y1={y(0)} y2={y(0)} className="ytc-base" />
        </svg>
        {hv ? (
          <div
            className="ytc-tip"
            role="status"
            style={{ left: Math.min(w - 150, Math.max(0, PAD.left + hover * band + band / 2 - 70)), top: 0 }}
          >
            <b>{show(hover)}</b>
            <span>
              {label} · {tipLabel(hv, unit)}
            </span>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
