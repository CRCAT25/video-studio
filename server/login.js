// Đăng nhập vào app: mật khẩu cục bộ (mặc định) và Google tùy chọn (1 chủ, OAuth loopback + PKCE, scope chỉ `openid`).
// Mật khẩu lưu băm scrypt; tạo lần đầu phải có mã thiết lập 6 số in ở terminal (chứng minh ngồi tại máy).
// Google: chỉ dùng `sub` trong id_token; lưu băm của sub (chủ) và băm mã phiên — không email/tên, không giữ token Google.
import crypto from 'node:crypto';
import { HttpError } from './projects.js';
import { formBody, gfetch } from './youtube/http.js';

export const SESSION_COOKIE = 'vs_session';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const LOGIN_FLOW_TTL_MS = 10 * 60_000;
export const LOGIN_CALLBACK_PATH = '/auth/callback';
export const PASSWORD_MIN = 8;
export const SETUP_MAX_TRIES = 5;
const OWNER_KEY = 'login.owner';
const PASSWORD_KEY = 'login.password';
const SETUP_KEY = 'login.setup';
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
export const ownerHash = (sub) => sha(`vs-login-owner:${sub}`);

const scrypt = (pw, salt, { N, r, p, keylen }) =>
  new Promise((ok, fail) => crypto.scrypt(pw, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (e, k) => (e ? fail(e) : ok(k))));

// Băm mật khẩu → chuỗi "scrypt$N$r$p$salt$hash" (base64url).
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64url(salt), b64url(key)].join('$');
}

// So mật khẩu với chuỗi băm (thời gian hằng); chuỗi hỏng → false.
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: want.length }).catch(() => null);
  return !!got && got.length === want.length && crypto.timingSafeEqual(got, want);
}

export const hasPassword = (store) => !!store.getSetting(PASSWORD_KEY);

// Tạo mã thiết lập 6 số mới (DB chỉ giữ băm, mã cũ hết hiệu lực). Dùng khi chưa có mật khẩu.
export function newSetupCode(store) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  store.setSetting(SETUP_KEY, sha(`vs-setup:${code}`));
  return code;
}

// Quên mật khẩu (lệnh `video-studio reset-password`): xóa mật khẩu + mọi phiên, trả mã thiết lập mới.
export function resetPassword(store) {
  store.setSetting(PASSWORD_KEY, null);
  store.deleteSessions();
  return newSetupCode(store);
}

