#!/usr/bin/env node
// claude cho server thử của bộ chấm trợ lý: lượt trợ lý (có --mcp-config) chạy claude THẬT, còn lại (bước video, mức dùng, đăng nhập, skill) chạy fake-claude.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const real = process.env.EVAL_REAL_CLAUDE; // tên không bắt đầu bằng VS_ vì childEnv bỏ mọi biến VS_*
const fake = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const [cmd, args] = argv.includes('--mcp-config') && real ? [real, argv] : [process.execPath, [fake, ...argv]];

const child = spawn(cmd, args, { stdio: 'inherit' });
// Chuyển tín hiệu dừng cho tiến trình con; con thoát thế nào thì shim thoát y vậy.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => {
  if (!sig) process.exit(code ?? 1);
  process.removeAllListeners(sig);
  process.kill(process.pid, sig);
});
child.on('error', (e) => {
  process.stderr.write(`claude-shim: ${e.message}\n`);
  process.exit(127);
});
