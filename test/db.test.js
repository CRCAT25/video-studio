import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '../server/db.js';

let tmp;
let store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  store = openStore(path.join(tmp, 'sub', 'studio.db'));
});

afterEach(() => {
  store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(id = 'p1', steps = ['a', 'b']) {
  store.insertProject({ id, preset_id: 'demo', channel_id: 'tiktok', title: `Dự án ${id}`, dir: path.join(tmp, id), claude_session_id: 'sess-' + id });
  return steps.map((key, i) => store.insertStep({ project_id: id, key, name: key.toUpperCase(), ord: i, state: i === 0 ? 'ready' : 'pending' }));
}

test('tạo schema v5, WAL, foreign_keys, busy_timeout; tạo thư mục cha', () => {
  assert.ok(fs.existsSync(path.join(tmp, 'sub', 'studio.db')));
  assert.equal(store.db.pragma('user_version', { simple: true }), 6);
  assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(store.db.pragma('busy_timeout', { simple: true }), 5000);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['artifacts', 'checks', 'costs', 'projects', 'run_events', 'runs', 'sessions', 'settings', 'steps', 'token_usage', 'yt_channels', 'yt_quota', 'yt_stats_cache', 'yt_uploads']);
  const idx = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ix_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(idx, ['ix_events_run', 'ix_runs_step', 'ix_token_usage_at']);
});

test('mở lại DB giữ dữ liệu; DB có user_version mới hơn → lỗi rõ ràng', () => {
  seed();
  const file = path.join(tmp, 'sub', 'studio.db');
  store.close();
  store = openStore(file);
  assert.equal(store.getProject('p1').title, 'Dự án p1');
  store.close();
  const raw = new Database(file);
  raw.pragma('user_version = 9');
  raw.close();
  assert.throws(() => openStore(file), /phiên bản 9/);
  store = null;
});

test('projects: insert/get/list/update (updated_at tự đặt, list theo updated_at DESC)', async () => {
  const p = store.insertProject({ id: 'p1', preset_id: 'demo', channel_id: null, title: 'A', dir: '/x/a', claude_session_id: 's1' });
  assert.equal(p.status, 'active');
  assert.equal(p.session_started, 0);
  assert.equal(p.created_at, p.updated_at);
  assert.match(p.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  store.insertProject({ id: 'p2', preset_id: 'demo', title: 'B', dir: '/x/b', claude_session_id: 's2' });
  await new Promise((r) => setTimeout(r, 5));
  const u = store.updateProject('p1', { status: 'running', session_started: 1 });
  assert.equal(u.status, 'running');
  assert.equal(u.session_started, 1);
  assert.ok(u.updated_at > p.updated_at);
  assert.deepEqual(store.listProjects().map((x) => x.id), ['p1', 'p2']);
  assert.equal(store.getProject('nope'), null);
  assert.throws(() => store.updateProject('p1', { bogus: 1 }), /bogus/);
  assert.throws(() => store.insertProject({ id: 'p1', preset_id: 'd', title: 't', dir: '/d' }), /UNIQUE|PRIMARY/);
});

test('steps: insert (uuid), list theo ord, get theo key/id, update', () => {
  const [a, b] = seed('p1', ['a', 'b']);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(store.listSteps('p1').map((s) => s.key), ['a', 'b']);
  assert.equal(store.getStep('p1', 'b').id, b.id);
  assert.equal(store.getStepById(a.id).key, 'a');
  assert.equal(store.getStep('p1', 'zz'), null);
  const u = store.updateStep(a.id, { state: 'running', current_run_id: 'r' });
  assert.equal(u.state, 'running');
  assert.equal(u.current_run_id, 'r');
  assert.throws(() => store.insertStep({ project_id: 'p1', key: 'a', name: 'A', ord: 5, state: 'pending' }), /UNIQUE/);
});

test('runs: n tăng theo từng bước, state running, allow_paid 0/1, JSON được parse', () => {
  const [a, b] = seed();
  const r1 = store.insertRun({ step_id: a.id, project_id: 'p1', prompt: 'P', feedback: null, allow_paid: false });
  const r2 = store.insertRun({ step_id: a.id, project_id: 'p1', prompt: 'P2', feedback: 'góp ý', allow_paid: true });
  const r3 = store.insertRun({ step_id: b.id, project_id: 'p1', prompt: 'Q' });
  assert.deepEqual([r1.n, r2.n, r3.n], [1, 2, 1]);
  assert.equal(r1.state, 'running');
  assert.equal(r1.allow_paid, 0);
  assert.equal(r2.allow_paid, 1);
  assert.equal(r2.feedback, 'góp ý');
  assert.ok(r1.started_at);
  assert.equal(r1.result, null);
  assert.deepEqual(store.listRunsByStep(a.id).map((r) => r.n), [2, 1]);

  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, total_cost_usd: 0.01, api_key: 'none' };
  const done = store.updateRun(r1.id, {
    state: 'done',
    ended_at: new Date().toISOString(),
    exit_code: 0,
    summary: 'Xong',
    result: { status: 'done', summary: 'Xong' },
    denials: [{ tool: 'Bash', input: { command: 'rm -rf x' } }],
    usage_json: JSON.stringify(usage),
  });
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result, { status: 'done', summary: 'Xong' });
  assert.equal(done.result_json, JSON.stringify({ status: 'done', summary: 'Xong' }));
  assert.equal(done.denials[0].tool, 'Bash');
  assert.deepEqual(done.usage, usage);
  assert.deepEqual(store.listRunsByState('running').map((r) => r.id).sort(), [r2.id, r3.id].sort());
  assert.equal(store.latestRunByStep(a.id).id, r2.id);
  assert.equal(store.latestRunByStep('khong-co'), null);
  assert.ok(store.runningRunOf('p1'));
  store.updateRun(r2.id, { state: 'stopped' });
  store.updateRun(r3.id, { state: 'failed' });
  assert.equal(store.runningRunOf('p1'), null);
});

