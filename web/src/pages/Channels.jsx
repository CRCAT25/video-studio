// Trang Kênh: thêm kênh YouTube bằng đăng nhập Google (chọn hồ sơ Chrome); mỗi kênh một thẻ — số liệu 28 ngày, bảng video.
// Token Google nằm ở server (Keychain); trang chỉ thấy trạng thái và số liệu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../components/Modal.jsx';
import YtChart from '../components/YtChart.jsx';
import Select, { DEFAULT_BROWSER, profileOptions, saveProfile, savedProfile } from '../components/Select.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { fmtDate, fmtNum, fmtRelative, two } from '../lib/format.js';

// Giây → "11:30" / "1:02:03".
export function fmtSecs(s) {
  if (s == null || Number.isNaN(Number(s))) return '—';
  const v = Math.round(Number(s));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = v % 60;
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

// Phút xem → giờ, 1 chữ số lẻ.
const fmtHours = (min) => (min == null ? '—' : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(Number(min) / 60));
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtNum(Math.abs(n))}`);
const dm = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '—');

const QUOTA_TIP = 'Google tính điểm theo mỗi lệnh gọi, đặt lại lúc 14–15h giờ Việt Nam';
const PRIVACY = { public: 'Công khai', unlisted: 'Không công khai', private: 'Riêng tư' };
const METRICS = [
  { id: 'views', label: 'Lượt xem', fmt: fmtNum },
  { id: 'minutes', label: 'Phút xem', fmt: fmtNum },
  { id: 'subsGained', label: 'Người đăng ký mới', fmt: fmtNum },
];
const COLS = [
  { id: 'title', label: 'Video', num: false },
  { id: 'publishedAt', label: 'Ngày đăng', num: false },
  { id: 'duration', label: 'Dài', num: true },
  { id: 'views', label: 'Lượt xem', num: true },
  { id: 'likes', label: 'Thích', num: true },
  { id: 'comments', label: 'Bình luận', num: true },
  { id: 'avgViewDuration', label: 'Xem TB', num: true, hint: '28 ngày' },
  { id: 'subsGained', label: 'Đăng ký', num: true, hint: '28 ngày' },
];

// Đầu trang + thẻ từng kênh. yt = trạng thái /api/youtube (App tải lại khi có SSE 'youtube').
export default function Channels({ yt, error, onReload }) {
  const toast = useToast();
  const prev = useRef(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState(null);
  const [busy, setBusy] = useState(false);

  // Báo khi vừa thêm / kết nối lại kênh hoặc vừa lỗi (so với lần tải trước).
  useEffect(() => {
    if (!yt) return;
    const before = prev.current;
    prev.current = { map: new Map(yt.channels.map((c) => [c.id, c])), addError: yt.addError };
    if (!before) return;
    for (const c of yt.channels) {
      const b = before.map.get(c.id);
      if (!b) toast(`Đã thêm kênh ${c.name}.`, 'ok');
      else if (b.status === 'reauth' && c.status === 'ok') toast(`Đã kết nối lại ${c.name}.`, 'ok');
      else if (c.lastError && c.lastError.at !== b.lastError?.at) toast(c.lastError.message, 'err');
    }
    if (yt.addError && yt.addError.at !== before.addError?.at) toast(yt.addError.message, 'err');
  }, [yt, toast]);

  useEffect(() => {
    if (!yt?.adding) setAddUrl(null);
  }, [yt?.adding]);

  const cancelAdd = async () => {
    setBusy(true);
    try {
      await api.ytAddCancel();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (error && !yt) {
    return (
      <div className="card pad empty">
        <b>Không tải được trạng thái YouTube.</b>
        <p className="note">{error.message}</p>
        <button type="button" className="btn" onClick={onReload}>
          Thử lại
        </button>
      </div>
    );
  }
  if (!yt) {
    return (
      <div className="card pad empty">
        <span className="spinner" aria-hidden="true" /> Đang tải…
      </div>
    );
  }

  const q = yt.quota;
  return (
    <>
      <div className="page-h">
        <div>
          <h1>Kênh YouTube</h1>
          <p className="muted small">
            Hạn mức YouTube hôm nay: <b>{fmtNum(q.used)}</b> / {fmtNum(q.limit)} điểm{' '}
            <span className="info-tip" tabIndex={0} title={QUOTA_TIP} aria-label={QUOTA_TIP}>
              ⓘ
            </span>
          </p>
        </div>
        <div className="acts">
          <a className="btn" href="#/channels/setup">
            Thiết lập Google
          </a>
          {yt.configured ? (
            <button type="button" className="btn primary" onClick={() => setAddOpen(true)} disabled={yt.adding}>
              + Thêm kênh
            </button>
          ) : null}
        </div>
      </div>

      {!yt.configured ? (
        <div className="card pad empty" style={{ marginBottom: 12 }}>
          <b>Chưa kết nối Google Cloud.</b>
          <p className="note">Làm 1 lần, khoảng 3 phút — app tự tạo dự án Google Cloud cho bạn.</p>
          <a className="btn primary" href="#/channels/setup">
            Bắt đầu
          </a>
        </div>
      ) : null}

      {yt.adding ? (
        <div className="card pad yt-wait" role="status" style={{ marginBottom: 12 }}>
          <span className="spinner" aria-hidden="true" />
          <p className="note">
            Chọn kênh muốn thêm ở trang Google rồi bấm Cho phép. Thấy cảnh báo "chưa xác minh" → <b>Nâng cao</b> → <b>Đi tới… (không an toàn)</b>.
          </p>
          <div className="acts">
            {addUrl ? (
              <a className="btn sm" href={addUrl} target="_blank" rel="noopener noreferrer">
                Mở lại trang Google
              </a>
            ) : null}
            <button type="button" className="btn sm" onClick={cancelAdd} disabled={busy}>
              Hủy
            </button>
          </div>
        </div>
      ) : null}

      {!yt.channels.length ? (
        yt.configured && !yt.adding ? (
          <div className="card pad empty">
            <b>Chưa có kênh nào.</b>
            <p className="note">Đăng nhập tài khoản Google sở hữu kênh để thêm.</p>
            <button type="button" className="btn primary" onClick={() => setAddOpen(true)}>
              + Thêm kênh
            </button>
          </div>
        ) : null
      ) : (
        <div className="yt-list">
          {yt.channels.map((c) => (
            <ChannelCard key={c.id} c={c} />
          ))}
        </div>
      )}

      {addOpen ? (
        <ConnectModal
          title="Thêm kênh YouTube"
          start={(profileDir) => api.ytAdd({ profileDir })}
          onClose={() => setAddOpen(false)}
          onStarted={(url) => {
            setAddUrl(url);
            setAddOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

// Thẻ một kênh đã thêm: trạng thái + nút (kết nối lại khi Google bắt đăng nhập lại, xóa kênh) + số liệu.
function ChannelCard({ c }) {
  const toast = useToast();
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [authUrl, setAuthUrl] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!c.pending) setAuthUrl(null);
  }, [c.pending]);

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => act(() => api.ytConnectCancel(c.id));
  const disconnect = () =>
    act(async () => {
      const r = await api.ytDisconnect(c.id);
      setConfirmOff(false);
      toast(r.revoked ? `Đã xóa kênh ${c.name}.` : 'Đã xóa kênh trên máy; Google không xác nhận thu hồi — gỡ thêm ở myaccount.google.com/permissions.', r.revoked ? 'ok' : 'info');
    });

  const reauth = c.status === 'reauth';
  const lamp = c.pending ? 'idle blink' : reauth ? 'err' : 'ok';
  const stText = c.pending ? 'Đang chờ cho phép trên Google' : reauth ? 'Cần kết nối lại' : 'Đã kết nối';

  return (
    <section className="card yt-card" aria-label={`Kênh ${c.name}`}>
      <div className="yt-h">
        <div className="yt-id">
          <h2>{c.name}</h2>
          <span className="muted small">
            <i className={`lamp ${lamp}`} /> {stText}
          </span>
        </div>
        <div className="acts">
          {c.pending ? (
            <button type="button" className="btn sm" onClick={cancel} disabled={busy}>
              Hủy
            </button>
          ) : reauth ? (
            <button type="button" className="btn sm primary" onClick={() => setConnectOpen(true)} disabled={busy}>
              Kết nối lại
            </button>
          ) : null}
          <button type="button" className="btn sm" onClick={() => setConfirmOff(true)} disabled={busy}>
            Xóa kênh
          </button>
        </div>
      </div>

      {c.pending ? (
        <div className="yt-wait" role="status">
          <span className="spinner" aria-hidden="true" />
          <p className="note">
            Chọn đúng kênh {c.name} ở trang Google rồi bấm Cho phép. Thấy cảnh báo "chưa xác minh" → <b>Nâng cao</b> → <b>Đi tới… (không an toàn)</b>.
            {authUrl ? (
              <>
                {' '}
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  Mở trang Google
                </a>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {!c.pending && c.lastError ? <p className="err-note">{c.lastError.message}</p> : null}

      <ChannelStats key={`${c.id}:${c.connectedAt}`} c={c} />

      {connectOpen ? (
        <ConnectModal
          title={`Kết nối lại ${c.name}`}
          start={(profileDir) => api.ytConnect(c.id, { profileDir })}
          onClose={() => setConnectOpen(false)}
          onStarted={(url) => {
            setAuthUrl(url);
            setConnectOpen(false);
          }}
        />
      ) : null}
      {confirmOff ? (
        <Modal title={`Xóa kênh ${c.name} khỏi app?`} onClose={() => setConfirmOff(false)} busy={busy}>
          <p className="note">App thu hồi quyền ở Google và xóa token khỏi máy. Kênh và video trên YouTube không bị ảnh hưởng.</p>
          <div className="modal-acts">
            <button type="button" className="btn" onClick={() => setConfirmOff(false)} disabled={busy} data-autofocus>
              Không
            </button>
            <button type="button" className="btn danger" onClick={disconnect} disabled={busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null} Xóa kênh
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

// Hộp chọn hồ sơ Chrome để mở trang đăng nhập Google; start(profileDir) gọi API thêm / kết nối lại.
function ConnectModal({ title, start: begin, onClose, onStarted }) {
  const toast = useToast();
  const [chrome, setChrome] = useState(null);
  const [profile, setProfile] = useState(() => savedProfile());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .chromeProfiles()
      .then(setChrome)
      .catch(() => setChrome({ supported: false, profiles: [] }));
  }, []);

  const profiles = chrome?.profiles || [];
  const picked = profile === DEFAULT_BROWSER || profiles.some((p) => p.dir === profile) ? profile : profiles[0]?.dir ?? DEFAULT_BROWSER;

  const start = async () => {
    setBusy(true);
    try {
      saveProfile(picked);
      const r = await begin(picked === DEFAULT_BROWSER ? null : picked);
      if (!r.opened) window.open(r.authUrl, '_blank', 'noopener');
      onStarted(r.authUrl);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} busy={busy} lead="App chỉ xin quyền xem số liệu kênh. Mật khẩu Google không đi qua app.">
      <label className="fld">
        <span>Mở trang Google trong</span>
        <Select value={picked} options={profileOptions(profiles, DEFAULT_BROWSER, chrome?.defaultBrowser)} onChange={setProfile} disabled={busy || !chrome} />
        <span className="hint">Chọn hồ sơ đang đăng nhập tài khoản Google sở hữu kênh.</span>
      </label>
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Đóng
        </button>
        <button type="button" className="btn primary" onClick={start} disabled={busy || !chrome}>
          {busy ? <span className="spinner" aria-hidden="true" /> : '→'} Mở trang Google
        </button>
      </div>
    </Modal>
  );
}

// Số liệu kênh đã kết nối: ô số, biểu đồ 28 ngày, bảng video. Tự tải khi hiện; "Làm mới" gọi lại Google.
function ChannelStats({ c }) {
  const [stats, setStats] = useState(null);
  const [videos, setVideos] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState('views');

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const [s, v] = await Promise.all([api.ytStats(c.id, refresh), api.ytVideos(c.id, refresh)]);
        setStats(s);
        setVideos(v);
        setErr(null);
      } catch (e) {
        setErr(e);
      } finally {
        setLoading(false);
      }
    },
    [c.id],
  );
  useEffect(() => {
    load(false);
  }, [load]);

  const m = METRICS.find((x) => x.id === metric);
  const t = stats?.totals;
  const ch = stats?.channel;

  return (
    <div className="yt-body">
      {err ? <p className="err-note">{err.message}</p> : null}
      {!stats && !err ? (
        <p className="note">
          <span className="spinner" aria-hidden="true" /> Đang tải số liệu…
        </p>
      ) : null}
      {stats ? (
        <>
          <div className="yt-tiles">
            <Tile label="Người đăng ký" value={ch?.subscribers == null ? 'Ẩn' : fmtNum(ch.subscribers)} sub={`${fmtNum(ch?.videos)} video`} />
            <Tile label="Lượt xem · 28 ngày" value={fmtNum(t.views)} sub={`Tổng kênh ${fmtNum(ch?.views)}`} />
            <Tile label="Giờ xem · 28 ngày" value={fmtHours(t.minutes)} sub={`Xem TB ${fmtSecs(t.avgViewDuration)}`} />
            <Tile label="Đăng ký ròng · 28 ngày" value={signed(t.subsGained - t.subsLost)} sub={`+${fmtNum(t.subsGained)} / −${fmtNum(t.subsLost)}`} />
          </div>

          <div className="yt-chart-h">
            <h3>
              {m.label} theo ngày <span className="muted small">{dm(stats.period.start)} – {dm(stats.period.end)}</span>
            </h3>
            <div className="chips" role="radiogroup" aria-label="Số liệu biểu đồ">
              {METRICS.map((x) => (
                <button key={x.id} type="button" role="radio" aria-checked={metric === x.id} className={`chip${metric === x.id ? ' on' : ''}`} onClick={() => setMetric(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>
          <YtChart days={stats.days} field={m.id} label={m.label} fmt={m.fmt} />
        </>
      ) : null}

      {videos ? <VideoTable videos={videos.videos} truncated={videos.truncated} /> : null}

      <div className="yt-foot">
        <span className="muted small">
          {stats ? <>Cập nhật {fmtRelative(stats.fetchedAt)} · Analytics thường trễ 1–2 ngày</> : null}
        </span>
        <button type="button" className="btn sm" onClick={() => load(true)} disabled={loading} title="Lấy số liệu mới từ Google (tốn hạn mức API)">
          {loading ? <span className="spinner" aria-hidden="true" /> : '↻'} Làm mới
        </button>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className="yt-tile">
      <span className="yt-tile-l">{label}</span>
      <b className="yt-tile-v">{value}</b>
      {sub ? <span className="yt-tile-s">{sub}</span> : null}
    </div>
  );
}

// Bảng video có sắp xếp theo cột (bấm tiêu đề cột).
function VideoTable({ videos, truncated }) {
  const [sort, setSort] = useState({ id: 'publishedAt', dir: -1 });
  const rows = useMemo(() => {
    const k = sort.id;
    return [...(videos || [])].sort((a, b) => {
      const x = a[k];
      const y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y, 'vi') : x - y) * sort.dir;
    });
  }, [videos, sort]);
  const by = (id) => setSort((s) => (s.id === id ? { id, dir: -s.dir } : { id, dir: id === 'title' ? 1 : -1 }));

  if (!videos?.length) return <p className="note">Kênh chưa có video.</p>;
  return (
    <div className="yt-videos">
      <h3>
        Video <span className="muted small">{fmtNum(videos.length)}{truncated ? ' video mới nhất' : ''}</span>
      </h3>
      <div className="tbl-wrap">
        <table className="yt-tbl">
          <thead>
            <tr>
              {COLS.map((col) => (
                <th key={col.id} className={col.num ? 'num' : ''} aria-sort={sort.id === col.id ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="th-btn" onClick={() => by(col.id)} title={col.hint ? `${col.label} (${col.hint})` : undefined}>
                    {col.label}
                    <span className="th-ar" aria-hidden="true">
                      {sort.id === col.id ? (sort.dir > 0 ? '▲' : '▼') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <td className="yt-title">
                  <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`} target="_blank" rel="noopener noreferrer">
                    {v.title}
                  </a>
                  {v.privacy && v.privacy !== 'public' ? <span className="tag">{PRIVACY[v.privacy] || v.privacy}</span> : null}
                </td>
                <td className="nowrap">{fmtDate(v.publishedAt)}</td>
                <td className="num">{fmtSecs(v.duration)}</td>
                <td className="num">{fmtNum(v.views)}</td>
                <td className="num">{fmtNum(v.likes)}</td>
                <td className="num">{fmtNum(v.comments)}</td>
                <td className="num">{fmtSecs(v.avgViewDuration)}</td>
                <td className="num">{v.subsGained == null ? '—' : fmtNum(v.subsGained)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
