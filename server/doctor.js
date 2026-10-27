// Kiểm môi trường (hợp đồng M1 §9.5): chỉ `claude --version` và `claude auth status`, không gửi prompt nào.
// Kết quả doctor chỉ giữ {loggedIn, authMethod, subscriptionType} — không giữ email/orgId/orgName.
// Riêng readIdentity() trả email theo yêu cầu (người dùng mở menu), không cache, không log, không đi vào doctor/event.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NOT_FOUND_PROBLEM = 'Không tìm thấy lệnh claude. Cài Claude Code rồi mở lại app.';
export const NOT_LOGGED_IN_PROBLEM = 'Claude Code chưa đăng nhập. Bấm “Đăng nhập Claude” để đăng nhập ngay trong app.';
export const AUTH_UNKNOWN_PROBLEM =
  'Không đọc được trạng thái đăng nhập của Claude Code (`claude auth status`). Nếu chạy bước bị lỗi, mở terminal chạy `claude` để kiểm tra.';

const MAX_OUTPUT = 256 * 1024;

// Bin .mjs/.js/.cjs chạy bằng node hiện tại; còn lại chạy trực tiếp (luôn shell:false).
export function commandFor(claudeBin, args) {
  const bin = String(claudeBin || 'claude');
  if (/\.(m?js|cjs)$/i.test(bin)) return { file: process.execPath, args: [bin, ...args] };
  return { file: bin, args };
}

// Tìm đường dẫn tuyệt đối của bin: có dấu '/' → resolve; ngược lại dò PATH (không spawn `which`). Không thấy → null.
export function resolveBin(claudeBin, envPath = process.env.PATH || '') {
  const bin = String(claudeBin || 'claude');
  const executable = (p) => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return false;
      fs.accessSync(p, /\.(m?js|cjs)$/i.test(p) ? fs.constants.R_OK : fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes('/') || bin.includes(path.sep)) {
    const abs = path.resolve(bin);
    return executable(abs) ? abs : null;
  }
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    if (executable(p)) return p;
  }
  return null;
}

// Chạy lệnh (stdin đóng, cwd = thư mục tạm riêng, timeout) → {ok, code, stdout, errorCode, timedOut}; không throw.
function run(claudeBin, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const { file, args: argv } = commandFor(claudeBin, args);
    let child;
    try {
      child = spawn(file, argv, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: process.env,
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', errorCode: e.code || 'ESPAWN', timedOut: false });
      return;
    }
    let stdout = '';
    let done = false;
    let timedOut = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* đã thoát */
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.resume(); // bỏ stderr (có thể chứa thông tin tài khoản) — chỉ cần mã thoát
    child.on('error', (e) => finish({ ok: false, code: null, stdout, errorCode: e.code || 'ESPAWN', timedOut }));
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut, code, stdout, errorCode: timedOut ? 'ETIMEDOUT' : null, timedOut }));
  });
}

// Lấy phiên bản từ chuỗi `claude --version` (vd "2.1.309 (Claude Code)" → "2.1.309").
export function parseVersion(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(s);
  if (m) return m[0];
  return s.split('\n')[0].slice(0, 80);
}

// Parse JSON của `claude auth status` và CHỈ giữ loggedIn/authMethod/subscriptionType; lỗi → null.
export function filterAuth(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        obj = JSON.parse(s.slice(a, b + 1));
      } catch {
        obj = null;
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const str = (v) => (typeof v === 'string' && v.length <= 100 ? v : null);
  return {
    loggedIn: obj.loggedIn === true,
    authMethod: str(obj.authMethod),
    subscriptionType: str(obj.subscriptionType),
  };
}

// Kiểm claude CLI + trạng thái đăng nhập (đã lọc) → {claude:{found,path,version}, auth, node, platform, problems}.
export async function runDoctor({ claudeBin: binIn = process.env.VS_CLAUDE_BIN || 'claude', timeoutMs = 10_000 } = {}) {
  const problems = [];
  // Đường dẫn tương đối tính theo cwd của server (vì lệnh chạy trong thư mục tạm khác).
  const claudeBin = /[\\/]/.test(String(binIn)) ? path.resolve(String(binIn)) : String(binIn || 'claude');
  // cwd riêng, xóa sau khi xong — bin giả (test) có thể ghi file vào cwd.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-doctor-'));
  let ver;
  let st;
  try {
    [ver, st] = await Promise.all([
      run(claudeBin, ['--version'], timeoutMs, cwd),
      run(claudeBin, ['auth', 'status'], timeoutMs, cwd),
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const claude = { found: false, path: resolveBin(claudeBin), version: null };
  let auth = null;

  if (ver.ok) {
    claude.found = true;
    claude.version = parseVersion(ver.stdout);
  } else if (ver.errorCode === 'ENOENT' || ver.errorCode === 'EACCES' || (!claude.path && !ver.timedOut)) {
    problems.push(NOT_FOUND_PROBLEM);
  } else if (ver.timedOut) {
    problems.push(`Lệnh \`claude --version\` không phản hồi sau ${Math.round(timeoutMs / 1000)} giây. Kiểm tra lại cài đặt Claude Code.`);
  } else {
    problems.push(`Lệnh \`claude --version\` lỗi (mã thoát ${ver.code}). Kiểm tra lại cài đặt Claude Code.`);
  }

  if (claude.found) {
    auth = filterAuth(st.stdout);
    if (!auth) problems.push(AUTH_UNKNOWN_PROBLEM);
    else if (auth.loggedIn !== true) problems.push(NOT_LOGGED_IN_PROBLEM);
  }

  return { claude, auth, node: process.version, platform: process.platform, problems };
}

// Đọc email tài khoản Claude đang đăng nhập (theo yêu cầu, không cache) → {email, subscriptionType}; không đọc được → email null.
export async function readIdentity({ claudeBin: binIn = process.env.VS_CLAUDE_BIN || 'claude', timeoutMs = 10_000 } = {}) {
  const claudeBin = /[\\/]/.test(String(binIn)) ? path.resolve(String(binIn)) : String(binIn || 'claude');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ident-'));
  try {
    const st = await run(claudeBin, ['auth', 'status'], timeoutMs, cwd);
    const text = String(st.stdout || '');
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    let obj = null;
    try {
      obj = JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text);
    } catch {
      obj = null;
    }
    const str = (v) => (typeof v === 'string' && v.length <= 200 ? v : null);
    if (!obj || typeof obj !== 'object' || obj.loggedIn !== true) return { email: null, subscriptionType: null };
    return { email: str(obj.email), subscriptionType: str(obj.subscriptionType) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
