import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { buildPrompt, cleanMessages, createIdeas, sanitize } from '../server/ideas.js';
import { REPO_ROOT } from '../server/presets.js';

const FAKE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const TOKEN = 'test-token-abcdefghijklmnop';
const STEPS = [{ id: 'nghien-cuu', name: 'Nghiên cứu' }, { id: 'kich-ban', name: 'Kịch bản' }];
const CH = [{ id: 'ka', name: 'Kênh A', platform: 'youtube' }];
let tmp, home;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ideas-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});
afterEach(() => {
  delete process.env.FAKE_IDEAS;
  delete process.env.FAKE_IDEAS_FAIL;
  fs.rmSync(tmp, { recursive: true, force: true });
});
const logOf = () => fs.readFileSync(path.join(home, 'ideas', '.fake-ideas.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const mk = (extra = {}) => createIdeas({ home, claudeBin: FAKE, env: process.env, channels: () => CH, videos: async () => ({ videos: [{ title: 'Video ít xem', views: 5 }, { title: 'Video hot', views: 999, publishedAt: '2026-10-01T00:00:00Z' }] }), steps: () => STEPS, ...extra });

test('cleanMessages: chỉ vai hợp lệ, cắt độ dài, giữ 12 tin gần nhất', () => {
  const raw = [{ role: 'system', text: 'x' }, { role: 'user', text: ' ' }, ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `t${i}${'a'.repeat(900)}` }))];
  const r = cleanMessages(raw);
  assert.equal(r.length, 12);
  assert.equal(r[11].text.length, 600);
  assert.ok(r[0].text.startsWith('t8'));
});

test('sanitize: bỏ ý tưởng trùng/rỗng, chỉ giữ id bước có thật và không trùng', () => {
  const r = sanitize({ reply: ' ok ', ideas: [{ title: 'A', why: 'w' }, { title: 'A', why: 'dup' }, { title: ' ' }], steps: ['kich-ban', 'ma', 'kich-ban', 'nghien-cuu'] }, STEPS);
  assert.deepEqual(r, { reply: 'ok', ideas: [{ title: 'A', why: 'w', viral: '' }], steps: ['kich-ban', 'nghien-cuu'] });
});

test('buildPrompt: video xếp theo lượt xem, có bước + hội thoại; web chỉ khi bật', () => {
  const p = buildPrompt({ channel: CH[0], videos: [{ title: 'a', views: 1 }, { title: 'b', views: 9 }], steps: STEPS, messages: [{ role: 'user', text: 'xin ý tưởng' }], web: false });
  assert.ok(p.indexOf('- b |') < p.indexOf('- a |'));
  assert.match(p, /nghien-cuu \| Nghiên cứu/);
  assert.match(p, /Người dùng: xin ý tưởng/);
  assert.match(p, /Không tìm web/);
});

test('chat: tin cuối phải của người dùng; kênh lạ → 404; tắt web thì không mở công cụ', async () => {
  const s = mk();
  await assert.rejects(() => s.chat({ messages: [] }), (e) => e.status === 400);
  await assert.rejects(() => s.chat({ messages: [{ role: 'assistant', text: 'x' }] }), (e) => e.status === 400);
  await assert.rejects(() => s.chat({ channelId: 'la', messages: [{ role: 'user', text: 'hi' }] }), (e) => e.status === 404);
  const r = await s.chat({ channelId: 'ka', messages: [{ role: 'user', text: 'cho tôi ý tưởng' }] });
  assert.equal(r.ideas.length, 2);
  const [log] = logOf();
  assert.equal(log.argv[log.argv.indexOf('--tools') + 1], '');
  assert.match(log.prompt, /Video hot \| 999 lượt xem \| 2026-10-01/);
  await s.chat({ channelId: 'ka', web: true, messages: [{ role: 'user', text: 'ý tưởng' }] });
  const l2 = logOf()[1];
  assert.equal(l2.argv[l2.argv.indexOf('--tools') + 1], 'WebSearch,WebFetch');
});

test('chat: lỗi lấy video không chặn; bố cục lọc id lạ; claude lỗi → 502', async () => {
  const s = mk({ videos: async () => { throw new Error('chưa nối'); } });
  const r = await s.chat({ channelId: 'ka', messages: [{ role: 'user', text: 'bố cục các bước' }] });
  assert.deepEqual(r.steps, ['nghien-cuu', 'kich-ban']);
  process.env.FAKE_IDEAS_FAIL = '1';
  await assert.rejects(() => s.chat({ messages: [{ role: 'user', text: 'hi' }] }), (e) => e.status === 502);
});

test('API /api/ideas/chat: 200 khi bật, 503 khi chưa bật', async () => {
  const h = { host: '127.0.0.1:4318', 'x-studio-token': TOKEN };
  const mkApp = (ideas) => buildApp({ store: { tokensSince: () => 0 }, projects: { list: () => [] }, token: TOKEN, home, channels: () => CH, ideas });
  let app = await mkApp((deps) => createIdeas({ home, claudeBin: FAKE, env: process.env, ...deps }));
  try {
    const res = await app.inject({ method: 'POST', url: '/api/ideas/chat', headers: h, payload: { channelId: 'ka', messages: [{ role: 'user', text: 'xin ý tưởng' }] } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ideas.length, 2);
    assert.ok(Array.isArray(res.json().steps));
  } finally {
    await app.close();
  }
  app = await mkApp(null);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/ideas/chat', headers: h, payload: { messages: [{ role: 'user', text: 'x' }] } })).statusCode, 503);
  } finally {
    await app.close();
  }
});
