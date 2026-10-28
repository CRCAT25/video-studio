import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTts, chunkText, splitCommand } from '../server/tts.js';
import { fileStore } from '../server/keychain.js';

const mk = (fetchImpl) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-tts-'));
  return { home, tts: createTts({ home, secrets: fileStore(path.join(home, 'secrets.json')), fetchImpl }) };
};
const audioRes = (b = 'AUDIO') => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(b), json: async () => ({}) });

test('chunkText cắt theo câu và không vượt giới hạn', () => {
  const t = Array.from({ length: 50 }, (_, i) => `Câu số ${i} khá dài một chút.`).join(' ');
  const parts = chunkText(t, 200);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 200));
  assert.deepEqual(chunkText('  '), []);
});

test('splitCommand tách dấu nháy', () => {
  assert.deepEqual(splitCommand('say -o "{out} x" --f \'{in}\''), ['say', '-o', '{out} x', '--f', '{in}']);
});

test('ElevenLabs: lưu, khóa không nằm trong tts.json, synth gọi đúng API', async () => {
  let call;
  const { home, tts } = mk(async (url, init) => { call = { url, init }; return audioRes(); });
  const p = await tts.save({ name: 'Eleven', kind: 'elevenlabs', voice: 'v123' }, 'SECRET');
  assert.equal(p.id, 'eleven');
  assert.ok(!fs.readFileSync(path.join(home, 'tts.json'), 'utf8').includes('SECRET'));
  assert.equal((await tts.list()).providers[0].hasKey, true);
  const out = path.join(home, 'o.mp3');
  const r = await tts.synth({ text: 'Xin chào', out });
  assert.equal(fs.readFileSync(out, 'utf8'), 'AUDIO');
  assert.match(call.url, /text-to-speech\/v123/);
  assert.equal(call.init.headers['xi-api-key'], 'SECRET');
  assert.equal(r.cost, 8);
});

test('http: thân JSON thoát ký tự, đọc base64 theo jsonPath', async () => {
  let body;
  const { home, tts } = mk(async (url, init) => { body = init.body; return { ok: true, status: 200, json: async () => ({ d: { a: Buffer.from('HELLO').toString('base64') } }) }; });
  await tts.save({ name: 'X', kind: 'http', http: { url: 'https://x.test/tts', headers: { Authorization: 'Bearer {key}' }, body: '{"t":"{text}"}', response: 'json-base64', jsonPath: 'd.a' } }, 'k');
  const out = path.join(home, 'o.mp3');
  const r = await tts.synth({ text: 'a "b"\nc', out });
  assert.deepEqual(JSON.parse(body), { t: 'a "b"\nc' });
  assert.equal(fs.readFileSync(out, 'utf8'), 'HELLO');
  assert.equal(r.paid, false);
});

test('command: chạy lệnh không qua shell, đọc {in} ghi {out}', async () => {
  const { home, tts } = mk();
  await tts.save({ name: 'Cp', kind: 'command', command: 'cp {in} {out}' });
  const out = path.join(home, 'c.mp3');
  await tts.synth({ text: 'abc', out });
  assert.equal(fs.readFileSync(out, 'utf8'), 'abc');
});

test('lỗi: không có provider, lệnh thiếu {out}, xóa chuyển mặc định', async () => {
  const { home, tts } = mk();
  await assert.rejects(tts.synth({ text: 'a', out: path.join(home, 'x.mp3') }), { code: 'no_provider' });
  await assert.rejects(tts.save({ name: 'B', kind: 'command', command: 'echo' }), { code: 'bad_command' });
  await tts.save({ name: 'A', kind: 'command', command: 'cp {in} {out}' });
  await tts.save({ name: 'B', kind: 'command', command: 'cp {in} {out}' });
  assert.equal((await tts.list()).default, 'a');
  await tts.remove('a');
  assert.equal((await tts.list()).default, 'b');
});

