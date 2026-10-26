// HTTP server của Video Studio (hợp đồng M1 §9, §9.2, §10): Fastify + auth + SSE + media + web/dist.
// Không import runner.js — runner (EventEmitter) được truyền vào qua deps.
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { clearTokenCookie, htmlPage, isPagePath, loginPage, parseCookies, registerAuth, splitUrl } from './auth.js';
import { runDoctor } from './doctor.js';
import { mediaHandler } from './media.js';
import { isInside, safeJoin } from './paths.js';
import { REPO_ROOT } from './presets.js';
import { HttpError } from './projects.js';
import { LOGIN_CALLBACK_PATH, SESSION_COOKIE, sessionCookie } from './login.js';
import { createHub } from './sse.js';
import { CALLBACK_PATH } from './youtube/index.js';

export const BODY_LIMIT = 256 * 1024;
export const MAX_FEEDBACK = 20_000;
export const DOCTOR_TTL_MS = 60_000;
export const DEFAULT_WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');
const INTERNAL_MESSAGE = 'Lỗi máy chủ nội bộ. Xem log ở terminal đang chạy server.';
const WAITING_STATES = new Set(['needs_input', 'failed', 'manual']);
const PRESET_FIELDS = ['id', 'name', 'channel', 'format', 'file', 'yaml', 'project_dir', 'skills', 'vars', 'permissions', 'defaults', 'steps'];

const STATIC_TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain; charset=utf-8', wasm: 'application/wasm',
};

let cachedVersion = null;
// Phiên bản app (field version của package.json ở gốc repo); lỗi đọc → '0.0.0'.
export function appVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = String(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || '0.0.0');
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