// Chuỗi Set-Cookie phiên (30 ngày); value rỗng + maxAge 0 → xóa.
export function sessionCookie(value, maxAgeSec = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeSec)}`;
}

// Đọc phần payload của id_token (nhận thẳng từ endpoint token của Google qua TLS nên không cần kiểm chữ ký).
function idTokenClaims(idToken) {
  try {
    const part = String(idToken).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Bộ đăng nhập. deps: store (db.js), getClient() → {clientId, clientSecret}|null, endpoints (googleEndpoints), fetch?, now?().
// onSetupCode(code): báo mã thiết lập mới (cli in ra terminal) khi mã cũ bị khóa vì nhập sai quá nhiều.
export function createLogin({ store, getClient = async () => null, endpoints = null, fetch: fetchFn = globalThis.fetch, now = () => Date.now(), ttlMs = SESSION_TTL_MS, onSetupCode = () => {} }) {
  const flows = new Map(); // state → {mode: 'login'|'claim', verifier, redirectUri, at}
  let setupFails = 0;
  let pwFails = 0;
  let pwLockedUntil = 0;

  const sweep = () => {
    for (const [s, f] of flows) if (now() - f.at > LOGIN_FLOW_TTL_MS) flows.delete(s);
  };
  const enabled = () => !!store.getSetting(OWNER_KEY);

  async function status() {
    const client = await getClient().catch(() => null);
    return { enabled: enabled(), configured: !!client };
  }

  // Tạo mật khẩu lần đầu: cần đúng mã thiết lập; sai SETUP_MAX_TRIES lần → mã mới (onSetupCode). Trả mã phiên.
  async function setupPassword({ code, password, confirm }) {
    if (hasPassword(store)) throw new HttpError(409, 'password_exists', 'Đã có mật khẩu — đăng nhập bằng mật khẩu.');
    const want = store.getSetting(SETUP_KEY);
    const given = sha(`vs-setup:${String(code ?? '').replace(/\s+/g, '')}`);
    if (!want || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(given))) {
      if (++setupFails >= SETUP_MAX_TRIES) {
        setupFails = 0;
        onSetupCode(newSetupCode(store));
        throw new HttpError(429, 'setup_locked', 'Sai mã quá nhiều lần — dùng mã mới vừa in ở terminal.');
      }
      throw new HttpError(400, 'setup_bad_code', 'Mã thiết lập không đúng — xem mã in ở terminal.');
    }
    checkNewPassword(password, confirm);
    store.setSetting(PASSWORD_KEY, await hashPassword(password));
    store.setSetting(SETUP_KEY, null);
    setupFails = 0;
    store.deleteSessions();
    return createSession();
  }

  // Đăng nhập bằng mật khẩu. Sai 5 lần liên tiếp → khóa 30 giây, gấp đôi mỗi lần sai tiếp (tối đa 15 phút).
  async function loginPassword(password) {
    const stored = store.getSetting(PASSWORD_KEY);
    if (!stored) throw new HttpError(409, 'no_password', 'Chưa có mật khẩu — tạo mật khẩu trước.');
    if (now() < pwLockedUntil) throw new HttpError(429, 'password_locked', `Sai quá nhiều lần — thử lại sau ${Math.ceil((pwLockedUntil - now()) / 1000)} giây.`);
    if (!(await verifyPassword(String(password ?? ''), stored))) {
      pwFails++;
      if (pwFails >= 5) pwLockedUntil = now() + Math.min(30_000 * 2 ** (pwFails - 5), 15 * 60_000);
      throw new HttpError(401, 'password_wrong', 'Mật khẩu không đúng.');
    }
    pwFails = 0;
    pwLockedUntil = 0;
    return createSession();
  }

  // Tạo URL đăng nhập Google. mode 'claim' (bật tính năng, gọi khi đã đăng nhập bằng token) hoặc 'login'.
  async function begin({ mode = 'login', redirectUri }) {
    const c = await getClient().catch(() => null);
    if (!c) throw new HttpError(409, 'login_not_configured', 'Chưa thiết lập Google Cloud — làm "Thiết lập Google" trước.');
    if (mode === 'login' && !enabled()) throw new HttpError(409, 'login_disabled', 'Đăng nhập Google chưa bật.');
    sweep();
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    flows.set(state, { mode, verifier, redirectUri, at: now() });
    const q = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid',
      state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return { authUrl: `${endpoints.auth}?${q}` };
  }

  // Google chuyển về: đổi code → id_token, lấy sub. claim → đặt chủ; login → phải trùng chủ. Trả {mode, sessionId}.
  async function finish({ state, code, error }) {
    sweep();
    const f = typeof state === 'string' ? flows.get(state) : null;
    if (f) flows.delete(state);
    if (error) throw new HttpError(400, 'login_denied', 'Bạn đã hủy đăng nhập Google.');
    if (!f) throw new HttpError(400, 'login_bad_state', 'Liên kết đăng nhập đã hết hạn — thử lại.');
    if (typeof code !== 'string' || !code) throw new HttpError(400, 'login_no_code', 'Google không trả mã xác nhận.');
    const c = await getClient().catch(() => null);
    if (!c) throw new HttpError(409, 'login_not_configured', 'Chưa thiết lập Google Cloud.');
    const t = await gfetch(fetchFn, endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: f.redirectUri, grant_type: 'authorization_code', code_verifier: f.verifier }),
    }).catch(() => {
      throw new HttpError(502, 'login_google_error', 'Google không xác nhận được đăng nhập — thử lại.');
    });
    const claims = idTokenClaims(t?.id_token);
    const sec = now() / 1000;
    const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    if (!claims || typeof claims.sub !== 'string' || !claims.sub || !ISSUERS.has(claims.iss) || !aud.includes(c.clientId) || !(Number(claims.exp) > sec)) {
      throw new HttpError(502, 'login_bad_token', 'Google trả thông tin đăng nhập không hợp lệ — thử lại.');
    }
    const hash = ownerHash(claims.sub);
    if (f.mode === 'claim') {
      store.setSetting(OWNER_KEY, hash);
      store.deleteSessions();
    } else {
      const owner = store.getSetting(OWNER_KEY);
      if (!owner) throw new HttpError(409, 'login_disabled', 'Đăng nhập Google chưa bật.');
      if (!crypto.timingSafeEqual(Buffer.from(owner), Buffer.from(hash))) throw new HttpError(403, 'login_forbidden', 'Tài khoản này không có quyền.');
    }
    return { mode: f.mode, sessionId: createSession() };
  }

  // Tạo phiên mới (lưu băm mã) → mã phiên cho cookie.
  function createSession() {
    store.deleteSessions({ expiredBefore: new Date(now()) });
    const id = b64url(crypto.randomBytes(32));
    store.addSession(sha(id), new Date(now() + ttlMs));
    return id;
  }

  // Mã phiên từ cookie còn hiệu lực? (không còn mật khẩu lẫn Google → mọi phiên vô hiệu)
  function check(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || !(enabled() || hasPassword(store))) return false;
    const row = store.getSession(sha(sessionId));
    return !!row && Date.parse(row.expires_at) > now();
  }

  function logout(sessionId) {
    if (typeof sessionId === 'string' && sessionId) store.deleteSession(sha(sessionId));
  }

  // Tắt đăng nhập Google: xóa chủ; chưa có mật khẩu thì xóa luôn mọi phiên.
  function disable() {
    store.setSetting(OWNER_KEY, null);
    if (!hasPassword(store)) store.deleteSessions();
    flows.clear();
  }

  return { status, enabled, hasPassword: () => hasPassword(store), setupPassword, loginPassword, begin, finish, check, logout, disable };
}

// Mật khẩu mới hợp lệ: ≥ PASSWORD_MIN ký tự, ≤ 200, hai ô trùng nhau.
function checkNewPassword(password, confirm) {
  const pw = typeof password === 'string' ? password : '';
  if (pw.length < PASSWORD_MIN) throw new HttpError(400, 'password_short', `Mật khẩu cần ít nhất ${PASSWORD_MIN} ký tự.`);
  if (pw.length > 200) throw new HttpError(400, 'password_long', 'Mật khẩu quá dài.');
  if (pw !== confirm) throw new HttpError(400, 'password_mismatch', 'Hai lần nhập mật khẩu không khớp.');
}
