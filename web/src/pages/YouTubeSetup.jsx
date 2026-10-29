// Trang "Thiết lập Google": trình thiết lập 4 bước — app tự tạo dự án + bật API (gcloud riêng), mở sẵn 2 trang Google
// bắt buộc làm tay, tự nhặt client_secret_*.json trong Tải về. Cách dán / chọn file thủ công vẫn còn (thu gọn).
// Client secret cất trong Keychain ở server; trang chỉ thấy đuôi client_id.
import { useCallback, useEffect, useRef, useState } from 'react';
import ConfirmModal from '../components/ConfirmModal.jsx';
import Select, { DEFAULT_BROWSER, profileOptions, saveProfile, savedProfile } from '../components/Select.jsx';
import { useToast } from '../components/Toast.jsx';
import { useSSE } from '../hooks/useSSE.js';
import { copyText } from '../lib/clipboard.js';
import { api } from '../api.js';
import { T, useT } from '../lib/i18n.jsx';

const STORAGE = { keychain: T('Keychain của macOS'), file: T('file riêng trên máy (quyền 600)') };
const STAGES = [T('Đăng nhập Google'), T('Dự án & API'), T('Màn hình xin quyền'), T('Tạo client')];
const STAGE_OF = { login: 0, project: 1, consent: 2, client: 3, done: 4 };
const BUSY_TEXT = {
  tools: T('Đang tải công cụ Google Cloud…'),
  login: T('Đã mở trang đăng nhập Google — chọn tài khoản rồi bấm Cho phép.'),
  project: T('Đang tạo dự án "Video Studio"…'),
  apis: T('Đang bật YouTube Data API v3 và YouTube Analytics API…'),
};
const MB = (n) => `${Math.round(n / 1e6)} MB`;

