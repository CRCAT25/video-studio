import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { createSkills } from '../server/skills.js';
import { buildPrompt, createSkillSearch, sanitize, sanitizeClarify } from '../server/skill-search.js';
import { REPO_ROOT } from '../server/presets.js';

const FAKE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const TOKEN = 'test-token-abcdefghijklmnop';
const md = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;
let tmp, home, local, skills;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sksearch-'));
  home = path.join(tmp, 'home');
  local = path.join(tmp, 'local');
  fs.mkdirSync(home);
  for (const [root, n, d] of [[local, 'nguoi-que', 'Làm video người que'], [local, 'khac', 'Việc khác']]) {
    fs.mkdirSync(path.join(root, n), { recursive: true });
    fs.writeFileSync(path.join(root, n, 'SKILL.md'), md(n, d));
  }
  skills = createSkills({ home, localRoot: local, presets: () => ({ presets: [] }), channels: () => [{ id: 'ka' }] });
  skills.importText({ name: 'thu-vien', content: md('thu-vien', 'Skill trong thư viện') });
});
afterEach(() => {
  delete process.env.FAKE_SKILL_SEARCH;
  delete process.env.FAKE_SKILL_SEARCH_FAIL;
  delete process.env.FAKE_SKILL_CLARIFY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sanitize: bỏ skill không có thật, trùng, và link không phải GitHub', () => {
  const lib = [{ name: 'a' }];
  const loc = [{ name: 'b' }];
  const r = sanitize(
    {
      matches: [{ name: 'a', source: 'library', reason: 'x' }, { name: 'a', source: 'library', reason: 'dup' }, { name: 'a', source: 'local', reason: 'sai nguồn' }, { name: 'b', source: 'local', reason: 'y' }, { name: 'ma', source: 'library', reason: 'z' }],
      suggestions: [{ title: 't', url: 'https://github.com/o/r', reason: 'ok' }, { title: 'bad', url: 'https://evil.example/o/r', reason: '' }, { title: 'js', url: 'javascript:alert(1)', reason: '' }, { title: 'dotdot', url: 'https://github.com/o/r/tree/main/../x', reason: '' }],
    },
    lib,
    loc,
  );
  assert.deepEqual(r.matches.map((m) => `${m.source}:${m.name}`), ['library:a', 'local:b']);
  assert.deepEqual(r.suggestions.map((s) => s.url), ['https://github.com/o/r']);
});

