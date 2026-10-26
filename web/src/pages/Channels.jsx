// Trang Kênh: danh sách kênh YouTube (thông tin chung) + thêm kênh bằng đăng nhập Google (chọn hồ sơ Chrome).
// Trang chi tiết kênh (#/channels/:id): số liệu theo khoảng ngày, biểu đồ, bảng video, kết nối lại / xóa kênh.
// Token Google nằm ở server (Keychain); trang chỉ thấy trạng thái và số liệu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../components/Modal.jsx';
import { Sk, SkZone } from '../components/Skeleton.jsx';
import RangePicker, { rangeLabel, savedRange } from '../components/RangePicker.jsx';
import YtChart from '../components/YtChart.jsx';
import Select, { DEFAULT_BROWSER, profileOptions, saveProfile, savedProfile } from '../components/Select.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { navigate } from '../lib/router.js';
import { useNow } from '../hooks/useNow.js';
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

const AUTO_KEY = 'vs.yt.auto';
const AUTO_MS = 5 * 60_000;
const AUTO_OPTIONS = [
  { value: 'off', label: 'Tự làm mới: tắt' },
  { value: '5', label: 'Tự làm mới: 5 phút' },
];
const savedAuto = () => {
  try {
    return localStorage.getItem(AUTO_KEY) === '5' ? '5' : 'off';
  } catch {
    return 'off';
  }
};

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
  { id: 'avgViewDuration', label: 'Xem TB', num: true, cls: 'hide-sm', hint: 'trong khoảng ngày đã chọn; Analytics trễ 1–2 ngày so với Studio' },
  { id: 'subs', label: 'Đăng ký', num: true, cls: 'hide-sm', hint: 'ròng: mới − hủy, trong khoảng ngày đã chọn; Analytics trễ 1–2 ngày so với Studio' },
];
// Shorts: API không có cờ riêng, YouTube cho Shorts dài tối đa 3 phút → coi video ≤ 180 giây là Shorts.
const SHORT_MAX = 180;
const isShort = (v) => v.duration != null && v.duration <= SHORT_MAX;
const TABS = [
  { id: 'video', label: 'Video', test: (v) => !isShort(v) },
  { id: 'short', label: 'Shorts', test: isShort },
];
const PAGE_SIZES = [10, 30, 50];

// Gộp số liệu ngày cho biểu đồ: > 400 ngày → theo tháng, > 90 ngày → theo tuần (7 ngày tính từ ngày đầu), còn lại giữ ngày.
export function bucketDays(days, span) {
  const unit = span > 400 ? 'month' : span > 90 ? 'week' : 'day';
  if (unit === 'day') return { unit, rows: days };
  const rows = [];
  days.forEach((d, i) => {
    const k = unit === 'month' ? d.date.slice(0, 7) : Math.floor(i / 7);
    const last = rows[rows.length - 1];
    if (last && last.k === k) {
      last.end = d.date;
      for (const m of METRICS) last[m.id] += d[m.id] || 0;
    } else rows.push({ k, date: d.date, end: d.date, ...Object.fromEntries(METRICS.map((m) => [m.id, d[m.id] || 0])) });
  });
  return { unit, rows };
}
const UNIT = { day: 'ngày', week: 'tuần', month: 'tháng' };

