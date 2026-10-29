// Giữ VieNeu nạp sẵn: một tiến trình Python nạp model một lần (~6 giây) rồi đọc nhiều lần (~1 giây/câu); rảnh 10 phút thì tự tắt cho nhẹ máy.
// Server mở thêm một Unix socket riêng (quyền 600) để lệnh studio-tts mà Claude chạy cũng dùng chung tiến trình này.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const VIENEU_SCRIPT = fileURLToPath(new URL('./bin/vieneu_tts.py', import.meta.url));
export const IDLE_MS = 10 * 60_000;

// Lệnh chạy script VieNeu qua uv (tự cài thư viện lần đầu); `extra` là tham số thêm cho script.
export function vieneuArgv(extra = []) {
  const uv = process.env.VS_UV || [path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv'].find((f) => fs.existsSync(f)) || 'uv';
  return [uv, ['run', '--no-project', '--python', '3.12', '--with', 'vieneu', '--with', 'onnxruntime<1.23', '--with', 'soundfile', 'python', VIENEU_SCRIPT, ...extra]];
}

// Socket theo thư mục dữ liệu (server và studio-tts cùng home → cùng socket); để ở thư mục tạm vì đường dẫn socket bị giới hạn ~104 ký tự.
export const vieneuSocket = (home) => path.join(os.tmpdir(), `vs-vieneu-${crypto.createHash('sha1').update(path.resolve(home)).digest('hex').slice(0, 12)}.sock`);

const fail = (message) => Object.assign(new Error(message), { status: 502, code: 'tts_failed' });

// Tiến trình đọc chạy nền. run({text, out, voice}) xếp hàng từng việc; chết giữa chừng thì việc đang chạy báo lỗi, việc sau tự mở lại.
export function createVieneuWorker({ argv = () => vieneuArgv(['--serve']), idleMs = IDLE_MS, jobMs = 30 * 60_000, spawnImpl = spawn } = {}) {
  let child = null; // { proc, ready: Promise, warm, waiting: [{resolve, reject}] }
  let idle = null;
  let queue = Promise.resolve();

  const kill = (c) => {
    if (!c || c.dead) return;
    c.dead = true;
    c.proc.stdin.end();
    setTimeout(() => c.proc.kill('SIGKILL'), 5000).unref();
  };
  function start() {
    const [bin, args] = argv();
    const proc = spawnImpl(bin, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const c = { proc, warm: false, dead: false, waiting: [], err: '' };
    let onReady;
    c.ready = new Promise((resolve, reject) => (onReady = { resolve, reject }));
    c.ready.catch(() => {});
    proc.stderr.on('data', (d) => { c.err = (c.err + d).slice(-500); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.ready) {
        c.warm = true;
        onReady.resolve();
      } else c.waiting.shift()?.resolve(m);
    });
    const die = (why) => {
      c.dead = true;
      c.warm = false;
      if (child === c) child = null;
      const e = fail(why);
      onReady.reject(e);
      for (const w of c.waiting.splice(0)) w.reject(e);
    };
    proc.on('error', (e) => die(`Không chạy được VieNeu: ${e.message}`));
    proc.on('close', (code) => die(`VieNeu dừng bất ngờ (mã ${code}). ${c.err.trim()}`.trim()));
    proc.stdin.on('error', () => {});
    return c;
  }

  async function job({ text, out, voice }) {
    clearTimeout(idle);
    if (!child || child.dead) child = start();
    const c = child;
    let timer;
    try {
      await c.ready;
      const reply = await new Promise((resolve, reject) => {
        c.waiting.push({ resolve, reject });
        c.proc.stdin.write(JSON.stringify({ text, out, voice }) + '\n');
        timer = setTimeout(() => (kill(c), reject(fail('VieNeu chạy quá lâu — đã dừng.'))), jobMs);
      });
      if (!reply.ok) throw fail(`VieNeu lỗi: ${reply.error || 'không rõ'}`);
      return reply;
    } finally {
      clearTimeout(timer);
      if (child === c && !c.dead) {
        idle = setTimeout(() => (child === c && (child = null), kill(c)), idleMs);
        idle.unref();
      }
    }
  }

  return {
    run: (j) => (queue = queue.catch(() => {}).then(() => job(j))),
    isWarm: () => !!child?.warm,
    stop() {
      clearTimeout(idle);
      kill(child);
      child = null;
    },
  };
}

// Server: nhận việc qua socket (1 dòng JSON vào, 1 dòng JSON ra) và chuyển cho worker.
export function serveVieneuSocket(worker, sock) {
  fs.rmSync(sock, { force: true });
  const srv = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', async (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = '';
      let reply;
      try {
        const j = JSON.parse(line);
        reply = { ok: true, ...(await worker.run({ text: String(j.text || ''), out: String(j.out || ''), voice: String(j.voice || '') })) };
      } catch (e) {
        reply = { ok: false, error: e.message };
      }
      conn.end(JSON.stringify(reply) + '\n');
    });
  });
  srv.on('error', (e) => console.error('Socket VieNeu lỗi:', e?.message || e));
  srv.listen(sock, () => fs.chmodSync(sock, 0o600));
  return {
    close: () => new Promise((r) => srv.close(() => (fs.rmSync(sock, { force: true }), r()))),
  };
}

// studio-tts: nhờ server đang chạy đọc giùm. Không có server (socket không tồn tại) → null để tự chạy một lần.
export function vieneuViaSocket(sock) {
  return {
    run: ({ text, out, voice }) =>
      new Promise((resolve, reject) => {
        if (!fs.existsSync(sock)) return resolve(null);
        const conn = net.createConnection(sock);
        let buf = '';
        let sent = false;
        conn.setEncoding('utf8');
        conn.on('connect', () => {
          sent = true;
          conn.write(JSON.stringify({ text, out, voice }) + '\n');
        });
        conn.on('data', (d) => (buf += d));
        conn.on('error', (e) => (sent ? reject(fail(`Mất kết nối tới Video Studio: ${e.message}`)) : resolve(null)));
        conn.on('end', () => {
          let m = null;
          try {
            m = JSON.parse(buf);
          } catch {
            return reject(fail('Video Studio trả kết quả giọng đọc lạ.'));
          }
          if (m.ok) resolve(m);
          else reject(fail(m.error || 'VieNeu lỗi.'));
        });
      }),
  };
}
