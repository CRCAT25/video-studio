// gcloud riêng của app (chỉ dùng cho "Thiết lập Google tự động"): tải bản chính thức vào VS_HOME/tools, kiểm sha256,
// chạy `gcloud auth login / print-access-token / revoke` với cấu hình riêng. Bỏ hết output (có email/URL); token chỉ giữ trong bộ nhớ.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GCLOUD_VERSION = '588.0.0';
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const CMD_TIMEOUT_MS = 60_000;
export const KILL_GRACE_MS = 3000;

const GC = (plat) => `https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_VERSION}-${plat}.tar.gz`;
// gcloud mới cần Python ≥ 3.10; macOS chỉ có 3.9 → kèm Python độc lập (python-build-standalone). Linux: gcloud tự có Python.
const PY = (triple) =>
  `https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.12.15%2B20261009-${triple}-install_only_stripped.tar.gz`;

// Bản tải cố định theo nền tảng (phiên bản ≥ 2 tuần tuổi) + kích thước + sha256.
export const TOOL_MANIFEST = {
  'darwin-arm64': {
    gcloud: { url: GC('darwin-arm'), size: 53984931, sha256: '0f580f1323d0465b11d1d7c506e701c27729e9c5ea0e1d0f855a4dc3e665db89' },
    python: { url: PY('aarch64-apple-darwin'), size: 25030095, sha256: '233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f' },
  },
  'darwin-x64': {
    gcloud: { url: GC('darwin-x86_64'), size: 54084109, sha256: '7941b3911838373f6af9fe96f957913127c531c9b4c5104ee9c0e9e9a55c5fb6' },
    python: { url: PY('x86_64-apple-darwin'), size: 24751118, sha256: 'fb3187d95334813b88940db0f1ca57b84cedfd552739c3a5771c3ea0e49988c9' },
  },
  'linux-x64': {
    gcloud: { url: GC('linux-x86_64'), size: 88024908, sha256: 'e38ceac43022bb5a4d94d5a4a9c9c51f90f28c910b59a018ae07011e220c4412' },
  },
  'linux-arm64': {
    gcloud: { url: GC('linux-arm'), size: 53909926, sha256: '15d0365242d72caebda77647642ae73f68bde10b1f71338c8a704aea200d8ab1' },
  },
};

// Tải url về dest, vừa tải vừa băm; sai kích thước / sha256 → xóa file và throw. onBytes(n) báo tiến độ.
export async function downloadVerified(url, dest, { size, sha256, fetch: fetchFn = globalThis.fetch, onBytes = () => {}, signal } = {}) {
  const res = await fetchFn(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Tải công cụ thất bại (HTTP ${res.status}).`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (size && got > size) throw new Error('File tải về lớn hơn dự kiến.');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onBytes(chunk.length);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (size && got !== size) throw new Error('File tải về không đủ dung lượng.');
    if (hash.digest('hex') !== sha256) throw new Error('File tải về sai mã kiểm tra (sha256).');
  } catch (e) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw e;
  }
}

// Giải nén .tar.gz vào dir bằng `tar` của hệ thống.
export function extractTgz(file, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', file, '-C', dir], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Giải nén thất bại (tar thoát ${code}).`))));
  });
}

