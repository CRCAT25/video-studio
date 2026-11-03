import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVoiceStudio, seedOf } from '../server/voicestudio.js';
import { createTts } from '../server/tts.js';

const ffmpegOk = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// WAV im lặng 0,2 giây để ffmpeg ghép thật.
const wav = () => {
  const n = 3200, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
};

// fetch giả cho backend: /health trả theo cờ `up`, /generate ghi lại form nhận được.
function fakeApi({ up = true } = {}) {
  const calls = [];
  const state = { up };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/health') return new Response('{}', { status: state.up ? 200 : 503 });
    if (u.pathname === '/generate') {
      calls.push(Object.fromEntries(init.body.entries()));
      return new Response(wav(), { status: 200 });
    }
    if (u.pathname === '/profiles') return new Response(JSON.stringify([{ id: 'p1', name: 'Giọng của tôi' }]), { status: 200 });
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls, state };
}
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-vs-'));

test('seedOf: cùng mô tả → cùng seed, khác mô tả → khác seed', () => {
  assert.equal(seedOf('male'), seedOf('male'));
  assert.notEqual(seedOf('male'), seedOf('female'));
});

test('VoiceStudio: chưa cài app → báo lỗi rõ, không cố chạy', async () => {
  const vs = createVoiceStudio({ home: mkHome(), dir: null, fetchImpl: fakeApi({ up: false }).fetchImpl });
  assert.equal(vs.available(), false);
  await assert.rejects(vs.ensure(), /Chưa cài app VoiceStudio/);
});

test('VoiceStudio: backend đang chạy thì không bật thêm', async () => {
  const api = fakeApi();
  let spawned = 0;
  const vs = createVoiceStudio({ home: mkHome(), dir: '/x', fetchImpl: api.fetchImpl, spawnImpl: () => (spawned++, {}) });
  await vs.ensure();
  assert.equal(spawned, 0);
});

test('VoiceStudio: backend chưa chạy → bật bằng uvicorn rồi chờ /health, ghi pid', async () => {
  const api = fakeApi({ up: false });
  const home = mkHome();
  let args = null;
  const spawnImpl = (bin, a, o) => {
    args = { bin, a, o };
    setTimeout(() => { api.state.up = true; }, 50);
    return { pid: 99999, on() {}, unref() {} };
  };
  const vs = createVoiceStudio({ home, dir: '/x', fetchImpl: api.fetchImpl, spawnImpl });
  await vs.ensure();
  assert.match(args.bin, /\.venv\/bin\/python$/);
  assert.deepEqual(args.a.slice(0, 3), ['-m', 'uvicorn', 'main:app']);
  assert.ok(args.a.includes('3900') && args.a.includes('127.0.0.1'));
  assert.equal(args.o.detached, true);
  assert.equal(fs.readFileSync(path.join(home, 'voicestudio.pid'), 'utf8'), '99999');
});

test('VoiceStudio: bật quá lâu → báo lỗi', async () => {
  const api = fakeApi({ up: false });
  const vs = createVoiceStudio({ home: mkHome(), dir: '/x', fetchImpl: api.fetchImpl, spawnImpl: () => ({ pid: 0, on() {}, unref() {} }), startMs: 1200 });
  await assert.rejects(vs.ensure(), /bật quá lâu/);
});

test('VoiceStudio: gửi mô tả giọng + seed cố định cho mọi đoạn, ghép thành mp3', { skip: !ffmpegOk && 'thiếu ffmpeg' }, async () => {
  const api = fakeApi();
  const home = mkHome();
  const out = path.join(home, 'a.mp3');
  const vs = createVoiceStudio({ home, dir: '/x', fetchImpl: api.fetchImpl });
  await vs.run({ parts: ['Câu một.', 'Câu hai.'], out, voice: 'male, middle-aged, low pitch' });
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[0].language, 'Vietnamese');
  assert.equal(api.calls[0].instruct, 'male, middle-aged, low pitch');
  assert.equal(api.calls[0].seed, api.calls[1].seed);
  assert.equal(api.calls[0].profile_id, undefined);
  assert.ok(fs.statSync(out).size > 100);
  assert.equal(fs.readdirSync(home).some((f) => f.startsWith('.vs-')), false, 'dọn thư mục tạm');
});

