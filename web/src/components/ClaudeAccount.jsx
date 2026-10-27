// Bảng "Tài khoản Claude": xem trạng thái, đăng nhập (chọn hồ sơ Chrome) / đăng xuất qua lệnh `claude auth` chính thức.
// App không thấy mật khẩu hay mã đăng nhập — Claude Code tự xác thực trên trình duyệt.
import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';
import Select, { profileOptions } from './Select.jsx';
import { Sk } from './Skeleton.jsx';
import { UsagePanel } from './Usage.jsx';
import { T, tr, useT } from '../lib/i18n.jsx';

const PROFILE_KEY = 'vs.chromeProfile';
const DEFAULT_BROWSER = '__default__';
const METHODS = [
  { id: 'claudeai', label: T('Gói Claude (Pro / Max)'), hint: T('Dùng hạn mức gói trên claude.ai.') },
  { id: 'console', label: 'Anthropic Console (API)', hint: T('Tính tiền theo lượng dùng API.') },
];

// Đọc/ghi hồ sơ Chrome đã chọn lần trước (chỉ là tiện ích, lỗi thì bỏ qua).
function savedProfile() {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}
function saveProfile(v) {
  try {
    localStorage.setItem(PROFILE_KEY, v);
  } catch {
    /* trình duyệt chặn lưu */
  }
}

// Tên dễ đọc cho authMethod của `claude auth status`.
function methodLabel(m) {
  if (!m || m === 'none') return '—';
  if (/claude\.?ai|oauth|subscription/i.test(m)) return tr('Gói Claude (claude.ai)');
  if (/console|api/i.test(m)) return 'API key / Console';
  return m;
}

// Câu báo kết quả lệnh auth vừa xong (last từ server) → {msg, kind}.
export function accountResultMessage(last) {
  if (!last) return null;
  const login = last.action === 'login';
  if (last.reason === 'ok') return { msg: login ? tr('Đã đăng nhập Claude Code.') : tr('Đã đăng xuất Claude Code.'), kind: 'ok' };
  if (last.reason === 'cancelled') return { msg: tr('Đã hủy đăng nhập.'), kind: 'info' };
  if (last.reason === 'timeout') return { msg: login ? tr('Quá 10 phút chưa đăng nhập xong — đã hủy, bấm Đăng nhập để thử lại.') : tr('Đăng xuất không phản hồi — thử lại.'), kind: 'err' };
  if (last.reason === 'not_found') return { msg: tr('Không chạy được lệnh claude. Kiểm tra Claude Code đã cài chưa.'), kind: 'err' };
  return { msg: login ? tr('Đăng nhập không thành công.') : tr('Đăng xuất không thành công.'), kind: 'err' };
}