// Đầu trang + thẻ từng kênh. yt = trạng thái /api/youtube (App tải lại khi có SSE 'youtube').
export default function Channels({ yt, error, onReload }) {
  const toast = useToast();
  const prev = useRef(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({});
  const [reloading, setReloading] = useState(false);
  const [range, setRange] = useState(savedRange);

  // Kênh lấy được số liệu (không cần kết nối lại / không đang chờ).
  const live = (yt?.channels || []).filter((c) => c.status !== 'reauth' && !c.pending);
  const liveKey = live.map((c) => `${c.id}:${c.connectedAt}`).join(',');

  // Tải số liệu mọi kênh; refresh = gọi lại Google (cả danh sách video) thay vì dùng cache.
  const loadStats = useCallback(
    async (refresh = false) => {
      const res = await Promise.allSettled(
        live.map((c) => Promise.all([api.ytStats(c.id, refresh, range), refresh ? api.ytVideos(c.id, true) : null])),
      );
      setStats(Object.fromEntries(live.map((c, i) => [c.id, res[i].status === 'fulfilled' ? res[i].value[0] : false])));
      return res.filter((r) => r.status === 'rejected').length;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveKey, range],
  );

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Mốc cập nhật cũ nhất trong các kênh = lần gần nhất mọi kênh đều có số mới.
  const now = useNow(30_000);
  const fetched = Object.values(stats)
    .map((x) => x?.fetchedAt)
    .filter(Boolean)
    .sort()[0];

  // Tự làm mới mỗi 5 phút khi bật: chỉ lúc đang mở tab này, không chồng lên lượt đang chạy, lỗi thì im lặng (còn nút bấm tay).
  const [auto, setAuto] = useState(savedAuto);
  const pickAuto = (v) => {
    setAuto(v);
    try {
      localStorage.setItem(AUTO_KEY, v);
    } catch {
      /* trình duyệt chặn lưu */
    }
  };
  const busyRef = useRef(false);
  const loadRef = useRef(loadStats);
  loadRef.current = loadStats;
  const hasLive = live.length > 0;
  useEffect(() => {
    if (auto !== '5' || !hasLive) return undefined;
    const t = setInterval(async () => {
      if (document.hidden || busyRef.current) return;
      busyRef.current = true;
      try {
        await loadRef.current(true);
      } finally {
        busyRef.current = false;
      }
    }, AUTO_MS);
    return () => clearInterval(t);
  }, [auto, hasLive]);

  const reloadAll = async () => {
    setReloading(true);
    busyRef.current = true;
    try {
      const failed = await loadStats(true);
      if (failed) toast(`${failed} kênh tải lỗi — thử lại sau.`, 'err');
      else toast('Đã tải lại tất cả kênh.', 'ok');
    } finally {
      busyRef.current = false;
      setReloading(false);
    }
  };

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
      <SkZone label="Đang tải kênh">
        <div className="page-h">
          <div>
            <h1>Kênh YouTube</h1>
            <p className="muted small">
              <Sk w="18em" />
            </p>
            <div className="quota-bar" />
          </div>
          <div className="acts">
            <Sk block w={140} h={34} />
            <Sk block w={120} h={34} />
          </div>
        </div>
        <div className="tbl-wrap yt-chlist">
          <table className="yt-tbl">
            <thead>
              <tr>
                <th>Kênh</th>
                <th className="num">Người đăng ký</th>
                <th className="num hide-sm">Video</th>
                <th className="num hide-sm">Lượt xem · {rangeLabel(range)}</th>
                <th>
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {['9em', '12em'].map((w) => (
                <tr key={w}>
                  <td>
                    <span className="yt-chname">
                      <Sk w={w} />
                    </span>
                    <span className="muted small yt-chst">
                      <Sk w="6em" />
                    </span>
                  </td>
                  <td className="num">
                    <Sk w="3em" />
                  </td>
                  <td className="num hide-sm">
                    <Sk w="2em" />
                  </td>
                  <td className="num hide-sm">
                    <Sk w="4em" />
                  </td>
                  <td>
                    <Sk block w={74} h={28} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SkZone>
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
          {fetched && !reloading ? (
            <span className="muted small" title={new Date(fetched).toLocaleString('vi-VN')}>
              Cập nhật {fmtRelative(fetched, now)}
            </span>
          ) : null}
          {live.length ? (
            <RangePicker
              value={range}
              onChange={(v) => {
                setStats({});
                setRange(v);
              }}
              disabled={reloading}
            />
          ) : null}
          {live.length ? (
            <button type="button" className="btn" onClick={reloadAll} disabled={reloading} title="Tải lại số liệu mới nhất từ YouTube cho tất cả kênh">
              {reloading ? <span className="spinner" aria-hidden="true" /> : '↻'} Làm mới tất cả
            </button>
          ) : null}
          {live.length ? (
            <div className="yt-range-sel">
              <Select label="Tự làm mới" value={auto} options={AUTO_OPTIONS} onChange={pickAuto} />
            </div>
          ) : null}
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
        <ChannelList range={range} channels={yt.channels} stats={stats} />
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
function ChannelList({ channels, stats, range }) {
  return (
    <div className="tbl-wrap yt-chlist">
      <table className="yt-tbl">
        <thead>
          <tr>
            <th>Kênh</th>
            <th className="num">Người đăng ký</th>
            <th className="num hide-sm">Video</th>
            <th className="num hide-sm">Lượt xem · {rangeLabel(range)}</th>
            <th>
              <span className="sr-only">Thao tác</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => (
            <ChannelRow key={c.id} c={c} s={stats[c.id]} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Một hàng kênh; s = số liệu (undefined: đang tải, false: lỗi) do trang danh sách tải.
function ChannelRow({ c, s }) {
  const ok = c.status !== 'reauth' && !c.pending;
  const st = chState(c);
  const ch = s?.channel;
  const cell = (v) => (s === undefined ? <Sk w="3em" /> : s === false ? '—' : v);
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
      <SkZone label="Đang tải kênh">
        {crumb}
        <section className="card yt-card">
          <div className="yt-h">
            <div className="yt-id">
              <h1>
                <Sk w="8em" />
              </h1>
              <span className="muted small">
                <Sk w="7em" />
              </span>
            </div>
            <div className="acts">
              <Sk block w={86} h={28} />
              <Sk block w={80} h={28} />
            </div>
          </div>
          <ChannelStatsSkeleton />
        </section>
      </SkZone>
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
  const [typed, setTyped] = useState('');
  const [authUrl, setAuthUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);

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

  // Phải gõ đúng y tên kênh (dấu, hoa/thường); chỉ chuẩn hóa NFC để bộ gõ tiếng Việt không làm lệch.
  const nameOk = typed.normalize('NFC') === String(c.name).normalize('NFC');
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
          <button type="button" className="btn sm" onClick={() => {
              setLoading(true);
              setTick((n) => n + 1);
            }} disabled={loading} title="Lấy số liệu mới từ Google (tốn hạn mức API)">
            {loading ? <span className="spinner" aria-hidden="true" /> : '↻'} Làm mới
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => {
              setTyped('');
              setConfirmOff(true);
            }}
            disabled={busy}
          >
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

      <ChannelStats key={`${c.id}:${c.connectedAt}`} c={c} tick={tick} onLoading={setLoading} />

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
          <form
            id="yt-del"
            className="yt-del"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk) disconnect();
            }}
          >
            <label className="fld">
              <span>
                Gõ "<b>{c.name}</b>" để xác nhận
              </span>
              <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} data-autofocus />
            </label>
          </form>
          <div className="modal-acts">
            <button type="button" className="btn" onClick={() => setConfirmOff(false)} disabled={busy}>
              Không
            </button>
            <button type="submit" form="yt-del" className="btn danger" disabled={busy || !nameOk}>
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

// Số liệu kênh đã kết nối theo khoảng ngày: ô số, biểu đồ, bảng video. Tự tải khi hiện / đổi khoảng; tick tăng (nút Làm mới ở đầu thẻ) → gọi lại Google.
function ChannelStats({ c, tick, onLoading }) {
  const [range, setRange] = useState(savedRange);
  const [stats, setStats] = useState(null);
  const [videos, setVideos] = useState(null);
  const [vstats, setVstats] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState('views');
  const seq = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const my = ++seq.current;
      setLoading(true);
      try {
        const [s, v, vs] = await Promise.all([api.ytStats(c.id, refresh, range), api.ytVideos(c.id, refresh), api.ytVideoStats(c.id, refresh, range)]);
        // Bỏ kết quả cũ khi đã đổi khoảng ngày giữa chừng.
        if (my !== seq.current) return;
        setStats({ ...s, range });
        setVideos(v);
        setVstats(vs);
        setErr(null);
      } catch (e) {
        if (my === seq.current) setErr(e);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [c.id, range],
  );
  useEffect(() => {
    load(false);
  }, [load]);
  // Chỉ chạy khi bấm Làm mới (không chạy lại khi đổi khoảng ngày).
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (tick) loadRef.current(true);
  }, [tick]);
  useEffect(() => {
    onLoading?.(loading);
  }, [loading, onLoading]);

  // Xem TB / Đăng ký trong bảng lấy theo khoảng ngày; video không có lượt xem trong khoảng → "—".
  const rows = useMemo(() => {
    if (!videos) return null;
    const by = vstats?.videos || {};
    return videos.videos.map((v) => ({ ...v, avgViewDuration: by[v.id]?.avgViewDuration ?? null, subs: by[v.id]?.subs ?? null }));
  }, [videos, vstats]);

  const m = METRICS.find((x) => x.id === metric);
  const t = stats?.totals;
  const ch = stats?.channel;
  const rl = stats ? rangeLabel(stats.range) : '';
  const chart = useMemo(() => (stats ? bucketDays(stats.days, stats.period.days) : null), [stats]);

  return (
    <div className="yt-body">
      <div className="yt-bar">
        <RangePicker value={range} onChange={setRange} disabled={loading && !stats} />
        {loading && stats ? <span className="spinner" aria-label="Đang tải" /> : null}
      </div>
      {err ? <p className="err-note">{err.message}</p> : null}
      {!stats && !err ? (
        <SkZone className="sk-col" label="Đang tải số liệu">
          <StatsBodySkeleton />
        </SkZone>
      ) : null}
      {stats ? (
        <>
          <div className="yt-tiles">
            <Tile label="Người đăng ký" value={ch?.subscribers == null ? 'Ẩn' : fmtNum(ch.subscribers)} sub={`${fmtNum(ch?.videos)} video`} />
            <Tile label={`Lượt xem · ${rl}`} value={fmtNum(t.views)} sub={`Tổng kênh ${fmtNum(ch?.views)}`} />
            <Tile label={`Giờ xem · ${rl}`} value={fmtHours(t.minutes)} sub={`Xem TB ${fmtSecs(t.avgViewDuration)}`} />
            <Tile label={`Đăng ký ròng · ${rl}`} value={signed(t.subsGained - t.subsLost)} sub={`+${fmtNum(t.subsGained)} / −${fmtNum(t.subsLost)}`} />
          </div>

          <div className="yt-chart-h">
            <h3>
              {m.label} theo {UNIT[chart.unit]} <span className="muted small">{dm(stats.period.start)} – {dm(stats.period.end)}</span>
            </h3>
            <div className="chips" role="radiogroup" aria-label="Số liệu biểu đồ">
              {METRICS.map((x) => (
                <button key={x.id} type="button" role="radio" aria-checked={metric === x.id} className={`chip${metric === x.id ? ' on' : ''}`} onClick={() => setMetric(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>
          <YtChart days={chart.rows} unit={chart.unit} field={m.id} label={m.label} fmt={m.fmt} />
        </>
      ) : null}

      {rows ? <VideoTable videos={rows} truncated={videos.truncated} /> : null}

      {stats ? (
        <div className="yt-foot">
          <span className="muted small">
            Cập nhật {fmtRelative(stats.fetchedAt)} · Analytics thường trễ 1–2 ngày
          </span>
        </div>
      ) : null}
    </div>
  );
}

// Khung chờ số liệu kênh: 4 ô số, tiêu đề biểu đồ + chip, biểu đồ, bảng video.
function StatsBodySkeleton() {
  return (
    <>
      <div className="yt-tiles">
        {['8em', '9em', '8em', '10em'].map((w, i) => (
          <div key={i} className="yt-tile">
            <span className="yt-tile-l">
              <Sk w={w} />
            </span>
            <b className="yt-tile-v">
              <Sk w="3em" />
            </b>
            <span className="yt-tile-s">
              <Sk w="6em" />
            </span>
          </div>
        ))}
      </div>
      <div className="yt-chart-h">
        <h3>
          <Sk w="14em" />
        </h3>
        <Sk block w={260} h={30} />
      </div>
      <Sk block h={180} />
      <Sk block h={220} />
    </>
  );
}

// Khung chờ phần số liệu khi chưa có dữ liệu kênh (thanh chọn khoảng ngày + StatsBodySkeleton).
function ChannelStatsSkeleton() {
  return (
    <div className="yt-body">
      <div className="yt-bar">
        <Sk block w={150} h={34} />
      </div>
      <StatsBodySkeleton />
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
                      <td className="num hide-sm">{v.subs == null ? '—' : signed(v.subs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="yt-pager">
            {truncated ? <span className="muted small yt-trunc">{fmtNum(all.length)} video mới nhất</span> : null}
            <span className="small muted yt-psize">
              <span aria-hidden="true">Số hàng mỗi trang</span>
              <Select
                size="sm"
                value={size}
                options={PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
                onChange={(n) => {
                  setSize(n);
                  setPage(0);
                }}
                label="Số hàng mỗi trang"
              />
            </span>
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