test('VoiceStudio: báo tiến độ theo số ký tự đã đọc sau mỗi đoạn', { skip: !ffmpegOk && 'thiếu ffmpeg' }, async () => {
  const home = mkHome();
  const vs = createVoiceStudio({ home, dir: '/x', fetchImpl: fakeApi().fetchImpl });
  const got = [];
  await vs.run({ parts: ['abcd', 'ef'], out: path.join(home, 'p.wav'), voice: 'male', onProgress: (x) => got.push(x) });
  assert.deepEqual(got.map((x) => [x.done, x.total, x.part, x.parts]), [[0, 6, 0, 2], [4, 6, 1, 2], [6, 6, 2, 2]]);
});

test('VoiceStudio: giọng profile:<id> dùng profile_id thay vì instruct', { skip: !ffmpegOk && 'thiếu ffmpeg' }, async () => {
  const api = fakeApi();
  const home = mkHome();
  const vs = createVoiceStudio({ home, dir: '/x', fetchImpl: api.fetchImpl });
  await vs.run({ parts: ['Xin chào.'], out: path.join(home, 'b.wav'), voice: 'profile:p1' });
  assert.equal(api.calls[0].profile_id, 'p1');
  assert.equal(api.calls[0].instruct, undefined);
  assert.deepEqual((await vs.profiles()).map((p) => p.id), ['profile:p1']);
});

test('VoiceStudio: engine nạp dở lúc mới bật → tự thử lại rồi đọc được', { skip: !ffmpegOk && 'thiếu ffmpeg' }, async () => {
  const api = fakeApi();
  let n = 0;
  const f = api.fetchImpl;
  const fetchImpl = async (url, init) => (new URL(url).pathname === '/generate' && n++ < 2 ? new Response('{"detail":"TTS engine \'omnivoice\' is not available"}', { status: 400 }) : f(url, init));
  const home = mkHome();
  const vs = createVoiceStudio({ home, dir: '/x', fetchImpl, retryMs: 5 });
  await vs.run({ parts: ['Xin chào.'], out: path.join(home, 'c.wav'), voice: 'male' });
  assert.equal(n, 3);
  const bad = createVoiceStudio({ home, dir: '/x', fetchImpl: async (u) => (new URL(u).pathname === '/generate' ? new Response('lỗi khác', { status: 400 }) : new Response('{}')), retryMs: 5 });
  await assert.rejects(bad.run({ parts: ['a'], out: path.join(home, 'd.wav'), voice: 'male' }), /lỗi 400/);
});

test('VoiceStudio: sweep chỉ tắt backend do mình bật, và chỉ khi đã rảnh', async () => {
  const home = mkHome();
  const vs = createVoiceStudio({ home, dir: '/x', fetchImpl: fakeApi().fetchImpl, idleMs: 100 });
  fs.writeFileSync(path.join(home, 'voicestudio.used'), String(Date.now()));
  vs.sweep(); // chưa có pid file → không làm gì, không lỗi
  fs.writeFileSync(path.join(home, 'voicestudio.pid'), '999999');
  vs.sweep(); // vừa dùng → giữ nguyên pid file
  assert.ok(fs.existsSync(path.join(home, 'voicestudio.pid')));
  fs.writeFileSync(path.join(home, 'voicestudio.used'), String(Date.now() - 5000));
  vs.sweep(); // rảnh → xóa pid file (pid không phải uvicorn nên không kill gì)
  assert.equal(fs.existsSync(path.join(home, 'voicestudio.pid')), false);
});

