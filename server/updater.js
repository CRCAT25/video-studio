// Báo bản mới: so version trong package.json với Release mới nhất trên GitHub (cache 6 giờ, lỗi mạng thì im lặng).
// Nút Cập nhật chạy `cli.js --update` ở tiến trình con (git pull + npm install + build) rồi chờ người dùng khởi động lại.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './presets.js';

const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const LOG_TAIL = 4000;

// "v1.2.3" / "1.2.3" → [1,2,3]; sai định dạng → null.
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

// a mới hơn b? (chỉ so số; định dạng sai → false).
export function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// owner/repo từ field repository của package.json (chuỗi hoặc {url}); không phải GitHub → null.
export function githubRepo(pkg) {
  const url = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

function readPkg(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Mặc định: chạy lệnh --update của chính app (bin: script node thay thế, dùng khi test), gom stdout+stderr; xong gọi onExit(code).
function defaultSpawnUpdate({ root, bin, onOutput, onExit }) {
  const args = bin ? [bin] : [path.join(root, 'server', 'cli.js'), '--update'];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => onOutput(String(b)));
  child.stderr.on('data', (b) => onOutput(String(b)));
  child.on('error', (e) => {
    onOutput(`${e.message}\n`);
    onExit(1);
  });
  child.on('close', (code) => onExit(code ?? 1));
}

// opts: {current?, repo?, apiBase?, fetchFn?, spawnUpdate?, updateBin?, now?, ttlMs?, enabled?, restart? (chỉ có khi chạy nền)}.
export function createUpdater({
  root = REPO_ROOT,
  current = null,
  repo = undefined,
  apiBase = 'https://api.github.com',
  fetchFn = globalThis.fetch,
  spawnUpdate = defaultSpawnUpdate,
  updateBin = null,
  now = Date.now,
  ttlMs = CHECK_TTL_MS,
  enabled = true,
  restart = null,
} = {}) {
  const pkg = readPkg(root);
  const cur = current || String(pkg.version || '0.0.0');
  const slug = repo === undefined ? githubRepo(pkg) : repo;
  const listeners = new Set();
  let latest = null; // {version, url, name}
  let checkedAt = 0;
  let pending = null;
  let state = 'idle'; // idle | running | done | error
  let log = '';

  const emit = () => listeners.forEach((fn) => fn());

  // Gọi GitHub (gộp lượt trùng); force bỏ qua cache. Không bao giờ throw.
  function check({ force = false } = {}) {
    if (!enabled || !slug || typeof fetchFn !== 'function') return Promise.resolve(status());
    if (!force && checkedAt && now() - checkedAt < ttlMs) return Promise.resolve(status());
    if (!pending) {
      pending = (async () => {
        try {
          const res = await fetchFn(`${apiBase}/repos/${slug}/releases/latest`, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'video-studio' },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404) latest = null; // chưa có Release nào
          else if (res.ok) {
            const r = await res.json();
            const version = String(r?.tag_name || '').replace(/^v/, '');
            const url = typeof r?.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : null;
            latest = parseVersion(version) ? { version, url, name: String(r?.name || '').slice(0, 120) } : null;
          } else return;
          checkedAt = now();
          emit();
        } catch {
          /* mạng lỗi: giữ kết quả cũ, lần sau thử lại */
        } finally {
          pending = null;
        }
      })();
    }
    return pending.then(status);
  }

  // Trạng thái gửi cho UI (không có đường dẫn máy hay bí mật).
  function status() {
    return {
      current: cur,
      latest: latest?.version ?? null,
      newer: !!latest && isNewer(latest.version, cur),
      url: latest?.url ?? null,
      name: latest?.name || null,
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
      state,
      log: state === 'error' ? log.slice(-LOG_TAIL) : null,
      canRestart: typeof restart === 'function',
    };
  }

  // Chạy cập nhật ở tiến trình con; đang chạy hoặc đã xong (chờ khởi động lại) → không chạy lại.
  function start() {
    if (state === 'running' || state === 'done') return status();
    state = 'running';
    log = '';
    emit();
    spawnUpdate({
      root,
      bin: updateBin,
      onOutput: (s) => {
        log = (log + s).slice(-LOG_TAIL * 2);
      },
      onExit: (code) => {
        state = code === 0 ? 'done' : 'error';
        emit();
      },
    });
    return status();
  }

  return {
    check,
    status,
    start,
    restart: () => (typeof restart === 'function' ? restart() : false),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
