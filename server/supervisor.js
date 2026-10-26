// Chạy trong terminal: tiến trình cha giữ terminal, chạy server thật ở tiến trình con. Con thoát mã 75 (nút Khởi động lại)
// → cha mở lại con từ code mới trên máy, cùng cổng, log vẫn in ở terminal này. Giống launchd khi chạy nền.
import { fork } from 'node:child_process';

export const RESTART_CODE = 75;
export const SUPERVISED_ENV = 'VS_SUPERVISED';

// Tham số cho lần mở lại: bỏ --open (đã mở trình duyệt rồi), giữ đúng cổng đang dùng.
export function restartArgs(argv, port) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open' || a === '--no-open') continue;
    if (a === '--port') {
      i++;
      continue;
    }
    if (a.startsWith('--port=')) continue;
    out.push(a);
  }
  return port ? [...out, '--port', String(port)] : out;
}

// Con báo cổng sau khi listen (chỉ khi chạy dưới cha).
export function reportListening(port) {
  if (process.env[SUPERVISED_ENV] === '1' && typeof process.send === 'function') process.send({ type: 'listening', port });
}

// Con: cha chết (mất kênh IPC) → tự tắt, không để server mồ côi.
export function exitWithParent(close) {
  if (process.env[SUPERVISED_ENV] !== '1' || typeof process.send !== 'function') return;
  process.on('disconnect', () => {
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    Promise.resolve(close?.()).finally(() => process.exit(0));
  });
}

// Cha: chạy con, mở lại khi con thoát mã 75; trả về mã thoát cuối. macOS/Linux: con ở nhóm tiến trình riêng, Ctrl+C/SIGTERM
// do cha chuyển cho con. Windows: Ctrl+C tới mọi tiến trình cùng cửa sổ, kill() lại là tắt cứng → cha chỉ chờ con tự tắt.
// spawnChild(args) để test thay fork.
export function supervise({
  script,
  argv = [],
  env = process.env,
  forward = process.platform !== 'win32',
  spawnChild = (args) =>
    fork(script, args, { env: { ...env, [SUPERVISED_ENV]: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], detached: forward, windowsHide: true }),
  log = (s) => console.log(s),
  signals = process,
} = {}) {
  return new Promise((resolve) => {
    let child = null;
    let port = null;
    let stopping = false;
    const onSignal = (sig) => {
      stopping = true;
      if (!child || child.exitCode != null || child.signalCode != null) finish(0);
      else if (forward) child.kill(sig);
    };
    const finish = (code) => {
      signals.off?.('SIGINT', onSignal);
      signals.off?.('SIGTERM', onSignal);
      resolve(code);
    };
    const start = (args) => {
      child = spawnChild(args);
      child.on('message', (m) => {
        if (m?.type === 'listening' && Number.isInteger(m.port)) port = m.port;
      });
      child.on('exit', (code, sig) => {
        if (code === RESTART_CODE && !stopping) {
          log('Đang khởi động lại Video Studio…');
          return start(restartArgs(argv, port));
        }
        finish(code ?? (sig ? 1 : 0));
      });
    };
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);
    start(argv);
  });
}

// Lệnh chạy server thường (không phải subcommand, --help, hay chế độ dịch vụ) → nên chạy dưới cha.
export function shouldSupervise(argv, env = process.env) {
  if (env[SUPERVISED_ENV] === '1' || env.VS_SUPERVISE === '0') return false;
  if (['--update', 'update', 'service', 'reset-password'].includes(argv[0])) return false;
  return !argv.some((a) => a === '--service' || a === '-h' || a === '--help');
}