test('tts: loại voicestudio miễn phí, mặc định giọng trung niên, đọc qua voicestudio.run', async () => {
  const home = mkHome();
  const got = [];
  const tts = createTts({ home, voicestudio: { available: () => true, run: async (j) => { got.push(j); fs.writeFileSync(j.out, 'x'); } } });
  const p = await tts.save({ kind: 'voicestudio', name: 'VoiceStudio' });
  assert.equal(p.price.perChar, 0);
  assert.match(p.voice, /middle-aged/);
  const out = path.join(home, 'o.mp3');
  const r = await tts.synth({ provider: p.id, text: 'Chào bạn.', out, allowPaid: false });
  assert.equal(r.paid, false);
  assert.equal(got[0].voice, p.voice);
  assert.deepEqual(got[0].parts, ['Chào bạn.']);
  const l = await tts.list();
  assert.equal(l.voicestudio.available, true);
  assert.ok(l.voicestudio.voices.length >= 4);
});

test('tts: voicestudio chưa bật trên server → 503', async () => {
  const home = mkHome();
  const tts = createTts({ home });
  const p = await tts.save({ kind: 'voicestudio', name: 'VS' });
  await assert.rejects(tts.synth({ provider: p.id, text: 'a', out: path.join(home, 'o.mp3') }), /chưa bật/);
});

test('tts.sample: nghe thử giọng VoiceStudio đang chọn, miễn phí, chưa cần lưu', async () => {
  const home = mkHome();
  const got = [];
  const tts = createTts({ home, voicestudio: { available: () => true, run: async (j) => { got.push(j); fs.writeFileSync(j.out, 'MP3'); } } });
  const r = await tts.sample({ kind: 'voicestudio', voice: 'female, elderly, low pitch' });
  assert.equal(r.audio.toString(), 'MP3');
  assert.equal(r.cost, 0);
  assert.equal(got[0].voice, 'female, elderly, low pitch');
  assert.equal(fs.existsSync(got[0].out), false);
  await assert.rejects(createTts({ home }).sample({ kind: 'voicestudio', voice: 'x' }), /VoiceStudio/);
});

test('voicefx: kẹp giá trị, bộ lọc ffmpeg đổi cao độ giữ tốc độ, không hiệu ứng thì null', async () => {
  const { cleanFx, fxFilter, VOICESTUDIO_THEMES } = await import('../server/voicestudio.js');
  assert.deepEqual(cleanFx({ pitch: -99, tempo: 9, echo: 5, dark: 1 }), { pitch: -6, tempo: 1.3, echo: 1, dark: true });
  assert.deepEqual(cleanFx(), { pitch: 0, tempo: 1, echo: 0, dark: false });
  assert.equal(fxFilter({}), null);
  assert.match(fxFilter({ pitch: -2 }), /asetrate=.*atempo=/);
  assert.match(fxFilter({ echo: 0.5, dark: true }), /lowpass.*aecho/);
  for (const t of VOICESTUDIO_THEMES) assert.deepEqual(cleanFx(t.fx), t.fx);
});

test('tts: fx của voicestudio được lưu (đã kẹp) và truyền cho run/sample', async () => {
  const home = mkHome();
  const got = [];
  const tts = createTts({ home, voicestudio: { available: () => true, run: async (j) => { got.push(j); fs.writeFileSync(j.out, 'x'); } } });
  const p = await tts.save({ kind: 'voicestudio', name: 'VS', fx: { pitch: -50, echo: 0.4 } });
  assert.equal(p.fx.pitch, -6);
  await tts.synth({ provider: p.id, text: 'a', out: path.join(home, 'o.mp3'), allowPaid: false });
  assert.equal(got[0].fx.echo, 0.4);
  await tts.sample({ kind: 'voicestudio', voice: 'male', fx: { tempo: 0.9 } });
  assert.equal(got[1].fx.tempo, 0.9);
  assert.equal((await tts.list()).voicestudio.themes.length >= 6, true);
});
