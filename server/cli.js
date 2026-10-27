#!/usr/bin/env node
// Lệnh chạy Video Studio (hợp đồng M1 §9.6): mở store, nạp preset, tạo runner, buildApp, listen 127.0.0.1, in link localhost
// (+ mã thiết lập khi chưa có mật khẩu).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { createAssistant } from './assistant.js';
import { createPlanApi } from './claude-plan.js';
import { createUsage } from './usage.js';
import { createSkillSearch } from './skill-search.js';
import { createDistill } from './distill.js';
import { createClaudeAccount } from './claude-account.js';
import { createSecretStore } from './keychain.js';
import { openStore } from './db.js';
import { runDoctor } from './doctor.js';
import { expandHome, studioHome } from './paths.js';
import { loadChannels, loadPresets, presetDirs } from './presets.js';
import { createProjects } from './projects.js';
import { createYouTube, openInChromeProfile, ytChannelList } from './youtube/index.js';
import { createGoogleWizard } from './youtube/wizard.js';
import { createLogin, hasPassword, newSetupCode, resetPassword } from './login.js';
import { persistentToken, runServiceCommand, startBackups } from './service.js';
import { UpdateError, runUpdate } from './update.js';
import { createUpdater } from './updater.js';
import { RESTART_CODE, SUPERVISED_ENV, exitWithParent, reportListening, shouldSupervise, supervise } from './supervisor.js';

export const DEFAULT_PORT = 4317;
export const PORT_TRIES = 20;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const HELP = `Video Studio — xưởng làm video chạy local

Cách dùng: node server/cli.js [--port 4317] [--host 127.0.0.1] [--model haiku] [--no-open] [--dev]
          node server/cli.js --update         (cập nhật bản mới: git pull + npm install + build)
          node server/cli.js reset-password   (quên mật khẩu: xóa mật khẩu, in mã thiết lập mới)
          node server/cli.js service install|uninstall|restart|status|open   (chạy nền trên macOS)

  --port <số>     cổng (mặc định 4317 hoặc $VS_PORT); bận thì thử tăng dần tới +${PORT_TRIES}
  --host <địa chỉ> chỉ nhận 127.0.0.1 (mặc định), localhost hoặc ::1
  --model <tên>   model cho claude -p (hoặc $VS_MODEL)
  --open          tự mở trình duyệt bằng link (mặc định chỉ in link)
  --no-open       không mở trình duyệt (mặc định)
  --dev           in gợi ý chạy giao diện dev (npm run dev:web)
  --service       chế độ dịch vụ nền (launchd): cổng cố định, không in mã thiết lập ra log
  -h, --help      in hướng dẫn này

Biến môi trường: VS_HOME (thư mục dữ liệu, mặc định ~/.video-studio), VS_PORT, VS_TOKEN, VS_CLAUDE_BIN, VS_MODEL;
khi test: VS_SECRETS=file (bí mật YouTube lưu file thay vì Keychain), VS_GOOGLE_BASE (server Google giả),
VS_GCLOUD (gcloud giả, bỏ bước tải), VS_DOWNLOADS (thư mục Tải về).`;

// Phân tích tham số dòng lệnh → {port, host, model, open, dev, help}; sai → throw Error tiếng Việt.
export function parseArgs(argv = [], env = process.env) {
  const out = { port: null, host: '127.0.0.1', model: null, open: false, dev: false, service: false, help: false };
  const args = [...argv];
  const takeValue = (name, inline) => {
    if (inline !== undefined) return inline;
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new Error(`Thiếu giá trị cho ${name}.`);
    return v;
  };
  while (args.length) {
    const a = args.shift();
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    switch (name) {
      case '--port':
        out.port = parsePort(takeValue('--port', inline), '--port');
        break;
      case '--host':
        out.host = takeValue('--host', inline);
        break;
      case '--model':
        out.model = takeValue('--model', inline);
        break;
      case '--no-open':
        out.open = false;
        break;
      case '--open':
        out.open = true;
        break;
      case '--dev':
        out.dev = true;
        break;
      case '--service':
        out.service = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`Không hiểu tham số "${a}". Chạy với --help để xem cách dùng.`);
    }
  }
  if (out.port === null) out.port = env.VS_PORT ? parsePort(env.VS_PORT, 'VS_PORT') : DEFAULT_PORT;
  if (!LOOPBACK.has(String(out.host).toLowerCase())) {
    throw new Error(`--host chỉ nhận 127.0.0.1, localhost hoặc ::1 (server không mở ra mạng ngoài) — nhận "${out.host}".`);
  }
  out.host = out.host === '[::1]' ? '::1' : String(out.host).toLowerCase();
  if (!out.model && env.VS_MODEL && env.VS_MODEL.trim()) out.model = env.VS_MODEL.trim();
  return out;
}

