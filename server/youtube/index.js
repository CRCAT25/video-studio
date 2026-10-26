// Dịch vụ "Kênh YouTube": thiết lập client Google, kết nối từng kênh (channels.yaml), số liệu có cache SQLite, hạn mức.
import { spawn } from 'node:child_process';
import { BROWSER_SCRIPT } from '../claude-account.js';
import { listChromeProfiles } from '../chrome-profiles.js';
import { HttpError } from '../projects.js';
import { DAILY_QUOTA, createYouTubeApi, quotaDay } from './api.js';
import { googleEndpoints, toHttpError } from './http.js';
import { READ_SCOPES, UPLOAD_SCOPES, clientHint, createOAuth } from './oauth.js';

export const CACHE_TTL_MS = 6 * 3600_000;
export const CALLBACK_PATH = '/api/youtube/oauth/callback';

// Mở URL trong hồ sơ Chrome đã chọn (cùng script với đăng nhập Claude); không chờ, không đọc output.
export function openInChromeProfile(url, profileDir, { script = BROWSER_SCRIPT } = {}) {
  const child = spawn('/bin/sh', [script, url], { stdio: 'ignore', detached: true, env: { ...process.env, VS_CHROME_PROFILE: profileDir } });
  child.on('error', () => {});
  child.unref();
}

