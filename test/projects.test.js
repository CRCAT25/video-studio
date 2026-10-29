import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/db.js';
import { loadChannels, loadPresets, REPO_ROOT } from '../server/presets.js';
import { createProjects, HttpError } from '../server/projects.js';
import { suggestPipeline } from '../server/pipeline.js';

const FIXTURE_PRESETS = path.join(REPO_ROOT, 'test', 'fixtures', 'presets');

let tmp;
let home;
let store;
let projects;
let extraDir;

// Preset riêng cho test: bước manual ở giữa.
const MANUAL_YAML = `id: man
name: Có bước thủ công
channel: kenh-la
project_dir: work/{slug}
steps:
  - id: one
    name: Một
    prompt: "Làm {title}"
    outputs: [one.md]
  - id: hand
    name: Tự tay
    manual: true
  - id: three
    name: Ba
    prompt: "x"
    outputs: [three.md]
    cost: { service: image-gen, estimate: "count(scenes)", always_ask: false }
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  home = path.join(tmp, 'home');
  extraDir = path.join(tmp, 'extra-presets');
  fs.mkdirSync(home);
  fs.mkdirSync(extraDir);
  fs.writeFileSync(path.join(extraDir, 'man.yaml'), MANUAL_YAML);
  store = openStore(path.join(home, 'studio.db'));
  projects = createProjects({
    store,
    presets: () => loadPresets([FIXTURE_PRESETS, extraDir]),
    channels: () => loadChannels([FIXTURE_PRESETS]),
    home,
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const states = (id) => Object.fromEntries(store.listSteps(id).map((s) => [s.key, s.state]));
const mk = (over = {}) => projects.create({ presetId: 'e2e-short', title: 'Đà Lạt — mùa mưa!', ...over });

function expectHttp(fn, status, code) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof HttpError, `phải là HttpError: ${e}`);
    assert.equal(e.status, status, e.message);
    assert.equal(e.code, code);
    assert.ok(e.message.length > 0);
    return true;
  });
}

// Chạy 1 lượt và kết thúc với outcome (giả lập runner).
function runStep(id, key, outcome = { state: 'done', summary: 'ok' }, opts = {}) {
  const run = projects.beginRun(id, key, { prompt: 'P', allowPaid: true, ...opts });
  return projects.finishRun(run.id, outcome);
}

test('create: slug tự sinh, dir tương đối tính từ home, steps ban đầu, snapshot, ProjectView', () => {
  const v = mk();
  assert.equal(v.id, 'da-lat-mua-mua');
  assert.equal(v.title, 'Đà Lạt — mùa mưa!');
  assert.equal(v.dir, path.join(home, 'projects', 'da-lat-mua-mua'));
  assert.ok(fs.statSync(path.join(v.dir, '.studio')).isDirectory());
  assert.deepEqual(v.preset, { id: 'e2e-short', name: 'E2E short (test)', format: 'short' });
  assert.deepEqual(v.channel, { id: 'tiktok', name: 'TikTok', platform: 'tiktok' });
  assert.equal(v.status, 'active');
  assert.match(v.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(v.session_started, 0);
  assert.deepEqual(v.steps.map((s) => [s.key, s.state]), [['hook', 'ready'], ['bible', 'pending'], ['voice', 'pending'], ['deliver', 'pending']]);
  assert.deepEqual(v.progress, { done: 0, total: 4 });
  assert.equal(v.current.key, 'hook');
  assert.equal(v.running_run_id, null);
  assert.deepEqual(v.costs, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, usd: null, runs: 0 });
  const voice = v.steps[2];
  assert.deepEqual(Object.keys(voice).sort(), ['approved', 'gate_mode', 'has_cost', 'key', 'manual', 'model', 'name', 'ord', 'outputs', 'run', 'state'].sort());
  assert.equal(voice.has_cost, true);
  assert.equal(voice.gate_mode, 'manual');
  assert.equal(voice.manual, false);
  assert.deepEqual(voice.outputs, ['audio/*.wav']);
  assert.equal(voice.run, null);
  assert.equal(v.steps[1].gate_mode, 'auto_if_checks');
  const snap = JSON.parse(fs.readFileSync(path.join(v.dir, '.studio', 'project.json'), 'utf8'));
  assert.equal(snap.id, v.id);
  assert.equal(snap.preset, 'e2e-short');
  assert.equal(snap.title, v.title);
  assert.deepEqual(snap.steps, [{ key: 'hook', state: 'ready' }, { key: 'bible', state: 'pending' }, { key: 'voice', state: 'pending' }, { key: 'deliver', state: 'pending' }]);
  assert.ok(snap.updated_at);
  assert.deepEqual(projects.view(v.id), v);
  assert.equal(projects.view('khong-co'), null);
});

test('create: slug/dir truyền vào; ~ được mở rộng; thư mục có sẵn được phép', () => {
  const existing = path.join(tmp, 'co-san');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'script.md'), 'cũ');
  const v = mk({ slug: 'my-slug', dir: existing + '/' });
  assert.equal(v.id, 'my-slug');
  assert.equal(v.dir, existing);
  assert.equal(fs.readFileSync(path.join(existing, 'script.md'), 'utf8'), 'cũ');
  // '~/…' hợp lệ (chỉ kiểm, không tạo thư mục ở home thật: dir_taken được kiểm trước khi mkdir)
  store.insertProject({ id: 'giu-cho', preset_id: 'e2e-short', title: 't', dir: path.join(os.homedir(), 'vs-test-khong-tao-' + process.pid) });
  expectHttp(() => mk({ slug: 'x2', dir: '~/vs-test-khong-tao-' + process.pid }), 409, 'dir_taken');
});

test('create: lỗi dữ liệu vào', () => {
  expectHttp(() => projects.create({ presetId: 'khong-co', title: 'A' }), 404, 'preset_not_found');
  expectHttp(() => mk({ title: '   ' }), 400, 'invalid_title');
  expectHttp(() => mk({ title: 'x'.repeat(201) }), 400, 'invalid_title');
  expectHttp(() => mk({ title: 42 }), 400, 'invalid_title');
  expectHttp(() => mk({ slug: 'Có Dấu' }), 400, 'invalid_slug');
  expectHttp(() => mk({ slug: '-bad' }), 400, 'invalid_slug');
  expectHttp(() => mk({ slug: 'a'.repeat(65) }), 400, 'invalid_slug');
  expectHttp(() => mk({ dir: 'relative/path' }), 400, 'invalid_dir');
  expectHttp(() => mk({ dir: 'a\0b' }), 400, 'invalid_dir');
  const file = path.join(tmp, 'la-file');
  fs.writeFileSync(file, 'x');
  expectHttp(() => mk({ dir: file }), 400, 'invalid_dir');
  assert.equal(store.listProjects().length, 0);
  // title được trim, 200 ký tự vẫn hợp lệ
  const v = mk({ title: '  ' + 'y'.repeat(200) + '  ', slug: 'dai' });
  assert.equal(v.title, 'y'.repeat(200));
});

test('create: trùng slug, trùng dir', () => {
  const v = mk();
  expectHttp(() => mk(), 409, 'slug_taken');
  expectHttp(() => mk({ slug: 'khac', dir: v.dir }), 409, 'dir_taken');
  expectHttp(() => mk({ slug: 'khac2', dir: v.dir + '/./' }), 409, 'dir_taken');
  // slug khác + dir khác thì được
  const w = mk({ slug: 'khac3' });
  assert.equal(w.dir, path.join(home, 'projects', 'khac3'));
  assert.equal(projects.list().length, 2);
});

test('create từ quy trình gợi ý (đã sửa): bước tắt bị bỏ, kênh tùy chọn, lỗi → invalid_pipeline kèm problems', () => {
  const raw = suggestPipeline({ orientation: 'horizontal', length: 'long', duration: 300 });
  raw.steps.find((s) => s.id === 'thumbnail').enabled = false;
  const v = projects.create({ pipeline: raw, title: 'Xe điện có rẻ?' });
  assert.deepEqual(v.preset, { id: 'dai-ngang-16x9', name: 'Video dài ngang 16:9', format: 'long' });
  assert.equal(v.channel, null, 'không chọn kênh → không gắn kênh');
  assert.deepEqual(v.steps.map((s) => s.key), ['nghien-cuu', 'kich-ban', 'phan-canh', 'hinh-anh', 'dung-cam', 'giong-doc', 'dung-video', 'xem-lai', 'goi-dang']);
  assert.equal(v.steps.find((s) => s.key === 'xem-lai').state, 'pending');
  assert.equal(projects.stepView(v.id, 'kich-ban').step.prompt_template.includes('{vars.duration_label}'), true);

  const w = projects.create({ pipeline: raw, title: 'Có kênh', channelId: 'tiktok' });
  assert.equal(w.channel.id, 'tiktok');
  expectHttp(() => projects.create({ pipeline: raw, title: 'Kênh lạ', channelId: 'khong-co' }), 400, 'channel_not_found');
  // kênh trong mẫu đã lưu vẫn dùng khi không chọn kênh; chọn kênh thì kênh chọn thắng
  assert.equal(projects.create({ presetId: 'e2e-short', title: 'Mặc định kênh' }).channel.id, 'tiktok');

  const bad = structuredClone(raw);
  bad.steps[0].prompt = '';
  bad.steps[1].outputs = ['/tuyet-doi'];
  assert.throws(
    () => projects.create({ pipeline: bad, title: 'Hỏng' }),
    (e) => e instanceof HttpError && e.status === 400 && e.code === 'invalid_pipeline' && e.problems.length === 2,
  );
  assert.equal(store.getProject('hong'), null);
});

test('bản chụp: sửa hoặc xóa file mẫu sau khi tạo không đổi quy trình của dự án', () => {
  const file = path.join(extraDir, 'man.yaml');
  const v = projects.create({ presetId: 'man', title: 'Chụp lại' });
  fs.writeFileSync(file, MANUAL_YAML.replace('prompt: "Làm {title}"', 'prompt: "ĐÃ SỬA"').replace('name: Một', 'name: Một mới'));
  assert.equal(projects.stepView(v.id, 'one').step.prompt_template, 'Làm {title}');
  assert.equal(projects.view(v.id).steps[0].name, 'Một');
  fs.unlinkSync(file);
  assert.deepEqual(projects.canRun(v.id, 'one'), { ok: true });
  assert.equal(projects.presetOf(v.id).id, 'man');
  // dự án tạo sau dùng mẫu mới (đã xóa → 404)
  expectHttp(() => projects.create({ presetId: 'man', title: 'Sau xóa' }), 404, 'preset_not_found');
});

test('list: OverviewItem không có steps[].outputs, mới cập nhật trước', async () => {
  mk({ slug: 'mot' });
  await new Promise((r) => setTimeout(r, 5));
  mk({ slug: 'hai' });
  const items = projects.list();
  assert.deepEqual(items.map((p) => p.id), ['hai', 'mot']);
  for (const it of items) {
    assert.ok(it.steps.every((s) => !('outputs' in s)));
    assert.ok('progress' in it && 'costs' in it && 'current' in it && 'running_run_id' in it);
  }
});

test('canRun: bước trước chưa xong, không tồn tại, busy, cost 412', () => {
  const { id } = mk();
  assert.deepEqual(projects.canRun(id, 'hook'), { ok: true });
  let r = projects.canRun(id, 'bible');
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'not_runnable');
  assert.equal(projects.canRun('khong-co', 'hook').status, 404);
  assert.equal(projects.canRun(id, 'khong-co').code, 'not_found');

  const run = projects.beginRun(id, 'hook', { prompt: 'P' });
  r = projects.canRun(id, 'hook');
  assert.equal(r.code, 'busy');
  assert.equal(r.status, 409);
  expectHttp(() => projects.beginRun(id, 'hook', {}), 409, 'busy');
  projects.finishRun(run.id, { state: 'done', summary: 'ok' });

  // bible pending → ready sau khi hook done; done bible → voice cần xác nhận chi phí
  runStep(id, 'bible');
  r = projects.canRun(id, 'voice');
  assert.equal(r.ok, false);
  assert.equal(r.status, 412);
  assert.equal(r.code, 'cost_confirm_required');
  assert.deepEqual(r.cost, { service: 'elevenlabs', estimate: 'chars(script.md)', always_ask: true, estimate_value: null, unit: 'ký tự' });
  expectHttp(() => projects.beginRun(id, 'voice', { allowPaid: false }), 412, 'cost_confirm_required');
  // free chỉ bỏ qua duyệt chi phí khi bước khai báo cost.free_fallback
  assert.equal(projects.canRun(id, 'voice', { free: true }).code, 'cost_confirm_required');
  try {
    projects.beginRun(id, 'voice', {});
  } catch (e) {
    assert.equal(e.cost.service, 'elevenlabs');
    assert.deepEqual(e.toJSON().cost, e.cost);
    assert.equal(e.toJSON().error, 'cost_confirm_required');
  }
  fs.writeFileSync(path.join(projects.view(id).dir, 'script.md'), '  Xin chào Đà Lạt  \n');
  assert.equal(projects.canRun(id, 'voice').cost.estimate_value, 15);
  assert.deepEqual(projects.canRun(id, 'voice', { allowPaid: true }), { ok: true });
});

test('luồng: done → bước kế ready; hết bước → project done; snapshot cập nhật', () => {
  const { id, dir } = mk();
  const run = projects.beginRun(id, 'hook', { prompt: 'Prompt 1', feedback: 'góp ý', allowPaid: false });
  assert.equal(run.state, 'running');
  assert.equal(run.n, 1);
  assert.equal(run.prompt, 'Prompt 1');
  assert.equal(run.feedback, 'góp ý');
  let v = projects.view(id);
  assert.equal(v.status, 'running');
  assert.equal(v.running_run_id, run.id);
  assert.equal(v.current.key, 'hook');
  assert.equal(v.current.state, 'running');
  assert.equal(store.getStep(id, 'hook').current_run_id, run.id);

  const fin = projects.finishRun(run.id, { state: 'done', summary: 'Đã viết hook', result: { status: 'done', summary: 'Đã viết hook' }, exit_code: 0 });
  assert.equal(fin.state, 'done');
  assert.equal(fin.summary, 'Đã viết hook');
  assert.equal(fin.exit_code, 0);
  assert.ok(fin.ended_at);
  assert.deepEqual(fin.result, { status: 'done', summary: 'Đã viết hook' });
  assert.deepEqual(states(id), { hook: 'done', bible: 'ready', voice: 'pending', deliver: 'pending' });
  v = projects.view(id);
  assert.equal(v.status, 'active');
  assert.equal(v.running_run_id, null);
  assert.equal(v.current.key, 'bible');
  assert.deepEqual(v.progress, { done: 1, total: 4 });
  assert.deepEqual(v.steps[0].run, {
    id: run.id, n: 1, state: 'done', started_at: run.started_at, ended_at: fin.ended_at, summary: 'Đã viết hook',
    error: null, progress_pct: null, progress_msg: null, exit_code: 0,
  });

  runStep(id, 'bible');
  runStep(id, 'voice');
  runStep(id, 'deliver');
  assert.deepEqual(states(id), { hook: 'done', bible: 'done', voice: 'done', deliver: 'done' });
  v = projects.view(id);
  assert.equal(v.status, 'done');
  assert.equal(v.current, null);
  assert.deepEqual(v.progress, { done: 4, total: 4 });
  const snap = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'project.json'), 'utf8'));
  assert.ok(snap.steps.every((s) => s.state === 'done'));
  // finishRun lần 2 không làm gì
  assert.equal(projects.finishRun(run.id, { state: 'failed' }).state, 'done');
  assert.equal(projects.finishRun('khong-co', { state: 'done' }), null);
});

test('check trượt → run failed "Kiểm tra không đạt", step failed; check NULL không tính', () => {
  const { id } = mk();
  runStep(id, 'hook');
  const r1 = projects.beginRun(id, 'bible', { prompt: 'P' });
  store.addCheck(r1.id, { name: 'project_json', cmd: 'test -s project.json', passed: false, output: '' });
  store.addCheck(r1.id, { name: 'chưa hỗ trợ', cmd: 'studio-check x', passed: null, output: '' });
  const f = projects.finishRun(r1.id, { state: 'done', summary: 'xong' });
  assert.equal(f.state, 'failed');
  assert.equal(f.error, 'Kiểm tra không đạt: project_json');
  assert.deepEqual(states(id), { hook: 'done', bible: 'failed', voice: 'pending', deliver: 'pending' });
  assert.equal(projects.view(id).status, 'active');

  const r2 = projects.beginRun(id, 'bible', { prompt: 'P' });
  assert.equal(r2.n, 2);
  store.addCheck(r2.id, { name: 'project_json', cmd: 'test -s project.json', passed: true, output: '' });
  store.addCheck(r2.id, { name: 'chưa hỗ trợ', cmd: 'studio-check x', passed: null, output: '' });
  assert.equal(projects.finishRun(r2.id, { state: 'done', summary: 'xong' }).state, 'done');
  assert.deepEqual(states(id), { hook: 'done', bible: 'done', voice: 'ready', deliver: 'pending' });
});

test('failed (Claude/exit≠0/timeout) → step failed; chạy lại được', () => {
  const { id } = mk();
  const f = runStep(id, 'hook', { state: 'failed', error: 'Hết thời gian (10 phút)', exit_code: 143 });
  assert.equal(f.state, 'failed');
  assert.equal(f.error, 'Hết thời gian (10 phút)');
  assert.equal(states(id).hook, 'failed');
  assert.deepEqual(projects.canRun(id, 'hook'), { ok: true });
  const g = runStep(id, 'hook', { state: 'failed' });
  assert.equal(g.error, 'Lượt chạy thất bại.');
  // outcome lạ → failed
  const h = runStep(id, 'hook', { state: 'weird' });
  assert.equal(h.state, 'failed');
});

test('rerun bước đã xong → bước sau done thành stale, ready thành pending; stale vẫn chạy được', () => {
  const { id } = mk();
  runStep(id, 'hook');
  runStep(id, 'bible');
  runStep(id, 'voice');
  assert.deepEqual(states(id), { hook: 'done', bible: 'done', voice: 'done', deliver: 'ready' });

  const r = projects.beginRun(id, 'hook', { prompt: 'lại' });
  assert.equal(r.n, 2);
  assert.deepEqual(states(id), { hook: 'running', bible: 'stale', voice: 'stale', deliver: 'pending' });
  projects.finishRun(r.id, { state: 'done', summary: 'mới' });
  assert.deepEqual(states(id), { hook: 'done', bible: 'stale', voice: 'stale', deliver: 'pending' });
  assert.equal(projects.view(id).status, 'active');

  // bước stale: chạy lại được (bước trước done)
  assert.deepEqual(projects.canRun(id, 'bible'), { ok: true });
  // voice stale: bước trước (bible) stale → vẫn cho chạy (∈ {done, stale})
  assert.deepEqual(projects.canRun(id, 'voice', { allowPaid: true }), { ok: true });
  // rerun bible (stale) → voice vẫn stale; xong bible → voice (stale) giữ nguyên
  runStep(id, 'bible');
  assert.deepEqual(states(id), { hook: 'done', bible: 'done', voice: 'stale', deliver: 'pending' });
  runStep(id, 'voice');
  assert.deepEqual(states(id), { hook: 'done', bible: 'done', voice: 'done', deliver: 'ready' });
});

test('needs_input → run & step needs_input; chạy lại kèm góp ý', () => {
  const { id } = mk();
  const r = runStep(id, 'hook', { state: 'needs_input', summary: 'Cần hỏi', result: { status: 'needs_input', summary: 'Cần hỏi', questions: ['Giọng nam hay nữ?'] } });
  assert.equal(r.state, 'needs_input');
  assert.equal(states(id).hook, 'needs_input');
  assert.equal(projects.view(id).status, 'active');
  assert.deepEqual(projects.canRun(id, 'hook'), { ok: true });
  const r2 = runStep(id, 'hook', { state: 'done', summary: 'ok' }, { feedback: 'Giọng nữ' });
  assert.equal(store.getRun(r2.id).feedback, 'Giọng nữ');
  assert.equal(states(id).bible, 'ready');
});

test('stopped → khôi phục state trước khi chạy (done/stale/failed/needs_input), còn lại ready', () => {
  const { id } = mk();
  // ready → stopped → ready
  let r = projects.beginRun(id, 'hook', {});
  projects.finishRun(r.id, { state: 'stopped' });
  assert.equal(states(id).hook, 'ready');
  assert.equal(store.getRun(r.id).state, 'stopped');
  assert.equal(projects.view(id).status, 'active');
  // failed → stopped → failed
  runStep(id, 'hook', { state: 'failed', error: 'x' });
  r = projects.beginRun(id, 'hook', {});
  projects.finishRun(r.id, { state: 'stopped' });
  assert.equal(states(id).hook, 'failed');
  // needs_input → stopped → needs_input
  runStep(id, 'hook', { state: 'needs_input' });
  r = projects.beginRun(id, 'hook', {});
  projects.finishRun(r.id, { state: 'stopped' });
  assert.equal(states(id).hook, 'needs_input');
  // done → (rerun) stopped → done; bước sau đã bị stale vẫn stale
  runStep(id, 'hook');
  runStep(id, 'bible');
  r = projects.beginRun(id, 'hook', {});
  assert.equal(states(id).bible, 'stale');
  projects.finishRun(r.id, { state: 'stopped' });
  assert.equal(states(id).hook, 'done');
  assert.equal(states(id).bible, 'stale');
  // prevState truyền qua outcome được ưu tiên
  r = projects.beginRun(id, 'bible', {});
  projects.finishRun(r.id, { state: 'stopped', prevState: 'failed' });
  assert.equal(states(id).bible, 'failed');
});

test('stopped khi service mất prevState (ví dụ service mới) → ready', () => {
  const { id } = mk();
  runStep(id, 'hook');
  const r = projects.beginRun(id, 'hook', {}); // prev = done
  const other = createProjects({ store, presets: () => loadPresets([FIXTURE_PRESETS]), channels: [], home });
  other.finishRun(r.id, { state: 'stopped' });
  assert.equal(states(id).hook, 'ready');
});

test('complete: các state cho phép, bước kế ready/manual, 409 khi không cho', () => {
  const { id } = mk();
  expectHttp(() => projects.complete(id, 'bible'), 409, 'not_runnable'); // pending
  const sv = projects.complete(id, 'hook'); // ready → done
  assert.equal(sv.step.state, 'done');
  assert.equal(sv.step.key, 'hook');
  assert.deepEqual(states(id), { hook: 'done', bible: 'ready', voice: 'pending', deliver: 'pending' });
  expectHttp(() => projects.complete(id, 'hook'), 409, 'not_runnable'); // đã done
  runStep(id, 'bible', { state: 'failed', error: 'x' });
  projects.complete(id, 'bible'); // failed → done
  runStep(id, 'voice', { state: 'needs_input' });
  projects.complete(id, 'voice'); // needs_input → done
  const r = projects.beginRun(id, 'deliver', {});
  expectHttp(() => projects.complete(id, 'deliver'), 409, 'not_runnable'); // running
  projects.finishRun(r.id, { state: 'stopped' });
  projects.complete(id, 'deliver');
  assert.equal(projects.view(id).status, 'done');
  expectHttp(() => projects.complete('khong-co', 'hook'), 404, 'not_found');
  expectHttp(() => projects.complete(id, 'khong-co'), 404, 'not_found');
});

test('approve: chỉ bước done; chạy lại thì xóa dấu duyệt', () => {
  const { id } = mk();
  expectHttp(() => projects.approve(id, 'hook'), 409, 'not_runnable'); // ready
  projects.complete(id, 'hook');
  assert.equal(projects.view(id).steps[0].approved, false);
  assert.equal(projects.approve(id, 'hook').step.approved, true);
  assert.equal(projects.view(id).steps[0].state, 'done');
  projects.beginRun(id, 'hook', {});
  assert.equal(projects.view(id).steps[0].approved, false);
  expectHttp(() => projects.approve('khong-co', 'hook'), 404, 'not_found');
});

test('bước manual: tới lượt → state manual, không chạy được, đánh dấu xong → bước kế', () => {
  const v = projects.create({ presetId: 'man', title: 'Thủ công' });
  assert.equal(v.dir, path.join(home, 'work', 'thu-cong'));
  assert.deepEqual(v.channel, { id: 'kenh-la', name: 'kenh-la', platform: null });
  assert.equal(v.steps[1].manual, true);
  assert.equal(v.steps[1].gate_mode, 'manual');
  runStep(v.id, 'one');
  assert.deepEqual(states(v.id), { one: 'done', hand: 'manual', three: 'pending' });
  const cr = projects.canRun(v.id, 'hand');
  assert.equal(cr.ok, false);
  assert.equal(cr.code, 'not_runnable');
  projects.complete(v.id, 'hand');
  assert.deepEqual(states(v.id), { one: 'done', hand: 'done', three: 'ready' });
  // always_ask: false → không cần xác nhận
  assert.deepEqual(projects.canRun(v.id, 'three'), { ok: true });
  // rerun bước 1 → manual done → stale
  const r = projects.beginRun(v.id, 'one', {});
  assert.deepEqual(states(v.id), { one: 'running', hand: 'stale', three: 'pending' });
  projects.finishRun(r.id, { state: 'done' });
  projects.complete(v.id, 'hand'); // stale → done
  assert.equal(states(v.id).hand, 'done');
});

test('recoverOnStartup: run chết → failed "Server dừng giữa chừng", step failed, project active, xóa lock pid chết', () => {
  const { id, dir } = mk();
  const run = projects.beginRun(id, 'hook', {});
  store.updateRun(run.id, { pid: 999999 });
  fs.writeFileSync(path.join(dir, '.studio', 'lock'), JSON.stringify({ pid: 999998, host: os.hostname(), since: new Date().toISOString(), run_id: run.id }));
  const v2 = mk({ slug: 'song', dir: path.join(tmp, 'song') });
  const alive = projects.beginRun(v2.id, 'hook', {});
  store.updateRun(alive.id, { pid: 4242 });

  // 4242 là claude của dự án 'song' mà cha (4343, một server khác) còn sống → không đụng
  const isAlive = (pid) => pid === 4242 || pid === 4343;
  const sidSong = store.getProject(v2.id).claude_session_id;
  const inspect = (pid) => (pid === 4242 ? { ppid: 4343, command: `claude -p --session-id ${sidSong}` } : null);
  const killed = [];
  const opts = { inspect, kill: (pid) => killed.push(pid) };
  assert.equal(projects.recoverOnStartup(isAlive, opts), 1);
  const r = store.getRun(run.id);
  assert.equal(r.state, 'failed');
  assert.equal(r.error, 'Server dừng giữa chừng');
  assert.ok(r.ended_at);
  assert.equal(states(id).hook, 'failed');
  assert.equal(projects.view(id).status, 'active');
  assert.ok(!fs.existsSync(path.join(dir, '.studio', 'lock')), 'lock pid chết phải bị xóa');
  // run còn sống không bị đụng
  assert.equal(store.getRun(alive.id).state, 'running');
  assert.equal(projects.view('song').status, 'running');
  assert.deepEqual(killed, []);
  // gọi lại → không còn gì để sửa
  assert.equal(projects.recoverOnStartup(isAlive, opts), 0);
});

test('recoverOnStartup: pid NULL → failed; lock pid còn sống / host khác giữ nguyên', () => {
  const { id, dir } = mk();
  const run = projects.beginRun(id, 'hook', {});
  const lock = path.join(dir, '.studio', 'lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 4242, host: os.hostname() }));
  assert.equal(projects.recoverOnStartup(() => true), 1);
  assert.equal(store.getRun(run.id).state, 'failed');
  assert.ok(fs.existsSync(lock));
  // dùng isAlive/inspect mặc định: pid hiện tại còn sống nhưng không phải claude của lượt (pid bị dùng lại)
  // → failed, KHÔNG gửi tín hiệu (process này vẫn sống); pid lớn không tồn tại → failed
  runStep(id, 'hook');
  const r1 = projects.beginRun(id, 'bible', {});
  store.updateRun(r1.id, { pid: process.pid });
  assert.equal(projects.recoverOnStartup(), 1);
  assert.equal(store.getRun(r1.id).state, 'failed');
  runStep(id, 'bible');
  const r2 = projects.beginRun(id, 'bible', {});
  store.updateRun(r2.id, { pid: 2 ** 22 + 12345 });
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12346, host: 'may-khac' }));
  assert.equal(projects.recoverOnStartup(), 1);
  assert.equal(states(id).bible, 'failed');
  assert.ok(fs.existsSync(lock), 'lock của máy khác không xóa');
});

test('recoverOnStartup: claude mồ côi (server cũ chết, ppid 1) → SIGTERM, lượt failed, rerun được; lock của lượt đã xong bị xóa dù khác máy', () => {
  const { id, dir } = mk();
  const sid = store.getProject(id).claude_session_id;
  const run = projects.beginRun(id, 'hook', {});
  store.updateRun(run.id, { pid: 5151 });
  const lock = path.join(dir, '.studio', 'lock');
  // server cũ chết, máy đổi hostname (vd 'may-2.local') → host khác nhưng run_id là lượt của DB này
  fs.writeFileSync(lock, JSON.stringify({ pid: 5050, host: 'may-2.local', run_id: run.id }));
  const killed = [];
  const fixed = projects.recoverOnStartup((pid) => pid === 5151, {
    inspect: (pid) => (pid === 5151 ? { ppid: 1, command: `/usr/local/bin/claude -p --resume ${sid} --output-format stream-json` } : null),
    kill: (pid) => killed.push(pid),
  });
  assert.equal(fixed, 1);
  assert.deepEqual(killed, [5151]);
  const r = store.getRun(run.id);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /^Server dừng giữa chừng/);
  assert.equal(states(id).hook, 'failed');
  assert.equal(projects.view(id).status, 'active');
  assert.ok(!fs.existsSync(lock), 'lock của lượt đã kết thúc phải bị xóa dù host khác');
  assert.equal(projects.canRun(id, 'hook').ok, true);
});

test('recoverOnStartup: claude mồ côi thật (process con có session id) bị dừng bằng inspect/kill mặc định', async () => {
  const { spawn } = await import('node:child_process');
  const { id } = mk();
  const sid = store.getProject(id).claude_session_id;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--session-id', sid], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal)));
  try {
    await new Promise((r) => setTimeout(r, 150));
    const run = projects.beginRun(id, 'hook', {});
    store.updateRun(run.id, { pid: child.pid });
    assert.equal(projects.recoverOnStartup(), 1);
    assert.equal(await exited, 'SIGTERM');
    assert.equal(store.getRun(run.id).state, 'failed');
  } finally {
    child.kill('SIGKILL');
  }
});

test('abandonRun: lượt running mà runner không trông → SIGTERM claude, stopped, bước về trạng thái trước, gỡ lock', () => {
  const { id, dir } = mk();
  const sid = store.getProject(id).claude_session_id;
  const run = projects.beginRun(id, 'hook', {});
  store.updateRun(run.id, { pid: 6161 });
  const lock = path.join(dir, '.studio', 'lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), run_id: run.id }));
  const killed = [];
  const opts = {
    isAlive: (pid) => pid === 6161,
    inspect: () => ({ ppid: 1, command: `claude -p --session-id ${sid}` }),
    kill: (pid) => killed.push(pid),
  };
  const r = projects.abandonRun(run.id, opts);
  assert.equal(r.state, 'stopped');
  assert.equal(r.error, 'Lượt mồ côi (server đã khởi động lại)');
  assert.deepEqual(killed, [6161]);
  assert.equal(states(id).hook, 'ready');
  assert.equal(projects.view(id).status, 'active');
  assert.ok(!fs.existsSync(lock));
  // không còn chạy / không tồn tại → null, không kill thêm
  assert.equal(projects.abandonRun(run.id, opts), null);
  assert.equal(projects.abandonRun('khong-co', opts), null);
  // pid đã bị process khác dùng lại → không kill, vẫn dừng lượt
  const run2 = projects.beginRun(id, 'hook', {});
  store.updateRun(run2.id, { pid: 6161 });
  assert.equal(projects.abandonRun(run2.id, { ...opts, inspect: () => ({ ppid: 1, command: '/usr/bin/vim' }) }).state, 'stopped');
  assert.deepEqual(killed, [6161]);
});

test('writeSnapshot ghi <dir>/.studio/project.json (tạo .studio nếu thiếu)', () => {
  const { id, dir } = mk();
  fs.rmSync(path.join(dir, '.studio'), { recursive: true, force: true });
  const data = projects.writeSnapshot(id);
  const file = path.join(dir, '.studio', 'project.json');
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(snap, data);
  assert.deepEqual(Object.keys(snap), ['id', 'preset', 'title', 'steps', 'updated_at']);
  assert.equal(fs.readdirSync(path.join(dir, '.studio')).filter((f) => f.endsWith('.tmp')).length, 0);
  assert.equal(projects.writeSnapshot('khong-co'), null);
});

test('estimateCost: chars / count / số nguyên / thiếu file / biểu thức lạ — không throw', () => {
  const { id, dir } = mk();
  assert.equal(projects.estimateCost(id, 'hook'), null, 'bước không có cost');
  assert.equal(projects.estimateCost('khong-co', 'voice'), null);
  assert.deepEqual(projects.estimateCost(id, 'voice'), { service: 'elevenlabs', estimate: 'chars(script.md)', estimate_value: null, unit: 'ký tự' });
  fs.writeFileSync(path.join(dir, 'script.md'), '\n  Ổ bánh mì 🥖 \n\n');
  assert.equal(projects.estimateCost(id, 'voice').estimate_value, 11);

  const m = projects.create({ presetId: 'man', title: 'Đếm cảnh' });
  assert.deepEqual(projects.estimateCost(m.id, 'three'), { service: 'image-gen', estimate: 'count(scenes)', estimate_value: null, unit: 'mục' });
  fs.writeFileSync(path.join(m.dir, 'project.json'), JSON.stringify({ scenes: [1, 2, 3] }));
  assert.equal(projects.estimateCost(m.id, 'three').estimate_value, 3);
  fs.writeFileSync(path.join(m.dir, 'project.json'), '{hỏng');
  assert.equal(projects.estimateCost(m.id, 'three').estimate_value, null);
  fs.writeFileSync(path.join(m.dir, 'project.json'), JSON.stringify({ scenes: 'không phải mảng' }));
  assert.equal(projects.estimateCost(m.id, 'three').estimate_value, null);

  // số nguyên, biểu thức lạ, file ngoài thư mục dự án (dự án cũ không có bản chụp → đọc theo mẫu)
  store.db.prepare('UPDATE projects SET pipeline = NULL WHERE id = ?').run(m.id);
  const custom = (estimate) => {
    const p = createProjects({
      store,
      presets: () => {
        const { presets } = loadPresets([extraDir]);
        const man = structuredClone(presets[0]);
        man.steps[2].cost.estimate = estimate;
        return { presets: [man], errors: [] };
      },
      channels: [],
      home,
    });
    return p.estimateCost(m.id, 'three');
  };
  assert.equal(custom('1200').estimate_value, 1200);
  assert.equal(custom('sqrt(9)').estimate_value, null);
  assert.equal(custom('chars(../../etc/passwd)').estimate_value, null);
  assert.equal(custom('chars(/etc/passwd)').estimate_value, null);
  assert.equal(custom(null).estimate_value, null);
});

test('stepView: đủ trường, runs n DESC, latest, can_run, resume_cmd', () => {
  const { id, dir, session_id } = mk({ slug: 'sv', dir: path.join(tmp, "it's dir") });
  let sv = projects.stepView(id, 'voice');
  assert.deepEqual(Object.keys(sv).sort(), ['can_run', 'latest', 'project', 'resume_cmd', 'runs', 'step', 'usage_by_step']);
  assert.equal(sv.project.id, id);
  assert.equal(sv.step.key, 'voice');
  assert.equal(sv.step.prompt_template.includes('script.md'), true);
  assert.deepEqual(sv.step.checks, []);
  assert.deepEqual(sv.step.cost, { service: 'elevenlabs', estimate: 'chars(script.md)', always_ask: true, estimate_value: null, unit: 'ký tự' });
  assert.equal(sv.step.timeout_ms, 600_000);
  assert.deepEqual(sv.runs, []);
  assert.equal(sv.latest, null);
  assert.equal(sv.can_run.ok, false);
  assert.equal(sv.can_run.code, 'not_runnable');
  assert.equal(sv.resume_cmd, null);
  assert.equal(projects.stepView(id, 'khong-co'), null);
  assert.equal(projects.stepView('khong-co', 'hook'), null);

  sv = projects.stepView(id, 'bible');
  assert.deepEqual(sv.step.checks, [{ name: 'project_json', run: 'test -s project.json' }]);
  assert.equal(sv.step.cost, null);

  runStep(id, 'hook', { state: 'needs_input', summary: 'hỏi' });
  const r2 = projects.beginRun(id, 'hook', { prompt: 'P2', feedback: 'trả lời' });
  store.updateRun(r2.id, { usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, denials: [{ tool: 'Bash', input: {} }] });
  store.setArtifacts(r2.id, [{ path: 'script.md', kind: 'markdown', bytes: 3 }]);
  store.addCheck(r2.id, { name: 'c', cmd: 'true', passed: true });
  store.addCost(r2.id, { kind: 'claude_tokens', units: 7, unit_name: 'token' });
  projects.finishRun(r2.id, { state: 'done', summary: 'xong', result: { status: 'done', summary: 'xong' } });
  store.updateProject(id, { session_started: 1 });

  sv = projects.stepView(id, 'hook');
  assert.deepEqual(sv.runs.map((r) => r.n), [2, 1]);
  const top = sv.runs[0];
  for (const k of ['id', 'n', 'state', 'started_at', 'ended_at', 'summary', 'error', 'progress_pct', 'progress_msg', 'exit_code', 'feedback', 'allow_paid', 'result', 'denials', 'usage']) {
    assert.ok(k in top, `runs[0] thiếu ${k}`);
  }
  assert.equal(top.feedback, 'trả lời');
  assert.equal(top.allow_paid, 0);
  assert.deepEqual(top.result, { status: 'done', summary: 'xong' });
  assert.equal(top.denials[0].tool, 'Bash');
  assert.equal(top.usage.output_tokens, 4);
  assert.deepEqual(sv.latest.run, top);
  assert.deepEqual(sv.latest.artifacts.map((a) => a.path), ['script.md']);
  assert.deepEqual(sv.latest.checks.map((c) => c.passed), [1]);
  assert.deepEqual(sv.latest.costs.map((c) => c.units), [7]);
  assert.equal(sv.step.state, 'done');
  assert.equal(sv.step.run.id, r2.id);
  assert.deepEqual(sv.can_run, { ok: true });
  assert.equal(sv.resume_cmd, `cd '${dir.replace(/'/g, "'\\''")}' && claude --resume ${session_id}`);
  assert.equal(sv.project.costs.output_tokens, 4);

  // bước có cost: can_run bỏ qua xác nhận chi phí (UI tự hỏi), báo cost_confirm
  runStep(id, 'bible');
  sv = projects.stepView(id, 'voice');
  assert.equal(sv.can_run.ok, true);
  assert.equal(sv.can_run.cost_confirm, true);
});

