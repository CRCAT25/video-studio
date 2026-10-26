// OAuth Google cho YouTube: client_secret.json của người dùng, luồng loopback + PKCE, làm mới / thu hồi token.
// Token và client secret chỉ nằm trong kho bí mật (Keychain) và bộ nhớ server — không trả cho trình duyệt, không log.
import crypto from 'node:crypto';
import { HttpError } from '../projects.js';
import { formBody, gfetch } from './http.js';

export const FLOW_TTL_MS = 10 * 60_000;
export const CLIENT_SECRET_NAME = 'google-client';
export const tokenName = (channelId) => `yt:${channelId}`;

// Quyền xin Google: Đợt 1 chỉ đọc; tải lên xin thêm khi cần (cấp tăng dần, không xin email/hồ sơ).
export const READ_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
export const UPLOAD_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Đọc nội dung client_secret.json dán vào → {clientId, clientSecret}; sai loại/thiếu trường → HttpError 400.
export function parseClientSecret(text) {
  let o;
  try {
    o = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new HttpError(400, 'invalid_client_secret', 'Không đọc được JSON — dán nguyên nội dung file client_secret_….json.');
  }
  if (o && typeof o === 'object' && o.web) {
    throw new HttpError(400, 'invalid_client_secret', 'Đây là client loại "Ứng dụng web". Hãy tạo client loại "Ứng dụng máy tính" (Desktop app).');
  }
  const c = o?.installed;
  const id = typeof c?.client_id === 'string' ? c.client_id.trim() : '';
  const secret = typeof c?.client_secret === 'string' ? c.client_secret.trim() : '';
  if (!id || !secret || !/\.apps\.googleusercontent\.com$/.test(id)) {
    throw new HttpError(400, 'invalid_client_secret', 'File thiếu client_id / client_secret của client "Ứng dụng máy tính".');
  }
  return { clientId: id, clientSecret: secret };
}

// Đuôi client_id để người dùng nhận ra đã dán file nào (không phải bí mật).
export function clientHint(clientId) {
  const head = String(clientId).split('.')[0] || '';
  return head.length > 12 ? `…${head.slice(-12)}` : head;
}