// Tạo dịch vụ YouTube. deps: store (db.js), secrets (keychain.js), channels() → [{id,name,platform}], fetch?, googleBase?,
// openUrl?(url, profileDir), profiles?(), onChange?(), now?().
export function createYouTube({
  store,
  secrets,
  channels = () => [],
  fetch: fetchFn = globalThis.fetch,
  googleBase = null,
  openUrl = openInChromeProfile,
  profiles = () => listChromeProfiles(),
  onChange = () => {},
  now = () => Date.now(),
  cacheTtlMs = CACHE_TTL_MS,
} = {}) {
  const endpoints = googleEndpoints(googleBase);
  const oauth = createOAuth({ secrets, endpoints, fetch: fetchFn, now });
  const api = createYouTubeApi({ endpoints, fetch: fetchFn, onUnits: (n) => store.ytQuotaAdd(quotaDay(new Date(now())), n) });
  const inflight = new Map(); // `${id}:${kind}` → Promise
  const lastError = new Map(); // id → {code, message, at} của lần kết nối gần nhất bị lỗi
  const listeners = new Set([onChange]);
  // Báo người nghe (app.js phát SSE 'youtube'); lỗi người nghe bỏ qua.
  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* bỏ qua */
      }
    }
  };

  const ytChannels = () => (channels() || []).filter((c) => c.platform === 'youtube');
  const needChannel = (id) => {
    const c = ytChannels().find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'not_found', `Không có kênh YouTube "${id}" trong channels.yaml.`);
    return c;
  };
  const needConnected = (id) => {
    needChannel(id);
    const row = store.ytChannel(id);
    if (!row) throw new HttpError(409, 'yt_not_connected', 'Kênh này chưa kết nối YouTube.');
    return row;
  };

  // Ảnh chụp trạng thái cho UI (không có token / secret).
  async function status() {
    const client = await oauth.getClient().catch(() => null);
    const rows = new Map(store.ytChannels().map((r) => [r.id, r]));
    const pending = new Set(oauth.pending());
    const day = quotaDay(new Date(now()));
    return {
      configured: !!client,
      client: client ? clientHint(client.clientId) : null,
      storage: secrets.kind,
      quota: { day, used: store.ytQuota(day), limit: DAILY_QUOTA },
      channels: ytChannels().map((c) => {
        const r = rows.get(c.id);
        return {
          id: c.id,
          name: c.name,
          videosDir: c.videos_dir ?? null,
          connected: !!r,
          ytChannelId: r?.yt_channel_id ?? null,
          title: r?.title ?? null,
          status: r?.status ?? null,
          canUpload: !!r?.can_upload,
          connectedAt: r?.connected_at ?? null,
          pending: pending.has(c.id),
          lastError: lastError.get(c.id) ?? null,
        };
      }),
    };
  }

  async function setup(text) {
    await oauth.setClient(text);
    emit();
    return status();
  }

  // Xóa client Google; còn kênh kết nối thì chặn (token phụ thuộc client).
  async function clearSetup() {
    if (store.ytChannels().length) throw new HttpError(409, 'yt_has_channels', 'Ngắt kết nối mọi kênh trước khi xóa thiết lập Google.');
    await oauth.clearClient();
    emit();
    return status();
  }

  // Bắt đầu kết nối kênh: tạo URL đăng nhập Google; có hồ sơ Chrome → mở luôn trong hồ sơ đó.
  async function connect({ channelId, redirectUri, profileDir = null, upload = false }) {
    needChannel(channelId);
    let profile = null;
    if (profileDir) {
      profile = (profiles()?.profiles || []).find((p) => p.dir === profileDir) || null;
      if (!profile) throw new HttpError(400, 'invalid_profile', 'Không tìm thấy hồ sơ Chrome này. Chọn lại hồ sơ.');
    }
    const scopes = upload ? [...READ_SCOPES, ...UPLOAD_SCOPES] : READ_SCOPES;
    const { authUrl } = await oauth.begin({ channelId, redirectUri, scopes });
    lastError.delete(channelId);
    let opened = false;
    if (profile) {
      try {
        openUrl(authUrl, profile.dir);
        opened = true;
      } catch {
        opened = false;
      }
    }
    emit();
    return { authUrl, opened };
  }

  function cancelConnect(channelId) {
    needChannel(channelId);
    const ok = oauth.cancel(channelId);
    emit();
    return { ok };
  }

  const fail = (channelId, e) => {
    if (channelId) lastError.set(channelId, { code: e.code || 'yt_error', message: e.message, at: new Date(now()).toISOString() });
    emit();
    return e;
  };

  // Google chuyển về: đổi code → token, đọc kênh, lưu. Trả {ok, channelId, title} hoặc ném HttpError (đã ghi lastError).
  async function callback({ state, code, error }) {
    if (error) {
      const id = oauth.discard(state);
      throw fail(id, new HttpError(400, 'yt_denied', error === 'access_denied' ? 'Bạn đã không cấp quyền cho app.' : `Google báo lỗi: ${String(error).slice(0, 80)}`));
    }
    let tokens;
    try {
      tokens = await oauth.finish({ state, code });
    } catch (e) {
      throw fail(e?.channelId ?? null, toHttpError(e));
    }
    const id = tokens.channelId;
    try {
      const token = async () => tokens.accessToken;
      const ch = await api.myChannel(token);
      if (!ch) throw new HttpError(400, 'yt_no_channel', 'Tài khoản Google này chưa có kênh YouTube — chọn đúng tài khoản / kênh thương hiệu ở màn hình Google.');
      const dup = store.ytChannels().find((r) => r.yt_channel_id === ch.id && r.id !== id);
      if (dup) throw new HttpError(409, 'yt_dup', `Kênh "${ch.title}" đã gắn với mục "${dup.id}". Chọn kênh khác ở màn hình Google.`);
      await oauth.saveTokens(id, tokens);
      const canUpload = UPLOAD_SCOPES.every((s) => tokens.scopes.includes(s));
      store.ytSaveChannel({ id, yt_channel_id: ch.id, title: ch.title, status: 'ok', can_upload: canUpload });
      store.ytClearCache(id);
      lastError.delete(id);
      emit();
      return { ok: true, channelId: id, title: ch.title };
    } catch (e) {
      throw fail(id, toHttpError(e));
    }
  }

  // Ngắt kết nối: thu hồi token ở Google, xóa khỏi Keychain + DB.
  async function disconnect(channelId) {
    needConnected(channelId);
    const r = await oauth.revoke(channelId);
    store.ytDeleteChannel(channelId);
    inflight.forEach((_, k) => k.startsWith(`${channelId}:`) && inflight.delete(k));
    emit();
    return { ok: true, revoked: r.revoked };
  }

  // Lấy số liệu (kind 'stats' | 'videos'): cache còn hạn → trả luôn; refresh hoặc hết hạn → gọi Google (gộp lượt trùng).
  async function cached(channelId, kind, refresh) {
    const row = needConnected(channelId);
    const hit = store.ytCacheGet(channelId, kind);
    const fresh = hit && now() - Date.parse(hit.fetched_at) < cacheTtlMs;
    if (hit && fresh && !refresh) return { ...hit.data, fetchedAt: hit.fetched_at, cached: true };
    const key = `${channelId}:${kind}`;
    if (!inflight.has(key)) {
      const token = (force) => oauth.accessToken(channelId, { force });
      const p = (kind === 'stats' ? api.channelStats(token, { today: quotaDay(new Date(now())) }) : api.videos(token, { today: quotaDay(new Date(now())) }))
        .then((data) => {
          const at = store.ytCachePut(channelId, kind, data, new Date(now()).toISOString());
          if (row.status !== 'ok') store.ytSetChannelStatus(channelId, 'ok');
          return { ...data, fetchedAt: at, cached: false };
        })
        .catch((e) => {
          const he = toHttpError(e);
          if (he?.code === 'yt_reauth') store.ytSetChannelStatus(channelId, 'reauth');
          throw he;
        })
        .finally(() => {
          inflight.delete(key);
          emit();
        });
      inflight.set(key, p);
    }
    return inflight.get(key);
  }

  return {
    status,
    setup,
    clearSetup,
    connect,
    cancelConnect,
    callback,
    disconnect,
    stats: (id, { refresh = false } = {}) => cached(id, 'stats', refresh),
    videos: (id, { refresh = false } = {}) => cached(id, 'videos', refresh),
    accessToken: (id, opts) => oauth.accessToken(id, opts),
    endpoints,
    googleClient: () => oauth.getClient(),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
