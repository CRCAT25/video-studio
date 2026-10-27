// Mức dùng gói Claude: % phiên 5 giờ / tuần (như /usage; dự phòng claude -p) + token app đã dùng hôm nay / 7 ngày.
// useUsage đặt ở Shell; UsageMeter ở đầu trang; UsagePanel trong bảng Tài khoản Claude.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSSE } from '../hooks/useSSE.js';
import { useToast } from './Toast.jsx';
import { Sk, SkZone } from './Skeleton.jsx';
import { T, intlLocale, tr, useT } from '../lib/i18n.jsx';

const WARN_AT = 0.8;
const WINDOWS = [
  { key: 'five_hour', label: T('Phiên 5 giờ'), short: '5h' },
  { key: 'seven_day', label: T('Tuần'), short: T('Tuần') },
];
const SOURCES = [
  { key: 'steps', label: T('Bước video') },
  { key: 'assistant', label: T('Trợ lý AI') },
  { key: 'check', label: T('Kiểm tra') },
];

const pct = (u) => Math.round((u || 0) * 100);

// Mức của cả tài khoản: 'bad' (bị giới hạn / chạm 100%), 'warn' (≥80% hoặc Claude cảnh báo), null.
export function usageLevel(limits) {
  if (!limits) return null;
  const us = Object.values(limits.windows || {}).map((w) => w.utilization);
  if (limits.status === 'rejected' || us.some((u) => u >= 1)) return 'bad';
  if (limits.status === 'allowed_warning' || us.some((u) => u >= WARN_AT)) return 'warn';
  return null;
}

