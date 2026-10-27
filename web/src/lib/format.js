// Nhãn và hàm định dạng số/thời gian dùng chung cho giao diện (dịch theo ngôn ngữ đang chọn).
import { T, intlLocale, tr } from './i18n.jsx';

// Bảng nhãn: giá trị là khóa tiếng Việt, đọc ra thì dịch theo ngôn ngữ hiện tại.
const tx = (o) => new Proxy(o, { get: (t, k) => (typeof t[k] === 'string' ? tr(t[k]) : t[k]) });

export const STATE_LABEL = tx({
  done: T('Xong'),
  running: T('Đang chạy'),
  needs_input: T('Cần trả lời'),
  failed: T('Lỗi'),
  pending: T('Chờ'),
  ready: T('Sẵn sàng'),
  stale: T('Cũ (cần chạy lại)'),
  manual: T('Việc tay'),
});
export const BOX_LABEL = tx({ stale: T('Chạy lại'), ready: T('Sẵn sàng'), manual: T('Việc tay') });
export const RUN_LABEL = tx({
  running: T('Đang chạy'),
  done: T('Xong'),
  failed: T('Lỗi'),
  needs_input: T('Cần trả lời'),
  stopped: T('Đã dừng'),
});
export const GATE_LABEL = tx({
  manual: T('Duyệt tay'),
  auto_if_checks: T('Tự duyệt nếu kiểm tra đạt'),
  auto_after: T('Tự duyệt sau hẹn giờ'),
  auto: T('Tự động'),
});
export const GATE_SHORT = tx({
  manual: T('Duyệt tay'),
  auto_if_checks: T('Tự nếu đạt'),
  auto_after: T('Tự hẹn giờ'),
  auto: T('Tự động'),
});
export const KIND_LABEL = tx({
  video: T('Video'),
  audio: T('Âm thanh'),
  image: T('Ảnh'),
  markdown: T('Markdown'),
  json: T('JSON'),
  text: T('Văn bản'),
  other: T('Khác'),
});
// Lớp màu cho dây chuyền theo trạng thái bước hiện tại.
export const LINE_CLASS = {
  running: 'L-run',
  ready: 'L-run',
  needs_input: 'L-ask',
  manual: 'L-wait',
  stale: 'L-wait',
  failed: 'L-err',
  done: 'L-ok',
};

// Gán nhãn trạng thái bước (không rõ → giữ nguyên mã).
export function stateLabel(s) {
  return STATE_LABEL[s] || s || '—';
}

// Hai chữ số: 7 → "07".
export function two(n) {
  return String(n).padStart(2, '0');
}

// Số đầy đủ theo ngôn ngữ: 12345 → "12.345" (vi) / "12,345" (en).
export function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return new Intl.NumberFormat(intlLocale()).format(Number(n));
}

// Số token gọn: 953 → "953", 12 300 → "12,3k", 1 250 000 → "1,25M".
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${trimDec(v / 1000, v < 1e4 ? 1 : 0)}k`;
  return `${trimDec(v / 1e6, 2)}M`;
}

function trimDec(x, d) {
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: d }).format(x);
}

// Dung lượng file: 1536 → "1,5 KB".
export function fmtBytes(b) {
  if (b == null || Number.isNaN(Number(b))) return '';
  const v = Number(b);
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${trimDec(x, x < 10 ? 1 : 0)} ${units[i]}`;
}

// Tiền USD (chỉ khi dùng API key): 0.1234 → "$0,123".
export function fmtUsd(x) {
  if (x == null) return '—';
  return `$${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 3, minimumFractionDigits: 2 }).format(Number(x))}`;
}

function toDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Thời gian tương đối: "vừa xong", "5 phút trước", "hôm qua", "3 ngày trước", hoặc ngày dd/mm/yyyy.
export function fmtRelative(iso, now = Date.now()) {
  const d = toDate(iso);
  if (!d) return '—';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return tr('vừa xong');
  const m = Math.round(s / 60);
  if (m < 60) return tr('{n} phút trước', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return tr('{n} giờ trước', { n: h });
  const days = Math.round(h / 24);
  if (days === 1) return tr('hôm qua');
  if (days < 7) return tr('{n} ngày trước', { n: days });
  return fmtDate(iso);
}

// Ngày dd/mm/yyyy.
export function fmtDate(iso) {
  const d = toDate(iso);
  if (!d) return '—';
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Giờ HH:MM:SS (giờ máy).
export function fmtTime(iso) {
  const d = toDate(iso);
  if (!d) return '--:--:--';
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// Ngày giờ ngắn "dd/mm HH:MM".
export function fmtDateTime(iso) {
  const d = toDate(iso);
  if (!d) return '—';
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// Thời lượng đồng hồ: 75 000 ms → "01:15", 3 700 000 → "1:01:40".
export function fmtElapsed(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

// Thời lượng chữ: 1 800 000 → "30 phút", 7 200 000 → "2 giờ".
export function fmtDuration(ms) {
  const v = Number(ms) || 0;
  if (v < 60000) return tr('{n} giây', { n: Math.round(v / 1000) });
  const m = Math.round(v / 60000);
  if (m < 60) return tr('{n} phút', { n: m });
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? tr('{h} giờ {m} phút', { h, m: r }) : tr('{n} giờ', { n: h });
}

// Thời gian chạy của một lượt (đến hiện tại nếu chưa kết thúc).
export function runElapsed(run, now = Date.now()) {
  const a = toDate(run?.started_at);
  if (!a) return 0;
  const b = toDate(run?.ended_at);
  return (b ? b.getTime() : now) - a.getTime();
}

// Tổng token của usage (in + out + cache).
export function usageTokens(u) {
  if (!u) return 0;
  return (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
    + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
}

// Nhãn mô tả cổng duyệt (auto_after kèm thời gian nếu có).
export function gateLabel(gate) {
  const mode = typeof gate === 'string' ? gate : gate?.mode;
  if (mode === 'auto_after' && gate?.after_ms) return tr('Tự duyệt sau {d}', { d: fmtDuration(gate.after_ms) });
  return GATE_LABEL[mode] || mode || '—';
}