test('createSkillSearch: prompt có skill thư viện + máy chưa nhập; chỉ mở web khi web:true', async () => {
  process.env.FAKE_SKILL_SEARCH = JSON.stringify({ matches: [{ name: 'nguoi-que', source: 'local', reason: 'hợp' }], suggestions: [{ title: 'r', url: 'https://github.com/o/r', reason: 'x' }] });
  const s = createSkillSearch({ home, claudeBin: FAKE, env: process.env, lib: skills });
  const r = await s.search({ query: 'video người que' });
  assert.deepEqual(r.alternatives, []);
  assert.deepEqual(r.matches, [{ name: 'nguoi-que', source: 'local', reason: 'hợp', scores: {} }]);
  const log = fs.readFileSync(path.join(home, 'skill-search', '.fake-skill-search.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.match(log[0].prompt, /thu-vien/);
  assert.match(log[0].prompt, /nguoi-que/);
  assert.equal(log[0].argv[log[0].argv.indexOf('--tools') + 1], '');
  await s.search({ query: 'video người que', web: true });
  const log2 = fs.readFileSync(path.join(home, 'skill-search', '.fake-skill-search.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log2[1].argv[log2[1].argv.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  await assert.rejects(() => s.search({ query: '  ' }), (e) => e.status === 400);
});

test('API: POST /api/skills/search; claude lỗi → 502; chưa bật → 503', async () => {
  process.env.FAKE_SKILL_SEARCH = JSON.stringify({ matches: [{ name: 'thu-vien', source: 'library', reason: 'ok' }], suggestions: [] });
  const h = { host: '127.0.0.1:4318', 'x-studio-token': TOKEN };
  const mkApp = (skillSearch) => buildApp({ store: { tokensSince: () => 0 }, projects: { list: () => [] }, token: TOKEN, home, skills, skillSearch });
  let app = await mkApp((lib) => createSkillSearch({ home, claudeBin: FAKE, env: process.env, lib }));
  try {
    const r = await app.inject({ method: 'POST', url: '/api/skills/search', headers: h, payload: { query: 'thư viện' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().matches[0].name, 'thu-vien');
    process.env.FAKE_SKILL_SEARCH_FAIL = '1';
    assert.equal((await app.inject({ method: 'POST', url: '/api/skills/search', headers: h, payload: { query: 'x' } })).statusCode, 502);
  } finally {
    await app.close();
  }
  app = await mkApp(null);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/skills/search', headers: h, payload: { query: 'x' } })).statusCode, 503);
  } finally {
    await app.close();
  }
});

test('sanitizeClarify: hỏi tiếp khi còn mơ hồ; đủ vòng hoặc thiếu câu hỏi → done kèm bản tinh chỉnh', () => {
  assert.deepEqual(sanitizeClarify({ done: false, question: ' Kênh nào? ', options: ['A', '', 'B', 'C', 'D', 'E'] }, 'q', []), { done: false, question: 'Kênh nào?', options: ['A', 'B', 'C', 'D'] });
  assert.deepEqual(sanitizeClarify({ done: true, refined: ' rõ rồi ' }, 'q', []), { done: true, refined: 'rõ rồi' });
  const three = [{ q: '1', a: 'x' }, { q: '2', a: 'y' }, { q: '3', a: 'z' }];
  assert.deepEqual(sanitizeClarify({ done: false, question: 'nữa?' }, 'q', three), { done: true, refined: 'q; x; y; z' });
  assert.deepEqual(sanitizeClarify({ done: false }, 'q', []), { done: true, refined: 'q' });
});

test('createSkillSearch.clarify + API: prompt có câu đã trả lời, không bật công cụ; chưa bật → 503', async () => {
  process.env.FAKE_SKILL_CLARIFY = JSON.stringify({ done: false, question: 'Phong cách hình?', options: ['Tối giản', 'Hoạt hình'] });
  const s = createSkillSearch({ home, claudeBin: FAKE, env: process.env, lib: skills });
  const r = await s.clarify({ query: 'video người que', answers: [{ q: 'Kênh nào?', a: 'TikTok' }, { q: '', a: 'bỏ' }] });
  assert.deepEqual(r, { done: false, question: 'Phong cách hình?', options: ['Tối giản', 'Hoạt hình'] });
  const log = fs.readFileSync(path.join(home, 'skill-search', '.fake-skill-search.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.match(log[0].prompt, /Đáp: TikTok/);
  assert.doesNotMatch(log[0].prompt, /bỏ/);
  assert.equal(log[0].argv[log[0].argv.indexOf('--tools') + 1], '');
  await assert.rejects(() => s.clarify({ query: ' ' }), (e) => e.status === 400);
  const h = { host: '127.0.0.1:4318', 'x-studio-token': TOKEN };
  const mkApp = (skillSearch) => buildApp({ store: { tokensSince: () => 0 }, projects: { list: () => [] }, token: TOKEN, home, skills, skillSearch });
  let app = await mkApp((lib) => createSkillSearch({ home, claudeBin: FAKE, env: process.env, lib }));
  try {
    const res = await app.inject({ method: 'POST', url: '/api/skills/search/clarify', headers: h, payload: { query: 'x', answers: [] } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().done, false);
  } finally {
    await app.close();
  }
  app = await mkApp(null);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/skills/search/clarify', headers: h, payload: { query: 'x' } })).statusCode, 503);
  } finally {
    await app.close();
  }
});

test('sanitize: alternatives bỏ trùng/rỗng, tối đa 4; tip cắt độ dài', () => {
  const r = sanitize({ matches: [], alternatives: ['a', 'a', ' ', 'b', 'c', 'd', 'e'], tip: ' cần skill X ' }, [], []);
  assert.deepEqual(r.alternatives, ['a', 'b', 'c', 'd']);
  assert.equal(r.tip, 'cần skill X');
  assert.deepEqual(sanitize({ matches: [] }, [], []).alternatives, []);
});

test('scores: buildPrompt có danh sách kênh; sanitize giữ id kênh thật, ép 0–100, bỏ id lạ', () => {
  const chs = [{ id: 'a', name: 'Kênh A', platform: 'youtube' }, { id: 'b', name: 'Kênh B' }];
  const lib = [{ name: 'x', description: 'd' }];
  const p = buildPrompt('q', lib, [], false, chs);
  assert.match(p, /- a \| Kênh A \| youtube/);
  assert.match(p, /scores/);
  assert.doesNotMatch(buildPrompt('q', lib, [], false, []), /scores/);
  const r = sanitize({ matches: [{ name: 'x', source: 'library', reason: 'r', scores: [{ channel: 'a', percent: 150 }, { channel: 'b', percent: 41.6 }, { channel: 'zz', percent: 50 }, { channel: 'a', percent: 'x' }] }] }, lib, [], chs);
  assert.deepEqual(r.matches[0].scores, { a: 100, b: 42 });
});
