// "Thiết lập Google tự động": gcloud riêng đăng nhập 1 lần → app tự tạo dự án + bật 2 API YouTube,
// mở sẵn 2 trang Google bắt buộc làm tay (màn hình xin quyền, tạo client), rồi tự nhặt client_secret_*.json trong Downloads.
// Trạng thái lưu VS_HOME/google-setup.json (không có token/bí mật); token gcloud chỉ nằm trong bộ nhớ, thu hồi ngay sau bước API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BROWSER_SCRIPT } from '../claude-account.js';
import { listChromeProfiles } from '../chrome-profiles.js';
import { HttpError } from '../projects.js';
import { createGcloud, installTools } from './gcloud.js';
import { GoogleError, gfetch, googleEndpoints } from './http.js';
import { parseClientSecret } from './oauth.js';

export const STEPS = ['login', 'project', 'consent', 'client', 'done'];
export const APP_NAME = 'Video Studio';
export const APIS = ['youtube.googleapis.com', 'youtubeanalytics.googleapis.com'];
export const WATCH_MS = 1500;
const STATE_FILE = 'google-setup.json';
const MAX_SECRET_BYTES = 20_000;

// Đường dẫn trang Google Cloud Console cho dự án (người dùng tự chỉnh khi cần).
export function consoleLinks(base, projectId) {
  const q = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
  return {
    tos: `${base}/`,
    project: `${base}/home/dashboard${q}`,
    apis: `${base}/apis/dashboard${q}`,
    consent: `${base}/auth/branding${q}`,
    audience: `${base}/auth/audience${q}`,
    client: `${base}/auth/clients/create${q}`,
    clients: `${base}/auth/clients${q}`,
  };
}

// Mã dự án ngẫu nhiên: video-studio-xxxxxx (a-z0-9).
export function newProjectId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `video-studio-${[...crypto.randomBytes(6)].map((b) => abc[b % abc.length]).join('')}`;
}

// Lỗi Google Cloud → HttpError tiếng Việt (mã gc_*).
export function cloudError(e) {
  if (e instanceof HttpError) return e;
  if (!(e instanceof GoogleError)) return new HttpError(500, 'gc_error', e?.message || 'Lỗi không xác định.');
  const msg = e.message || '';
  if (e.status === 0) return new HttpError(502, 'gc_network', 'Không kết nối được tới Google. Kiểm tra mạng rồi bấm Thử lại.');
  if (/terms of service/i.test(msg)) {
    return new HttpError(409, 'gc_tos', 'Tài khoản này chưa đồng ý Điều khoản Google Cloud. Mở trang Google Cloud, bấm Đồng ý, rồi bấm Thử lại.');
  }
  if (e.status === 401) return new HttpError(401, 'gc_reauth', 'Phiên đăng nhập Google Cloud đã hết — bấm Thử lại để đăng nhập lại.');
  if (e.status === 429 || e.reason === 'RESOURCE_EXHAUSTED' || /quota|limit/i.test(msg)) {
    return new HttpError(409, 'gc_project_quota', 'Tài khoản đã hết lượt tạo dự án mới. Chọn một dự án có sẵn bên dưới.');
  }
  return new HttpError(502, 'gc_error', `Google Cloud báo lỗi ${e.status}${e.reason ? ` (${e.reason})` : ''}.`);
}

const blank = () => ({ step: 'login', profileDir: null, profileName: null, projectId: null, clientSince: null, found: null });

