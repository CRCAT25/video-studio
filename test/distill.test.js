import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { openStore } from '../server/db.js';
import { buildPrompt, createDistill, sanitizeDraft } from '../server/distill.js';
import { loadChannels, loadPresets, REPO_ROOT } from '../server/presets.js';
import { createProjects } from '../server/projects.js';
import { createSkills } from '../server/skills.js';

const FAKE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const FIXTURE_PRESETS = path.join(REPO_ROOT, 'test', 'fixtures', 'presets');
const TOKEN = 'test-token-abcdefghijklmnop';
const H = { host: '127.0.0.1:4318', 'x-studio-token': TOKEN };
const SKILL_MD = '---\nname: ve-nguoi-que\ndescription: Vẽ cảnh người que\n---\n# Vẽ\nGọi scripts/lib.py.\n';
const DRAFT = {
  name: 'Vẽ Người Que',
  summary: 'Phong cách vẽ.',
  files: [
    { path: 'SKILL.md', content: SKILL_MD },
    { path: 'scripts/lib.py', content: 'def nen(): pass\n' },
    { path: '../thoat.txt', content: 'x' },
    { path: '.an', content: 'x' },
  ],
  samples: ['outputs/s01.png', 'outputs/khong-co.png', 'outputs/notes.txt'],
};
let tmp, home, store, projects, skills, app, projDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-distill-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  store = openStore(path.join(home, 'studio.db'));
  projects = createProjects({ store, presets: () => loadPresets([FIXTURE_PRESETS]), channels: () => loadChannels([FIXTURE_PRESETS]), home });
  skills = createSkills({ home, localRoot: path.join(tmp, 'local'), presets: () => ({ presets: [] }), channels: () => [] });
});
afterEach(async () => {
  delete process.env.FAKE_SKILL_SEARCH;
  delete process.env.FAKE_SKILL_SEARCH_FAIL;
  if (app) await app.close();
  app = null;
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function makeApp(distill) {
  app = await buildApp({ store, projects, presets: () => loadPresets([FIXTURE_PRESETS]), channels: () => loadChannels([FIXTURE_PRESETS]), token: TOKEN, webDist: path.join(tmp, 'no-dist'), home, skills, distill });
  return app;
}
const call = (method, url, payload = {}) => app.inject({ method, url, headers: H, payload });

// Dự án có bước "hook" đã xong, kèm ảnh/mã đầu ra thật trong thư mục dự án.
async function projectWithOutputs() {
  await makeApp(createDistill({ claudeBin: FAKE, env: process.env }));
  const r = await call('POST', '/api/projects', { presetId: 'e2e-short', title: 'Mèo' });
  assert.equal(r.statusCode, 201, r.body);
  projDir = r.json().project?.dir ?? r.json().dir;
  fs.mkdirSync(path.join(projDir, 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'outputs', 's01.png'), 'PNGDATA');
  fs.writeFileSync(path.join(projDir, 'outputs', 'notes.txt'), 'ghi chú');
  const step = store.getStep('meo', 'hook');
  const run = store.insertRun({ step_id: step.id, project_id: 'meo', feedback: 'nền sáng hơn' });
  store.setArtifacts(run.id ?? run, [{ path: 'outputs/s01.png', kind: 'image' }, { path: 'outputs/notes.txt', kind: 'text' }]);
}

test('buildPrompt: nhúng prompt gốc, góp ý, đường dẫn đầu ra và nội dung file văn bản', async () => {
  fs.mkdirSync(path.join(tmp, 'p'));
  fs.writeFileSync(path.join(tmp, 'p', 'draw.py'), 'print("ve")');
  const p = buildPrompt({ stepName: 'Hình ảnh', stepKey: 'hinh-anh', promptTemplate: 'Vẽ cảnh', dir: path.join(tmp, 'p'), artifacts: [{ path: 'draw.py' }, { path: 'a.png' }], feedbacks: ['đậm hơn'], existing: [{ name: 'cu', content: 'NOIDUNGCU' }] }, 'Kênh A');
  for (const s of ['Hình ảnh', 'Vẽ cảnh', 'đậm hơn', 'print("ve")', 'a.png', 'Kênh A', 'NOIDUNGCU', 'CẬP NHẬT']) assert.ok(p.includes(s), s);
});

test('sanitizeDraft: slug tên, bỏ đường dẫn xấu, samples phải là ảnh thuộc đầu ra, updates chỉ khi trùng', () => {
  const arts = [{ path: 'outputs/s01.png' }, { path: 'outputs/notes.txt' }];
  const d = sanitizeDraft(DRAFT, { artifacts: arts, existingNames: [] });
  assert.equal(d.name, 've-nguoi-que');
  assert.deepEqual(d.files.map((f) => f.path), ['SKILL.md', 'scripts/lib.py']);
  assert.deepEqual(d.samples, ['outputs/s01.png']);
  assert.equal(d.updates, '');
  assert.equal(sanitizeDraft({ ...DRAFT, updates: 've-nguoi-que' }, { artifacts: arts, existingNames: ['ve-nguoi-que'] }).updates, 've-nguoi-que');
  assert.equal(sanitizeDraft({ ...DRAFT, updates: 'khac' }, { artifacts: arts, existingNames: ['khac'] }).updates, '');
  assert.throws(() => sanitizeDraft({ name: 'x', files: [{ path: 'a.md', content: 'y' }] }), (e) => e.code === 'distill_failed');
  assert.throws(() => sanitizeDraft({ name: '', files: [] }), (e) => e.code === 'distill_failed');
});

test('createDistill: chạy claude giả chỉ với công cụ đọc, trả bản nháp đã lọc; lỗi → distill_failed; thiếu bin → claude_unavailable', async () => {
  fs.mkdirSync(path.join(tmp, 'p'));
  process.env.FAKE_SKILL_SEARCH = JSON.stringify(DRAFT);
  const src = { stepName: 'S', stepKey: 's', dir: path.join(tmp, 'p'), artifacts: [{ path: 'outputs/s01.png' }], existing: [] };
  const d = await createDistill({ claudeBin: FAKE, env: process.env }).draft(src);
  assert.equal(d.name, 've-nguoi-que');
  assert.deepEqual(d.samples, ['outputs/s01.png']);
  const log = JSON.parse(fs.readFileSync(path.join(tmp, 'p', '.fake-skill-search.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(log.argv[log.argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  process.env.FAKE_SKILL_SEARCH_FAIL = '1';
  await assert.rejects(createDistill({ claudeBin: FAKE, env: process.env }).draft(src), (e) => e.code === 'distill_failed');
  await assert.rejects(createDistill({ claudeBin: path.join(tmp, 'khong-co'), env: process.env }).draft(src), (e) => e.code === 'claude_unavailable');
});

test('saveDraft: ghi file, chép ảnh mẫu, chặn đường dẫn xấu, trùng tên 409, overwrite giữ .studio.json, thiếu SKILL.md 400', () => {
  fs.writeFileSync(path.join(tmp, 'mau.png'), 'PNG');
  const files = [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'scripts/lib.py', content: 'x' }, { path: 'samples/mau.png', from: path.join(tmp, 'mau.png') }];
  const r = skills.saveDraft({ name: 've-nguoi-que', files });
  assert.equal(r.updated, false);
  assert.equal(fs.readFileSync(path.join(r.path, 'samples', 'mau.png'), 'utf8'), 'PNG');
  assert.throws(() => skills.saveDraft({ name: 've-nguoi-que', files }), (e) => e.status === 409 && e.code === 'skill_exists');
  skills.setScope('ve-nguoi-que', { channels: [] });
  fs.writeFileSync(path.join(r.path, '.studio.json'), '{"channels":["ka"]}');
  const r2 = skills.saveDraft({ name: 've-nguoi-que', files: [{ path: 'SKILL.md', content: SKILL_MD + 'mới\n' }], overwrite: true });
  assert.equal(r2.updated, true);
  assert.match(fs.readFileSync(path.join(r.path, 'SKILL.md'), 'utf8'), /mới/);
  assert.equal(fs.existsSync(path.join(r.path, 'scripts')), false);
  assert.equal(fs.existsSync(path.join(r.path, '.studio.json')), true);
  for (const bad of ['../x', '/abs', '.an', 'a//b']) assert.throws(() => skills.saveDraft({ name: 'khac', files: [{ path: 'SKILL.md', content: SKILL_MD }, { path: bad, content: 'x' }] }), (e) => e.status === 400, bad);
  assert.throws(() => skills.saveDraft({ name: 'khac', files: [{ path: 'scripts/a.py', content: 'x' }] }), (e) => e.status === 400);
  assert.equal(fs.existsSync(path.join(skills.lib, 'khac')), false);
});

test('API distill: 503 khi chưa bật; 409 khi bước chưa xong; 404 bước lạ', async () => {
  await makeApp(null);
  await call('POST', '/api/projects', { presetId: 'e2e-short', title: 'Mèo' });
  assert.equal((await call('POST', '/api/projects/meo/steps/hook/distill')).statusCode, 503);
  await app.close();
  await makeApp(createDistill({ claudeBin: FAKE, env: process.env }));
  const r = await call('POST', '/api/projects/meo/steps/hook/distill');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'step_not_done');
  assert.equal((await call('POST', '/api/projects/meo/steps/khong-co/distill')).statusCode, 404);
});

test('API distill + save: bản nháp không ghi gì; lưu vào thư viện, chép ảnh mẫu, gắn vào quy trình dự án; lưu lại trùng → 409; overwrite → 200', async () => {
  await projectWithOutputs();
  assert.equal((await call('POST', '/api/projects/meo/steps/hook/complete')).statusCode, 200);
  process.env.FAKE_SKILL_SEARCH = JSON.stringify(DRAFT);
  const d = await call('POST', '/api/projects/meo/steps/hook/distill');
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(d.json().name, 've-nguoi-que');
  assert.equal(skills.list().length, 0);
  const prompt = JSON.parse(fs.readFileSync(path.join(projDir, '.fake-skill-search.jsonl'), 'utf8').trim().split('\n')[0]).prompt;
  assert.match(prompt, /nền sáng hơn/);
  assert.match(prompt, /outputs\/s01\.png/);

  const body = { name: 've-nguoi-que', files: d.json().files, samples: ['outputs/s01.png', '../../etc/hosts', 'outputs/notes.txt'] };
  const s = await call('POST', '/api/projects/meo/steps/hook/distill/save', body);
  assert.equal(s.statusCode, 201, s.body);
  assert.equal(s.json().attached, true);
  assert.equal(fs.readFileSync(path.join(skills.lib, 've-nguoi-que', 'samples', 's01.png'), 'utf8'), 'PNGDATA');
  assert.equal(fs.existsSync(path.join(skills.lib, 've-nguoi-que', 'samples', 'notes.txt')), false);
  const snap = JSON.parse(store.getProject('meo').pipeline);
  assert.deepEqual(snap.skills, [path.join(skills.lib, 've-nguoi-que')]);

  const dup = await call('POST', '/api/projects/meo/steps/hook/distill/save', body);
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error, 'skill_exists');
  const up = await call('POST', '/api/projects/meo/steps/hook/distill/save', { ...body, overwrite: true });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(JSON.parse(store.getProject('meo').pipeline).skills.length, 1);
  assert.equal((await call('POST', '/api/projects/meo/steps/hook/distill/save', { name: 'x' })).statusCode, 400);
});

test('scope project: buildPrompt liệt kê từng bước + hậu tố -project; sanitizeDraft ép hậu tố; distillSource bỏ bước chưa xong', async () => {
  const p = buildPrompt({ scope: 'project', stepName: 'B2', stepKey: 'b2', dir: tmp, artifacts: [], existing: [], steps: [{ stepKey: 'b1', stepName: 'Bước Một', promptTemplate: 'PROMPT1', feedbacks: ['GOPY1'], artifacts: [] }, { stepKey: 'b2', stepName: 'Bước Hai', promptTemplate: 'PROMPT2', feedbacks: [], artifacts: [] }] });
  for (const s of ['CẢ QUY TRÌNH', 'Bước Một', 'PROMPT1', 'GOPY1', 'PROMPT2', '-project']) assert.ok(p.includes(s), s);
  assert.equal(sanitizeDraft(DRAFT, { scope: 'project' }).name, 've-nguoi-que-project');
  assert.equal(sanitizeDraft({ ...DRAFT, name: 'x-project' }, { scope: 'project' }).name, 'x-project');
  await projectWithOutputs();
  const none = await call('POST', '/api/projects/meo/steps/hook/distill', { scope: 'project' });
  assert.equal(none.statusCode, 409);
  assert.equal((await call('POST', '/api/projects/meo/steps/hook/complete')).statusCode, 200);
  const src = projects.distillSource('meo', 'hook', 'project');
  assert.equal(src.scope, 'project');
  assert.equal(src.steps.length, 1);
  assert.equal(src.steps[0].stepKey, 'hook');
  process.env.FAKE_SKILL_SEARCH = JSON.stringify(DRAFT);
  const d = await call('POST', '/api/projects/meo/steps/hook/distill', { scope: 'project' });
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(d.json().name, 've-nguoi-que-project');
  const s = await call('POST', '/api/projects/meo/steps/hook/distill/save', { scope: 'project', name: d.json().name, files: d.json().files, samples: [] });
  assert.equal(s.statusCode, 201, s.body);
  // Lần sau: skill -project đang gắn được đưa vào prompt để cập nhật; skill bước thì không.
  assert.deepEqual(projects.distillSource('meo', 'hook', 'project').existing.map((x) => x.name), ['ve-nguoi-que-project']);
  assert.deepEqual(projects.distillSource('meo', 'hook', 'step').existing, []);
});

test('distill-progress: không có lượt nào chạy → phase null', async () => {
  await makeApp(null);
  await call('POST', '/api/projects', { presetId: 'e2e-short', title: 'Mèo' });
  const r = await call('GET', '/api/projects/meo/distill-progress');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().phase, null);
});
