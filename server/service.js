// Chạy Video Studio như dịch vụ nền macOS (launchd LaunchAgent): tự bật khi đăng nhập máy, tự chạy lại khi lỗi.
// Kèm: token ẩn cố định ($VS_HOME/token, quyền 600, cho dev/test), xoay vòng log, sao lưu DB hằng ngày (giữ 7 bản).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateToken } from './auth.js';
import { openStore } from './db.js';
import { hasPassword, newSetupCode } from './login.js';
import { REPO_ROOT } from './presets.js';

export const SERVICE_LABEL = 'com.videostudio.app';
export const SERVICE_PORT = 4318;
export const BACKUP_KEEP = 7;
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
const CLI = path.join(REPO_ROOT, 'server', 'cli.js');

export const SERVICE_HELP = `Chạy nền Video Studio (macOS launchd)

Cách dùng: node server/cli.js service <lệnh> [--port ${SERVICE_PORT}]

  install     cài + bật dịch vụ (tự chạy khi đăng nhập máy, tự bật lại khi lỗi)
  uninstall   tắt + gỡ dịch vụ (giữ nguyên dữ liệu trong VS_HOME)
  restart     khởi động lại dịch vụ (sau khi cập nhật code)
  status      dịch vụ có đang chạy không
  open        mở app trong trình duyệt (chưa có mật khẩu → in mã thiết lập)

Log: <VS_HOME>/logs/server.log · Sao lưu DB: <VS_HOME>/backups (giữ ${BACKUP_KEEP} bản).`;

// Token ẩn cố định: đọc $home/token, chưa có → tạo (quyền 600).
export function persistentToken(home) {
  const file = path.join(home, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 8) return t;
  } catch {
    /* chưa có */
  }
  const t = generateToken();
  fs.writeFileSync(file, `${t}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return t;
}

// Log quá lớn → đổi tên thành .1 (bản cũ hơn bị ghi đè). Gọi trước khi launchd (re)start để nó mở file mới.
export function rotateLog(file, maxBytes = LOG_MAX_BYTES) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch {
    /* chưa có log */
  }
}

const dayStamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Sao lưu DB 1 lần/ngày vào dir (studio-YYYY-MM-DD.db, bản sao nhất quán qua SQLite backup API), giữ `keep` bản mới nhất.
export async function backupDb(db, dir, { now = new Date(), keep = BACKUP_KEEP } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `studio-${dayStamp(now)}.db`);
  let made = null;
  if (!fs.existsSync(file)) {
    const tmp = `${file}.tmp`;
    await db.backup(tmp);
    fs.renameSync(tmp, file);
    made = file;
  }
  const all = fs.readdirSync(dir).filter((f) => /^studio-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  return made;
}

// Sao lưu ngay khi khởi động rồi kiểm lại mỗi giờ (qua ngày mới thì tạo bản mới). Trả hàm dừng.
export function startBackups(db, dir, { onError = () => {}, everyMs = 3600_000 } = {}) {
  const run = () => backupDb(db, dir).catch(onError);
  run();
  const t = setInterval(run, everyMs);
  t.unref();
  return () => clearInterval(t);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Nội dung file plist cho launchd. KeepAlive.SuccessfulExit=false: thoát lỗi/bị giết → chạy lại; tắt êm (exit 0) → thôi.
export function plistXml({ label, node, cli, port, home, workdir, pathEnv, logFile }) {
  const env = { PATH: pathEnv, VS_HOME: home };
  const args = [node, cli, '--service', '--port', String(port), '--no-open'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${xml(workdir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

// Bộ điều khiển dịch vụ. deps tiêm được cho test: launchctl(args) → {status, stdout, stderr}, openUrl, fetch, agentsDir, uid.
export function createService({
  home,
  label = SERVICE_LABEL,
  port = SERVICE_PORT,
  agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents'),
  uid = process.getuid?.() ?? 0,
  node = process.execPath,
  cli = CLI,
  pathEnv = process.env.PATH || '/usr/bin:/bin',
  launchctl = (args) => spawnSync('launchctl', args, { encoding: 'utf8' }),
  openUrl = (url) => spawnSync('open', [url]),
  fetch: fetchFn = globalThis.fetch,
  platform = process.platform,
} = {}) {
  const plistFile = path.join(agentsDir, `${label}.plist`);
  const domain = `gui/${uid}`;
  const logFile = path.join(home, 'logs', 'server.log');
  const target = `${domain}/${label}`;

  const needMac = () => {
    if (platform !== 'darwin') throw new Error('Chạy nền bằng launchd chỉ có trên macOS.');
  };
  const loaded = () => launchctl(['print', target]).status === 0;

  async function health() {
    try {
      const r = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  // Chờ server trả lời /api/health (tối đa timeoutMs).
  async function waitHealthy(timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await health()) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  // Ghi plist (chỉ khi nội dung đổi) rồi nạp lại vào launchd.
  async function install() {
    needMac();
    if (!loaded() && (await health())) {
      throw new Error(`Cổng ${port} đang có Video Studio khác chạy (ví dụ mở bằng terminal). Tắt nó trước rồi cài lại.`);
    }
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    persistentToken(home);
    const body = plistXml({ label, node, cli, port, home, workdir: REPO_ROOT, pathEnv, logFile });
    fs.writeFileSync(plistFile, body, { mode: 0o644 });
    if (loaded()) launchctl(['bootout', target]);
    rotateLog(logFile);
    const r = launchctl(['bootstrap', domain, plistFile]);
    if (r.status !== 0) throw new Error(`launchctl bootstrap lỗi: ${(r.stderr || r.stdout || '').trim() || r.status}`);
    const ok = await waitHealthy();
    return { plistFile, logFile, healthy: ok, url: `http://127.0.0.1:${port}/` };
  }

  function uninstall() {
    needMac();
    const was = loaded();
    if (was) launchctl(['bootout', target]);
    const had = fs.existsSync(plistFile);
    fs.rmSync(plistFile, { force: true });
    return { removed: was || had };
  }

  async function restart() {
    needMac();
    if (!loaded()) throw new Error('Dịch vụ chưa cài — chạy "service install" trước.');
    rotateLog(logFile);
    const r = launchctl(['kickstart', '-k', target]);
    if (r.status !== 0) throw new Error(`launchctl kickstart lỗi: ${(r.stderr || '').trim() || r.status}`);
    return { healthy: await waitHealthy() };
  }

  async function status() {
    return { installed: fs.existsSync(plistFile), loaded: platform === 'darwin' && loaded(), healthy: await health(), port, logFile };
  }

  // Mở app; chưa có mật khẩu → tạo mã thiết lập mới (DB dùng chung với server) để người dùng tạo mật khẩu.
  function open() {
    const url = `http://127.0.0.1:${port}/`;
    let setupCode = null;
    const store = openStore(path.join(home, 'studio.db'));
    try {
      if (!hasPassword(store)) setupCode = newSetupCode(store);
    } finally {
      store.close();
    }
    openUrl(url);
    return { url, setupCode };
  }

  return { install, uninstall, restart, status, open, plistFile, logFile, label };
}