// Tạo trình thiết lập. deps: home, setClient(text) (lưu client vào Keychain qua youtube.setup), isConfigured(),
// fetch?, googleBase?, openUrl?(url, profileDir), profiles?(), gcloudBin? (bỏ qua bước tải — dùng khi test), env?, downloadsDir?, platform?, arch?.
export function createGoogleWizard({
  home,
  setClient,
  isConfigured = async () => false,
  fetch: fetchFn = globalThis.fetch,
  googleBase = null,
  openUrl = () => {},
  profiles = () => listChromeProfiles(),
  gcloudBin = null,
  browserScript = BROWSER_SCRIPT,
  env = process.env,
  downloadsDir = path.join(os.homedir(), 'Downloads'),
  trashDir = path.join(os.homedir(), '.Trash'),
  platform = process.platform,
  arch = process.arch,
  manifest,
  onChange = () => {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 1500,
  watchMs = WATCH_MS,
} = {}) {
  const endpoints = googleEndpoints(googleBase);
  const file = path.join(home, STATE_FILE);
  const toolsDir = path.join(home, 'tools');
  const configDir = path.join(home, 'gcloud');
  const listeners = new Set([onChange]);
  let st = load();
  let job = null; // {phase: 'tools'|'login'|'project'|'apis', progress, cancelled, abort}
  let error = null; // {code, message}
  let projects = null; // danh sách dự án có sẵn khi hết lượt tạo
  let watchErr = null;
  let watcher = null;
  let gcloud = null;
  let lastEmit = 0;

  function load() {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (o && STEPS.includes(o.step)) return { ...blank(), ...o };
    } catch {
      /* chưa có */
    }
    return blank();
  }
  const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2), { mode: 0o600 });
  const emit = (throttle = false) => {
    if (throttle && now() - lastEmit < 250) return;
    lastEmit = now();
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* bỏ qua */
      }
    }
  };
  const setStep = (step, extra = {}) => {
    Object.assign(st, extra, { step });
    save();
    emit();
  };

  // Ảnh chụp cho UI (không token, không đường dẫn tuyệt đối).
  function status() {
    return {
      step: st.step,
      busy: job ? job.phase : null,
      progress: job?.progress ?? null,
      profile: st.profileDir ? { dir: st.profileDir, name: st.profileName } : null,
      projectId: st.projectId,
      projects,
      error,
      found: st.found ? { name: st.found.name } : null,
      watchError: watchErr,
      appName: APP_NAME,
      links: consoleLinks(endpoints.console, st.projectId),
    };
  }

  const needIdle = () => {
    if (job) throw new HttpError(409, 'gc_busy', 'Đang thiết lập — đợi bước hiện tại xong hoặc bấm Hủy.');
  };

  // Mở trang Google trong hồ sơ đã chọn; trình duyệt mặc định → UI tự mở (opened=false).
  function open(page) {
    const url = consoleLinks(endpoints.console, st.projectId)[page];
    if (!url) throw new HttpError(400, 'invalid_body', 'Trang không hợp lệ.');
    let opened = false;
    if (st.profileDir) {
      try {
        openUrl(url, st.profileDir);
        opened = true;
      } catch {
        opened = false;
      }
    }
    return { url, opened };
  }

  // ---- gcloud
  async function ensureGcloud() {
    if (gcloud) return gcloud;
    let bin = gcloudBin;
    let python = null;
    if (!bin) {
      job.phase = 'tools';
      job.abort = new AbortController();
      emit();
      const p = await installTools({
        dir: toolsDir,
        platform,
        arch,
        manifest,
        fetch: fetchFn,
        signal: job.abort.signal,
        onProgress: (pr) => {
          if (job) job.progress = pr;
          emit(true);
        },
      });
      bin = p.gcloud;
      python = p.python;
      job.progress = null;
    }
    gcloud = createGcloud({ bin, python, configDir, browserScript, env });
    return gcloud;
  }

  // Thu hồi quyền gcloud + xóa công cụ đã tải (~450 MB). Lỗi bỏ qua.
  async function cleanup() {
    try {
      if (gcloud) await gcloud.revoke();
      else fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      /* bỏ qua */
    }
    gcloud = null;
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }

  // ---- Google Cloud REST (token gcloud)
  const call = (token, url, { method = 'GET', body } = {}) =>
    gfetch(fetchFn, url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  // Chờ long-running operation xong; lỗi trong operation → GoogleError.
  async function waitOp(token, base, op) {
    for (let i = 0; !op?.done; i++) {
      if (i >= 80) throw new GoogleError(504, 'timeout', 'Google Cloud xử lý quá lâu.');
      await sleep(pollMs);
      if (job?.cancelled) throw new HttpError(409, 'gc_cancelled', 'Đã hủy.');
      op = await call(token, `${base}/${op.name}`);
    }
    if (op.error) throw new GoogleError(op.error.code === 8 ? 429 : 400, op.error.status || null, op.error.message || null);
    return op.response;
  }

  async function listProjects(token) {
    const r = await call(token, `${endpoints.crm}/projects:search?query=${encodeURIComponent('state:ACTIVE')}&pageSize=100`);
    return (r?.projects || []).map((p) => ({ projectId: p.projectId, name: p.displayName || p.projectId })).slice(0, 100);
  }

  // Dự án: lần trước đã tạo và còn hoạt động → dùng lại; không thì tạo mới (trùng mã → thử mã khác, tối đa 3 lần).
  async function ensureProject(token) {
    if (st.projectId) {
      const p = await call(token, `${endpoints.crm}/projects/${encodeURIComponent(st.projectId)}`).catch(() => null);
      if (p?.state === 'ACTIVE') return st.projectId;
    }
    for (let i = 0; ; i++) {
      const projectId = newProjectId();
      try {
        const op = await call(token, `${endpoints.crm}/projects`, { method: 'POST', body: { projectId, displayName: APP_NAME } });
        await waitOp(token, endpoints.crm, op);
        st.projectId = projectId;
        save();
        return projectId;
      } catch (e) {
        if (i < 2 && e instanceof GoogleError && (e.status === 409 || e.reason === 'ALREADY_EXISTS')) continue;
        throw e;
      }
    }
  }

  // Bật 2 API; dự án mới tạo có thể chưa "thấy" ngay → thử lại vài lần.
  async function enableApis(token, projectId) {
    for (let i = 0; ; i++) {
      try {
        const op = await call(token, `${endpoints.serviceusage}/projects/${encodeURIComponent(projectId)}/services:batchEnable`, { method: 'POST', body: { serviceIds: APIS } });
        await waitOp(token, endpoints.serviceusage, op);
        return;
      } catch (e) {
        const retry = e instanceof GoogleError && [400, 403, 404, 409].includes(e.status) && !/terms of service/i.test(e.message || '');
        if (!retry || i >= 5) throw e;
        await sleep(3000);
      }
    }
  }

  // Lấy token gcloud; chưa đăng nhập → mở trang đăng nhập Google và chờ.
  async function cloudToken() {
    const g = await ensureGcloud();
    let token = await g.token();
    if (token) return token;
    job.phase = 'login';
    if (st.step !== 'login') setStep('login');
    else emit();
    const ok = await g.login({ profileDir: st.profileDir });
    if (job.cancelled) throw new HttpError(409, 'gc_cancelled', 'Đã hủy.');
    token = ok ? await g.token() : null;
    if (!token) throw new HttpError(400, 'gc_login', 'Chưa đăng nhập được Google Cloud — bấm Thử lại và chọn Cho phép trên trang Google.');
    return token;
  }

  // Chạy nền 1 việc; lỗi ghi vào error (quota → kèm danh sách dự án).
  function runJob(phase, work) {
    job = { phase, progress: null, cancelled: false, abort: null };
    error = null;
    emit();
    const j = job;
    j.done = (async () => {
      try {
        await work(j);
      } catch (e) {
        if (!j.cancelled) {
          const he = cloudError(e);
          error = { code: he.code, message: he.message };
          if (he.code === 'gc_project_quota' && j.token) projects = await listProjects(j.token).catch(() => []);
        }
      } finally {
        job = null;
        emit();
      }
    })();
    return status();
  }

  // Bật API cho dự án → dọn gcloud → sang bước màn hình xin quyền (mở luôn trang Google nếu có hồ sơ Chrome).
  async function finishCloud(j, token, projectId) {
    j.phase = 'apis';
    if (st.step !== 'project') setStep('project', { projectId });
    else emit();
    await enableApis(token, projectId);
    j.token = null;
    await cleanup();
    projects = null;
    setStep('consent', { projectId });
    open('consent');
  }

  // Bắt đầu / thử lại: profileDir null = trình duyệt mặc định.
  function start({ profileDir = null } = {}) {
    needIdle();
    if (!['login', 'project'].includes(st.step)) throw new HttpError(409, 'gc_step', 'Dự án đã tạo xong — làm tiếp bước hiện tại hoặc bấm Làm lại từ đầu.');
    let profile = null;
    if (profileDir) {
      profile = (profiles()?.profiles || []).find((p) => p.dir === profileDir) || null;
      if (!profile) throw new HttpError(400, 'invalid_profile', 'Không tìm thấy hồ sơ Chrome này. Chọn lại hồ sơ.');
    }
    st.profileDir = profile?.dir ?? null;
    st.profileName = profile?.name ?? null;
    save();
    projects = null;
    return runJob('login', async (j) => {
      const token = await cloudToken();
      j.token = token;
      j.phase = 'project';
      setStep('project');
      const projectId = await ensureProject(token);
      await finishCloud(j, token, projectId);
    });
  }

  // Hết lượt tạo dự án → người dùng chọn dự án có sẵn.
  function useProject(projectId) {
    needIdle();
    if (st.step !== 'project' || !projects?.some((p) => p.projectId === projectId)) {
      throw new HttpError(400, 'invalid_body', 'Chọn một dự án trong danh sách.');
    }
    return runJob('apis', async (j) => {
      const token = await cloudToken();
      j.token = token;
      await finishCloud(j, token, projectId);
    });
  }

  async function cancel() {
    if (!job) return status();
    const j = job;
    j.cancelled = true;
    j.abort?.abort();
    gcloud?.cancel();
    await j.done;
    return status();
  }

  // Bước kế: màn hình xin quyền → tạo client (mở trang + bắt đầu theo dõi Downloads).
  async function next() {
    needIdle();
    if (st.step !== 'consent') throw new HttpError(409, 'gc_step', 'Không ở bước màn hình xin quyền.');
    setStep('client', { clientSince: new Date(now()).toISOString() });
    startWatch();
    return { ...status(), open: open('client') };
  }

  // Quay lại bước màn hình xin quyền (người dùng cần sửa).
  function back() {
    needIdle();
    if (st.step !== 'client') throw new HttpError(409, 'gc_step', 'Không ở bước tạo client.');
    stopWatch();
    setStep('consent');
    return status();
  }

  // ---- Theo dõi Downloads: file client_secret_*.json mới, đúng dự án → lưu client, xong.
  async function scan() {
    if (st.step !== 'client') return stopWatch();
    if (await isConfigured().catch(() => false)) {
      stopWatch();
      setStep('done');
      return;
    }
    let names;
    try {
      names = fs.readdirSync(downloadsDir);
      if (watchErr) {
        watchErr = null;
        emit();
      }
    } catch (e) {
      const msg = e.code === 'EPERM' || e.code === 'EACCES' ? 'App không được đọc thư mục Tải về — chọn file thủ công bên dưới.' : 'Không đọc được thư mục Tải về — chọn file thủ công bên dưới.';
      if (watchErr !== msg) {
        watchErr = msg;
        emit();
      }
      return;
    }
    const since = Date.parse(st.clientSince || 0) - 5000;
    for (const name of names) {
      if (!/^client_secret_.+\.json$/i.test(name)) continue;
      const p = path.join(downloadsDir, name);
      let text;
      try {
        const s = fs.statSync(p);
        if (!s.isFile() || s.mtimeMs < since || s.size > MAX_SECRET_BYTES) continue;
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      let o = null;
      try {
        o = JSON.parse(text);
      } catch {
        continue; // đang tải dở
      }
      if ((o?.installed || o?.web)?.project_id !== st.projectId) continue;
      try {
        parseClientSecret(o);
      } catch (e) {
        const msg = `${name}: ${e.message}`;
        if (error?.message !== msg) {
          error = { code: 'gc_client_type', message: msg };
          emit();
        }
        continue;
      }
      try {
        await setClient(text);
      } catch (e) {
        error = { code: e.code || 'gc_error', message: e.message };
        emit();
        return;
      }
      stopWatch();
      error = null;
      setStep('done', { found: { name, path: p } });
      return;
    }
  }

  function startWatch() {
    if (watcher) return;
    let running = false;
    watcher = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await scan();
      } finally {
        running = false;
      }
    }, watchMs);
    watcher.unref?.();
  }
  function stopWatch() {
    if (watcher) clearInterval(watcher);
    watcher = null;
  }

  // Xử lý file client_secret trong Downloads: keep=false → chuyển vào Thùng rác (macOS) / xóa (Linux).
  function handleDownload({ keep = false } = {}) {
    const f = st.found;
    if (!f) throw new HttpError(409, 'gc_no_file', 'Không còn file nào để xử lý.');
    let trashed = false;
    if (!keep && path.dirname(f.path) === path.resolve(downloadsDir) && fs.existsSync(f.path)) {
      if (platform === 'darwin') {
        let dest = path.join(trashDir, f.name);
        if (fs.existsSync(dest)) dest = path.join(trashDir, `${path.basename(f.name, '.json')} ${now()}.json`);
        try {
          fs.renameSync(f.path, dest);
        } catch {
          fs.rmSync(f.path, { force: true });
        }
      } else fs.rmSync(f.path, { force: true });
      trashed = true;
    }
    st.found = null;
    save();
    emit();
    return { ...status(), trashed };
  }

  // Làm lại từ đầu: hủy việc đang chạy, thu hồi gcloud, xóa trạng thái (không đụng client đã lưu, không xóa dự án trên Google).
  async function reset() {
    await cancel();
    stopWatch();
    await cleanup();
    st = blank();
    error = null;
    projects = null;
    watchErr = null;
    fs.rmSync(file, { force: true });
    emit();
    return status();
  }

  // Hoàn tất bằng cách dán / chọn file tay khi đang ở bước tạo client.
  async function manualDone() {
    if (['consent', 'client'].includes(st.step)) {
      stopWatch();
      setStep('done');
    }
  }

  // Client bị xóa sau khi đã xong → quay về bước tạo client (dự án + API vẫn còn).
  function clientCleared() {
    if (st.step !== 'done') return;
    setStep('client', { clientSince: new Date(now()).toISOString(), found: null });
    startWatch();
  }

  function dispose() {
    stopWatch();
    if (job) {
      job.cancelled = true;
      job.abort?.abort();
      gcloud?.cancel();
    }
  }

  if (st.step === 'client') startWatch();

  return {
    status,
    start,
    useProject,
    cancel,
    next,
    back,
    open,
    handleDownload,
    reset,
    manualDone,
    clientCleared,
    dispose,
    scan,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