// Giờ mở lại (giây epoch) → "14:30" nếu hôm nay, không thì "T5 14:30".
export function resetLabel(sec, now = new Date()) {
  if (!sec) return null;
  const d = new Date(sec * 1000);
  const hm = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString(intlLocale(), { weekday: 'short' })} ${hm}`;
}

// Khoảng cách tới / từ một mốc (ms) → "3 giờ", "2 ngày", "5 phút", "vài giây".
export function spanLabel(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return tr('vài giây');
  if (m < 60) return tr('{n} phút', { n: m });
  const h = Math.round(m / 60);
  return h < 24 ? tr('{n} giờ', { n: h }) : tr('{n} ngày', { n: Math.round(h / 24) });
}

// Số token gọn: 950, 12,3K, 4,5M.
export function fmtTokens(n) {
  const v = n || 0;
  if (v < 1000) return String(v);
  const [d, unit] = v < 1e6 ? [1e3, 'K'] : [1e6, 'M'];
  return `${(v / d).toLocaleString(intlLocale(), { maximumFractionDigits: v / d < 100 ? 1 : 0 })}${unit}`;
}

// Tải + nghe SSE 'usage'; chạm giới hạn → toast một lần cho mỗi giờ mở lại.
export function useUsage() {
  const [data, setData] = useState(null); // {limits, checking, tokens, via, nextCheckAt}
  const [error, setError] = useState(null);
  const [off, setOff] = useState(false); // server không bật
  const [, setTick] = useState(0);
  const warned = useRef(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setData(await api.claudeUsage());
      setError(null);
    } catch (e) {
      if (e.status === 503) setOff(true);
      else setError(e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useSSE((msg) => {
    if (msg.type === 'usage') setData(msg.data);
    else if (msg.type === 'reconnect') load();
  });

  const limits = data?.limits;
  useEffect(() => {
    if (usageLevel(limits) !== 'bad') return;
    const key = limits.resetsAt ?? limits.at;
    if (warned.current === key) return;
    warned.current = key;
    const at = resetLabel(limits.resetsAt);
    toast(at ? tr('Đã chạm giới hạn gói Claude — mở lại lúc {at}.', { at }) : tr('Đã chạm giới hạn gói Claude.'), 'err', 8000);
  }, [limits, toast]);

  // Khóa nút tới mốc server cho phép (10 s sau lần hỏi API, 1 phút sau lần hỏi claude); tới mốc thì vẽ lại.
  const next = data?.nextCheckAt;
  const cool = !!next && next > Date.now();
  useEffect(() => {
    if (!next) return undefined;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(next - Date.now(), 0) + 50);
    return () => clearTimeout(t);
  }, [next]);

  // auto: lúc mở bảng — server chỉ hỏi API (không tốn token), lỗi thì im lặng.
  const check = async ({ auto = false } = {}) => {
    if (!auto) setData((cur) => (cur ? { ...cur, checking: true } : cur));
    try {
      const { apiError, ...s } = await api.claudeUsageCheck(auto ? { auto: true } : {});
      setData(s);
      setError(null);
      if (apiError) toast(tr('{e} — đã hỏi Claude thay (tốn vài nghìn token).', { e: apiError }), 'info', 6000);
    } catch (e) {
      if (e.status === 503) setOff(true);
      else if (!auto) toast(e.message, 'err');
      load();
    }
  };
  return { data, error, off, cool, load, check };
}

// Nút nhỏ ở đầu trang: "5h 54%"; bấm mở bảng Tài khoản. Màn hẹp chỉ hiện số %.
export function UsageMeter({ usage, onClick }) {
  const t = useT();
  if (usage.off) return null;
  const { data } = usage;
  const limits = data?.limits;
  const five = limits?.windows?.five_hour;
  const week = limits?.windows?.seven_day;
  const level = usageLevel(limits);
  const title = limits
    ? t('Mức dùng gói Claude — 5 giờ: {a} · tuần: {b}', { a: five ? `${pct(five.utilization)}%` : '—', b: week ? `${pct(week.utilization)}%` : '—' })
    : t('Mức dùng gói Claude — chưa có số liệu');
  return (
    <button type="button" className={`use-btn${level ? ` ${level}` : ''}`} onClick={onClick} title={title} aria-label={title}>
      <span className="hide-s use-k">5h</span>
      <span className="use-v" aria-busy={!data || undefined}>
        {!data ? <Sk w="2.5em" /> : five ? `${pct(five.utilization)}%` : '—'}
      </span>
    </button>
  );
}

// Một dòng: nhãn bên trái, "69% · mở lại sau 3 giờ" bên phải, thanh % bên dưới.
function Bar({ label, w }) {
  const t = useT();
  const u = w?.utilization;
  const level = u == null ? null : u >= 1 ? 'bad' : u >= WARN_AT ? 'warn' : null;
  const left = w?.resetsAt ? w.resetsAt * 1000 - Date.now() : null;
  return (
    <div className={`use-row${level ? ` ${level}` : ''}`}>
      <div className="use-row-h">
        <span>{label}</span>
        <span className="use-row-v" title={w?.resetsAt ? t('Mở lại {at}', { at: resetLabel(w.resetsAt) }) : undefined}>
          <b>{u == null ? '—' : `${pct(u)}%`}</b>
          {left != null && left > 0 ? ` · ${t('mở lại sau {s}', { s: spanLabel(left) })}` : ''}
        </span>
      </div>
      <div className="use-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={u == null ? undefined : pct(u)}>
        <i style={{ width: `${Math.min(pct(u), 100)}%` }} />
      </div>
    </div>
  );
}

// Mục "Mức dùng" trong bảng Tài khoản Claude.
export function UsagePanel({ usage }) {
  const t = useT();
  const { data, error } = usage;
  useEffect(() => {
    usage.check({ auto: true }); // lấy % mới (không tốn token) + token bước video vừa ghi
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (usage.off) return null;
  const limits = data?.limits;
  const tokens = data?.tokens;
  const checking = !!data?.checking;
  const status = limits?.status === 'rejected' ? t('Đang bị giới hạn') : null;
  return (
    <section className="use-box" aria-label={t('Mức dùng')}>
      <div className="use-head">
        <span>{t('Giới hạn gói Claude')}</span>
        {status ? <span className="use-flag">{status}</span> : null}
      </div>
      {!data ? (
        error ? (
          <p className="note">{error.message}</p>
        ) : (
          <SkZone className="use-sk">
            <Sk block h="34px" />
            <Sk block h="34px" />
          </SkZone>
        )
      ) : (
        <>
          {limits && Object.keys(limits.windows || {}).length ? (
            <div className="use-bars">
              {WINDOWS.map((w) => (
                <Bar key={w.key} label={t(w.label)} w={limits.windows[w.key]} />
              ))}
            </div>
          ) : (
            <p className="note">{t('Chưa có số liệu — chạy một bước hoặc bấm Kiểm tra ngay.')}</p>
          )}
          <div className="use-foot">
            <button type="button" className="use-refresh" onClick={() => usage.check()} disabled={checking || usage.cool} title={usage.cool && !checking ? t('Vừa kiểm tra — thử lại sau ít giây') : t('Lấy số mới như /usage (không tốn token)')}>
              {checking ? <span className="spinner" aria-hidden="true" /> : null}
              {t('Kiểm tra ngay')}
            </button>
            <span className="use-at" title={t('% tính cho cả tài khoản Claude')}>
              {checking ? t('Đang kiểm tra…') : limits?.at ? t('Cập nhật {s} trước', { s: spanLabel(Date.now() - Date.parse(limits.at)) }) : t('Chưa cập nhật')}
            </span>
          </div>
          {tokens ? (
            <table className="use-tbl">
              <caption className="sr-only">{t('Token app đã dùng')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Token của app')}</th>
                  <th scope="col">{t('Hôm nay')}</th>
                  <th scope="col">{t('7 ngày')}</th>
                </tr>
              </thead>
              <tbody>
                {SOURCES.filter((s) => s.key !== 'check' || tokens.today?.check?.total || tokens.week?.check?.total).map((s) => ( // Kiểm tra chỉ hiện khi từng tốn token (dự phòng claude -p)
                  <tr key={s.key}>
                    <th scope="row">{t(s.label)}</th>
                    <td>{fmtTokens(tokens.today?.[s.key]?.total)}</td>
                    <td>{fmtTokens(tokens.week?.[s.key]?.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}
    </section>
  );
}
