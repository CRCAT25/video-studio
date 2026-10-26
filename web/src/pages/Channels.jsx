// Trang Kênh: danh sách kênh YouTube (thông tin chung) + thêm kênh bằng đăng nhập Google (chọn hồ sơ Chrome).
// Trang chi tiết kênh (#/channels/:id): số liệu 28 ngày, biểu đồ, bảng video, kết nối lại / xóa kênh.
// Token Google nằm ở server (Keychain); trang chỉ thấy trạng thái và số liệu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../components/Modal.jsx';
import YtChart from '../components/YtChart.jsx';
import Select, { DEFAULT_BROWSER, profileOptions, saveProfile, savedProfile } from '../components/Select.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { navigate } from '../lib/router.js';
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
// Mốc màu theo % đã dùng: ≤25 xanh lá, >25 xanh dương, >50 cam, >75 đỏ.
const quotaLevel = (pct) => (pct > 75 ? 'err' : pct > 50 ? 'wait' : pct > 25 ? 'run' : 'ok');

// Thanh hạn mức YouTube hôm nay.
function QuotaBar({ used, limit }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className={`quota-bar q-${quotaLevel(pct)}`} role="progressbar" aria-label="Hạn mức YouTube hôm nay" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

const PRIVACY = { public: 'Công khai', unlisted: 'Không công khai', private: 'Riêng tư' };
const METRICS = [
  { id: 'views', label: 'Lượt xem', fmt: fmtNum },
  { id: 'minutes', label: 'Phút xem', fmt: fmtNum },
  { id: 'subsGained', label: 'Người đăng ký mới', fmt: fmtNum },
];
const COLS = [
  { id: 'title', label: 'Video' },
  { id: 'privacy', label: 'Chế độ hiển thị', sort: false, cls: 'hide-sm' },
  { id: 'publishedAt', label: 'Ngày', cls: 'hide-sm' },
  { id: 'views', label: 'Lượt xem', num: true },
  { id: 'likes', label: 'Thích', num: true, cls: 'hide-sm' },
  { id: 'comments', label: 'Bình luận', num: true, cls: 'hide-sm' },
  { id: 'avgViewDuration', label: 'Xem TB', num: true, cls: 'hide-sm', hint: 'trọn đời' },
  { id: 'subsGained', label: 'Đăng ký', num: true, cls: 'hide-sm', hint: 'trọn đời' },
];
// Shorts: API không có cờ riêng, YouTube cho Shorts dài tối đa 3 phút → coi video ≤ 180 giây là Shorts.
const SHORT_MAX = 180;
const isShort = (v) => v.duration != null && v.duration <= SHORT_MAX;
const TABS = [
  { id: 'video', label: 'Video', test: (v) => !isShort(v) },
  { id: 'short', label: 'Shorts', test: isShort },
];
const PAGE_SIZES = [10, 30, 50];

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
            <span className="info-tip" tabIndex={0} role="button" aria-describedby="quota-tip">
              ⓘ
              <span className="info-pop" role="tooltip" id="quota-tip">
                {QUOTA_TIP}
              </span>
            </span>
          </p>
          <QuotaBar used={q.used} limit={q.limit} />
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
        <ChannelList channels={yt.channels} />
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

const chHref = (id) => `#/channels/${encodeURIComponent(id)}`;

// Trạng thái kênh → đèn + chữ.
function chState(c) {
  if (c.pending) return { lamp: 'idle blink', text: 'Đang chờ cho phép trên Google' };
  if (c.status === 'reauth') return { lamp: 'err', text: 'Cần kết nối lại' };
  return { lamp: 'ok', text: 'Đã kết nối' };
}

// Bảng danh sách kênh: tên, trạng thái, số chung; cuối hàng có nút vào chi tiết.
function ChannelList({ channels }) {
  return (
    <div className="tbl-wrap yt-chlist">
      <table className="yt-tbl">
        <thead>
          <tr>
            <th>Kênh</th>
            <th className="num">Người đăng ký</th>
            <th className="num hide-sm">Video</th>
            <th className="num hide-sm">Lượt xem · 28 ngày</th>
            <th>
              <span className="sr-only">Thao tác</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => (
            <ChannelRow key={c.id} c={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Một hàng kênh; số liệu lấy từ cache server (không gọi lại Google nếu còn mới).
function ChannelRow({ c }) {
  const [s, setS] = useState(null);
  const ok = c.status !== 'reauth' && !c.pending;
  useEffect(() => {
    if (!ok) return undefined;
    let live = true;
    api
      .ytStats(c.id)
      .then((r) => live && setS(r))
      .catch(() => live && setS(false));
    return () => {
      live = false;
    };
  }, [c.id, c.connectedAt, ok]);
  const st = chState(c);
  const ch = s?.channel;
  const cell = (v) => (s == null ? <span className="muted">…</span> : s === false ? '—' : v);
  return (
    <tr>
      <td>
        <a className="yt-chname" href={chHref(c.id)}>
          {c.name}
        </a>
        <span className="muted small yt-chst">
          <i className={`lamp ${st.lamp}`} /> {st.text}
        </span>
      </td>
      <td className="num">{ok ? cell(ch?.subscribers == null ? 'Ẩn' : fmtNum(ch.subscribers)) : '—'}</td>
      <td className="num hide-sm">{ok ? cell(fmtNum(ch?.videos)) : '—'}</td>
      <td className="num hide-sm">{ok ? cell(fmtNum(s?.totals?.views)) : '—'}</td>
      <td className="yt-chact">
        <a className="btn sm" href={chHref(c.id)} aria-label={`Xem chi tiết ${c.name}`}>
          Chi tiết ›
        </a>
      </td>
    </tr>
  );
}

// Trang chi tiết một kênh.
export function ChannelDetail({ id, yt, error, onReload }) {
  const c = yt?.channels.find((x) => x.id === id);
  // Kênh vừa bị xóa (trạng thái mới không còn) → về danh sách.
  const seen = useRef(false);
  useEffect(() => {
    if (c) seen.current = true;
    else if (seen.current && yt) navigate('#/channels');
  }, [c, yt]);
  useEffect(() => {
    document.title = `${c?.name || 'Kênh'} · Video Studio`;
  }, [c?.name]);
  const crumb = (
    <nav className="crumb" aria-label="Đường dẫn">
      <a href="#/channels">Kênh</a>
      <span className="sep">›</span>
      {c?.name || id}
    </nav>
  );
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
  if (!c) {
    return (
      <>
        {crumb}
        <div className="card pad empty">
          <b>Không có kênh này.</b>
          <p className="note">
            <a href="#/channels">Về danh sách kênh</a>
          </p>
        </div>
      </>
    );
  }
  return (
    <>
      {crumb}
      <ChannelCard c={c} />
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
  const { lamp, text: stText } = chState(c);

  return (
    <section className="card yt-card" aria-label={`Kênh ${c.name}`}>
      <div className="yt-h">
        <div className="yt-id">
          <h1>{c.name}</h1>
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

// Biểu tượng chế độ hiển thị (quả địa cầu / mắt gạch / khóa).
function PrivacyIcon({ p }) {
  const d = {
    public: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13M8 1.5c1.8 1.8 2.6 4 2.6 6.5S9.8 12.7 8 14.5M8 1.5C6.2 3.3 5.4 5.5 5.4 8s.8 4.7 2.6 6.5',
    unlisted: 'M6.5 9.5l3-3M5 7.5 3.5 9a2.1 2.1 0 0 0 3 3L8 10.5M8 5.5 9.5 4a2.1 2.1 0 0 1 3 3L11 8.5',
    private: 'M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3z',
  }[p];
  if (!d) return null;
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// Bảng video kiểu YouTube Studio: tab Video/Shorts, ảnh thu nhỏ + mô tả, sắp xếp theo cột, phân trang.
function VideoTable({ videos, truncated }) {
  const all = videos || [];
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, all.filter(t.test).length])), [all]);
  const [tab, setTab] = useState(() => (counts.video || !counts.short ? 'video' : 'short'));
  const [sort, setSort] = useState({ id: 'publishedAt', dir: -1 });
  const [size, setSize] = useState(30);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const k = sort.id;
    const t = TABS.find((x) => x.id === tab);
    return all.filter(t.test).sort((a, b) => {
      const x = a[k];
      const y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y, 'vi') : x - y) * sort.dir;
    });
  }, [all, tab, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const pg = Math.min(page, pages - 1);
  const shown = rows.slice(pg * size, pg * size + size);
  const by = (id) => {
    setSort((s) => (s.id === id ? { id, dir: -s.dir } : { id, dir: id === 'title' ? 1 : -1 }));
    setPage(0);
  };
  const pick = (id) => {
    setTab(id);
    setPage(0);
  };

  if (!all.length) return <p className="note">Kênh chưa có video.</p>;
  return (
    <div className="yt-videos">
      <div className="yt-vtabs" role="tablist" aria-label="Loại nội dung">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`yt-vtab${tab === t.id ? ' on' : ''}`} onClick={() => pick(t.id)}>
            {t.label} <span className="muted">{fmtNum(counts[t.id])}</span>
          </button>
        ))}
      </div>
      {!rows.length ? (
        <p className="note">Chưa có {tab === 'short' ? 'Shorts' : 'video'} nào.</p>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="yt-tbl">
              <thead>
                <tr>
                  {COLS.map((col) => (
                    <th
                      key={col.id}
                      className={[col.num ? 'num' : '', col.cls || ''].join(' ').trim() || undefined}
                      aria-sort={col.sort === false ? undefined : sort.id === col.id ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}
                    >
                      {col.sort === false ? (
                        col.label
                      ) : (
                        <button type="button" className="th-btn" onClick={() => by(col.id)} title={col.hint ? `${col.label} (${col.hint})` : undefined}>
                          {col.label}
                          <span className="th-ar" aria-hidden="true">
                            {sort.id === col.id ? (sort.dir > 0 ? '↑' : '↓') : ''}
                          </span>
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => {
                  const href = `https://www.youtube.com/${isShort(v) ? 'shorts/' : 'watch?v='}${encodeURIComponent(v.id)}`;
                  return (
                    <tr key={v.id}>
                      <td className="yt-title">
                        <div className="yt-vid">
                          <a className="yt-thumb" href={href} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true">
                            {v.thumb ? <img src={v.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
                            <span className="yt-dur">{fmtSecs(v.duration)}</span>
                          </a>
                          <div className="yt-vtext">
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {v.title}
                            </a>
                            {v.description ? <p className="yt-desc">{v.description}</p> : null}
                            <span className="yt-mdate muted small">{fmtDate(v.publishedAt)}</span>
                          </div>
                        </div>
                      </td>
                      <td className="hide-sm">
                        <span className="yt-priv">
                          <PrivacyIcon p={v.privacy} />
                          {PRIVACY[v.privacy] || v.privacy || '—'}
                        </span>
                      </td>
                      <td className="nowrap hide-sm">{fmtDate(v.publishedAt)}</td>
                      <td className="num">{fmtNum(v.views)}</td>
                      <td className="num hide-sm">{fmtNum(v.likes)}</td>
                      <td className="num hide-sm">{fmtNum(v.comments)}</td>
                      <td className="num hide-sm">{fmtSecs(v.avgViewDuration)}</td>
                      <td className="num hide-sm">{v.subsGained == null ? '—' : fmtNum(v.subsGained)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="yt-pager">
            {truncated ? <span className="muted small yt-trunc">{fmtNum(all.length)} video mới nhất</span> : null}
            <label className="small muted yt-psize">
              Số hàng mỗi trang
              <select
                value={size}
                onChange={(e) => {
                  setSize(Number(e.target.value));
                  setPage(0);
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span className="small muted" aria-live="polite">
              {pg * size + 1}–{pg * size + shown.length}/{rows.length}
            </span>
            <span className="yt-pbtns">
              {[
                ['Trang đầu', '|‹', 0, pg === 0],
                ['Trang trước', '‹', pg - 1, pg === 0],
                ['Trang sau', '›', pg + 1, pg >= pages - 1],
                ['Trang cuối', '›|', pages - 1, pg >= pages - 1],
              ].map(([label, ch, to, off]) => (
                <button key={label} type="button" className="btn sm ghost" aria-label={label} title={label} disabled={off} onClick={() => setPage(to)}>
                  {ch}
                </button>
              ))}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