// account = trạng thái từ server ({busy, method, profile, startedAt, last}); running = số bước đang chạy; usage = useUsage().
export default function ClaudeAccount({ doctor, account, running = 0, usage = null, onClose, onRefresh }) {
  const t = useT();
  const toast = useToast();
  const [chrome, setChrome] = useState(null); // {supported, profiles}
  const [profile, setProfile] = useState(() => savedProfile());
  const [method, setMethod] = useState('claudeai');
  const [busy, setBusy] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  const loadProfiles = async () => {
    try {
      setChrome(await api.chromeProfiles());
    } catch {
      setChrome({ supported: false, profiles: [] });
    }
  };
  useEffect(() => {
    loadProfiles();
  }, []);

  const profiles = chrome?.profiles || [];
  // Hồ sơ đang chọn: lần trước (nếu còn) → hồ sơ dùng gần nhất → trình duyệt mặc định.
  const picked = profile === DEFAULT_BROWSER || profiles.some((p) => p.dir === profile)
    ? profile
    : profiles[0]?.dir ?? DEFAULT_BROWSER;
  const pickedProfile = profiles.find((p) => p.dir === picked) || null;

  const auth = doctor?.auth;
  const found = !!doctor?.claude?.found;
  const logged = !!auth?.loggedIn;
  const waiting = account?.busy === 'login';
  const locked = running > 0;

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
  const login = () =>
    act(async () => {
      saveProfile(picked);
      await api.claudeLogin({ method, profileDir: picked === DEFAULT_BROWSER ? null : picked });
    });
  const relogin = () =>
    act(async () => {
      await api.claudeLoginCancel().catch(() => null);
      await api.claudeLogin({ method: account?.method || method, profileDir: account?.profile?.dir ?? null });
    });
  const cancel = () => act(() => api.claudeLoginCancel());
  const logout = () =>
    act(async () => {
      await api.claudeLogout();
      setConfirmOut(false);
    });

  return (
    <Modal title={t('Tài khoản Claude')} onClose={onClose} busy={busy} lead={t('Mật khẩu và mã đăng nhập không đi qua app.')}>
      <div className={`acc-box${logged ? ' on' : ''}`}>
        <i className={`lamp ${!doctor ? 'idle' : logged ? 'ok' : 'err'}`} />
        <div>
          <b aria-busy={!doctor || undefined}>{!doctor ? <><Sk w="8em" /><span className="sr-only">{t('Đang kiểm tra')}</span></> : !found ? t('Chưa cài Claude Code') : logged ? t('Đã đăng nhập') : t('Chưa đăng nhập')}</b>
          {logged ? (
            <div className="acc-meta">
              <span>{t('Gói ')}<b>{auth.subscriptionType ? String(auth.subscriptionType).toUpperCase() : '—'}</b></span>
              <span>{t('Cách đăng nhập ')}<b>{methodLabel(auth.authMethod)}</b></span>
            </div>
          ) : null}
          {found ? <div className="acc-meta mono dim">Claude Code {doctor.claude.version || '?'}</div> : null}
        </div>
        <button type="button" className="btn sm" onClick={() => act(onRefresh)} disabled={busy} title={t('Đọc lại trạng thái đăng nhập')}>
          {t('↻ Làm mới')}
        </button>
      </div>

      {logged && usage && !waiting && !confirmOut ? <UsagePanel usage={usage} /> : null}

      {waiting ? (
        <div className="acc-wait" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <b>{t('Đang chờ bạn đăng nhập trên trình duyệt…')}</b>
            <p className="note">
              {account.profile ? <>{t('Trang đăng nhập đã mở trong hồ sơ Chrome ')}<b>{account.profile.name}</b>. </> : t('Trang đăng nhập đã mở trong trình duyệt mặc định. ')}
              {t('Xong, app tự cập nhật.')}
            </p>
          </div>
        </div>
      ) : null}

      {!waiting && confirmOut ? (
        <div className="acc-confirm">
          <b>{t('Đăng xuất Claude Code trên máy này?')}</b>
          <p className="note">
            {t('Đăng xuất cả Claude Code ở terminal và ứng dụng khác trên máy.')}
          </p>
        </div>
      ) : null}

      {!waiting && !confirmOut && found ? (
        <>
          <div className="fld">
            <span className="fld-l">{t('Đăng nhập bằng')}</span>
            <div className="chips" role="radiogroup" aria-label={t('Đăng nhập bằng')}>
              {METHODS.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={method === m.id} className={`chip${method === m.id ? ' on' : ''}`} onClick={() => setMethod(m.id)} disabled={busy}>
                  {t(m.label)}
                </button>
              ))}
            </div>
            <span className="hint">{t(METHODS.find((m) => m.id === method)?.hint)}</span>
          </div>
          <label className="fld">
            <span>{t('Mở trang đăng nhập trong')}</span>
            <Select value={picked} options={profileOptions(profiles, DEFAULT_BROWSER, chrome?.defaultBrowser)} onChange={setProfile} disabled={busy} />
            <span className="hint">
              {pickedProfile ? (
t('Chọn hồ sơ đang đăng nhập claude.ai.')
              ) : chrome && !profiles.length ? (
                t('Không tìm thấy hồ sơ Chrome nào.')
              ) : null}
            </span>
          </label>
        </>
      ) : null}

      {locked && !waiting ? <p className="warn-note">{t('Đang có {n} bước chạy — đợi xong hoặc dừng trước.', { n: running })}</p> : null}

      <div className="modal-acts">
        {waiting ? (
          <>
            <button type="button" className="btn" onClick={cancel} disabled={busy}>
              {t('Hủy')}
            </button>
            <button type="button" className="btn primary" onClick={relogin} disabled={busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : '↗'} {t('Mở lại trang đăng nhập')}
            </button>
          </>
        ) : confirmOut ? (
          <>
            <button type="button" className="btn" onClick={() => setConfirmOut(false)} disabled={busy} data-autofocus>
              {t('Không')}
            </button>
            <button type="button" className="btn danger" onClick={logout} disabled={busy || locked}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null} {t('Đăng xuất')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              {t('Đóng')}
            </button>
            {logged ? (
              <button type="button" className="btn danger" onClick={() => setConfirmOut(true)} disabled={busy || locked || !!account?.busy}>
                {t('Đăng xuất')}
              </button>
            ) : null}
            {found ? (
              <button type="button" className="btn primary" onClick={login} disabled={busy || locked || !!account?.busy}>
                {busy ? <span className="spinner" aria-hidden="true" /> : '→'} {logged ? t('Đổi tài khoản') : t('Đăng nhập')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