test('mẫu bị xóa: dự án có bản chụp vẫn chạy; dự án cũ không bản chụp → preset_not_found', () => {
  const { id } = mk();
  const orphan = createProjects({ store, presets: () => ({ presets: [], errors: [] }), channels: () => [], home });
  assert.equal(orphan.presetOf(id).id, 'e2e-short');
  assert.deepEqual(orphan.canRun(id, 'hook'), { ok: true });
  assert.ok(orphan.view(id).steps[0].outputs.length > 0);

  store.db.prepare('UPDATE projects SET pipeline = NULL WHERE id = ?').run(id);
  const legacy = createProjects({ store, presets: () => ({ presets: [], errors: [] }), channels: () => [], home });
  const v = legacy.view(id);
  assert.deepEqual(v.preset, { id: 'e2e-short', name: 'e2e-short', format: null });
  assert.deepEqual(v.channel, { id: 'tiktok', name: 'tiktok', platform: null });
  assert.deepEqual(v.steps[0].outputs, []);
  const cr = legacy.canRun(id, 'hook');
  assert.equal(cr.status, 404);
  assert.equal(cr.code, 'preset_not_found');
  assert.equal(legacy.presetOf(id), null);
  assert.equal(projects.presetOf(id).id, 'e2e-short');
  assert.ok(legacy.stepView(id, 'hook'));
});