// Mốc đầu tháng hiện tại (giờ máy, 00:00 ngày 1) dạng ISO UTC — dùng cho stats.tokens_month.
export function monthStartIso(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

// Rút gọn một run (row DB) thành RunSummary (§6); null → null.
export function runSummary(r) {
  if (!r) return null;
  return {
    id: r.id,
    n: r.n,
    state: r.state,
    started_at: r.started_at,
    ended_at: r.ended_at ?? null,
    summary: r.summary ?? null,
    error: r.error ?? null,
    progress_pct: r.progress_pct ?? null,
    progress_msg: r.progress_msg ?? null,
    exit_code: r.exit_code ?? null,
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHttpError = (e) => e instanceof HttpError || (!!e && e.name === 'HttpError' && Number.isInteger(e.status) && typeof e.code === 'string');
const badBody = (message) => new HttpError(400, 'invalid_body', message);
const notFound = (message = 'Không tìm thấy.') => new HttpError(404, 'not_found', message);
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const callList = (v) => (typeof v === 'function' ? v() : v);

// Số nguyên ≥ 0 từ query; sai → fallback.
function intParam(v, fallback) {
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v.trim())) return fallback;
  return Number(v.trim());
}

function guidePage(distDir) {
  const esc = escHtml;
  return htmlPage(
    'Video Studio — chưa build giao diện',
    `<p>Server đang chạy nhưng chưa có bản build giao diện (<code>${esc(distDir)}</code>).</p>
<p>Mở terminal trong thư mục <code>${esc(REPO_ROOT)}</code> và chạy <code>npm run build</code>, rồi tải lại trang này.</p>
<p>Khi đang phát triển giao diện: chạy server với <code>--dev</code> rồi <code>npm run dev:web</code> (Vite chuyển <code>/api</code>, <code>/media</code> sang server).</p>`,
  );
}

// Tạo Fastify app với mọi endpoint §9.2. deps: {store, projects, runner, presets, channels, token, webDist, doctor,
// account? (createClaudeAccount — thiếu thì các route /api/claude/* trả 503), youtube? (createYouTube — thiếu thì /api/youtube/* trả 503), googleWizard? (createGoogleWizard), login? (createLogin — đăng nhập Google), updater? (createUpdater — báo bản mới), home?, hub?, logger?, logError?, doctorTtlMs?}. Không listen — cli.js/test tự listen hoặc dùng app.inject.
export async function buildApp({
  store,
  projects,
  runner = null,
  presets = () => ({ presets: [], errors: [] }),
  channels = () => [],
  token,
  webDist = DEFAULT_WEB_DIST,
  doctor = null,
  account = null,
  youtube = null,
  googleWizard = null,
  login = null,
  updater = null,
  home = null,
  hub = null,
  logger = false,
  logError = (err) => console.error('[video-studio] Lỗi máy chủ:', err),
  doctorTtlMs = DOCTOR_TTL_MS,
} = {}) {
  if (!store) throw new Error('buildApp cần store.');
  if (!projects) throw new Error('buildApp cần projects.');
  const version = appVersion();
  const distDir = path.resolve(webDist || DEFAULT_WEB_DIST);
  const sse = hub || createHub();
  const runDoctorFn = typeof doctor === 'function'
    ? doctor
    : () => runDoctor({ claudeBin: process.env.VS_CLAUDE_BIN || 'claude' });

  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT,
    routerOptions: { maxParamLength: 500 },
    return503OnClosing: true,
  });

  // JSON: thân rỗng → undefined (nút Dừng/Đánh dấu xong có thể gửi rỗng); còn lại dùng parser mặc định (chống proto poisoning).
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (req, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') return done(null, undefined);
    return defaultJson(req, body, done);
  });
  // Form HTML của trang đăng nhập (/auth/setup, /auth/password); /api vẫn chỉ nhận JSON (hook 415 bên dưới).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  // ---- web/dist
  let realDist = null;
  const distRoot = () => {
    if (realDist) return realDist;
    try {
      realDist = fs.realpathSync(distDir);
    } catch {
      return null;
    }
    return realDist;
  };
  const indexFile = () => {
    const root = distRoot();
    if (!root) return null;
    try {
      const f = path.join(root, 'index.html');
      return fs.statSync(f).isFile() ? f : null;
    } catch {
      return null;
    }
  };
  // File tĩnh trong web/dist theo pathname (chặn dotfile, ../, symlink ra ngoài); không có → null.
  const staticFile = (pathname) => {
    const root = distRoot();
    if (!root) return null;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (rel.includes('\0')) return null;
    const segs = rel.split(/[\\/]+/).filter(Boolean);
    if (!segs.length || segs.some((s) => s.startsWith('.'))) return null;
    try {
      const abs = fs.realpathSync(safeJoin(root, segs.join('/')));
      if (!isInside(root, abs) || abs === root) return null;
      const stat = fs.statSync(abs);
      return stat.isFile() ? { abs, stat } : null;
    } catch {
      return null;
    }
  };
  const isIndex = (abs) => abs === indexFile();

  // Route không cần token: /api/health và file tĩnh có thật (trừ index.html — trang app cần token).
  const isPublic = (req, pathname) => {
    if (pathname === '/api/health') return true;
    // Google chuyển về sau khi đăng nhập (có thể ở hồ sơ Chrome không có cookie app) — tự bảo vệ bằng state một lần.
    if (pathname === CALLBACK_PATH && req.method === 'GET' && !!youtube) return true;
    // Trang đăng nhập Google: tự bảo vệ bằng state một lần + kiểm chủ.
    if ((pathname === '/auth/google' || pathname === LOGIN_CALLBACK_PATH) && req.method === 'GET' && !!login) return true;
    // Form tạo mật khẩu / đăng nhập: tự kiểm mã thiết lập / mật khẩu (Origin lạ đã bị chặn 403 ở trên).
    if ((pathname === '/auth/setup' || pathname === '/auth/password') && req.method === 'POST' && !!login) return true;
    if (!isPagePath(pathname)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (pathname.startsWith('/assets/')) return true;
    if (pathname === '/') return false;
    const f = staticFile(pathname);
    return !!f && !isIndex(f.abs);
  };

  const sessionOf = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
  // Có nút Google trên trang đăng nhập khi đã bật + client Google còn.
  const googleReady = async () => {
    if (!login) return false;
    const st = await login.status().catch(() => null);
    return !!(st?.enabled && st?.configured);
  };
  const authPage = async (error = null) =>
    loginPage({ mode: !login ? null : login.hasPassword() ? 'password' : 'setup', google: await googleReady(), error });
  registerAuth(app, {
    token,
    isPublic,
    session: (req) => !!login && login.check(sessionOf(req)),
    page: () => authPage(),
  });

  // Lệnh ghi dưới /api bắt buộc Content-Type JSON (kể cả thân rỗng) → trang lạ không gửi được "simple request" (CSRF).
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!req.routeOptions?.url || !splitUrl(req.url).pathname.startsWith('/api/')) return; // route lạ → để 404
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'invalid_body', 'Chỉ nhận dữ liệu JSON (Content-Type: application/json).');
  });

  // ---- lỗi
  app.setErrorHandler((err, req, reply) => {
    if (isHttpError(err)) {
      const body = typeof err.toJSON === 'function' ? err.toJSON() : { error: err.code, message: err.message };
      return reply.code(err.status).type('application/json; charset=utf-8').send(body);
    }
    const sc = Number(err?.statusCode);
    if (sc >= 400 && sc < 500) {
      let message = 'Dữ liệu gửi lên không hợp lệ.';
      if (sc === 413) message = `Dữ liệu gửi lên quá lớn (tối đa ${BODY_LIMIT / 1024} KB).`;
      else if (sc === 415) message = 'Chỉ nhận dữ liệu JSON (Content-Type: application/json).';
      const code = sc === 404 ? 'not_found' : 'invalid_body';
      return reply.code(sc).type('application/json; charset=utf-8').send({ error: code, message: sc === 404 ? 'Không tìm thấy.' : message });
    }
    try {
      logError(err);
    } catch {
      /* bỏ qua lỗi khi log */
    }
    return reply.code(500).type('application/json; charset=utf-8').send({ error: 'internal', message: INTERNAL_MESSAGE });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'Không tìm thấy.' });
  });

  // ---- SSE + runner
  const onEvent = (e) => {
    if (!e || !e.event) return;
    sse.broadcast('log', { runId: e.runId, projectId: e.projectId, event: e.event });
  };
  const onChange = (e) => sse.broadcast('change', { projectId: e?.projectId ?? null });
  if (runner && typeof runner.on === 'function') {
    runner.on('event', onEvent);
    runner.on('change', onChange);
  }
  app.addHook('preClose', async () => {
    sse.closeAll();
  });
  app.addHook('onClose', async () => {
    if (runner && typeof runner.off === 'function') {
      runner.off('event', onEvent);
      runner.off('change', onChange);
    }
    offAccount();
    offYoutube();
    offWizard();
    offUpdater();
  });

  // ---- doctor (cache 60 s; ?refresh=1 bỏ cache; lỗi không cache)
  let doctorCache = null; // {at, promise}
  const getDoctor = (refresh) => {
    const fresh = doctorCache && Date.now() - doctorCache.at < doctorTtlMs;
    if (!refresh && fresh) return doctorCache.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = Promise.resolve()
      .then(() => runDoctorFn())
      .catch((e) => {
        if (doctorCache === entry) doctorCache = null;
        throw e;
      });
    doctorCache = entry;
    return entry.promise;
  };

  // ---- tài khoản Claude: lệnh auth bắt đầu/xong → bỏ cache doctor + báo UI qua SSE 'account'
  const offAccount = account && typeof account.on === 'function'
    ? account.on((status) => {
        doctorCache = null;
        sse.broadcast('account', status);
      })
    : () => {};
  const needAccount = () => {
    if (!account) throw new HttpError(503, 'account_unavailable', 'Chức năng tài khoản Claude chưa bật trên server này.');
    return account;
  };
  // Đổi tài khoản giữa lúc claude -p đang chạy sẽ làm hỏng lượt đó → chặn.
  const noRunsActive = () => {
    const running = projects.list().filter((p) => p.status === 'running').length;
    if (running) throw new HttpError(409, 'runs_active', `Đang có ${running} dự án chạy bước — đợi xong hoặc bấm Dừng rồi mới đăng nhập / đăng xuất.`);
  };

  // ---- YouTube: đổi trạng thái → SSE 'youtube' (UI tự tải lại)
  const offYoutube = youtube && typeof youtube.on === 'function' ? youtube.on(() => sse.broadcast('youtube', {})) : () => {};
  const offWizard = googleWizard ? googleWizard.on(() => sse.broadcast('google-setup', {})) : () => {};
  const offUpdater = updater ? updater.on(() => sse.broadcast('update', updater.status())) : () => {};

  // ---- Bản mới (Release GitHub). Không có updater → coi như không có bản mới.
  app.get('/api/update', async () => (updater ? updater.check() : { current: version, latest: null, newer: false, state: 'idle', canRestart: false }));
  app.post('/api/update', async () => {
    if (!updater) throw new HttpError(503, 'update_unavailable', 'Chức năng cập nhật chưa bật trên server này.');
    const st = await updater.check();
    if (!st.newer) throw new HttpError(409, 'update_none', 'Đang là bản mới nhất.');
    return updater.start();
  });
  // Khởi động lại (chỉ khi chạy nền — launchd tự mở lại); trả lời trước rồi mới thoát.
  app.post('/api/update/restart', async (req, reply) => {
    if (!updater?.status().canRestart) throw new HttpError(409, 'restart_unavailable', 'Chỉ khởi động lại được khi app chạy nền — hãy tắt rồi mở lại video-studio.');
    reply.raw.on('finish', () => setTimeout(() => updater.restart(), 100));
    return { ok: true };
  });
  const needWizard = () => {
    if (!googleWizard) throw new HttpError(503, 'youtube_unavailable', 'Chức năng thiết lập Google chưa bật trên server này.');
    return googleWizard;
  };
  const needYoutube = () => {
    if (!youtube) throw new HttpError(503, 'youtube_unavailable', 'Chức năng YouTube chưa bật trên server này.');
    return youtube;
  };
  // Địa chỉ loopback Google chuyển về (client "Ứng dụng máy tính" chấp nhận mọi cổng trên 127.0.0.1 / [::1]).
  const loopbackOrigin = () => {
    const a = app.server.address();
    const host = a && typeof a === 'object' && a.family === 'IPv6' ? '[::1]' : '127.0.0.1';
    return `http://${host}:${a && typeof a === 'object' ? a.port : 0}`;
  };
  const redirectUri = () => `${loopbackOrigin()}${CALLBACK_PATH}`;
  const bodyOf = (req, hint) => {
    const b = req.body === undefined || req.body === null ? {} : req.body;
    if (!isObject(b)) throw badBody(`Cần gửi JSON ${hint}.`);
    return b;
  };
  const optStr = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw badBody(`${name} phải là chuỗi.`);
    return v;
  };
  const isRefresh = (req) => req.query?.refresh === '1' || req.query?.refresh === 'true';

  // ---- API
  app.get('/api/health', async () => ({ ok: true, version }));

  app.get('/api/doctor', async (req) => {
    const r = await getDoctor(req.query?.refresh === '1' || req.query?.refresh === 'true');
    return {
      claude: r?.claude ?? { found: false, path: null, version: null },
      auth: r?.auth ?? null,
      node: r?.node ?? process.version,
      platform: r?.platform ?? process.platform,
      home: home ?? null,
      problems: Array.isArray(r?.problems) ? r.problems : [],
    };
  });

  app.get('/api/claude/account', async () => needAccount().status());

  app.get('/api/chrome-profiles', async () => needAccount().profiles());

  app.post('/api/claude/login', async (req, reply) => {
    const acc = needAccount();
    const b = req.body === undefined || req.body === null ? {} : req.body;
    if (!isObject(b)) throw badBody('Cần gửi JSON {method?, profileDir?}.');
    if (b.method !== undefined && typeof b.method !== 'string') throw badBody('Cách đăng nhập phải là "claudeai" hoặc "console".');
    if (b.profileDir !== undefined && b.profileDir !== null && typeof b.profileDir !== 'string') throw badBody('profileDir phải là chuỗi.');
    noRunsActive();
    return reply.code(202).send(acc.login({ method: b.method ?? 'claudeai', profileDir: b.profileDir ?? null }));
  });

  app.post('/api/claude/login/cancel', async () => needAccount().cancel());

  app.post('/api/claude/logout', async () => {
    const acc = needAccount();
    noRunsActive();
    return acc.logout();
  });

  app.get('/api/channels', async () => callList(channels) ?? []);

  app.get('/api/youtube', async () => needYoutube().status());

  app.post('/api/youtube/setup', async (req) => {
    const yt = needYoutube();
    const b = bodyOf(req, '{clientSecret}');
    if (typeof b.clientSecret !== 'string' || !b.clientSecret.trim()) throw badBody('Dán nội dung file client_secret.json.');
    if (b.clientSecret.length > 20_000) throw badBody('Nội dung quá dài — chỉ dán file client_secret.json.');
    const r = await yt.setup(b.clientSecret);
    await googleWizard?.manualDone();
    return r;
  });

  app.post('/api/youtube/setup/clear', async () => {
    if (login?.enabled()) throw new HttpError(409, 'login_enabled', 'Tắt "Đăng nhập Google" trước khi xóa thiết lập Google.');
    const r = await needYoutube().clearSetup();
    googleWizard?.clientCleared();
    return r;
  });

  // ---- Thiết lập Google tự động (wizard)
  app.get('/api/youtube/wizard', async () => needWizard().status());

  app.post('/api/youtube/wizard/start', async (req) => {
    const w = needWizard();
    const b = bodyOf(req, '{profileDir?}');
    return w.start({ profileDir: optStr(b.profileDir, 'profileDir') });
  });

  app.post('/api/youtube/wizard/project', async (req) => {
    const w = needWizard();
    const b = bodyOf(req, '{projectId}');
    if (typeof b.projectId !== 'string' || !b.projectId) throw badBody('Chọn một dự án.');
    return w.useProject(b.projectId);
  });

  app.post('/api/youtube/wizard/open', async (req) => {
    const w = needWizard();
    const b = bodyOf(req, '{page}');
    if (typeof b.page !== 'string') throw badBody('Thiếu trang cần mở.');
    return w.open(b.page);
  });

  app.post('/api/youtube/wizard/download', async (req) => {
    const w = needWizard();
    const b = bodyOf(req, '{keep?}');
    return w.handleDownload({ keep: b.keep === true });
  });

  app.post('/api/youtube/wizard/next', async () => needWizard().next());
  app.post('/api/youtube/wizard/back', async () => needWizard().back());
  app.post('/api/youtube/wizard/cancel', async () => needWizard().cancel());
  app.post('/api/youtube/wizard/reset', async () => needWizard().reset());

  // Thêm kênh: đăng nhập Google, kênh được tạo khi Google trả về thành công.
  app.post('/api/youtube/channels/add', async (req) => {
    const yt = needYoutube();
    const b = bodyOf(req, '{profileDir?}');
    const profileDir = optStr(b.profileDir, 'profileDir');
    return yt.connect({ redirectUri: redirectUri(), profileDir });
  });

  app.post('/api/youtube/channels/add/cancel', async () => needYoutube().cancelConnect());

  app.post('/api/youtube/channels/:id/connect', async (req) => {
    const yt = needYoutube();
    const b = bodyOf(req, '{profileDir?}');
    const profileDir = optStr(b.profileDir, 'profileDir');
    return yt.connect({ channelId: req.params.id, redirectUri: redirectUri(), profileDir });
  });

  app.post('/api/youtube/channels/:id/connect/cancel', async (req) => needYoutube().cancelConnect(req.params.id));

  app.post('/api/youtube/channels/:id/disconnect', async (req) => needYoutube().disconnect(req.params.id));

  app.get('/api/youtube/channels/:id/stats', async (req) => needYoutube().stats(req.params.id, { refresh: isRefresh(req) }));

  app.get('/api/youtube/channels/:id/videos', async (req) => needYoutube().videos(req.params.id, { refresh: isRefresh(req) }));

  // Trang Google chuyển về: không lộ code/token; chỉ báo kết quả để người dùng quay lại app.
  app.get(CALLBACK_PATH, async (req, reply) => {
    const yt = needYoutube();
    const q = req.query || {};
    const one = (v) => (typeof v === 'string' ? v : null);
    reply.header('cache-control', 'no-store').type('text/html; charset=utf-8');
    try {
      const r = await yt.callback({ state: one(q.state), code: one(q.code), error: one(q.error) });
      return htmlPage('Đã kết nối YouTube', `<p>${r.added ? 'Đã thêm' : 'Đã kết nối lại'} kênh <b>${escHtml(r.title)}</b>.</p><p>Đóng tab này và quay lại Video Studio.</p>`);
    } catch (e) {
      if (!isHttpError(e)) logError(e);
      const msg = isHttpError(e) ? e.message : INTERNAL_MESSAGE;
      return reply.code(isHttpError(e) ? e.status : 500).send(htmlPage('Chưa kết nối được', `<p>${escHtml(msg)}</p><p>Quay lại Video Studio và thử lại.</p>`));
    }
  });

  // ---- Đăng nhập Google (1 chủ). Cookie phiên SameSite=Strict: callback trả trang tự chuyển (meta refresh)
  // thay vì 302, để lần tải "/" là điều hướng cùng site và trình duyệt gửi cookie.
  const needLogin = () => {
    if (!login) throw new HttpError(503, 'login_unavailable', 'Chức năng đăng nhập Google chưa bật trên server này.');
    return login;
  };
  const loginError = async (reply, e) => {
    if (!isHttpError(e)) logError(e);
    const msg = isHttpError(e) ? e.message : INTERNAL_MESSAGE;
    return reply.code(isHttpError(e) ? e.status : 500).type('text/html; charset=utf-8').header('cache-control', 'no-store')
      .send(await authPage(msg));
  };

  app.get('/api/auth', async (req) => {
    const st = login ? await login.status() : { enabled: false, configured: false };
    return { google: { available: !!login, ...st }, password: !!login?.hasPassword(), via: login?.check(sessionOf(req)) ? 'session' : 'token' };
  });

  // Form HTML (không script): đúng → cookie phiên + 303 về "/" (cùng site nên cookie Strict vẫn được gửi).
  const formOpts = { bodyLimit: 4096 };
  const signedIn = (reply, sessionId) => reply.code(303).header('set-cookie', sessionCookie(sessionId)).header('location', '/').header('cache-control', 'no-store').send();
  app.post('/auth/setup', formOpts, async (req, reply) => {
    try {
      const b = req.body || {};
      return signedIn(reply, await needLogin().setupPassword({ code: b.code, password: b.password, confirm: b.confirm }));
    } catch (e) {
      return loginError(reply, e);
    }
  });
  app.post('/auth/password', formOpts, async (req, reply) => {
    try {
      return signedIn(reply, await needLogin().loginPassword((req.body || {}).password));
    } catch (e) {
      return loginError(reply, e);
    }
  });

  app.post('/api/auth/google/enable', async () => ({ authUrl: (await needLogin().begin({ mode: 'claim', redirectUri: `${loopbackOrigin()}${LOGIN_CALLBACK_PATH}` })).authUrl }));

  app.post('/api/auth/google/disable', async () => {
    needLogin().disable();
    return { ok: true };
  });

  // Đăng xuất khỏi Video Studio (không đụng Google / Claude): xóa phiên + cookie token.
  app.post('/api/auth/logout', async (req, reply) => {
    login?.logout(sessionOf(req));
    reply.header('set-cookie', [sessionCookie('', 0), clearTokenCookie()]);
    return { ok: true };
  });

  app.get('/auth/google', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const origin = loopbackOrigin();
      // Cookie gắn theo host: luôn đăng nhập trên đúng host Google chuyển về.
      if (`http://${String(req.headers.host).toLowerCase()}` !== origin) return reply.redirect(`${origin}/auth/google`, 302);
      const { authUrl } = await needLogin().begin({ mode: 'login', redirectUri: `${origin}${LOGIN_CALLBACK_PATH}` });
      return reply.redirect(authUrl, 302);
    } catch (e) {
      return loginError(reply, e);
    }
  });

  app.get(LOGIN_CALLBACK_PATH, async (req, reply) => {
    const q = req.query || {};
    const one = (v) => (typeof v === 'string' ? v : null);
    reply.header('cache-control', 'no-store');
    try {
      const r = await needLogin().finish({ state: one(q.state), code: one(q.code), error: one(q.error) });
      const to = r.mode === 'claim' ? '/#/channels' : '/';
      reply.header('set-cookie', sessionCookie(r.sessionId)).type('text/html; charset=utf-8');
      return htmlPage(r.mode === 'claim' ? 'Đã bật đăng nhập Google' : 'Đã đăng nhập', `<p><a href="${to}">Tiếp tục vào Video Studio</a></p>`, { refresh: to });
    } catch (e) {
      return loginError(reply, e);
    }
  });

  app.get('/api/presets', async () => {
    const res = callList(presets) ?? {};
    const list = Array.isArray(res) ? res : Array.isArray(res.presets) ? res.presets : [];
    const out = list.map((p) => {
      const o = {};
      for (const k of PRESET_FIELDS) o[k] = p[k] ?? null;
      return o;
    });
    return { presets: out, errors: Array.isArray(res.errors) ? res.errors : [] };
  });

  app.get('/api/projects', async () => {
    const list = projects.list();
    const stats = { total: list.length, running: 0, waiting: 0, done: 0, tokens_month: 0 };
    for (const p of list) {
      if (p.status === 'running') stats.running++;
      if (p.status === 'done') stats.done++;
      for (const s of p.steps || []) if (WAITING_STATES.has(s.state)) stats.waiting++;
    }
    stats.tokens_month = Number(store.tokensSince(monthStartIso())) || 0;
    return { projects: list, stats };
  });

  app.post('/api/projects', async (req, reply) => {
    const b = req.body;
    if (!isObject(b)) throw badBody('Cần gửi JSON {presetId, title, slug?, dir?}.');
    if (typeof b.presetId !== 'string' || !b.presetId.trim()) throw badBody('Thiếu presetId.');
    if (typeof b.title !== 'string') throw new HttpError(400, 'invalid_title', 'Tiêu đề phải là chuỗi 1–200 ký tự.');
    const opt = (v, code, message) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string') throw new HttpError(400, code, message);
      return v;
    };
    const slug = opt(b.slug, 'invalid_slug', 'Slug phải là chuỗi chữ thường, số, gạch ngang.');
    const dir = opt(b.dir, 'invalid_dir', 'Thư mục phải là đường dẫn tuyệt đối.');
    const view = projects.create({ presetId: b.presetId.trim(), title: b.title, slug, dir });
    sse.broadcast('change', { projectId: view.id });
    return reply.code(201).send(view);
  });

  app.get('/api/projects/:id', async (req) => {
    const v = projects.view(req.params.id);
    if (!v) throw notFound(`Không tìm thấy dự án "${req.params.id}".`);
    return v;
  });

  app.get('/api/projects/:id/steps/:key', async (req) => {
    const v = projects.stepView(req.params.id, req.params.key);
    if (!v) throw notFound(`Không tìm thấy bước "${req.params.key}" trong dự án "${req.params.id}".`);
    return v;
  });

  app.post('/api/projects/:id/steps/:key/run', async (req, reply) => {
    const b = req.body === undefined || req.body === null ? {} : req.body;
    if (!isObject(b)) throw badBody('Cần gửi JSON {feedback?, allowPaid?}.');
    const { feedback, allowPaid } = b;
    if (feedback !== undefined && feedback !== null && typeof feedback !== 'string') throw badBody('Góp ý phải là chuỗi.');
    if (typeof feedback === 'string' && feedback.length > MAX_FEEDBACK) throw badBody('Góp ý tối đa 20 000 ký tự.');
    if (allowPaid !== undefined && allowPaid !== null && typeof allowPaid !== 'boolean') throw badBody('allowPaid phải là true/false.');
    const paid = allowPaid === true;
    const chk = projects.canRun(req.params.id, req.params.key, { allowPaid: paid });
    if (!chk.ok) throw new HttpError(chk.status, chk.code, chk.message, chk.cost ? { cost: chk.cost } : undefined);
    if (!runner || typeof runner.start !== 'function') throw new Error('Runner chưa sẵn sàng.');
    const fb = typeof feedback === 'string' && feedback.trim() ? feedback : null;
    const run = await runner.start(req.params.id, req.params.key, { feedback: fb, allowPaid: paid });
    return reply.code(202).send({ run: runSummary(run) });
  });

  app.post('/api/runs/:id/stop', async (req) => {
    const run = store.getRun(req.params.id);
    if (!run) throw notFound('Không tìm thấy lượt chạy.');
    const ok = runner && typeof runner.stop === 'function' ? await runner.stop(req.params.id) : false;
    if (ok) return { ok: true };
    // DB còn 'running' mà runner này không trông (mồ côi sau khi server khởi động lại) → dừng hẳn để gỡ kẹt
    if (run.state === 'running' && typeof projects.abandonRun === 'function' && projects.abandonRun(run.id)) {
      sse.broadcast('change', { projectId: run.project_id });
      return { ok: true };
    }
    throw notFound('Lượt này không còn chạy.');
  });

  app.post('/api/projects/:id/steps/:key/complete', async (req) => {
    const view = projects.complete(req.params.id, req.params.key);
    sse.broadcast('change', { projectId: req.params.id });
    return view;
  });

  app.get('/api/runs/:id/events', async (req) => {
    const run = store.getRun(req.params.id);
    if (!run) throw notFound('Không tìm thấy lượt chạy.');
    const after = intParam(req.query?.after, 0);
    const limit = Math.min(Math.max(intParam(req.query?.limit, 1000), 1), 5000);
    const events = store.listEvents(run.id, after, limit).map((e) => ({
      seq: e.seq,
      ts: e.ts,
      kind: e.kind,
      text: e.text ?? null,
      payload: e.payload ?? null,
    }));
    return { events, done: run.state !== 'running' && events.length < limit };
  });

  app.get('/api/stream', (req, reply) => {
    sse.add(reply, { version });
  });

  // ---- media
  app.route({ method: ['GET', 'HEAD'], url: '/media/:projectId/*', handler: mediaHandler({ store }) });

  // ---- web/dist + SPA fallback + trang hướng dẫn build
  const sendStatic = (req, reply, { abs, stat }, cacheControl) => {
    const ext = path.extname(abs).slice(1).toLowerCase();
    reply
      .code(200)
      .header('content-type', STATIC_TYPES[ext] || 'application/octet-stream')
      .header('cache-control', cacheControl)
      .header('last-modified', stat.mtime.toUTCString())
      .header('content-length', stat.size);
    if (req.method === 'HEAD') return reply.send();
    if (stat.size === 0) return reply.send('');
    return reply.send(fs.createReadStream(abs));
  };

  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    handler: async (req, reply) => {
      const { pathname } = splitUrl(req.url);
      if (!isPagePath(pathname)) throw notFound();
      const f = pathname === '/' ? null : staticFile(pathname);
      if (f && !isIndex(f.abs)) {
        return sendStatic(req, reply, f, pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
      const last = pathname.split('/').pop() || '';
      if (!f && (pathname.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(last))) throw notFound('Không tìm thấy file.');
      const index = indexFile();
      if (!index) {
        return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(guidePage(distDir));
      }
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(fs.readFileSync(index));
    },
  });

  return app;
}