// Bộ OAuth: {getClient, setClient, clearClient, begin, finish, discard, cancel, pending, accessToken, saveTokens, revoke, forget}.
export function createOAuth({ secrets, endpoints, fetch: fetchFn = globalThis.fetch, now = () => Date.now(), flowTtlMs = FLOW_TTL_MS }) {
  const flows = new Map(); // state → {channelId, verifier, redirectUri, scopes, at}
  const access = new Map(); // channelId → {token, exp}
  let clientCache;

  async function getClient() {
    if (clientCache !== undefined) return clientCache;
    const raw = await secrets.get(CLIENT_SECRET_NAME);
    let c = null;
    try {
      c = raw ? JSON.parse(raw) : null;
    } catch {
      c = null;
    }
    clientCache = c?.clientId && c?.clientSecret ? c : null;
    return clientCache;
  }

  async function setClient(text) {
    const c = parseClientSecret(text);
    await secrets.set(CLIENT_SECRET_NAME, JSON.stringify(c));
    clientCache = c;
    return c;
  }

  async function clearClient() {
    await secrets.remove(CLIENT_SECRET_NAME);
    clientCache = null;
  }

  const needClient = async () => {
    const c = await getClient();
    if (!c) throw new HttpError(409, 'yt_not_configured', 'Chưa thiết lập Google Cloud — mở "Thiết lập Google" và dán client_secret.json.');
    return c;
  };

  // Dọn luồng quá hạn.
  const sweep = () => {
    for (const [s, f] of flows) if (now() - f.at > flowTtlMs) flows.delete(s);
  };

  // Bắt đầu luồng kết nối cho kênh → {authUrl, state}. Mỗi kênh chỉ một luồng chờ (luồng cũ bị thay).
  async function begin({ channelId, redirectUri, scopes = READ_SCOPES }) {
    const c = await needClient();
    sweep();
    for (const [s, f] of flows) if (f.channelId === channelId) flows.delete(s);
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    flows.set(state, { channelId, verifier, redirectUri, scopes, at: now() });
    const q = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return { authUrl: `${endpoints.auth}?${q}`, state };
  }

  // Kênh đang chờ đăng nhập Google (để UI hiện "Đang chờ…").
  function pending() {
    sweep();
    return [...new Set([...flows.values()].map((f) => f.channelId))];
  }

  // Bỏ luồng theo state (Google báo lỗi / người dùng từ chối); trả channelId hoặc null.
  function discard(state) {
    const f = typeof state === 'string' ? flows.get(state) : null;
    if (!f) return null;
    flows.delete(state);
    return f.channelId;
  }

  function cancel(channelId) {
    let n = 0;
    for (const [s, f] of flows) if (f.channelId === channelId && flows.delete(s)) n++;
    return n > 0;
  }

  // Google chuyển về callback: kiểm state, đổi code → token. Trả {channelId, accessToken, refreshToken, scopes}.
  async function finish({ state, code }) {
    sweep();
    const f = typeof state === 'string' ? flows.get(state) : null;
    if (!f) throw new HttpError(400, 'yt_bad_state', 'Liên kết đăng nhập đã hết hạn hoặc không hợp lệ — bấm Kết nối lại trong app.');
    flows.delete(state);
    try {
      return await exchange(f, code);
    } catch (e) {
      if (e && typeof e === 'object') e.channelId = f.channelId;
      throw e;
    }
  }

  // Đổi authorization code → token cho luồng f.
  async function exchange(f, code) {
    if (typeof code !== 'string' || !code) throw new HttpError(400, 'yt_no_code', 'Google không trả mã xác nhận.');
    const c = await needClient();
    const t = await gfetch(fetchFn, endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: f.redirectUri, grant_type: 'authorization_code', code_verifier: f.verifier }),
    });
    if (!t?.access_token) throw new HttpError(502, 'yt_error', 'Google không trả access token.');
    if (!t.refresh_token) throw new HttpError(502, 'yt_no_refresh', 'Google không trả refresh token — vào myaccount.google.com/permissions gỡ quyền app rồi kết nối lại.');
    const scopes = typeof t.scope === 'string' ? t.scope.split(/\s+/).filter(Boolean) : f.scopes;
    return { channelId: f.channelId, accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600, refreshToken: t.refresh_token, scopes };
  }

  // Lưu refresh token của kênh vào kho bí mật + nhớ access token trong bộ nhớ.
  async function saveTokens(channelId, { accessToken, expiresIn, refreshToken, scopes }) {
    await secrets.set(tokenName(channelId), JSON.stringify({ refresh_token: refreshToken, scopes }));
    access.set(channelId, { token: accessToken, exp: now() + (expiresIn - 60) * 1000 });
  }

  async function readTokens(channelId) {
    const raw = await secrets.get(tokenName(channelId));
    try {
      const o = raw ? JSON.parse(raw) : null;
      return o?.refresh_token ? o : null;
    } catch {
      return null;
    }
  }

  // Access token còn hạn (làm mới bằng refresh token khi cần); force=true bỏ bản trong bộ nhớ.
  async function accessToken(channelId, { force = false } = {}) {
    const a = access.get(channelId);
    if (!force && a && a.exp > now()) return a.token;
    const saved = await readTokens(channelId);
    if (!saved) throw new HttpError(401, 'yt_reauth', 'Chưa có token cho kênh này — bấm Kết nối lại.');
    const c = await needClient();
    const t = await gfetch(fetchFn, endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: saved.refresh_token, grant_type: 'refresh_token' }),
    });
    if (!t?.access_token) throw new HttpError(502, 'yt_error', 'Google không trả access token.');
    access.set(channelId, { token: t.access_token, exp: now() + ((Number(t.expires_in) || 3600) - 60) * 1000 });
    return t.access_token;
  }

  // Thu hồi token ở Google (cố gắng, lỗi bỏ qua) rồi xóa khỏi kho.
  async function revoke(channelId) {
    const saved = await readTokens(channelId).catch(() => null);
    let revoked = false;
    if (saved) {
      try {
        await gfetch(fetchFn, endpoints.revoke, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: formBody({ token: saved.refresh_token }),
        });
        revoked = true;
      } catch {
        revoked = false;
      }
    }
    await forget(channelId);
    return { revoked };
  }

  // Xóa token của kênh khỏi kho + bộ nhớ (không gọi Google).
  async function forget(channelId) {
    access.delete(channelId);
    await secrets.remove(tokenName(channelId));
  }

  return { getClient, setClient, clearClient, begin, finish, discard, cancel, pending, saveTokens, readTokens, accessToken, revoke, forget };
}