test('API: lưu, liệt kê, đọc thử, xóa giọng đọc', async () => {
  const { buildApp } = await import('../server/app.js');
  const { home, tts } = mk();
  const app = await buildApp({ store: { tokensSince: () => 0 }, projects: { list: () => [] }, token: 'tok-12345678', home, tts, skills: {} });
  const h = { host: '127.0.0.1:4318', 'x-studio-token': 'tok-12345678' };
  const put = await app.inject({ method: 'PUT', url: '/api/tts/providers', headers: h, payload: { provider: { name: 'Cp', kind: 'command', command: 'cp {in} {out}' }, makeDefault: true } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().default, 'cp');
  const test_ = await app.inject({ method: 'POST', url: '/api/tts/test', headers: h, payload: { text: 'hi' } });
  assert.equal(test_.statusCode, 200);
  assert.equal(test_.json().audio, `data:audio/mpeg;base64,${Buffer.from('hi').toString('base64')}`);
  const bad = await app.inject({ method: 'PUT', url: '/api/tts/providers', headers: h, payload: { provider: { name: 'X', kind: 'command', command: 'echo' } } });
  assert.equal(bad.statusCode, 400);
  const del = await app.inject({ method: 'DELETE', url: '/api/tts/providers/cp', headers: h, payload: {} });
  assert.equal(del.statusCode, 200, del.body);
  assert.deepEqual(del.json().providers, []);
});

test('studio-tts CLI: ghi file và in JSON', async () => {
  const { execFileSync } = await import('node:child_process');
  const { home, tts } = mk();
  await tts.save({ name: 'Cp', kind: 'command', command: 'cp {in} {out}' });
  const out = path.join(home, 'cli.mp3');
  const r = JSON.parse(execFileSync('node', ['server/bin/studio-tts.mjs', '--text', 'xin chào', '--out', out], { env: { ...process.env, VS_HOME: home, VS_SECRETS: 'file' } }).toString());
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(out, 'utf8'), 'xin chào');
});

test('ElevenLabs: tải danh sách giọng bằng khóa vừa nhập, báo thiếu quyền', async () => {
  let hdr;
  const ok = mk(async (url, init) => { hdr = init.headers['xi-api-key']; return { ok: true, status: 200, json: async () => ({ voices: [{ voice_id: 'a1', name: 'An', labels: { language: 'vi', gender: 'female' }, preview_url: 'https://x/p.mp3' }, { name: 'bỏ' }] }) }; });
  const v = (await ok.tts.voices({ key: "K1" })).voices;
  assert.equal(hdr, 'K1');
  assert.deepEqual(v, [{ id: 'a1', name: 'An', category: '', desc: 'vi · female', preview: 'https://x/p.mp3' }]);
  const bad = mk(async () => ({ ok: false, status: 401, json: async () => ({ detail: { status: 'missing_permissions', message: 'voices_read' } }) }));
  await assert.rejects(bad.tts.voices({ key: 'K' }), /Voices: Read/);
  assert.equal((await bad.tts.voices({})).bundled, true);
});

test('khóa API có ký tự không phải ASCII bị từ chối rõ ràng', async () => {
  const { tts } = mk(async () => audioRes());
  await assert.rejects(tts.save({ name: 'E', kind: 'elevenlabs', voice: 'v' }, 'sk_abcẽ'), { code: 'bad_key' });
  await assert.rejects(tts.voices({ key: 'sk abc' }), { code: 'bad_key' });
});

test('ElevenLabs: lỗi khi đọc được giải thích rõ (thiếu quyền, sai khóa, giọng thư viện)', async () => {
  const run = async (status, detail) => {
    const { tts } = mk(async () => ({ ok: false, status, json: async () => ({ detail }) }));
    await tts.save({ name: 'E', kind: 'elevenlabs', voice: 'v' }, 'K');
    return tts.synth({ text: 'a', out: path.join(os.tmpdir(), 'x.mp3') }).then(() => '', (e) => e.message);
  };
  assert.match(await run(401, { status: 'missing_permissions', message: 'text_to_speech' }), /thiếu quyền "Text to Speech"/);
  assert.match(await run(401, { status: 'invalid_api_key', message: 'Invalid API key' }), /không đúng hoặc đã bị thu hồi/);
  assert.match(await run(402, { status: 'paid_plan_required', message: 'Free users cannot use library voices via the API' }), /gói miễn phí/);
  assert.match(await run(404, { status: 'voice_not_found' }), /ID giọng/);
});

test('ElevenLabs: gói free chỉ giữ giọng dùng được; đọc thử câu ngắn', async () => {
  const list = { voices: [{ voice_id: 'a', name: 'Premade', category: 'premade' }, { voice_id: 'b', name: 'Lib', category: 'professional' }] };
  const { tts } = mk(async (url) => {
    if (url.endsWith('/v1/voices')) return { ok: true, status: 200, json: async () => list };
    if (url.endsWith('/v1/user/subscription')) return { ok: true, status: 200, json: async () => ({ tier: 'free' }) };
    return audioRes('MP3');
  });
  const r = await tts.voices({ key: 'K' });
  assert.deepEqual(r.voices.map((v) => v.id), ['a']);
  assert.equal(r.hidden, 1);
  const s = await tts.sample({ key: 'K', voice: 'a', text: 'Chào bạn' });
  assert.equal(s.audio.toString(), 'MP3');
  assert.equal(s.cost, 8);
  await assert.rejects(tts.sample({ key: 'K' }), { code: 'no_voice' });
});
