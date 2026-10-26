// Đăng nhập / đăng xuất Claude Code ngay trong app: chạy `claude auth login|logout`, Claude Code tự lo xác thực trên trình duyệt.
// App không đọc output (bỏ hết stdout/stderr), không ghi gì vào stdin — chỉ theo dõi mã thoát; không bao giờ cầm mã/token.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listChromeProfiles } from './chrome-profiles.js';
import { commandFor } from './doctor.js';
import { HttpError } from './projects.js';

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const LOGOUT_TIMEOUT_MS = 30_000;
export const KILL_GRACE_MS = 3000;
export const LOGIN_METHODS = ['claudeai', 'console'];
export const BROWSER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'open-chrome-profile.sh');

// Tạo bộ điều khiển tài khoản: {status, login, cancel, logout, profiles, on, dispose}. Mỗi lúc chỉ một lệnh auth chạy.
// onChange(status) / on(fn) được gọi mỗi khi bắt đầu/kết thúc một lệnh (app.js dùng để làm mới doctor + phát SSE).
export function createClaudeAccount({
  claudeBin = 'claude',
  browserScript = BROWSER_SCRIPT,
  profiles = () => listChromeProfiles(),
  onChange = () => {},
  env = process.env,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  logoutTimeoutMs = LOGOUT_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  const bin = /[\\/]/.test(String(claudeBin)) ? path.resolve(String(claudeBin)) : String(claudeBin || 'claude');
  let job = null;
  let last = null; // {action, ok, reason, code, at}
  const listeners = new Set([onChange]);

  // Ảnh chụp trạng thái gửi cho UI (không chứa gì về tài khoản).
  function status() {
    return {
      busy: job ? job.action : null,
      method: job?.method ?? null,
      profile: job?.profile ? { dir: job.profile.dir, name: job.profile.name } : null,
      startedAt: job?.startedAt ?? null,
      last,
    };
  }

  function notify() {
    const s = status();
    for (const fn of listeners) {
      try {
        fn(s);
      } catch {
        /* lỗi của người nghe không làm hỏng lệnh auth */
      }
    }
  }

  // Đăng ký nghe thay đổi; trả hàm hủy đăng ký.
  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // Dừng tiến trình đang chạy (SIGTERM, quá hạn thì SIGKILL).
  function kill(j) {
    if (!j?.child || j.finished) return;
    try {
      j.child.kill('SIGTERM');
    } catch {
      /* đã thoát */
    }
    j.killTimer = setTimeout(() => {
      try {
        j.child.kill('SIGKILL');
      } catch {
        /* đã thoát */
      }
    }, killGraceMs);
  }

  // Chạy một lệnh auth; trả job có j.done (Promise → last).
  function start(action, { method = null, profile = null, timeoutMs }) {
    const args = action === 'login' ? ['auth', 'login', method === 'console' ? '--console' : '--claudeai'] : ['auth', 'logout'];
    const { file, args: argv } = commandFor(bin, args);
    const childEnv = { ...env };
    if (profile) {
      childEnv.BROWSER = browserScript;
      childEnv.VS_CHROME_PROFILE = profile.dir;
    }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-auth-'));
    const j = { action, method, profile, startedAt: new Date().toISOString(), cancelled: false, timedOut: false, finished: false };
    let resolveDone;
    j.done = new Promise((r) => {
      resolveDone = r;
    });
    const finish = (code, errorCode = null) => {
      if (j.finished) return;
      j.finished = true;
      clearTimeout(j.timer);
      clearTimeout(j.killTimer);
      fs.rmSync(cwd, { recursive: true, force: true });
      if (job === j) job = null;
      let reason = 'failed';
      if (j.cancelled) reason = 'cancelled';
      else if (j.timedOut) reason = 'timeout';
      else if (errorCode === 'ENOENT' || errorCode === 'EACCES') reason = 'not_found';
      else if (code === 0) reason = 'ok';
      last = { action, ok: reason === 'ok', reason, code: Number.isInteger(code) ? code : null, at: new Date().toISOString() };
      notify();
      resolveDone(last);
    };
    try {
      j.child = spawn(file, argv, { shell: false, stdio: 'ignore', cwd, env: childEnv, windowsHide: true });
    } catch (e) {
      finish(null, e.code || 'ESPAWN');
      return j;
    }
    job = j;
    j.child.on('error', (e) => finish(null, e.code || 'ESPAWN'));
    j.child.on('close', (code) => finish(code));
    j.timer = setTimeout(() => {
      j.timedOut = true;
      kill(j);
    }, timeoutMs);
    notify();
    return j;
  }

  const busyError = () =>
    new HttpError(409, 'account_busy', job?.action === 'login' ? 'Đang chờ đăng nhập — hoàn tất trên trình duyệt hoặc bấm Hủy.' : 'Đang đăng xuất, đợi vài giây.');

  // Bắt đầu đăng nhập (không chờ xong); profileDir rỗng = trình duyệt mặc định của máy.
  function login({ method = 'claudeai', profileDir = null } = {}) {
    if (job) throw busyError();
    if (!LOGIN_METHODS.includes(method)) throw new HttpError(400, 'invalid_body', 'Cách đăng nhập phải là "claudeai" hoặc "console".');
    let profile = null;
    if (profileDir !== null && profileDir !== undefined && profileDir !== '') {
      profile = (profiles()?.profiles || []).find((p) => p.dir === profileDir) || null;
      if (!profile) throw new HttpError(400, 'invalid_profile', 'Không tìm thấy hồ sơ Chrome này. Bấm làm mới danh sách rồi chọn lại.');
    }
    start('login', { method, profile, timeoutMs: loginTimeoutMs });
    return status();
  }

  // Hủy lượt đăng nhập đang chờ; chờ tiến trình thoát rồi trả status.
  async function cancel() {
    if (!job || job.action !== 'login') throw new HttpError(409, 'not_logging_in', 'Không có lượt đăng nhập nào đang chờ.');
    const j = job;
    j.cancelled = true;
    kill(j);
    await j.done;
    return status();
  }

  // Đăng xuất và chờ xong (lệnh ngắn).
  async function logout() {
    if (job) throw busyError();
    const j = start('logout', { timeoutMs: logoutTimeoutMs });
    await j.done;
    return status();
  }

  // Dừng mọi lệnh auth đang chạy (khi server tắt).
  function dispose() {
    if (job) {
      job.cancelled = true;
      kill(job);
    }
  }

  return { status, login, cancel, logout, profiles: () => profiles(), on, dispose, isBusy: () => !!job };
}
