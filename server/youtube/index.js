// Dịch vụ "Kênh YouTube": thiết lập client Google, thêm kênh bằng đăng nhập Google (lưu DB), số liệu có cache SQLite, hạn mức.
import { spawn } from 'node:child_process';
import { BROWSER_SCRIPT } from '../claude-account.js';
import { listChromeProfiles } from '../chrome-profiles.js';
import { HttpError } from '../projects.js';
import { DAILY_QUOTA, PERIOD_DAYS, createYouTubeApi, parseRange, quotaDay } from './api.js';
import { googleEndpoints, toHttpError } from './http.js';
import { READ_SCOPES, UPLOAD_SCOPES, clientHint, createOAuth } from './oauth.js';

export const CACHE_TTL_MS = 6 * 3600_000;
export const CALLBACK_PATH = '/api/youtube/oauth/callback';
// Khóa luồng "Thêm kênh" (chưa có mã kênh cho tới khi Google trả về) — không trùng mã kênh vì có ký tự '+'.
export const NEW_CHANNEL = '+new';

// Tên kênh → mã nội bộ: bỏ dấu, chữ thường, nối bằng '-' ("Bếp Nhà Mình" → "bep-nha-minh").
export function slugify(title) {
  const s = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'kenh';
}

// Mã chưa dùng: slug, slug-2, slug-3…
export function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// Kênh YouTube đã thêm (DB) theo dạng Channel chung của app.
export const ytChannelList = (store) => store.ytChannels().map((r) => ({ id: r.id, name: r.title || r.id, platform: 'youtube', videos_dir: null }));

// Mở URL trong hồ sơ Chrome đã chọn (cùng script với đăng nhập Claude); không chờ, không đọc output.
export function openInChromeProfile(url, profileDir, { script = BROWSER_SCRIPT } = {}) {
  const child = spawn('/bin/sh', [script, url], { stdio: 'ignore', detached: true, env: { ...process.env, VS_CHROME_PROFILE: profileDir } });
  child.on('error', () => {});
  child.unref();
}