// Cổng hợp lệ 0–65535 (0 = cổng ngẫu nhiên, dùng cho test).
export function parsePort(v, label = 'cổng') {
  const s = String(v ?? '').trim();
  if (!/^\d{1,5}$/.test(s) || Number(s) > 65535) throw new Error(`${label} không hợp lệ: "${v}" (cần số 0–65535).`);
  return Number(s);
}

// Listen trên host:port; EADDRINUSE → thử port+1 … port+tries. Trả cổng thật đang nghe.
export async function listenWithFallback(app, { host = '127.0.0.1', port = DEFAULT_PORT, tries = PORT_TRIES } = {}) {
  let lastErr = null;
  for (let i = 0; i <= tries; i++) {
    const p = port + i;
    if (p > 65535) break;
    try {
      await app.listen({ host, port: p });
      const addr = app.server.address();
      return addr && typeof addr === 'object' ? addr.port : p;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EADDRINUSE' || port === 0) throw e;
    }
  }
  const err = new Error(`Không tìm được cổng trống từ ${port} tới ${Math.min(port + tries, 65535)}.`);
  err.cause = lastErr;
  throw err;
}

// Đường dẫn claude: có dấu '/' → tuyệt đối theo cwd lúc khởi động; ngược lại để nguyên (dò PATH khi spawn).
export function resolveClaudeBin(v) {
  const s = String(v || '').trim() || 'claude';
  return /[\\/]/.test(s) ? path.resolve(s) : s;
}

// Hàm đọc preset có cache ngắn (1 s) để mỗi request không phải parse lại YAML nhiều lần; .invalidate() bỏ cache sau khi lưu/xóa.
export function cachedPresets(dirs, ttlMs = 1000) {
  let cache = null;
  const get = () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    const value = loadPresets(dirs);
    cache = { at: Date.now(), value };
    return value;
  };
  get.invalidate = () => {
    cache = null;
  };
  return get;
}

// Thư mục dữ liệu: VS_HOME trong env được truyền vào (test truyền thư mục tạm), không có → studioHome().
export function resolveHome(env = process.env) {
  const raw = env.VS_HOME && String(env.VS_HOME).trim();
  if (!raw) return studioHome();
  const home = path.resolve(expandHome(raw));
  fs.mkdirSync(home, { recursive: true });
  return home;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

async function loadRunnerModule() {
  try {
    return await import('./runner.js');
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('runner.js')) {
      throw new Error('Thiếu server/runner.js — chưa thể chạy bước nào. Cài đặt bản đầy đủ của Video Studio rồi chạy lại.');
    }
    throw e;
  }
}