test('events: seq tăng theo từng run, listEvents after/limit, payload parse', () => {
  const [a] = seed();
  const r1 = store.insertRun({ step_id: a.id, project_id: 'p1' });
  const r2 = store.insertRun({ step_id: a.id, project_id: 'p1' });
  const e1 = store.addEvent(r1.id, { kind: 'init', text: 'Bắt đầu', payload: { model: 'x' } });
  assert.equal(e1.seq, 1);
  assert.equal(e1.kind, 'init');
  assert.deepEqual(e1.payload, { model: 'x' });
  assert.ok(e1.ts && typeof e1.id === 'number');
  for (let i = 0; i < 4; i++) store.addEvent(r1.id, { kind: 'text', text: `t${i}` });
  const f1 = store.addEvent(r2.id, { kind: 'text' });
  assert.equal(f1.seq, 1, 'seq đếm riêng cho từng run');
  assert.equal(f1.text, null);
  assert.equal(f1.payload, null);
  assert.deepEqual(store.listEvents(r1.id).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.listEvents(r1.id, 2).map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(store.listEvents(r1.id, 1, 2).map((e) => e.seq), [2, 3]);
  assert.deepEqual(store.listEvents(r1.id)[0].payload, { model: 'x' });
  assert.equal(store.listEvents(r1.id, 99).length, 0);
});

test('artifacts thay thế toàn bộ; checks passed 1/0/NULL; costs', () => {
  const [a] = seed();
  const r = store.insertRun({ step_id: a.id, project_id: 'p1' });
  store.setArtifacts(r.id, [
    { path: 'script.md', kind: 'markdown', label: 'Kịch bản', bytes: 10, mtime: new Date(0) },
    { path: 'a.wav', kind: 'audio', bytes: 20, mtime: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(store.listArtifacts(r.id).length, 2);
  assert.equal(store.listArtifacts(r.id)[0].mtime, '1970-01-01T00:00:00.000Z');
  store.setArtifacts(r.id, [{ path: 'x.png', kind: 'image', label: null, bytes: 1, mtime: null }]);
  assert.deepEqual(store.listArtifacts(r.id).map((x) => x.path), ['x.png']);

  store.addCheck(r.id, { name: 'ok', cmd: 'true', passed: true, output: '', duration_ms: 3 });
  store.addCheck(r.id, { name: 'trượt', cmd: 'false', passed: false, output: 'lỗi', duration_ms: 4 });
  store.addCheck(r.id, { name: 'bỏ qua', cmd: 'studio-check x', passed: null, output: 'Chưa hỗ trợ', duration_ms: 0 });
  assert.deepEqual(store.listChecks(r.id).map((c) => c.passed), [1, 0, null]);
  assert.equal(store.listChecks(r.id)[1].cmd, 'false');

  store.addCost(r.id, { kind: 'claude_tokens', units: 1234, unit_name: 'token', usd: null, note: 'haiku' });
  const c = store.listCostsByRun(r.id);
  assert.equal(c.length, 1);
  assert.equal(c[0].units, 1234);
  assert.equal(c[0].usd, null);
});

test('costSummary: cộng token từ usage, usd từ costs (null nếu không có), đếm lượt', () => {
  const [a, b] = seed();
  assert.deepEqual(store.costSummary('p1'), {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, usd: null, runs: 0,
  });
  const r1 = store.insertRun({ step_id: a.id, project_id: 'p1' });
  const r2 = store.insertRun({ step_id: b.id, project_id: 'p1' });
  store.insertRun({ step_id: b.id, project_id: 'p1' }); // chưa có usage
  store.updateRun(r1.id, { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 } });
  store.updateRun(r2.id, { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
  store.addCost(r1.id, { kind: 'claude_tokens', units: 334, unit_name: 'token', usd: null });
  let s = store.costSummary('p1');
  assert.deepEqual(s, { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 303, cache_creation_input_tokens: 8, usd: null, runs: 3 });
  store.addCost(r2.id, { kind: 'claude_tokens', units: 10, unit_name: 'token', usd: 0.25 });
  store.addCost(r2.id, { kind: 'elevenlabs', units: 500, unit_name: 'ký tự', usd: 0.5 });
  s = store.costSummary('p1');
  assert.equal(s.usd, 0.75);
  // dự án khác không bị tính lẫn
  seed('p2', ['x']);
  assert.equal(store.costSummary('p2').runs, 0);
});

test('tokensSince: chỉ claude_tokens, theo started_at của run', () => {
  const [a] = seed();
  const r1 = store.insertRun({ step_id: a.id, project_id: 'p1' });
  const r2 = store.insertRun({ step_id: a.id, project_id: 'p1' });
  store.updateRun(r1.id, { started_at: '2026-09-15T10:00:00.000Z' });
  store.updateRun(r2.id, { started_at: '2026-10-02T10:00:00.000Z' });
  store.addCost(r1.id, { kind: 'claude_tokens', units: 100, unit_name: 'token' });
  store.addCost(r2.id, { kind: 'claude_tokens', units: 40, unit_name: 'token' });
  store.addCost(r2.id, { kind: 'elevenlabs', units: 999, unit_name: 'ký tự' });
  assert.equal(store.tokensSince('2026-10-01T00:00:00.000Z'), 40);
  assert.equal(store.tokensSince('2026-01-01T00:00:00.000Z'), 140);
  assert.equal(store.tokensSince(new Date('2027-01-01T00:00:00Z')), 0);
});

test('cascade: xóa project xóa steps, runs, events, artifacts, checks, costs', () => {
  const [a] = seed();
  const r = store.insertRun({ step_id: a.id, project_id: 'p1' });
  store.addEvent(r.id, { kind: 'text', text: 'x' });
  store.setArtifacts(r.id, [{ path: 'a.md', kind: 'markdown' }]);
  store.addCheck(r.id, { name: 'c', cmd: 'true', passed: true });
  store.addCost(r.id, { kind: 'claude_tokens', units: 1, unit_name: 'token' });
  store.db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
  for (const t of ['steps', 'runs', 'run_events', 'artifacts', 'checks', 'costs']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test('tx: lỗi giữa chừng → rollback', () => {
  seed();
  assert.throws(() =>
    store.tx(() => {
      store.updateProject('p1', { status: 'done' });
      throw new Error('boom');
    }),
  /boom/);
  assert.equal(store.getProject('p1').status, 'active');
  assert.equal(store.tx(() => 42), 42);
});

test(':memory: hoạt động', () => {
  const m = openStore(':memory:');
  try {
    m.insertProject({ id: 'x', preset_id: 'p', title: 't', dir: '/d' });
    assert.equal(m.listProjects().length, 1);
  } finally {
    m.close();
  }
});

test('token_usage: ghi theo nguồn, tổng từ mốc thời gian gồm cả runs.usage_json', () => {
  const [a] = seed();
  const run = store.insertRun({ step_id: a.id, project_id: 'p1' });
  store.updateRun(run.id, { usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } });
  store.addTokenUsage('assistant', { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 7, junk: 9 });
  store.addTokenUsage('assistant', { input_tokens: '2', output_tokens: -5 });
  store.addTokenUsage('check', { input_tokens: 1, output_tokens: 1 }, '2020-01-01T00:00:00.000Z');
  const t = store.tokenTotals('2024-01-01T00:00:00.000Z');
  assert.deepEqual(t.steps, { input: 10, output: 5, cache: 150, total: 165 });
  assert.deepEqual(t.assistant, { input: 5, output: 4, cache: 7, total: 16 });
  assert.deepEqual(t.check, { input: 0, output: 0, cache: 0, total: 0 });
  assert.equal(store.tokenTotals('2019-01-01T00:00:00.000Z').check.total, 2);
  assert.equal(store.tokenTotals(new Date(Date.now() + 86_400_000)).steps.total, 0);
});

test('nâng cấp DB v4 → v5 giữ dữ liệu, thêm bảng token_usage', () => {
  seed();
  store.db.exec('DROP TABLE token_usage');
  store.db.exec('ALTER TABLE steps DROP COLUMN approved');
  store.db.pragma('user_version = 4');
  store.close();
  store = openStore(path.join(tmp, 'sub', 'studio.db'));
  assert.equal(store.db.pragma('user_version', { simple: true }), 6);
  assert.equal(store.listProjects().length, 1);
  store.addTokenUsage('check', { output_tokens: 2 });
  assert.equal(store.tokenTotals('2000-01-01').check.total, 2);
});