// Tạo dịch vụ YouTube. deps: store (db.js), secrets (keychain.js), channels() → mọi kênh của app (để tránh trùng mã), fetch?, googleBase?,
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

  const needChannel = (id) => {
    const row = typeof id === 'string' ? store.ytChannel(id) : null;
    if (!row) throw new HttpError(404, 'not_found', 'Không có kênh này — có thể đã bị xóa.');
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
      adding: pending.has(NEW_CHANNEL),
      addError: lastError.get(NEW_CHANNEL) ?? null,
      channels: [...rows.values()].map((r) => ({
        id: r.id,
        name: r.title || r.id,
        ytChannelId: r.yt_channel_id,
        title: r.title,
        status: r.status,
        canUpload: !!r.can_upload,
        connectedAt: r.connected_at,
        pending: pending.has(r.id),
        lastError: lastError.get(r.id) ?? null,
      })),
    };
  }

  async function setup(text) {
    await oauth.setClient(text);
    emit();
    return status();
  }

  // Xóa client Google; còn kênh kết nối thì chặn (token phụ thuộc client).
  async function clearSetup() {
    if (store.ytChannels().length) throw new HttpError(409, 'yt_has_channels', 'Xóa mọi kênh trước khi xóa thiết lập Google.');
    await oauth.clearClient();
    emit();
    return status();
  }

  // Bắt đầu đăng nhập Google: channelId = NEW_CHANNEL → thêm kênh mới, mã kênh có sẵn → kết nối lại kênh đó.
  // Tạo URL đăng nhập; có hồ sơ Chrome → mở luôn trong hồ sơ đó.
  async function connect({ channelId = NEW_CHANNEL, redirectUri, profileDir = null, upload = false }) {
    if (channelId !== NEW_CHANNEL) needChannel(channelId);
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

  function cancelConnect(channelId = NEW_CHANNEL) {
    if (channelId !== NEW_CHANNEL) needChannel(channelId);
    const ok = oauth.cancel(channelId);
    emit();
    return { ok };
  }

  const fail = (channelId, e) => {
    if (channelId) lastError.set(channelId, { code: e.code || 'yt_error', message: e.message, at: new Date(now()).toISOString() });
    emit();
    return e;
  };

  // Google chuyển về: đổi code → token, đọc kênh, lưu (thêm mới hoặc kết nối lại đúng kênh cũ).
  // Trả {ok, channelId, title, added} hoặc ném HttpError (đã ghi lastError).
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
    const flowId = tokens.channelId;
    try {
      const token = async () => tokens.accessToken;
      const ch = await api.myChannel(token);
      if (!ch) throw new HttpError(400, 'yt_no_channel', 'Tài khoản Google này chưa có kênh YouTube — chọn đúng tài khoản / kênh thương hiệu ở màn hình Google.');
      const rows = store.ytChannels();
      const added = flowId === NEW_CHANNEL;
      let id = flowId;
      if (added) {
        const dup = rows.find((r) => r.yt_channel_id === ch.id);
        if (dup) throw new HttpError(409, 'yt_dup', `Kênh "${ch.title}" đã được thêm rồi.`);
        const taken = new Set([...rows.map((r) => r.id), ...(channels() || []).map((c) => c.id)]);
        id = uniqueId(slugify(ch.title), taken);
      } else {
        const row = rows.find((r) => r.id === flowId);
        if (!row) throw new HttpError(404, 'not_found', 'Kênh này đã bị xóa trong lúc đăng nhập.');
        if (row.yt_channel_id !== ch.id) throw new HttpError(409, 'yt_wrong_channel', `Bạn vừa chọn kênh "${ch.title}" — hãy chọn đúng kênh "${row.title}" ở màn hình Google.`);
      }
      await oauth.saveTokens(id, tokens);
      const canUpload = UPLOAD_SCOPES.every((s) => tokens.scopes.includes(s));
      store.ytSaveChannel({ id, yt_channel_id: ch.id, title: ch.title, status: 'ok', can_upload: canUpload });
      store.ytClearCache(id);
      lastError.delete(flowId);
      emit();
      return { ok: true, channelId: id, title: ch.title, added };
    } catch (e) {
      throw fail(flowId, toHttpError(e));
    }
  }

  // Xóa kênh: thu hồi token ở Google, xóa khỏi Keychain + DB.
  async function disconnect(channelId) {
    needChannel(channelId);
    lastError.delete(channelId);
    oauth.cancel(channelId);
    const r = await oauth.revoke(channelId);
    store.ytDeleteChannel(channelId);
    inflight.forEach((_, k) => k.startsWith(`${channelId}:`) && inflight.delete(k));
    emit();
    return { ok: true, revoked: r.revoked };
  }

  // Khoảng ngày hợp lệ (theo ngày hạn mức hiện tại) hoặc 400.
  function needRange(range) {
    const r = parseRange(range ?? PERIOD_DAYS, quotaDay(new Date(now())));
    if (!r) throw new HttpError(400, 'invalid_range', 'Khoảng ngày không hợp lệ.');
    return r;
  }

  // Lấy số liệu theo kind ('stats', 'stats:<khoảng>', 'videos', 'vstats:<khoảng>'): cache còn hạn → trả luôn;
  // refresh hoặc hết hạn → fetcher(token, today) gọi Google (gộp lượt trùng).
  async function cached(channelId, kind, refresh, fetcher) {
    const row = needChannel(channelId);
    const hit = store.ytCacheGet(channelId, kind);
    const fresh = hit && now() - Date.parse(hit.fetched_at) < cacheTtlMs;
    if (hit && fresh && !refresh) return { ...hit.data, fetchedAt: hit.fetched_at, cached: true };
    const key = `${channelId}:${kind}`;
    if (!inflight.has(key)) {
      const token = (force) => oauth.accessToken(channelId, { force });
      const today = quotaDay(new Date(now()));
      const p = fetcher(token, today)
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

  // Thay đổi sub/view "hôm nay" theo giờ máy: số mới nhất − mốc cuối của ngày trước (chưa có thì mốc đầu hôm nay).
  // Lượt vừa gọi Google thì ghi mốc trước; null khi chưa đủ hai mốc để so.
  function todayOf(id, res) {
    const d = new Date(now());
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!res.cached && res.channel) store.ytDailyPut(id, day, { subs: res.channel.subscribers ?? null, views: res.channel.views ?? null }, res.fetchedAt);
    const cur = store.ytDailyGet(id, day);
    if (!cur) return null;
    const prev = store.ytDailyPrev(id, day);
    const base = prev ? { subs: prev.subs, views: prev.views, since: prev.day } : cur.first_at !== cur.at ? { subs: cur.first_subs, views: cur.first_views, since: cur.first_at } : null;
    if (!base) return null;
    const diff = (a, b) => (a == null || b == null ? null : a - b);
    return { subs: diff(cur.subs, base.subs), views: diff(cur.views, base.views), since: base.since, at: cur.at };
  }

  return {
    status,
    setup,
    clearSetup,
    connect,
    cancelConnect,
    callback,
    disconnect,
    // range: "7"|"28"|"90"|"365"|"YYYY-MM-DD_YYYY-MM-DD"; 28 ngày giữ kind 'stats' cũ.
    stats: async (id, { refresh = false, range } = {}) => {
      const r = needRange(range);
      const res = await cached(id, r.key === String(PERIOD_DAYS) ? 'stats' : `stats:${r.key}`, refresh, (t, today) => api.channelStats(t, { today, range: r.key }));
      return { ...res, today: todayOf(id, res) };
    },
    videos: (id, { refresh = false } = {}) => cached(id, 'videos', refresh, (t, today) => api.videos(t, { today })),
    videoStats: async (id, { refresh = false, range } = {}) => {
      const r = needRange(range);
      return cached(id, `vstats:${r.key}`, refresh, (t, today) => api.videoStats(t, { today, range: r.key }));
    },
    accessToken: (id, opts) => oauth.accessToken(id, opts),
    endpoints,
    googleClient: () => oauth.getClient(),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