// Cài gcloud (+ Python nếu cần) vào dir; đã cài đúng bản thì bỏ qua. Trả {gcloud, python}. onProgress({bytes, total}).
export async function installTools({ dir, platform = process.platform, arch = process.arch, manifest = TOOL_MANIFEST, fetch: fetchFn, onProgress = () => {}, signal } = {}) {
  const m = manifest[`${platform}-${arch}`];
  if (!m) throw new Error(`Chưa hỗ trợ tự cài gcloud trên ${platform}-${arch} — dùng cách thủ công.`);
  const paths = {
    gcloud: path.join(dir, 'google-cloud-sdk', 'bin', 'gcloud'),
    python: m.python ? path.join(dir, 'python', 'bin', 'python3') : null,
  };
  const marker = path.join(dir, 'ready.json');
  const want = JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.sha256])));
  try {
    if (fs.readFileSync(marker, 'utf8') === want && fs.existsSync(paths.gcloud)) return paths;
  } catch {
    /* chưa cài */
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const total = Object.values(m).reduce((s, t) => s + t.size, 0);
  let bytes = 0;
  onProgress({ bytes, total });
  for (const [name, t] of Object.entries(m)) {
    const file = path.join(dir, `${name}.tar.gz`);
    await downloadVerified(t.url, file, {
      size: t.size,
      sha256: t.sha256,
      fetch: fetchFn,
      signal,
      onBytes: (n) => {
        bytes += n;
        onProgress({ bytes, total });
      },
    });
    await extractTgz(file, dir);
    fs.rmSync(file, { force: true });
  }
  fs.writeFileSync(marker, want);
  return paths;
}

// Bộ chạy gcloud với cấu hình riêng (configDir). browserScript + profileDir → mở trang đăng nhập trong hồ sơ Chrome đó.
export function createGcloud({ bin, python = null, configDir, browserScript, env = process.env, killGraceMs = KILL_GRACE_MS }) {
  let current = null; // tiến trình đang chạy (để hủy)

  const baseEnv = () => {
    const e = { ...env };
    for (const k of Object.keys(e)) if (k.startsWith('VS_') || k === 'BROWSER') delete e[k];
    Object.assign(e, {
      CLOUDSDK_CONFIG: configDir,
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
      CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true',
    });
    if (python) e.CLOUDSDK_PYTHON = python;
    return e;
  };

  // Chạy 1 lệnh; capture=true thì giữ stdout (chỉ dùng cho token). Trả {code, stdout}.
  function run(args, { capture = false, timeoutMs = CMD_TIMEOUT_MS, profileDir = null } = {}) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const e = baseEnv();
    if (profileDir) {
      e.BROWSER = browserScript;
      e.VS_CHROME_PROFILE = profileDir;
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], env: e, shell: false });
      } catch {
        resolve({ code: null, stdout: '' });
        return;
      }
      const me = { child, killed: false };
      current = me;
      let out = '';
      child.stdout?.on('data', (b) => {
        if (out.length < 8192) out += b.toString('utf8');
      });
      let killTimer = null;
      const timer = setTimeout(() => kill(me), timeoutMs);
      const done = (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (current === me) current = null;
        resolve({ code, stdout: out, killed: me.killed });
      };
      function kill(j) {
        j.killed = true;
        try {
          j.child.kill('SIGTERM');
        } catch {
          /* đã thoát */
        }
        killTimer = setTimeout(() => {
          try {
            j.child.kill('SIGKILL');
          } catch {
            /* đã thoát */
          }
        }, killGraceMs);
      }
      me.kill = () => kill(me);
      child.on('error', () => done(null));
      child.on('close', (code) => done(code));
    });
  }

  return {
    // Đăng nhập (mở trình duyệt, chờ người dùng bấm Cho phép). Trả true khi thành công.
    async login({ profileDir = null, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
      const r = await run(['auth', 'login', '--brief'], { timeoutMs, profileDir });
      return r.code === 0;
    },
    // Access token (quyền cloud-platform) hoặc null nếu chưa đăng nhập.
    async token() {
      const r = await run(['auth', 'print-access-token'], { capture: true });
      const t = r.code === 0 ? r.stdout.trim() : '';
      return /^[\w.\-~+/=]{10,4096}$/.test(t) ? t : null;
    },
    // Thu hồi quyền của gcloud ở Google rồi xóa cấu hình riêng.
    async revoke() {
      if (fs.existsSync(configDir)) await run(['auth', 'revoke', '--all', '--quiet']);
      fs.rmSync(configDir, { recursive: true, force: true });
    },
    cancel() {
      current?.kill?.();
    },
  };
}
