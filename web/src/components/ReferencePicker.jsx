// Chọn 1 video đã đăng của kênh YouTube đã kết nối làm tài liệu tham khảo cho dự án mới (thay cho việc nạp skill).
// value = {channelId, videoId} | null.
import { useEffect, useMemo, useState } from 'react';
import Select from './Select.jsx';
import { Sk, SkZone } from './Skeleton.jsx';
import { api } from '../api.js';
import { fmtDate, fmtNum } from '../lib/format.js';
import { useT } from '../lib/i18n.jsx';

const dur = (s) => {
  const n = Math.round(Number(s));
  if (!Number.isFinite(n) || n < 0) return '—';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const x = String(n % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

export default function ReferencePicker({ channels = [], defaultChannelId = '', value, onChange, disabled = false }) {
  const t = useT();
  const [live, setLive] = useState(null); // id các kênh đã kết nối YouTube
  const [chId, setChId] = useState('');
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('views');

  useEffect(() => {
    let off = false;
    api.youtube().then((r) => !off && setLive((r?.channels || []).filter((c) => c.status === 'ok').map((c) => c.id))).catch(() => !off && setLive([]));
    return () => { off = true; };
  }, []);

  const chans = useMemo(() => (live ? channels.filter((c) => live.includes(c.id)) : []), [live, channels]);
  useEffect(() => {
    if (!chans.length || chans.some((c) => c.id === chId)) return;
    setChId(chans.some((c) => c.id === defaultChannelId) ? defaultChannelId : chans[0].id);
  }, [chans, chId, defaultChannelId]);

  useEffect(() => {
    if (!chId) return undefined;
    let off = false;
    setList(null);
    setErr(null);
    api.ytVideos(chId).then((r) => !off && setList(r?.videos || [])).catch((e) => !off && setErr(e));
    return () => { off = true; };
  }, [chId]);

  if (!live) return <SkZone label={t('Đang tải')}><Sk w="60%" /></SkZone>;
  if (!chans.length) return <span className="hint">{t('Chưa có kênh nào kết nối YouTube — kết nối ở trang Kênh để chọn video tham khảo.')}</span>;

  const ql = q.trim().toLowerCase();
  const rows = (list || [])
    .filter((v) => !ql || String(v.title).toLowerCase().includes(ql))
    .sort((a, b) => (sort === 'views' ? (b.views ?? -1) - (a.views ?? -1) : String(b.publishedAt).localeCompare(String(a.publishedAt))))
    .slice(0, 50);
  const picked = value && value.channelId === chId ? value.videoId : null;

  return (
    <div className="ref-pick">
      <div className="ref-bar">
        <Select value={chId} options={chans.map((c) => ({ value: c.id, label: c.name || c.id }))} onChange={setChId} disabled={disabled} label={t('Kênh')} />
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Lọc theo tên video')} aria-label={t('Lọc theo tên video')} disabled={disabled} />
        <Select
          value={sort}
          options={[{ value: 'views', label: t('Nhiều lượt xem nhất') }, { value: 'new', label: t('Mới nhất') }]}
          onChange={setSort}
          disabled={disabled}
          label={t('Sắp xếp')}
        />
      </div>
      {err ? (
        <div className="err-note" role="alert">{err.message}</div>
      ) : !list ? (
        <SkZone label={t('Đang tải video')}><Sk block h="52px" /><Sk block h="52px" /></SkZone>
      ) : !rows.length ? (
        <span className="hint">{list.length ? t('Không có video khớp.') : t('Kênh chưa có video.')}</span>
      ) : (
        <div className="ref-list" role="radiogroup" aria-label={t('Video tham khảo')}>
          {rows.map((v) => (
            <label key={v.id} className={`ref-it${picked === v.id ? ' on' : ''}`}>
              <input
                type="radio"
                name="ref-video"
                checked={picked === v.id}
                disabled={disabled}
                onClick={() => picked === v.id && onChange(null)}
                onChange={() => onChange({ channelId: chId, videoId: v.id })}
              />
              {v.thumb ? <img src={v.thumb} alt="" loading="lazy" /> : <span className="ref-th" />}
              <span className="ref-tx">
                <b>{v.title}</b>
                <span className="hint">{t('{v} lượt xem · {d} · {date}', { v: fmtNum(v.views), d: dur(v.duration), date: fmtDate(v.publishedAt) })}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <span className="hint">{t('AI chỉ biết tiêu đề, mô tả và số liệu của video (không có kịch bản hay hình ảnh), nên sẽ suy ra cấu trúc và nhịp từ đó. Bấm lại video đã chọn để bỏ.')}</span>
    </div>
  );
}