// Thanh tiến độ 4 bước.
function Stages({ at }) {
  const t = useT();
  return (
    <ol className="gw-stages" aria-label={t('Tiến độ')}>
      {STAGES.map((s, i) => (
        <li key={s} className={i < at ? 'done' : i === at ? 'cur' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="gw-bar" aria-hidden="true" />
          <span className="gw-lb">
            {i < at ? '✓ ' : ''}
            {t(s)}
          </span>
        </li>
      ))}
    </ol>
  );
}

// 1 dòng giá trị cần điền trên trang Google (+ nút Sao chép nếu có).
function Val({ label, value, copy }) {
  const t = useT();
  const toast = useToast();
  return (
    <li>
      <span className="muted">{label}</span>
      <b>{value}</b>
      {copy ? (
        <button type="button" className="btn sm ghost" onClick={async () => toast((await copyText(value)) ? t('Đã sao chép.') : t('Không sao chép được.'), 'info')}>
          {t('Sao chép')}
        </button>
      ) : null}
    </li>
  );
}

// Các bước trên trang Google để Xuất bản ứng dụng (first = còn phải tạo màn hình xin quyền trước).
function PublishTodo({ wiz, gl, first }) {
  const t = useT();
  return (
    <ol className="gw-todo">
      {first ? (
        <li>
          Trang {gl('consent', t('Thông tin ứng dụng'))} → <b>{t('Bắt đầu')}</b>:
          <ul className="gw-vals">
            <Val label={t('Tên ứng dụng')} value={wiz.appName} copy />
            <Val label={t('Email hỗ trợ')} value="chọn email của bạn" />
            <Val label={t('Đối tượng')} value="Bên ngoài" />
            <Val label={t('Thông tin liên hệ')} value="email của bạn" />
          </ul>
          Đánh dấu đồng ý → <b>{t('Tạo')}</b>.
        </li>
      ) : null}
      <li>
        {first ? t('Vẫn trang đó') : <>Trang {gl('consent', t('Thông tin ứng dụng'))}</>}, điền thêm:
        <ul className="gw-vals">
          <Val label={t('Trang chủ')} value={wiz.homepage} copy />
          <Val label={t('Chính sách quyền riêng tư')} value={wiz.privacy} copy />
          <Val label={t('Miền được phép')} value="github.com" copy />
        </ul>
        Miền được phép: bấm <b>{t('Thêm miền')}</b>{t('. Để trống logo (có logo là Google bắt xác minh) → ')}<b>{t('Lưu')}</b>.
      </li>
      <li>
        Trang {gl('audience', t('Đối tượng'))} → <b>{t('Xuất bản ứng dụng')}</b> → <b>{t('Xác nhận')}</b>.
      </li>
    </ol>
  );
}

const GOOGLE_PAGES = [
  ['project', T('Dự án')],
  ['apis', 'API'],
  ['consent', T('Màn hình xin quyền')],
  ['clients', 'Client'],
];

export default function YouTubeSetup({ yt, onReload }) {
  const t = useT();
  const toast = useToast();
  const [wiz, setWiz] = useState(null);
  const [noWiz, setNoWiz] = useState(false);
  const [chrome, setChrome] = useState(null);
  const [profile, setProfile] = useState(() => savedProfile());
  const [pid, setPid] = useState('');
  const [acting, setActing] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const timer = useRef(null);
  const lastStep = useRef(null);

  const load = useCallback(() => {
    api
      .gw()
      .then((w) => {
        setWiz(w);
        setNoWiz(false);
      })
      .catch(() => setNoWiz(true));
  }, []);
  useEffect(() => {
    load();
    api
      .chromeProfiles()
      .then(setChrome)
      .catch(() => setChrome({ supported: false, profiles: [] }));
    return () => clearTimeout(timer.current);
  }, [load]);
  useSSE((msg) => {
    if (msg.type !== 'google-setup' && msg.type !== 'reconnect') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 100);
  });
  // Vừa xong (tự nhặt được file) → tải lại trạng thái YouTube.
  useEffect(() => {
    if (wiz?.step === 'done' && lastStep.current && lastStep.current !== 'done') onReload?.();
    lastStep.current = wiz?.step ?? null;
  }, [wiz?.step, onReload]);

  const profiles = chrome?.profiles || [];
  const picked = profile === DEFAULT_BROWSER || profiles.some((p) => p.dir === profile) ? profile : profiles[0]?.dir ?? DEFAULT_BROWSER;

  // Gọi 1 hành động wizard; trả kết quả (hoặc null nếu lỗi — đã báo toast).
  const act = async (fn) => {
    setActing(true);
    try {
      const r = await fn();
      if (r && r.step) setWiz(r);
      return r;
    } catch (e) {
      toast(e.message, 'err');
      load();
      return null;
    } finally {
      setActing(false);
    }
  };
  // Mở trang Google: server mở trong hồ sơ Chrome đã chọn; trình duyệt mặc định → mở tab mới ở đây.
  const openPage = async (page) => {
    const r = await act(() => api.gwOpen(page));
    if (r && !r.opened) window.open(r.url, '_blank', 'noopener');
  };
  // Link "Chỉnh trên Google": có hồ sơ Chrome → mở qua server, không thì để link mở bình thường.
  const gl = (page, text) => (
    <a
      href={wiz?.links?.[page]}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!wiz?.profile) return;
        e.preventDefault();
        openPage(page);
      }}
    >
      {text}
    </a>
  );

  // Nút "Chỉnh trên Google" ở chân trang: giống gl nhưng là nút.
  const glOpen = (page) => {
    if (wiz?.profile) openPage(page);
    else if (wiz?.links?.[page]) window.open(wiz.links[page], '_blank', 'noopener');
  };

  const start = () => {
    saveProfile(picked);
    act(() => api.gwStart(picked === DEFAULT_BROWSER ? null : picked));
  };
  const next = async () => {
    const r = await act(() => api.gwNext());
    if (r?.open && !r.open.opened) window.open(r.open.url, '_blank', 'noopener');
  };
  const reset = () => setConfirmReset(true);
  const handleFile = async (keep) => {
    const r = await act(() => api.gwDownload(keep));
    if (r) toast(r.trashed ? t('Đã chuyển file vào Thùng rác.') : t('Đã giữ file trong Tải về.'), 'info');
  };

  const connected = (yt?.channels || []).filter((c) => c.connected).length;
  const showWizard = !noWiz && wiz && !(yt?.configured && wiz.step !== 'done' && !wiz.busy && STAGE_OF[wiz.step] < 2);

  return (
    <>
      <div className="page-h">
        <div>
          <p className="small">
            <a href="#/channels">{t('← Kênh')}</a>
          </p>
          <h1>{t('Thiết lập Google')}</h1>
          <p className="muted small">{t('Làm 1 lần, khoảng 3 phút. Dự án Google Cloud là của bạn — app không dùng máy chủ trung gian.')}</p>
        </div>
      </div>

      {yt?.configured ? <SetupOk yt={yt} connected={connected} onReload={onReload} /> : null}
      {yt?.configured ? <GoogleLogin /> : null}

      {wiz?.found ? (
        <div className="card pad gw-found">
          <p>
            {t('Đã lưu client vào {s}. Xóa file {f} khỏi thư mục Tải về?', { s: STORAGE[yt?.storage] ? t(STORAGE[yt?.storage]) : t('kho bí mật của máy'), f: <span className="mono">{wiz.found.name}</span> })}
          </p>
          <div className="acts">
            <button type="button" className="btn primary" onClick={() => handleFile(false)} disabled={acting}>
              {t('Chuyển vào Thùng rác')}
            </button>
            <button type="button" className="btn" onClick={() => handleFile(true)} disabled={acting}>
              {t('Giữ lại')}
            </button>
          </div>
        </div>
      ) : null}

      {showWizard ? (
        <section className="card gw" aria-labelledby="gw-h">
          <div className="gw-head">
            <h2 id="gw-h">{wiz.step === 'done' ? t('Đã thiết lập xong') : t('Thiết lập tự động')}</h2>
            <Stages at={STAGE_OF[wiz.step] ?? 0} />
          </div>
          <div className="gw-body">
            <StepBody
              wiz={wiz}
              acting={acting}
              picker={
                <label className="fld">
                  <span>{t('Đăng nhập Google trong')}</span>
                  <Select value={picked} options={profileOptions(profiles, DEFAULT_BROWSER, chrome?.defaultBrowser)} onChange={setProfile} disabled={acting || !chrome} />
                  <span className="hint">{t('Chọn hồ sơ đang đăng nhập tài khoản Google sở hữu kênh.')}</span>
                </label>
              }
              pid={pid}
              setPid={setPid}
              onStart={start}
              onCancel={() => act(() => api.gwCancel())}
              onProject={() => act(() => api.gwProject(pid))}
              onOpen={openPage}
              onNext={next}
              onBack={() => act(() => api.gwBack())}
              gl={gl}
            />
          </div>
          {wiz.projectId || wiz.step !== 'login' ? (
            <div className="gw-foot">
              {wiz.projectId ? (
                <div className="gw-links">
                  <span className="small muted">{t('Chỉnh trên Google:')}</span>
                  {GOOGLE_PAGES.map(([page, text]) => (
                    <button key={page} type="button" className="btn sm" onClick={() => glOpen(page)} disabled={acting}>
                      {t(text)}
                    </button>
                  ))}
                </div>
              ) : (
                <span />
              )}
              <button type="button" className="btn sm danger" onClick={reset} disabled={acting}>
                {t('Làm lại từ đầu')}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <Manual yt={yt} onReload={onReload} open={noWiz} />

      <section className="card pad yt-limits">
        <h2>{t('Giới hạn của Google')}</h2>
        <ul>
          <li>
            Khi kết nối, Google báo <b>{t('"Google chưa xác minh ứng dụng này"')}</b>{t(' — vì app là của bạn. Bấm ')}<b>{t('Nâng cao')}</b> → <b>{t('Đi tới … (không an toàn)')}</b>.
          </li>
          <li>{t('Hạn mức miễn phí ~10.000 điểm/ngày (đặt lại lúc 14:00–15:00 giờ Việt Nam). Xem số liệu tốn vài điểm; tải 1 video lên tốn ~1.600.')}</li>
          <li>{t('Dự án chưa được Google duyệt thì video tải lên qua API luôn ở chế độ ')}<b>{t('Riêng tư')}</b>{t(' — bạn tự chuyển Công khai trong YouTube Studio.')}</li>
          <li>{t('Đặt hình thu nhỏ cần kênh đã xác minh số điện thoại.')}</li>
        </ul>
      </section>
      {confirmReset ? <ConfirmModal title={t('Làm lại từ đầu?')} body={t('Dự án đã tạo trên Google vẫn giữ nguyên.')} okLabel={t('Làm lại')} danger onOk={() => act(() => api.gwReset())} onClose={() => setConfirmReset(false)} /> : null}
    </>
  );
}

// Nội dung theo bước hiện tại.
function StepBody({ wiz, acting, picker, pid, setPid, onStart, onCancel, onProject, onOpen, onNext, onBack, gl }) {
  const t = useT();
  const err = wiz.error;
  const dis = acting || !!wiz.busy;

  if (wiz.busy) {
    const p = wiz.progress;
    const pct = p?.total ? Math.min(100, Math.round((p.bytes / p.total) * 100)) : null;
    return (
      <>
        <div className="yt-wait" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <p className="note">{BUSY_TEXT[wiz.busy] ? t(BUSY_TEXT[wiz.busy]) : t('Đang xử lý…')}</p>
            {wiz.busy === 'tools' && pct !== null ? (
              <>
                <progress className="gw-progress" max="100" value={pct} aria-label={t('Tiến độ tải')} />
                <p className="note">
                  {t('{pct}% · {a} / {b} — chỉ tải lần đầu, tự xóa khi xong.', { pct, a: MB(p.bytes), b: MB(p.total) })}
                </p>
              </>
            ) : null}
            {wiz.busy === 'login' && !wiz.profile ? <p className="note">{t('Trang mở trong trình duyệt mặc định của máy.')}</p> : null}
          </div>
        </div>
        <div className="acts">
          <button type="button" className="btn" onClick={onCancel} disabled={acting}>
            {t('Hủy')}
          </button>
        </div>
      </>
    );
  }

  if (wiz.step === 'login' || wiz.step === 'project') {
    return (
      <>
        {err ? <p className="err-note">{err.message}</p> : null}
        {err?.code === 'gc_tos' ? (
          <div className="acts">
            <button type="button" className="btn" onClick={() => onOpen('tos')} disabled={dis}>
              {t('Mở trang Google Cloud')}
            </button>
            <button type="button" className="btn primary" onClick={onStart} disabled={dis}>
              {t('Thử lại')}
            </button>
          </div>
        ) : err?.code === 'gc_project_quota' ? (
          wiz.projects?.length ? (
            <>
              <label className="fld">
                <span>{t('Dự án có sẵn')}</span>
                <Select value={pid} options={wiz.projects.map((p) => ({ value: p.projectId, label: p.name, meta: p.projectId }))} onChange={setPid} placeholder={t('Chọn dự án…')} disabled={dis} />
                <span className="hint">{t('App bật 2 API YouTube trong dự án này.')}</span>
              </label>
              <div className="acts">
                <button type="button" className="btn primary" onClick={onProject} disabled={dis || !pid}>
                  {t('Dùng dự án này')}
                </button>
              </div>
            </>
          ) : (
            <p className="note">{t('Không có dự án nào để chọn — xóa bớt dự án cũ trên Google Cloud rồi bấm Thử lại, hoặc làm thủ công bên dưới.')}</p>
          )
        ) : (
          <>
            {!err ? <p>{t('App tự tạo dự án "Video Studio" trên Google Cloud của bạn và bật 2 API YouTube. Bạn chỉ cần đăng nhập Google và bấm ')}<b>{t('Cho phép')}</b>.</p> : null}
            {picker}
            <div className="acts">
              <button type="button" className="btn primary" onClick={onStart} disabled={dis}>
                {err || wiz.step === 'project' ? t('Thử lại') : t('Bắt đầu')}
              </button>
            </div>
          </>
        )}
      </>
    );
  }

  if (wiz.step === 'consent') {
    return (
      <>
        <p>
          Dự án <span className="mono">{wiz.projectId}</span> đã sẵn sàng. Google bắt buộc bạn tự điền trang xin quyền — {wiz.profile ? t('app đã mở sẵn trang này') : t('mở trang rồi')} điền:
        </p>
        <PublishTodo wiz={wiz} gl={gl} first />
        <p className="warn-note">{t('Bỏ qua bước Xuất bản thì Google tự hủy quyền sau 7 ngày — phải kết nối lại mỗi tuần.')}</p>
        <div className="acts">
          <button type="button" className="btn" onClick={() => onOpen('consent')} disabled={dis}>
            {wiz.profile ? t('Mở lại trang xin quyền') : t('Mở trang xin quyền')}
          </button>
          <button type="button" className="btn" onClick={() => onOpen('audience')} disabled={dis}>
            {t('Mở trang Đối tượng')}
          </button>
          <button type="button" className="btn primary" onClick={onNext} disabled={dis}>
            {t('Xong, tiếp tục →')}
          </button>
        </div>
      </>
    );
  }

  if (wiz.step === 'client') {
    return (
      <>
        <p>
          Trên trang {gl('client', t('Tạo client'))}: Loại ứng dụng chọn <b>{t('Ứng dụng dành cho máy tính')}</b> → <b>{t('Tạo')}</b> → <b>{t('Tải JSON xuống')}</b>.
        </p>
        {err ? <p className="err-note">{err.message}</p> : null}
        {wiz.watchError ? (
          <p className="warn-note">{wiz.watchError}</p>
        ) : (
          <div className="yt-wait" role="status">
            <span className="spinner" aria-hidden="true" />
            <p className="note">{t('Đang chờ file client_secret_….json trong thư mục Tải về — app tự nhận, không cần làm gì thêm.')}</p>
          </div>
        )}
        <div className="acts">
          <button type="button" className="btn" onClick={onBack} disabled={dis}>
            {t('← Quay lại')}
          </button>
          <button type="button" className="btn" onClick={() => onOpen('client')} disabled={dis}>
            {t('Mở lại trang tạo client')}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="gw-done">
      <p>{t('Google đã sẵn sàng. Giờ thêm kênh YouTube của bạn.')}</p>
      <details className="gw-publish">
        <summary>{t('Chưa xuất bản ứng dụng? (quyền bị hủy sau 7 ngày)')}</summary>
        <PublishTodo wiz={wiz} gl={gl} />
      </details>
      <a className="btn primary" href="#/channels">
        {t('Thêm kênh →')}
      </a>
    </div>
  );
}

// Thẻ "Đã thiết lập" + nút xóa thiết lập.
function SetupOk({ yt, connected, onReload }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const clear = async () => {
    setBusy(true);
    try {
      await api.ytSetupClear();
      toast(t('Đã xóa thiết lập Google.'), 'info');
      onReload?.();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card pad yt-setup-ok">
      <i className="lamp" style={{ "--c": "var(--ok)" }} />
      <div>
        <b>{t('Đã thiết lập')}</b>
        <p className="note">
          {t('Client {c} · lưu trong {s}', { c: <span className="mono">{yt.client}</span>, s: STORAGE[yt.storage] ? t(STORAGE[yt.storage]) : yt.storage })}
        </p>
      </div>
      <button type="button" className="btn sm danger" onClick={clear} disabled={busy || connected > 0} title={connected ? t('Ngắt kết nối mọi kênh trước') : undefined}>
        {t('Xóa thiết lập')}
      </button>
    </div>
  );
}

// Bật/tắt "Đăng nhập bằng Google" cho app: tài khoản Google dùng lúc bật thành chủ duy nhất.
function GoogleLogin() {
  const t = useT();
  const toast = useToast();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.auth().then(setSt, () => setSt(null));
  }, []);
  useEffect(load, [load]);
  if (!st?.google?.available) return null;
  const on = st.google.enabled;
  const enable = async () => {
    setBusy(true);
    try {
      const r = await api.authEnable();
      window.location.assign(r.authUrl);
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await api.authDisable();
      toast(t('Đã tắt đăng nhập Google. Dùng mật khẩu để mở app.'), 'info');
      load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card pad yt-setup-ok gl-login">
      <i className="lamp" style={{ '--c': on ? 'var(--ok)' : 'var(--idle)' }} />
      <div>
        <b>{t('Đăng nhập bằng Google')}</b>
        <p className="note">{on ? t('Đang bật — chỉ tài khoản Google đã dùng lúc bật mới vào được.') : t('Mở app bằng tài khoản Google, ngoài mật khẩu.')}</p>
      </div>
      {on ? (
        <button type="button" className="btn sm" onClick={disable} disabled={busy}>
          {t('Tắt')}
        </button>
      ) : (
        <button type="button" className="btn sm primary" onClick={enable} disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null} {t('Bật đăng nhập Google')}
        </button>
      )}
    </div>
  );
}

// Cách thủ công: tự làm trên Google Cloud rồi dán / chọn file client_secret.json.
function Manual({ yt, onReload, open }) {
  const t = useT();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.ytSetup(text);
      setText('');
      toast(t('Đã lưu thiết lập Google.'), 'ok');
      onReload?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const pickFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 20_000) return setErr(t('File quá lớn — chọn đúng file client_secret_….json.'));
    setText(await f.text());
    setErr(null);
  };

  return (
    <details className="card gw-manual" open={open || undefined}>
      <summary>{t('Tự làm thủ công')}</summary>
      <div className="gw-manual-b">
        <p className="note">
          Đã có client OAuth loại <b>{t('Ứng dụng dành cho máy tính')}</b> (dự án bật YouTube Data API v3 + YouTube Analytics API)? Dán nội dung file client_secret.json hoặc chọn file.
        </p>
        <label className="fld">
          <span className="sr-only">{t('Nội dung client_secret.json')}</span>
          <textarea
            className="mono"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='{"installed":{"client_id":"….apps.googleusercontent.com", …}}'
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {err ? <p className="err-note">{err}</p> : null}
        <div className="acts yt-paste-acts">
          <label className="btn">
            {t('Chọn file…')}
            <input type="file" accept=".json,application/json" onChange={pickFile} className="sr-only" disabled={busy} />
          </label>
          <button type="button" className="btn primary" onClick={save} disabled={busy || !text.trim()}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null} {yt?.configured ? t('Thay thiết lập') : t('Lưu')}
          </button>
        </div>
      </div>
    </details>
  );
}