// Chạy server: trả {app, port, url, close()} (close dùng cho tín hiệu tắt). Lỗi → throw.
// Mở link bằng trình duyệt mặc định của hệ điều hành; lỗi thì bỏ qua (link vẫn in ở terminal).
export function openInBrowser(url, platform = process.platform) {
  const [cmd, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* không mở được — người dùng bấm link trong terminal */
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, { openUrl = openInBrowser, update = runUpdate } = {}) {
  if (argv[0] === '--update' || argv[0] === 'update') {
    try {
      update();
      return { exitCode: 0 };
    } catch (e) {
      if (!(e instanceof UpdateError)) throw e;
      console.error(e.message);
      return { exitCode: 1 };
    }
  }
  if (argv[0] === 'service') {
    const code = await runServiceCommand(argv.slice(1), { home: resolveHome(env), env });
    return { exitCode: code };
  }
  if (argv[0] === 'reset-password') {
    const store = openStore(path.join(resolveHome(env), 'studio.db'));
    try {
      const code = resetPassword(store);
      console.log('Đã xóa mật khẩu và đăng xuất mọi phiên.');
      console.log(`Mở app và tạo mật khẩu mới với mã thiết lập: ${code}`);
    } finally {
      store.close();
    }
    return { exitCode: 0 };
  }
  const opts = parseArgs(argv, env);
  if (opts.help) {
    console.log(HELP);
    return null;
  }
  const home = resolveHome(env);
  // Token ẩn (VS_HOME/token, quyền 600) chỉ dùng cho dev/test qua ?t= hoặc header; người dùng đăng nhập bằng mật khẩu.
  const token = env.VS_TOKEN && env.VS_TOKEN.trim() ? env.VS_TOKEN.trim() : persistentToken(home);
  if (token.length < 8) throw new Error('VS_TOKEN quá ngắn (cần ≥ 8 ký tự).');
  const claudeBin = resolveClaudeBin(env.VS_CLAUDE_BIN);
  const dirs = presetDirs(home);
  const presets = cachedPresets(dirs);

  const { createRunner } = await loadRunnerModule();
  const store = openStore(path.join(home, 'studio.db'));
  // Kênh: YouTube = kênh đã thêm trong app (DB); nền tảng khác lấy từ channels.yaml ($VS_HOME/presets ưu tiên, rồi repo).
  const channels = () => [...loadChannels([...dirs].reverse()).filter((c) => c.platform !== 'youtube'), ...ytChannelList(store)];
  let app = null;
  let runner = null;
  let wizard = null;
  let stopBackups = () => {};
  let closeRef = null;
  let backupDir = null;
  // Lệnh `claude auth` không cần (và không được thấy) biến VS_* như token của app.
  const authEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('VS_')));
  const account = createClaudeAccount({ claudeBin, env: authEnv });
  // Trợ lý AI: MCP gọi về app theo địa chỉ biết sau khi listen.
  let assistUrl = null;
  // Mức dùng gói Claude: bắt % từ mọi lượt claude -p; Kiểm tra hỏi API như /usage (token Claude Code chỉ đọc lúc kiểm tra),
  // lỗi thì chạy 1 câu ngắn. VS_CLAUDE_CREDENTIALS / VS_CLAUDE_API_BASE: file token + API giả khi test.
  const usage = createUsage({ home, store, claudeBin, env: authEnv, planApi: createPlanApi({ env }) });
  const assistant = createAssistant({ home, claudeBin, baseUrl: () => assistUrl, usage });
  try {
    const projects = createProjects({ store, presets, channels, home });
    const fixed = projects.recoverOnStartup();
    runner = createRunner({ store, projects, presets, claudeBin, model: opts.model, home, lockHost: os.hostname() });
    runner.on('rate_limit', (info) => usage.observe(info));
    const youtube = createYouTube({
      store,
      // VS_SECRETS=file: lưu bí mật vào $VS_HOME/secrets.json thay vì Keychain (dùng khi test).
      secrets: createSecretStore({ home, platform: env.VS_SECRETS === 'file' ? 'file' : process.platform }),
      channels,
      googleBase: env.VS_GOOGLE_BASE || null,
    });
    wizard = createGoogleWizard({
      home,
      setClient: (text) => youtube.setup(text),
      isConfigured: async () => (await youtube.status()).configured,
      googleBase: env.VS_GOOGLE_BASE || null,
      openUrl: (url, dir) => openInChromeProfile(url, dir),
      gcloudBin: env.VS_GCLOUD ? path.resolve(env.VS_GCLOUD) : null,
      downloadsDir: env.VS_DOWNLOADS ? path.resolve(expandHome(env.VS_DOWNLOADS)) : undefined,
      env: authEnv,
    });
    // Báo bản mới từ Release GitHub (VS_UPDATE_CHECK=0 để tắt). Chạy nền / chạy dưới tiến trình cha: thoát mã 75 để được mở lại bản mới.
    const updater = createUpdater({
      enabled: env.VS_UPDATE_CHECK !== '0',
      apiBase: env.VS_UPDATE_API || undefined,
      updateBin: env.VS_UPDATE_BIN ? path.resolve(env.VS_UPDATE_BIN) : null,
      restart: opts.service || env[SUPERVISED_ENV] === '1' ? () => closeRef?.().finally(() => process.exit(RESTART_CODE)) : null,
    });
    app = await buildApp({
      store,
      updater,
      projects,
      runner,
      presets,
      channels,
      token,
      doctor: () => runDoctor({ claudeBin }),
      account,
      assistant,
      usage,
      skillSearch: (lib, channels) => createSkillSearch({ home, claudeBin, env: authEnv, lib, channels }),
      distill: createDistill({ claudeBin, env: authEnv }),
      youtube,
      googleWizard: wizard,
      login: createLogin({
        store,
        getClient: () => youtube.googleClient(),
        endpoints: youtube.endpoints,
        // Chế độ dịch vụ không in mã ra log — lấy mã bằng `service open`.
        onSetupCode: (code) => !opts.service && console.log(`Mã thiết lập mới: ${code}`),
      }),
      home,
      resetAll: {
        // Tên thư mục sao lưu (chưa đụng gì); run() đóng app, chuyển thư mục dữ liệu sang đó rồi thoát (mã 75 → được mở lại).
        prepare: async () => {
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
          backupDir = `${home}.bak-${stamp}`;
          return { backup: backupDir, restarting: !!(opts.service || env[SUPERVISED_ENV] === '1') };
        },
        run: async () => {
          try {
            await closeRef?.();
            fs.renameSync(home, backupDir);
          } catch (e) {
            console.error('Đặt lại lỗi:', e?.message || e);
          }
          process.exit(opts.service || env[SUPERVISED_ENV] === '1' ? RESTART_CODE : 0);
        },
      },
    });
    // Dịch vụ nền: cổng cố định (bookmark/cookie gắn cổng) — bận thì báo lỗi, launchd thử lại sau.
    const port = await listenWithFallback(app, { host: opts.host, port: opts.port, tries: opts.service ? 0 : PORT_TRIES });
    reportListening(port);
    stopBackups = startBackups(store.db, path.join(home, 'backups'), { onError: (e) => console.error('Sao lưu DB lỗi:', e?.message || e) });
    const shownHost = opts.host === '::1' ? '[::1]' : opts.host;
    const url = `http://${shownHost}:${port}/`;
    assistUrl = url;

    if (port !== opts.port && opts.port !== 0) console.log(`Cổng ${opts.port} đang bận — dùng cổng ${port}.`);
    console.log(`Video Studio đang chạy: ${url}`);
    // Chưa có mật khẩu → mã 6 số để tạo mật khẩu ở lần mở đầu (chế độ dịch vụ: log là file → không in).
    if (!opts.service && !hasPassword(store)) console.log(`Lần đầu: tạo mật khẩu với mã thiết lập ${newSetupCode(store)}`);
    console.log(`Thư mục dữ liệu (VS_HOME): ${home}`);
    if (fixed > 0) console.log(`Đã đánh dấu ${fixed} lượt chạy dở (server dừng giữa chừng) là thất bại.`);
    const { errors } = presets();
    for (const e of errors || []) console.warn(`Quy trình lỗi — ${e.file}: ${e.message}`);
    // --open: tự mở trình duyệt (mặc định chỉ in link).
    if (opts.open && !opts.service && !opts.dev) openUrl(url);
    if (opts.dev) {
      console.log('Chế độ dev: mở terminal khác và chạy');
      console.log(`  VS_PORT=${port} VS_TOKEN=${token} npm run dev:web`);
      console.log('Vite chuyển /api, /media sang server này (CORS không mở).');
    }

    updater.check().then((u) => {
      if (u.newer) console.log(`Có bản mới v${u.latest} (đang dùng v${u.current}) — chạy: video-studio --update`);
    });

    const close = async () => {
      stopBackups();
      account.dispose();
      assistant.dispose();
      usage.dispose();
      wizard?.dispose();
      try {
        if (runner && typeof runner.shutdown === 'function') await Promise.race([runner.shutdown(), delay(8000)]);
      } catch (e) {
        console.error('Lỗi khi dừng các lượt đang chạy:', e?.message || e);
      }
      try {
        await app.close();
      } catch {
        /* đã đóng */
      }
      store.close();
    };
    closeRef = close;
    exitWithParent(close);
    return { app, port, url, token, home, close };
  } catch (e) {
    account.dispose();
    assistant.dispose();
    wizard?.dispose();
    try {
      if (app) await app.close();
    } catch {
      /* bỏ qua */
    }
    try {
      if (runner && typeof runner.shutdown === 'function') await Promise.race([runner.shutdown(), delay(3000)]);
    } catch {
      /* bỏ qua */
    }
    store.close();
    throw e;
  }
}

function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isEntry() && shouldSupervise(process.argv.slice(2))) {
  supervise({ script: fileURLToPath(import.meta.url), argv: process.argv.slice(2) }).then((code) => process.exit(code));
} else if (isEntry()) {
  let server = null;
  let stopping = false;
  const onSignal = async (sig) => {
    if (stopping) {
      console.log('Thoát ngay.');
      process.exit(1);
    }
    stopping = true;
    console.log(`\nNhận ${sig} — đang tắt Video Studio…`);
    const force = setTimeout(() => process.exit(1), 12_000);
    force.unref();
    try {
      if (server) await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  main().then(
    (s) => {
      server = s;
      if (!s) process.exit(0);
      if (s.exitCode !== undefined) process.exit(s.exitCode);
    },
    (e) => {
      console.error(`Không khởi động được Video Studio: ${e?.message || e}`);
      process.exit(1);
    },
  );
}