test('beginRun lỗi giữa transaction không để lại run/trạng thái dở', () => {
  const { id } = mk();
  expectHttp(() => projects.beginRun(id, 'bible', {}), 409, 'not_runnable');
  assert.equal(store.listRunsByState('running').length, 0);
  assert.deepEqual(states(id), { hook: 'ready', bible: 'pending', voice: 'pending', deliver: 'pending' });
  assert.equal(projects.view(id).status, 'active');
});

test('updatePipeline: đổi chỗ bước chưa chạy, bước đã chạy bị khóa, đang chạy thì từ chối', () => {
  const { id } = mk();
  const { pipeline, locked } = projects.pipelineOf(id);
  assert.deepEqual(locked, []);
  const steps = pipeline.steps.map((s) => ({ ...s }));
  // đưa "voice" xuống cuối
  const i = steps.findIndex((s) => (s.id ?? s.key) === 'voice');
  const [v] = steps.splice(i, 1);
  steps.push(v);
  const view = projects.updatePipeline(id, { ...pipeline, steps });
  assert.deepEqual(view.steps.map((s) => s.key), steps.map((s) => s.id ?? s.key));
  assert.equal(states(id).hook, 'ready');
  assert.equal(states(id).voice, 'pending');

  // hook đã chạy xong → bị khóa, không đưa xuống được
  const hook = store.getStep(id, 'hook');
  store.updateStep(hook.id, { state: 'done' });
  assert.deepEqual(projects.pipelineOf(id).locked, ['hook']);
  const swapped = steps.slice();
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  expectHttp(() => projects.updatePipeline(id, { ...pipeline, steps: swapped }), 400, 'invalid_pipeline');
  // sau hook, bước kế tiếp thành ready khi tất cả bước khóa đã xong
  projects.updatePipeline(id, { ...pipeline, steps });
  assert.equal(states(id)[steps[1].id ?? steps[1].key], 'ready');
});
