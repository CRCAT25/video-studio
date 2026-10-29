import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVieneuWorker, serveVieneuSocket, vieneuSocket, vieneuViaSocket } from '../server/vieneu.js';
import { createTts } from '../server/tts.js';

// Worker giả theo đúng giao thức --serve: báo ready, mỗi dòng JSON ghi "VIENEU <voice> #<lần>" ra file out.
// Chữ "lỗi" trong câu → trả ok:false; "chết" → thoát ngay.
const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let n = 0;
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
rl.on('line', (l) => {
  const j = JSON.parse(l);
  if (j.text.includes('chết')) process.exit(3);
  if (j.text.includes('lỗi')) return process.stdout.write(JSON.stringify({ ok: false, error: 'hỏng' }) + '\\n');
  require('node:fs').writeFileSync(j.out, 'VIENEU ' + j.voice + ' #' + ++n);
  process.stdout.write(JSON.stringify({ ok: true, secs: 1 }) + '\\n');
});`;

const mk = (opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-vn-'));
  const script = path.join(dir, 'fake.cjs');
  fs.writeFileSync(script, FAKE);
  let spawns = 0;
  const worker = createVieneuWorker({ argv: () => (spawns++, [process.execPath, [script]]), ...opts });
  return { dir, worker, spawns: () => spawns, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
};

test('VieNeu worker: nạp một lần, đọc nhiều lần dùng lại cùng tiến trình', async (t) => {
  const { dir, worker, spawns, read } = mk();
  t.after(() => worker.stop());
  assert.equal(worker.isWarm(), false);
  await worker.run({ text: 'Câu một.', out: path.join(dir, 'a.mp3'), voice: 'Ngọc Linh' });
  assert.equal(worker.isWarm(), true);
  // Hai việc gửi cùng lúc vẫn xếp hàng lần lượt.
  await Promise.all([
    worker.run({ text: 'Câu hai.', out: path.join(dir, 'b.mp3'), voice: 'Thiện Minh' }),
    worker.run({ text: 'Câu ba.', out: path.join(dir, 'c.mp3'), voice: 'Thiện Minh' }),
  ]);
  assert.equal(read('a.mp3'), 'VIENEU Ngọc Linh #1');
  assert.equal(read('c.mp3'), 'VIENEU Thiện Minh #3');
  assert.equal(spawns(), 1);
});

test('VieNeu worker: lỗi một câu không làm chết tiến trình; chết thì lần sau tự mở lại', async (t) => {
  const { dir, worker, spawns, read } = mk();
  t.after(() => worker.stop());
  await assert.rejects(worker.run({ text: 'có lỗi', out: path.join(dir, 'x.mp3'), voice: '' }), { code: 'tts_failed', message: /hỏng/ });
  await assert.rejects(worker.run({ text: 'chết', out: path.join(dir, 'x.mp3'), voice: '' }), { message: /dừng bất ngờ/ });
  assert.equal(worker.isWarm(), false);
  await worker.run({ text: 'Sống lại.', out: path.join(dir, 'y.mp3'), voice: 'A' });
  assert.equal(read('y.mp3'), 'VIENEU A #1');
  assert.equal(spawns(), 2);
});

test('VieNeu worker: rảnh quá hạn thì tự tắt, đọc tiếp thì nạp lại', async (t) => {
  const { dir, worker, spawns } = mk({ idleMs: 50 });
  t.after(() => worker.stop());
  await worker.run({ text: 'Một.', out: path.join(dir, 'a.mp3'), voice: '' });
  assert.equal(worker.isWarm(), true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(worker.isWarm(), false);
  await worker.run({ text: 'Hai.', out: path.join(dir, 'b.mp3'), voice: '' });
  assert.equal(spawns(), 2);
});

test('VieNeu socket: studio-tts nhờ server đọc; không có server → null để tự chạy', async (t) => {
  const { dir, worker, read } = mk();
  const home = path.join(dir, 'home');
  const sock = vieneuSocket(home);
  const client = vieneuViaSocket(sock);
  assert.equal(await client.run({ text: 'x', out: path.join(dir, 'n.mp3'), voice: '' }), null);
  const srv = serveVieneuSocket(worker, sock);
  t.after(async () => (worker.stop(), await srv.close()));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  const tts = createTts({ home, vieneu: client });
  const r = await tts.synth({ text: 'Xin chào', out: path.join(dir, 's.mp3') });
  assert.equal(r.provider, 'vieneu');
  assert.equal(read('s.mp3'), 'VIENEU Thiện Minh #1');
  await assert.rejects(client.run({ text: 'có lỗi', out: path.join(dir, 'e.mp3'), voice: '' }), { message: /hỏng/ });
});

test('createTts: báo VieNeu đã nạp sẵn chưa (list + choices)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-vn-'));
  let warm = false;
  const tts = createTts({ home, vieneu: { run: async () => null, isWarm: () => warm } });
  assert.equal((await tts.list()).vieneuWarm, false);
  warm = true;
  assert.equal((await tts.list()).vieneuWarm, true);
  assert.equal((await tts.choices()).free.warm, true);
});

test('VieNeu worker: việc còn xếp hàng mà lượt đã bị dừng (signal aborted) → bỏ, không đọc', async (t) => {
  const { dir, worker, spawns } = mk();
  t.after(() => worker.stop());
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(worker.run({ text: 'Câu bị hủy.', out: path.join(dir, 'z.mp3'), voice: '' }, { signal: ac.signal }), { message: /Đã hủy/ });
  assert.equal(fs.existsSync(path.join(dir, 'z.mp3')), false);
  assert.equal(spawns(), 0);
});