// Lệnh `service …` của cli.js. Trả mã thoát.
export async function runServiceCommand(argv, { home, env = process.env, log = console.log, ...deps } = {}) {
  const [cmd, ...rest] = argv;
  let port = env.VS_SERVICE_PORT ? Number(env.VS_SERVICE_PORT) : SERVICE_PORT;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--port' || a.startsWith('--port=')) {
      const v = a.includes('=') ? a.split('=')[1] : rest[++i];
      if (!/^\d{1,5}$/.test(String(v)) || Number(v) < 1 || Number(v) > 65535) throw new Error(`--port không hợp lệ: "${v}".`);
      port = Number(v);
    } else throw new Error(`Không hiểu tham số "${a}".`);
  }
  const label = env.VS_SERVICE_LABEL || SERVICE_LABEL;
  const svc = createService({ home, port, label, ...deps });
  switch (cmd) {
    case 'install': {
      const r = await svc.install();
      log(r.healthy ? `Đã bật chạy nền: ${r.url}` : `Đã cài dịch vụ nhưng server chưa trả lời — xem log: ${r.logFile}`);
      log('Mở app: npm run open (lần đầu sẽ in mã thiết lập để tạo mật khẩu).');
      return r.healthy ? 0 : 1;
    }
    case 'uninstall':
      log(svc.uninstall().removed ? 'Đã tắt và gỡ dịch vụ. Dữ liệu vẫn giữ nguyên.' : 'Dịch vụ chưa được cài.');
      return 0;
    case 'restart': {
      const r = await svc.restart();
      log(r.healthy ? 'Đã khởi động lại.' : `Server chưa trả lời — xem log: ${svc.logFile}`);
      return r.healthy ? 0 : 1;
    }
    case 'status': {
      const s = await svc.status();
      log(`Cài: ${s.installed ? 'có' : 'không'} · launchd: ${s.loaded ? 'đã nạp' : 'chưa nạp'} · server :${s.port}: ${s.healthy ? 'đang chạy' : 'không trả lời'}`);
      return s.healthy ? 0 : 1;
    }
    case 'open': {
      const r = svc.open();
      log(`Đã mở ${r.url}`);
      if (r.setupCode) log(`Lần đầu: tạo mật khẩu với mã thiết lập ${r.setupCode}`);
      return 0;
    }
    default:
      log(SERVICE_HELP);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}
