import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createUpdater } from '../server/updater.js';
import { buildApp, monthStartIso } from '../server/app.js';
import { CSP, UNAUTHORIZED_MESSAGE } from '../server/auth.js';
import { openStore } from '../server/db.js';
import { loadChannels, loadPresets, REPO_ROOT } from '../server/presets.js';
import { createProjects } from '../server/projects.js';
import { createHub } from '../server/sse.js';
import { createClaudeAccount } from '../server/claude-account.js';
import { cachedPresets, DEFAULT_PORT, listenWithFallback, main, parseArgs, parsePort, resolveClaudeBin, resolveHome } from '../server/cli.js';

const FIXTURE_PRESETS = path.join(REPO_ROOT, 'test', 'fixtures', 'presets');
const TOKEN = 'test-token-abcdefghijklmnop';
const HOST = '127.0.0.1:4318';

// Runner giả: EventEmitter có start/stop/shutdown như hợp đồng §8 (không spawn gì).
class FakeRunner extends EventEmitter {
  constructor(projects) {
    super();
    this.projects = projects;
    this.calls = [];
    this.running = new Set();
  }

  start(id, key, opts) {
    this.calls.push({ id, key, opts });
    const run = this.projects.beginRun(id, key, { prompt: 'giả', feedback: opts.feedback, allowPaid: opts.allowPaid });
    this.running.add(run.id);
    return run;
  }

  async stop(runId) {
    if (!this.running.has(runId)) return false;
    this.running.delete(runId);
    this.projects.finishRun(runId, { state: 'stopped' });
    return true;
  }

  async shutdown() {}
}

let tmp;
let home;
let store;
let projects;
let runner;
let sent;
let hub;
let app;
let doctorCalls;
let errorsLogged;

async function makeApp(overrides = {}) {
  app = await buildApp({
    store,
    projects,
    runner,
    presets: () => loadPresets([FIXTURE_PRESETS]),
    channels: () => loadChannels([FIXTURE_PRESETS]),
    token: TOKEN,
    webDist: path.join(tmp, 'no-dist'),
    doctor: async () => {
      doctorCalls++;
      return {
        claude: { found: true, path: '/x/claude', version: '9.9.9' },
        auth: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
        node: process.version,
        platform: process.platform,
        problems: [],
      };
    },
    home,
    hub,
    logError: (e) => errorsLogged.push(e),
    ...overrides,
  });
  return app;
}

// inject kèm Host hợp lệ + token header (ghi đè được qua opts.headers).
function req(opts) {
  const { headers = {}, ...rest } = opts;
  return app.inject({ ...rest, headers: { host: HOST, 'x-studio-token': TOKEN, ...headers } });
}
const anon = (opts) => app.inject({ ...opts, headers: { host: HOST, ...(opts.headers || {}) } });

async function createProject(title = 'Mèo đi chợ', extra = {}) {
  const r = await req({ method: 'POST', url: '/api/projects', payload: { presetId: 'e2e-short', title, ...extra } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  store = openStore(path.join(home, 'studio.db'));
  projects = createProjects({
    store,
    presets: () => loadPresets([FIXTURE_PRESETS]),
    channels: () => loadChannels([FIXTURE_PRESETS]),
    home,
  });
  runner = new FakeRunner(projects);
  sent = [];
  const real = createHub({ pingMs: 0 });
  hub = {
    ...real,
    broadcast(event, data) {
      sent.push([event, data]);
      return real.broadcast(event, data);
    },
  };
  doctorCalls = 0;
  errorsLogged = [];
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- bảo mật

test('health không cần token, có header bảo mật + CSP đúng hợp đồng', async () => {
  await makeApp();
  const r = await anon({ url: '/api/health' });
  assert.equal(r.statusCode, 200);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const { boot, ...rest } = r.json();
  assert.deepEqual(rest, { ok: true, version: pkg.version });
  assert.match(boot, /^[0-9a-f-]{36}$/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'same-origin');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(
    r.headers['content-security-policy'],
    "default-src 'self'; img-src 'self' data: blob: https://i.ytimg.com; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  assert.equal(r.headers['content-security-policy'], CSP);
});

test('thiếu/sai token: API → 401 JSON, trang → 401 HTML; header bảo mật vẫn có', async () => {
  await makeApp();
  const a = await anon({ url: '/api/projects' });
  assert.equal(a.statusCode, 401);
  assert.deepEqual(a.json(), { error: 'unauthorized', message: UNAUTHORIZED_MESSAGE });
  assert.equal(a.headers['content-security-policy'], CSP);

  const wrong = await anon({ url: '/api/projects', headers: { 'x-studio-token': 'sai-token-123' } });
  assert.equal(wrong.statusCode, 401);

  const page = await anon({ url: '/' });
  assert.equal(page.statusCode, 401);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /video-studio/);
  assert.equal(page.headers['x-frame-options'], 'DENY');

  const badQ = await anon({ url: '/?t=sai-token-123' });
  assert.equal(badQ.statusCode, 401);
  assert.equal(badQ.headers['set-cookie'], undefined);

  const media = await anon({ url: '/media/abc/x.md' });
  assert.equal(media.statusCode, 401);
  assert.equal(media.json().error, 'unauthorized');

  const post = await anon({ method: 'POST', url: '/api/projects', payload: { presetId: 'e2e-short', title: 'x' } });
  assert.equal(post.statusCode, 401);
  assert.equal(store.listProjects().length, 0);
});

test('?t= trên trang HTML → set cookie HttpOnly SameSite=Strict + 302 bỏ t; cookie dùng được', async () => {
  await makeApp();
  const r = await anon({ url: `/?t=${TOKEN}` });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/');
  assert.equal(r.headers['cache-control'], 'no-store');
  const cookie = r.headers['set-cookie'];
  assert.equal(cookie, `vs_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);

  const keep = await anon({ url: `/projects/x?a=1&t=${TOKEN}&b=2` });
  assert.equal(keep.statusCode, 302);
  assert.equal(keep.headers.location, '/projects/x?a=1&b=2');

  const withCookie = await anon({ url: '/api/projects', headers: { cookie: `khac=1; vs_token=${TOKEN}` } });
  assert.equal(withCookie.statusCode, 200);

  // ?t= trên API: set cookie nhưng không 302
  const api = await anon({ url: `/api/projects?t=${TOKEN}` });
  assert.equal(api.statusCode, 200);
  assert.match(api.headers['set-cookie'], /^vs_token=/);

  const badCookie = await anon({ url: '/api/projects', headers: { cookie: 'vs_token=sai' } });
  assert.equal(badCookie.statusCode, 401);
});

test('Host lạ → 421 bad_host (kể cả /api/health); Host loopback có cổng được nhận', async () => {
  await makeApp();
  for (const host of ['evil.com', 'evil.com:4318', '127.0.0.1.nip.io:4318', '10.0.0.2:4318', 'localhost:99999', '[::2]:4318']) {
    const r = await app.inject({ url: '/api/health', headers: { host } });
    assert.equal(r.statusCode, 421, host);
    assert.equal(r.json().error, 'bad_host');
    assert.equal(r.headers['content-security-policy'], CSP);
  }
  for (const host of ['127.0.0.1:4318', 'localhost:4318', '[::1]:4318', '127.0.0.1', 'LOCALHOST:4318']) {
    const r = await app.inject({ url: '/api/projects', headers: { host, 'x-studio-token': TOKEN } });
    assert.equal(r.statusCode, 200, host);
  }
});

test('Origin khác http://<Host> → 403 forbidden_origin; Origin trùng → qua', async () => {
  await makeApp();
  for (const origin of ['http://evil.com', 'null', 'http://127.0.0.1:9999', 'https://127.0.0.1:4318', 'http://localhost:4318']) {
    const r = await req({ method: 'POST', url: '/api/projects', headers: { origin }, payload: { presetId: 'e2e-short', title: 'x' } });
    assert.equal(r.statusCode, 403, origin);
    assert.equal(r.json().error, 'forbidden_origin');
  }
  assert.equal(store.listProjects().length, 0);
  const ok = await req({ method: 'POST', url: '/api/projects', headers: { origin: `http://${HOST}` }, payload: { presetId: 'e2e-short', title: 'Hợp lệ' } });
  assert.equal(ok.statusCode, 201);
});

// ---------- endpoint đọc

test('GET /api/channels, /api/presets (đủ field), /api/doctor (cache 60 s, refresh, home)', async () => {
  await makeApp();
  const ch = await req({ url: '/api/channels' });
  assert.equal(ch.statusCode, 200);
  assert.ok(Array.isArray(ch.json()));
  assert.ok(ch.json().some((c) => c.id === 'tiktok'));

  const pr = await req({ url: '/api/presets' });
  assert.equal(pr.statusCode, 200);
  const body = pr.json();
  assert.ok(Array.isArray(body.errors));
  const p = body.presets.find((x) => x.id === 'e2e-short');
  assert.ok(p);
  assert.deepEqual(Object.keys(p).sort(), ['channel', 'defaults', 'file', 'format', 'id', 'mine', 'name', 'permissions', 'pipeline', 'project_dir', 'skills', 'steps', 'vars', 'yaml'].sort());
  assert.equal(p.steps.length, 4);
  assert.match(p.yaml, /e2e-short/);

  const d1 = await req({ url: '/api/doctor' });
  assert.equal(d1.statusCode, 200);
  const d = d1.json();
  assert.deepEqual(Object.keys(d).sort(), ['auth', 'claude', 'home', 'node', 'platform', 'problems']);
  assert.equal(d.home, home);
  assert.equal(d.claude.version, '9.9.9');
  await req({ url: '/api/doctor' });
  assert.equal(doctorCalls, 1, 'lần 2 trong 60 s dùng cache');
  await req({ url: '/api/doctor?refresh=1' });
  assert.equal(doctorCalls, 2);
});

test('doctor lỗi → 500 không lộ stack, không cache lỗi', async () => {
  let n = 0;
  await makeApp({
    doctor: async () => {
      n++;
      if (n === 1) throw new Error('bí mật nội bộ /Users/x');
      return { claude: { found: false, path: null, version: null }, auth: null, node: 'v', platform: 'p', problems: ['x'] };
    },
  });
  const r = await req({ url: '/api/doctor' });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(Object.keys(r.json()).sort(), ['error', 'message']);
  assert.equal(r.json().error, 'internal');
  assert.doesNotMatch(r.body, /bí mật|\/Users\/x|at /);
  assert.equal(errorsLogged.length, 1);
  const r2 = await req({ url: '/api/doctor' });
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json().problems, ['x']);
  assert.equal(n, 2);
});

test('lỗi bất ngờ trong route → 500 {error:internal} không lộ stack', async () => {
  await makeApp({
    projects: {
      ...projects,
      list() {
        throw new TypeError('Cannot read properties of undefined (reading secretField)');
      },
    },
  });
  const r = await req({ url: '/api/projects' });
  assert.equal(r.statusCode, 500);
  assert.equal(r.json().error, 'internal');
  assert.doesNotMatch(r.body, /secretField|TypeError|\.js:\d+/);
  assert.equal(r.headers['content-security-policy'], CSP);
});

// ---------- dự án

test('POST /api/projects → 201 + broadcast change; GET danh sách/chi tiết/bước; stats', async () => {
  await makeApp();
  const v = await createProject('Mèo đi chợ');
  assert.equal(v.id, 'meo-di-cho');
  assert.equal(v.preset.id, 'e2e-short');
  assert.ok(v.dir.startsWith(home));
  assert.deepEqual(sent.at(-1), ['change', { projectId: 'meo-di-cho' }]);

  const list = await req({ url: '/api/projects' });
  assert.equal(list.statusCode, 200);
  const lb = list.json();
  assert.equal(lb.projects.length, 1);
  assert.deepEqual(lb.stats, { total: 1, running: 0, waiting: 0, done: 0, tokens_month: 0 });

  const one = await req({ url: '/api/projects/meo-di-cho' });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().steps.length, 4);
  assert.equal(one.json().steps[0].state, 'ready');

  const sv = await req({ url: '/api/projects/meo-di-cho/steps/hook' });
  assert.equal(sv.statusCode, 200);
  assert.equal(sv.json().step.key, 'hook');
  assert.equal(sv.json().project.id, 'meo-di-cho');

  assert.equal((await req({ url: '/api/projects/khong-co' })).statusCode, 404);
  assert.equal((await req({ url: '/api/projects/khong-co' })).json().error, 'not_found');
  const ns = await req({ url: '/api/projects/meo-di-cho/steps/khong-co' });
  assert.equal(ns.statusCode, 404);
  assert.equal(ns.json().error, 'not_found');
});

test('POST /api/projects: lỗi 400/404/409 đúng mã', async () => {
  await makeApp();
  await createProject('Trùng tên');
  const cases = [
    [{ presetId: 'e2e-short', title: 'Trùng tên' }, 409, 'slug_taken'],
    [{ presetId: 'khong-co', title: 'abc' }, 404, 'preset_not_found'],
    [{ presetId: 'e2e-short', title: '   ' }, 400, 'invalid_title'],
    [{ presetId: 'e2e-short', title: 42 }, 400, 'invalid_title'],
    [{ presetId: 'e2e-short', title: 'Slug lạ', slug: 'Có Dấu!' }, 400, 'invalid_slug'],
    [{ presetId: 'e2e-short', title: 'Slug số', slug: 12 }, 400, 'invalid_slug'],
    [{ presetId: 'e2e-short', title: 'Dir tương đối', dir: 'tuong/doi' }, 400, 'invalid_dir'],
    [{ title: 'Thiếu preset' }, 400, 'invalid_body'],
    [[1, 2], 400, 'invalid_body'],
  ];
  for (const [payload, status, code] of cases) {
    const r = await req({ method: 'POST', url: '/api/projects', payload });
    assert.equal(r.statusCode, status, JSON.stringify(payload));
    assert.equal(r.json().error, code, JSON.stringify(payload));
    assert.equal(typeof r.json().message, 'string');
  }
  const dirTaken = await req({
    method: 'POST',
    url: '/api/projects',
    payload: { presetId: 'e2e-short', title: 'Khác', dir: path.join(home, 'projects', 'trung-ten') },
  });
  assert.equal(dirTaken.statusCode, 409);
  assert.equal(dirTaken.json().error, 'dir_taken');
});

test('quy trình: catalog, suggest (mặc định + lỗi), lưu/xóa "Quy trình của tôi", mine trong /api/presets', async () => {
  const mineDir = path.join(home, 'presets');
  // cache dài như app thật: lưu/xóa phải bỏ cache, không thì danh sách cũ
  await makeApp({ presets: cachedPresets([FIXTURE_PRESETS, mineDir], 60_000) });

  const cat = await req({ url: '/api/pipeline/catalog' });
  assert.equal(cat.statusCode, 200);
  assert.deepEqual(Object.keys(cat.json()).sort(), ['aspects', 'lengths', 'orientations', 'steps']);

  const def = (await req({ url: '/api/pipeline/suggest' })).json().pipeline;
  assert.equal(def.name, 'Video ngắn dọc 9:16');
  const sg = await req({ url: '/api/pipeline/suggest?orientation=horizontal&aspect=16:9&length=long&duration=1200&hd4k=1' });
  assert.equal(sg.statusCode, 200);
  const pl = sg.json().pipeline;
  assert.equal(pl.vars.resolution, '3840x2160');
  assert.equal(pl.vars.duration_label, '20 phút');
  for (const [q, code] of [['orientation=x', 'invalid_format'], ['orientation=vertical&aspect=21:9', 'invalid_format'], ['length=short&duration=5', 'invalid_format'], ['duration=abc', 'invalid_format']]) {
    const r = await req({ url: `/api/pipeline/suggest?${q}` });
    assert.equal(r.statusCode, 400, q);
    assert.equal(r.json().error, code, q);
  }

  assert.ok(!(await req({ url: '/api/presets' })).json().presets.some((p) => p.id === 'kenh-xe-dien')); // nạp cache trước
  const sv = await req({ method: 'POST', url: '/api/pipelines', payload: { pipeline: pl, name: 'Kênh xe điện' } });
  assert.equal(sv.statusCode, 201, sv.body);
  assert.deepEqual(sv.json(), { id: 'kenh-xe-dien', name: 'Kênh xe điện' });
  const list = (await req({ url: '/api/presets' })).json().presets;
  assert.equal(list.find((p) => p.id === 'kenh-xe-dien').mine, true);
  assert.equal(list.find((p) => p.id === 'e2e-short').mine, false);

  // sửa: đọc bản gốc, đổi tên + bỏ 1 bước, ghi đè giữ nguyên id
  const got = (await req({ url: '/api/pipelines/kenh-xe-dien' })).json().pipeline;
  assert.equal(got.id, 'kenh-xe-dien');
  const put = await req({ method: 'PUT', url: '/api/pipelines/kenh-xe-dien', payload: { pipeline: { ...got, steps: got.steps.slice(0, -1) }, name: 'Kênh xe đã sửa' } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), { id: 'kenh-xe-dien', name: 'Kênh xe đã sửa' });
  assert.equal((await req({ url: '/api/pipelines/kenh-xe-dien' })).json().pipeline.steps.length, got.steps.length - 1);
  assert.equal((await req({ method: 'PUT', url: '/api/pipelines/e2e-short', payload: { pipeline: got, name: 'x' } })).statusCode, 404, 'mẫu có sẵn không sửa được');

  for (const [payload, status, code] of [
    [{ name: 'x' }, 400, 'invalid_body'],
    [{ pipeline: pl, name: '' }, 400, 'invalid_format'],
    [{ pipeline: { ...pl, steps: [] }, name: 'Rỗng' }, 400, 'invalid_pipeline'],
  ]) {
    const r = await req({ method: 'POST', url: '/api/pipelines', payload });
    assert.equal(r.statusCode, status, JSON.stringify(payload).slice(0, 80));
    assert.equal(r.json().error, code);
  }

  // xóa: chỉ quy trình trong <home>/presets; mẫu fixture/không tồn tại → 404
  const del = (id) => req({ method: 'DELETE', url: `/api/pipelines/${id}`, payload: {} });
  assert.equal((await del('e2e-short')).statusCode, 404);
  assert.equal((await req({ method: 'DELETE', url: '/api/pipelines/kenh-xe-dien' })).statusCode, 415, 'thiếu JSON → chặn CSRF');
  assert.equal((await del('kenh-xe-dien')).statusCode, 200);
  assert.equal((await del('kenh-xe-dien')).json().error, 'pipeline_not_found');
  assert.ok(!(await req({ url: '/api/presets' })).json().presets.some((p) => p.id === 'kenh-xe-dien'));
});

test('nhân bản / xuất / nhập quy trình + hồ sơ phong cách', async () => {
  await makeApp({ presets: cachedPresets([FIXTURE_PRESETS, path.join(home, 'presets')], 60_000) });
  const dup = await req({ method: 'POST', url: '/api/pipelines/e2e-short/duplicate', payload: {} });
  assert.equal(dup.statusCode, 201);
  const id = dup.json().id;
  const pr = (await req({ url: '/api/presets' })).json();
  assert.ok(pr.presets.find((p) => p.id === id)?.mine, JSON.stringify([id, pr.presets.map((p) => p.id), pr.errors]));
  assert.equal((await req({ method: 'POST', url: '/api/pipelines/khong-co/duplicate', payload: {} })).statusCode, 404);

  const ex = (await req({ url: `/api/pipelines/${id}/export` })).json();
  assert.match(ex.filename, /\.yaml$/);
  assert.ok(!/^skills:|^channel:/m.test(ex.yaml), 'không lộ skill/kênh riêng');
  const imp = await req({ method: 'POST', url: '/api/pipelines/import', payload: { yaml: ex.yaml.replace(/^name:.*$/m, 'name: Bản nhập') } });
  assert.equal(imp.statusCode, 201);
  assert.equal(imp.json().name, 'Bản nhập');
  assert.equal((await req({ method: 'POST', url: '/api/pipelines/import', payload: { yaml: 'a: [' } })).statusCode, 400);
  assert.equal((await req({ method: 'POST', url: '/api/pipelines/import', payload: { yaml: 'name: x\nsteps: []' } })).statusCode, 400);

  assert.equal((await req({ url: '/api/style' })).json().text, '');
  assert.equal((await req({ method: 'PUT', url: '/api/style', payload: { text: 'Giọng ấm, câu ngắn.' } })).statusCode, 200);
  assert.equal((await req({ url: '/api/style' })).json().text, 'Giọng ấm, câu ngắn.');
  assert.equal((await req({ method: 'PUT', url: '/api/style', payload: { text: 'x'.repeat(21000) } })).statusCode, 400);
  await req({ method: 'PUT', url: '/api/style', payload: { text: '' } });
  assert.equal((await req({ url: '/api/style' })).json().text, '');
});

test('POST /api/projects với pipeline: kênh tùy chọn, saveAs lưu mẫu, lỗi invalid_pipeline kèm problems', async () => {
  await makeApp();
  const pl = (await req({ url: '/api/pipeline/suggest?length=short&duration=30' })).json().pipeline;

  const a = await req({ method: 'POST', url: '/api/projects', payload: { pipeline: pl, title: 'Không kênh' } });
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(a.json().channel, null);
  assert.equal(a.json().saved, undefined);
  assert.equal(a.json().steps.length, 7);

  const b = await req({ method: 'POST', url: '/api/projects', payload: { pipeline: pl, title: 'Có kênh', channelId: 'tiktok', saveAs: '  Shorts 30 giây ' } });
  assert.equal(b.statusCode, 201, b.body);
  assert.equal(b.json().channel.id, 'tiktok');
  assert.deepEqual(b.json().saved, { id: 'shorts-30-giay', name: 'Shorts 30 giây' });
  assert.ok(fs.existsSync(path.join(home, 'presets', 'shorts-30-giay.yaml')));

  const bad = structuredClone(pl);
  bad.steps[0].prompt = '';
  const cases = [
    [{ pipeline: bad, title: 'Hỏng' }, 400, 'invalid_pipeline'],
    [{ pipeline: 'x', title: 'Chuỗi' }, 400, 'invalid_body'],
    [{ pipeline: pl, title: 'Kênh lạ', channelId: 'khong-co' }, 400, 'channel_not_found'],
    [{ pipeline: pl, title: 'Kênh số', channelId: 5 }, 400, 'channel_not_found'],
    [{ pipeline: pl, title: 'Tên dài', saveAs: 'x'.repeat(81) }, 400, 'invalid_name'],
    [{ presetId: 'e2e-short', title: 'Lưu không pipeline', saveAs: 'abc' }, 400, 'invalid_name'],
  ];
  for (const [payload, status, code] of cases) {
    const r = await req({ method: 'POST', url: '/api/projects', payload });
    assert.equal(r.statusCode, status, payload.title);
    assert.equal(r.json().error, code, payload.title);
  }
  const r = await req({ method: 'POST', url: '/api/projects', payload: { pipeline: bad, title: 'Hỏng' } });
  assert.ok(Array.isArray(r.json().problems) && r.json().problems.length === 1);
  assert.equal(projects.list().length, 2, 'lỗi không tạo dự án');
});

test('body JSON hỏng → 400, quá 256 KB → 413, sai content-type → 415 (đều invalid_body)', async () => {
  await makeApp();
  const bad = await req({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: '{"presetId":' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_body');

  const big = await req({
    method: 'POST',
    url: '/api/projects',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ presetId: 'e2e-short', title: 'x', pad: 'a'.repeat(300 * 1024) }),
  });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error, 'invalid_body');

  const xml = await req({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/xml' }, payload: '<a/>' });
  assert.equal(xml.statusCode, 415);
  assert.equal(xml.json().error, 'invalid_body');

  // text/plain (simple request của trang lạ) → 415 trước cả khi parse
  const text = await req({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'text/plain' }, payload: 'hello' });
  assert.equal(text.statusCode, 415);
  assert.equal(text.json().error, 'invalid_body');

  const proto = await req({
    method: 'POST',
    url: '/api/projects',
    headers: { 'content-type': 'application/json' },
    payload: '{"presetId":"e2e-short","title":"x","__proto__":{"polluted":1}}',
  });
  assert.equal(proto.statusCode, 400);
  assert.equal({}.polluted, undefined);
});

test('POST /api thiếu Content-Type JSON → 415, không chạy/duyệt bước (chặn CSRF simple request)', async () => {
  await makeApp();
  await createProject('Chống CSRF');
  const urls = ['/api/projects/chong-csrf/steps/hook/run', '/api/projects/chong-csrf/steps/hook/complete', '/api/runs/1/stop'];
  for (const url of urls) {
    for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'multipart/form-data; boundary=x' }]) {
      const r = await req({ method: 'POST', url, headers, payload: headers['content-type'] ? 'a=1' : undefined });
      assert.equal(r.statusCode, 415, `${url} ${JSON.stringify(headers)}`);
      assert.equal(r.json().error, 'invalid_body');
    }
  }
  assert.equal(runner.calls.length, 0);
  assert.equal(projects.view('chong-csrf').steps[0].state, 'ready');
  // content-type JSON kèm charset vẫn qua
  const ok = await req({ method: 'POST', url: urls[0], headers: { 'content-type': 'application/json; charset=utf-8' }, payload: '{}' });
  assert.equal(ok.statusCode, 202);
});

// ---------- chạy / dừng / đánh dấu xong / events

test('run → 202 {run}, runner.start nhận feedback/allowPaid; busy 409; stop 200 rồi 404', async () => {
  await makeApp();
  await createProject('Chạy thử');
  const r = await req({ method: 'POST', url: '/api/projects/chay-thu/steps/hook/run', payload: { feedback: 'Ngắn hơn nhé' } });
  assert.equal(r.statusCode, 202, r.body);
  const { run } = r.json();
  assert.deepEqual(Object.keys(run).sort(), ['ended_at', 'error', 'exit_code', 'id', 'n', 'progress_msg', 'progress_pct', 'started_at', 'state', 'summary']);
  assert.equal(run.n, 1);
  assert.equal(run.state, 'running');
  assert.deepEqual(runner.calls[0], { id: 'chay-thu', key: 'hook', opts: { feedback: 'Ngắn hơn nhé', allowPaid: false, allowOnce: [] } });

  const stats = (await req({ url: '/api/projects' })).json().stats;
  assert.equal(stats.running, 1);

  const busy = await req({ method: 'POST', url: '/api/projects/chay-thu/steps/hook/run', payload: {} });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error, 'busy');
  assert.equal(runner.calls.length, 1);

  const stop = await req({ method: 'POST', url: `/api/runs/${run.id}/stop`, payload: {} });
  assert.equal(stop.statusCode, 200);
  assert.deepEqual(stop.json(), { ok: true });
  assert.equal(store.getRun(run.id).state, 'stopped');

  const again = await req({ method: 'POST', url: `/api/runs/${run.id}/stop`, payload: {} });
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().error, 'not_found');
  const none = await req({ method: 'POST', url: '/api/runs/khong-co/stop', payload: {} });
  assert.equal(none.statusCode, 404);
});

test('stop lượt mồ côi (DB running, runner không trông — server đã khởi động lại) → 200 stopped, chạy lại được', async () => {
  await makeApp();
  await createProject('Mồ côi');
  const orphan = projects.beginRun('mo-coi', 'hook', { prompt: 'cũ' }); // không qua runner → runner.stop trả false
  const busy = await req({ method: 'POST', url: '/api/projects/mo-coi/steps/hook/run', payload: {} });
  assert.equal(busy.statusCode, 409);
  const stop = await req({ method: 'POST', url: `/api/runs/${orphan.id}/stop`, payload: {} });
  assert.equal(stop.statusCode, 200);
  assert.deepEqual(stop.json(), { ok: true });
  const r = store.getRun(orphan.id);
  assert.equal(r.state, 'stopped');
  assert.equal(r.error, 'Lượt mồ côi (server đã khởi động lại)');
  assert.ok(sent.some(([ev, d]) => ev === 'change' && d?.projectId === 'mo-coi'));
  const again = await req({ method: 'POST', url: '/api/projects/mo-coi/steps/hook/run', payload: {} });
  assert.equal(again.statusCode, 202);
});

test('run: body sai → 400; bước trước chưa xong → 409 not_runnable; dự án/bước lạ → 404', async () => {
  await makeApp();
  await createProject('Kiểm body');
  const url = '/api/projects/kiem-body/steps/hook/run';
  for (const payload of [{ feedback: 'x'.repeat(20_001) }, { feedback: 5 }, { allowPaid: 'yes' }, [1]]) {
    const r = await req({ method: 'POST', url, payload });
    assert.equal(r.statusCode, 400, JSON.stringify(payload).slice(0, 60));
    assert.equal(r.json().error, 'invalid_body');
  }
  const max = await req({ method: 'POST', url, payload: { feedback: 'x'.repeat(20_000) } });
  assert.equal(max.statusCode, 202);
  await runner.stop(max.json().run.id);

  const notYet = await req({ method: 'POST', url: '/api/projects/kiem-body/steps/bible/run', payload: {} });
  assert.equal(notYet.statusCode, 409);
  assert.equal(notYet.json().error, 'not_runnable');

  const np = await req({ method: 'POST', url: '/api/projects/khong-co/steps/hook/run', payload: {} });
  assert.equal(np.statusCode, 404);
  assert.equal(np.json().error, 'not_found');
  const nk = await req({ method: 'POST', url: '/api/projects/kiem-body/steps/khong-co/run', payload: {} });
  assert.equal(nk.statusCode, 404);
  assert.equal(runner.calls.length, 1);

  // thân rỗng nhưng có content-type JSON vẫn chạy được (nút Dừng/Đánh dấu xong)
  const empty = await req({ method: 'POST', url, headers: { 'content-type': 'application/json' } });
  assert.equal(empty.statusCode, 202);
  assert.deepEqual(runner.calls.at(-1).opts, { feedback: null, allowPaid: false, allowOnce: [] });
});

test('bước tốn tiền: thiếu allowPaid → 412 cost_confirm_required kèm cost; allowPaid:true → 202', async () => {
  await makeApp();
  const v = await createProject('Tốn tiền');
  fs.writeFileSync(path.join(v.dir, 'script.md'), 'Xin chào các bạn');
  const c1 = await req({ method: 'POST', url: '/api/projects/ton-tien/steps/hook/complete', payload: {} });
  assert.equal(c1.statusCode, 200);
  assert.equal((await req({ method: 'POST', url: '/api/projects/ton-tien/steps/bible/complete', payload: {} })).statusCode, 200);

  const r = await req({ method: 'POST', url: '/api/projects/ton-tien/steps/voice/run', payload: {} });
  assert.equal(r.statusCode, 412);
  const b = r.json();
  assert.equal(b.error, 'cost_confirm_required');
  assert.equal(b.cost.service, 'elevenlabs');
  assert.equal(b.cost.estimate_value, 'Xin chào các bạn'.length);
  assert.equal(runner.calls.length, 0);

  const ok = await req({ method: 'POST', url: '/api/projects/ton-tien/steps/voice/run', payload: { allowPaid: true } });
  assert.equal(ok.statusCode, 202);
  assert.deepEqual(runner.calls[0].opts, { feedback: null, allowPaid: true, allowOnce: [] });
});

test('run: allowOnce hợp lệ chuyển tới runner; quy tắc nguy hiểm/sai kiểu → 400', async () => {
  await makeApp();
  const p = await createProject('Một lần');
  const url = `/api/projects/${p.id}/steps/hook/run`;
  const bad = await req({ method: 'POST', url, payload: { allowOnce: ['Bash(rm *)'] } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await req({ method: 'POST', url, payload: { allowOnce: 'WebSearch' } })).statusCode, 400);
  const { validateGrantRule } = await import('../server/pipeline.js');
  assert.equal(validateGrantRule('Bash(find *)', { once: true }), 'Bash(find *)');
  assert.throws(() => validateGrantRule('Bash(find *)'));
  assert.equal((await req({ method: 'POST', url: `/api/projects/${p.id}/permissions`, payload: { tool: 'Bash(find *)' } })).statusCode, 400);
  const ok = await req({ method: 'POST', url, payload: { allowOnce: ['Bash(mkdir *)', 'WebSearch'] } });
  assert.equal(ok.statusCode, 202, ok.body);
  assert.deepEqual(runner.calls.at(-1).opts.allowOnce, ['Bash(mkdir *)', 'WebSearch']);
});

test('runner.start ném HttpError (vd locked) → đúng mã; complete 200 + change, lần 2 → 409', async () => {
  const { HttpError } = await import('../server/projects.js');
  await makeApp();
  await createProject('Khóa');
  runner.start = () => {
    throw new HttpError(409, 'locked', 'Thư mục dự án đang bị process khác giữ.');
  };
  const r = await req({ method: 'POST', url: '/api/projects/khoa/steps/hook/run', payload: {} });
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json(), { error: 'locked', message: 'Thư mục dự án đang bị process khác giữ.' });

  sent.length = 0;
  const c = await req({ method: 'POST', url: '/api/projects/khoa/steps/hook/complete', payload: {} });
  assert.equal(c.statusCode, 200);
  assert.equal(c.json().step.state, 'done');
  assert.deepEqual(sent, [['change', { projectId: 'khoa' }]]);
  const c2 = await req({ method: 'POST', url: '/api/projects/khoa/steps/hook/complete', payload: {} });
  assert.equal(c2.statusCode, 409);
  assert.equal(c2.json().error, 'not_runnable');
  const c3 = await req({ method: 'POST', url: '/api/projects/khoa/steps/khong-co/complete', payload: {} });
  assert.equal(c3.statusCode, 404);
});

test('GET /api/runs/:id/events?after=&limit= → events seq tăng dần + done', async () => {
  await makeApp();
  await createProject('Sự kiện');
  const run = (await req({ method: 'POST', url: '/api/projects/su-kien/steps/hook/run', payload: {} })).json().run;
  for (let i = 1; i <= 5; i++) store.addEvent(run.id, { kind: 'text', text: `dòng ${i}`, payload: { i } });

  const all = await req({ url: `/api/runs/${run.id}/events` });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().events.length, 5);
  assert.deepEqual(Object.keys(all.json().events[0]).sort(), ['kind', 'payload', 'seq', 'text', 'ts']);
  assert.equal(all.json().done, false, 'run còn running');

  const after = (await req({ url: `/api/runs/${run.id}/events?after=3` })).json();
  assert.deepEqual(after.events.map((e) => e.seq), [4, 5]);
  assert.deepEqual(after.events[0].payload, { i: 4 });

  projects.finishRun(run.id, { state: 'done', summary: 'xong' });
  runner.running.delete(run.id);
  const lim = (await req({ url: `/api/runs/${run.id}/events?after=0&limit=2` })).json();
  assert.deepEqual(lim.events.map((e) => e.seq), [1, 2]);
  assert.equal(lim.done, false, 'còn trang sau');
  const rest = (await req({ url: `/api/runs/${run.id}/events?after=2&limit=10` })).json();
  assert.equal(rest.events.length, 3);
  assert.equal(rest.done, true);
  const bad = (await req({ url: `/api/runs/${run.id}/events?after=abc` })).json();
  assert.equal(bad.events.length, 5);

  const nf = await req({ url: '/api/runs/khong-co/events' });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().error, 'not_found');
});

test('runner emit event/change → broadcast log/change; gỡ listener khi app.close', async () => {
  await makeApp();
  const ev = { seq: 1, ts: '2026-10-25T00:00:00.000Z', kind: 'text', text: 'xin chào', payload: null };
  runner.emit('event', { runId: 'r1', projectId: 'p1', event: ev });
  runner.emit('change', { projectId: 'p1' });
  assert.deepEqual(sent, [
    ['log', { runId: 'r1', projectId: 'p1', event: ev }],
    ['change', { projectId: 'p1' }],
  ]);
  assert.equal(runner.listenerCount('event'), 1);
  await app.close();
  app = null;
  assert.equal(runner.listenerCount('event'), 0);
  assert.equal(runner.listenerCount('change'), 0);
});

test('tokens_month = tổng claude_tokens từ đầu tháng; waiting đếm needs_input/failed/manual', async () => {
  await makeApp();
  await createProject('Token');
  const run = (await req({ method: 'POST', url: '/api/projects/token/steps/hook/run', payload: {} })).json().run;
  store.addCost(run.id, { kind: 'claude_tokens', units: 1234, unit_name: 'token', usd: null, note: 'test' });
  projects.finishRun(run.id, { state: 'needs_input', summary: 'hỏi' });
  runner.running.delete(run.id);
  const s = (await req({ url: '/api/projects' })).json().stats;
  assert.equal(s.tokens_month, 1234);
  assert.equal(s.waiting, 1);
  assert.equal(s.running, 0);
  assert.ok(monthStartIso(new Date(2026, 9, 25, 15)) <= new Date(2026, 9, 1, 0, 0, 1).toISOString());
});

// ---------- web/dist

test('web/dist: index cần token, asset công khai + cache dài, SPA fallback, chặn dotfile, 404', async () => {
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Video Studio</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc.css'), 'body{}');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dist, '.secret'), 'bí mật');
  await makeApp({ webDist: dist });

  assert.equal((await anon({ url: '/' })).statusCode, 401);
  assert.equal((await anon({ url: '/index.html' })).statusCode, 401);
  const idx = await req({ url: '/' });
  assert.equal(idx.statusCode, 200);
  assert.match(idx.headers['content-type'], /^text\/html/);
  assert.equal(idx.headers['cache-control'], 'no-cache');
  assert.match(idx.body, /Video Studio/);
  assert.equal(idx.headers['content-security-policy'], CSP);

  const spa = await req({ url: '/projects/abc/steps/hook' });
  assert.equal(spa.statusCode, 200);
  assert.match(spa.body, /id="root"/);

  const js = await anon({ url: '/assets/app-abc.js' });
  assert.equal(js.statusCode, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.match(js.headers['cache-control'], /immutable/);
  assert.equal(js.body, 'console.log(1)');
  assert.equal((await anon({ url: '/assets/app-abc.css' })).headers['content-type'], 'text/css; charset=utf-8');
  const fav = await anon({ url: '/favicon.svg' });
  assert.equal(fav.statusCode, 200);
  assert.equal(fav.headers['content-type'], 'image/svg+xml');

  const head = await anon({ method: 'HEAD', url: '/assets/app-abc.js' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], String('console.log(1)'.length));
  assert.equal(head.body, '');

  assert.equal((await anon({ url: '/assets/khong-co.js' })).statusCode, 404);
  assert.equal((await anon({ url: '/assets/..%2findex.html' })).statusCode, 404);
  assert.equal((await anon({ url: '/.secret' })).statusCode, 401);
  const sec = await req({ url: '/.secret' });
  assert.equal(sec.statusCode, 404);
  assert.doesNotMatch(sec.body, /bí mật/);
  assert.equal((await req({ url: '/khong-co.png' })).statusCode, 404);

  const api404 = await req({ url: '/api/khong-co' });
  assert.equal(api404.statusCode, 404);
  assert.equal(api404.json().error, 'not_found');
  const del = await req({ method: 'DELETE', url: '/api/projects' });
  assert.equal(del.statusCode, 404);
  assert.equal(del.json().error, 'not_found');
});

test('chưa build web/dist → trang HTML hướng dẫn npm run build', async () => {
  await makeApp();
  const r = await req({ url: '/' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.match(r.body, /npm run build/);
  assert.doesNotMatch(r.body, /<script/i);
  const deep = await req({ url: '/projects/x' });
  assert.equal(deep.statusCode, 200);
  assert.match(deep.body, /npm run build/);
});

test('web/dist mặc định nằm ở <repo>/web/dist (không phụ thuộc cwd)', async () => {
  const { DEFAULT_WEB_DIST } = await import('../server/app.js');
  assert.equal(DEFAULT_WEB_DIST, path.join(REPO_ROOT, 'web', 'dist'));
});

// ---------- SSE

function getStream(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers }, resolve);
    r.on('error', reject);
  });
}

function waitFor(res, state, pattern, ms = 3000) {
  return new Promise((resolve, reject) => {
    if (pattern.test(state.buf)) return resolve();
    const t = setTimeout(() => {
      res.off('data', onData);
      reject(new Error(`Hết giờ chờ ${pattern}; đã nhận: ${state.buf}`));
    }, ms);
    function onData() {
      if (pattern.test(state.buf)) {
        clearTimeout(t);
        res.off('data', onData);
        resolve();
      }
    }
    res.on('data', onData);
  });
}

test('SSE /api/stream: header đúng, gửi hello, nhận log từ runner, tự gỡ client khi đóng', async () => {
  await makeApp({ hub: undefined });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  const denied = await getStream(port);
  assert.equal(denied.statusCode, 401);
  denied.resume();

  const res = await getStream(port, { 'x-studio-token': TOKEN });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  assert.match(res.headers['cache-control'], /no-cache/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const state = { buf: '' };
  res.setEncoding('utf8');
  res.on('data', (d) => {
    state.buf += d;
  });
  await waitFor(res, state, /event: hello\ndata: (.+)\n\n/);
  const hello = JSON.parse(/event: hello\ndata: (.+)\n\n/.exec(state.buf)[1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(hello, { version: pkg.version });

  runner.emit('event', { runId: 'r9', projectId: 'p9', event: { seq: 7, ts: 't', kind: 'text', text: 'Đang làm…', payload: null } });
  await waitFor(res, state, /event: log\ndata: .+\n\n/);
  const log = JSON.parse(/event: log\ndata: (.+)\n\n/.exec(state.buf)[1]);
  assert.equal(log.runId, 'r9');
  assert.equal(log.event.text, 'Đang làm…');

  const closed = new Promise((resolve) => res.on('close', resolve));
  res.destroy();
  await closed;
  // client rớt → hub tự gỡ (broadcast không lỗi)
  for (let i = 0; i < 50; i++) {
    runner.emit('change', { projectId: 'p9' });
    await new Promise((r) => setTimeout(r, 10));
  }
});

test('SSE: app.close() không treo khi còn client đang mở', async () => {
  await makeApp({ hub: undefined });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const res = await getStream(port, { cookie: `vs_token=${TOKEN}` });
  assert.equal(res.statusCode, 200);
  const state = { buf: '' };
  res.setEncoding('utf8');
  res.on('data', (d) => {
    state.buf += d;
  });
  await waitFor(res, state, /event: hello/);
  const ended = new Promise((resolve) => res.on('end', resolve));
  await app.close();
  app = null;
  await ended;
});

// ---------- cli

// ---------- tài khoản Claude (lệnh auth chạy trên fake-claude, không đụng tài khoản thật)

const FAKE_CLAUDE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');

// Bộ điều khiển tài khoản thật chạy fake-claude; FAKE_AUTH_FILE giữ trạng thái đăng nhập giả.
function fakeAccount(extraEnv = {}) {
  const authFile = path.join(tmp, 'auth.json');
  const account = createClaudeAccount({
    claudeBin: FAKE_CLAUDE,
    profiles: () => ({ supported: true, profiles: [{ dir: 'Profile 1', name: 'Công việc', color: '#ff0000', lastUsed: true }] }),
    env: { PATH: process.env.PATH, FAKE_AUTH_FILE: authFile, ...extraEnv },
    killGraceMs: 200,
  });
  return { account, authFile };
}

// Chờ tới khi SSE 'account' báo lệnh auth xong.
async function accountDone() {
  for (let i = 0; i < 300; i++) {
    const ev = sent.filter(([e]) => e === 'account').at(-1);
    if (ev && ev[1].busy === null) return ev[1];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('lệnh auth không xong');
}

test('tài khoản: thiếu account → 503 account_unavailable', async () => {
  await makeApp();
  for (const [method, url] of [['GET', '/api/claude/account'], ['GET', '/api/chrome-profiles'], ['POST', '/api/claude/login'], ['POST', '/api/claude/logout']]) {
    const r = await req({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    assert.equal(r.statusCode, 503, url);
    assert.equal(r.json().error, 'account_unavailable');
  }
});

test('tài khoản: login 202 → SSE account + bỏ cache doctor; hồ sơ Chrome chỉ dir/name/color', async () => {
  const { account, authFile } = fakeAccount({ FAKE_LOGIN_MS: '50' });
  await makeApp({ account });
  const prof = await req({ url: '/api/chrome-profiles' });
  assert.deepEqual(prof.json().profiles[0], { dir: 'Profile 1', name: 'Công việc', color: '#ff0000', lastUsed: true });
  await req({ url: '/api/doctor' });
  const before = doctorCalls;
  const r = await req({ method: 'POST', url: '/api/claude/login', payload: { method: 'claudeai', profileDir: 'Profile 1' } });
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(r.json().busy, 'login');
  assert.deepEqual(r.json().profile, { dir: 'Profile 1', name: 'Công việc' });
  const busy = await req({ method: 'POST', url: '/api/claude/login', payload: {} });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error, 'account_busy');
  const done = await accountDone();
  assert.equal(done.last.reason, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).loggedIn, true);
  await req({ url: '/api/doctor' });
  assert.equal(doctorCalls, before + 1, 'doctor phải đọc lại sau lệnh auth');
  assert.equal((await req({ url: '/api/claude/account' })).json().last.action, 'login');
});

test('tài khoản: body sai → 400; thiếu JSON → 415; hồ sơ lạ → 400 invalid_profile', async () => {
  const { account } = fakeAccount();
  await makeApp({ account });
  const bad = await req({ method: 'POST', url: '/api/claude/login', payload: { method: 5 } });
  assert.equal(bad.statusCode, 400);
  const prof = await req({ method: 'POST', url: '/api/claude/login', payload: { profileDir: 'Profile 99' } });
  assert.equal(prof.statusCode, 400);
  assert.equal(prof.json().error, 'invalid_profile');
  const noJson = await req({ method: 'POST', url: '/api/claude/logout', payload: 'x', headers: { 'content-type': 'text/plain' } });
  assert.equal(noJson.statusCode, 415);
  assert.equal(account.isBusy(), false);
});

test('tài khoản: đang có dự án chạy → login/logout 409 runs_active', async () => {
  const { account } = fakeAccount();
  await makeApp({ account });
  await createProject('Đang chạy');
  projects.beginRun('dang-chay', 'hook', { prompt: 'giả' });
  for (const url of ['/api/claude/login', '/api/claude/logout']) {
    const r = await req({ method: 'POST', url, payload: {} });
    assert.equal(r.statusCode, 409, url);
    assert.equal(r.json().error, 'runs_active');
  }
  assert.equal(account.isBusy(), false);
});

test('tài khoản: cancel lượt đang chờ; cancel khi rảnh → 409; logout ghi đăng xuất', async () => {
  const { account, authFile } = fakeAccount({ FAKE_LOGIN_MS: '5000' });
  await makeApp({ account });
  assert.equal((await req({ method: 'POST', url: '/api/claude/login', payload: {} })).statusCode, 202);
  const c = await req({ method: 'POST', url: '/api/claude/login/cancel', payload: {} });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().last.reason, 'cancelled');
  const again = await req({ method: 'POST', url: '/api/claude/login/cancel', payload: {} });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'not_logging_in');
  const out = await req({ method: 'POST', url: '/api/claude/logout', payload: {} });
  assert.equal(out.statusCode, 200, out.body);
  assert.equal(out.json().last.reason, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).loggedIn, false);
});

test('cli parseArgs/parsePort/resolveClaudeBin/resolveHome', () => {
  assert.deepEqual(parseArgs([], {}), { port: DEFAULT_PORT, host: '127.0.0.1', model: null, open: false, dev: false, service: false, help: false });
  assert.equal(parseArgs(['--port', '5000'], { VS_PORT: '6000' }).port, 5000);
  assert.equal(parseArgs(['--port=5001'], {}).port, 5001);
  assert.equal(parseArgs([], { VS_PORT: '6000' }).port, 6000);
  assert.equal(parseArgs(['--model', 'haiku'], { VS_MODEL: 'opus' }).model, 'haiku');
  assert.equal(parseArgs([], { VS_MODEL: ' opus ' }).model, 'opus');
  assert.equal(parseArgs(['--host', '[::1]'], {}).host, '::1');
  assert.equal(parseArgs(['--host=LOCALHOST'], {}).host, 'localhost');
  const d = parseArgs(['--dev', '--no-open'], {});
  assert.equal(d.dev, true);
  assert.equal(d.open, false);
  assert.equal(parseArgs(['-h'], {}).help, true);
  assert.throws(() => parseArgs(['--host', '0.0.0.0'], {}), /chỉ nhận 127\.0\.0\.1/);
  assert.throws(() => parseArgs(['--port', 'abc'], {}), /không hợp lệ/);
  assert.throws(() => parseArgs([], { VS_PORT: '99999' }), /VS_PORT không hợp lệ/);
  assert.throws(() => parseArgs(['--port'], {}), /Thiếu giá trị/);
  assert.throws(() => parseArgs(['--la'], {}), /Không hiểu tham số/);
  assert.equal(parsePort('0'), 0);
  assert.throws(() => parsePort('-1'), /không hợp lệ/);
  assert.equal(resolveClaudeBin(''), 'claude');
  assert.equal(resolveClaudeBin('claude-dev'), 'claude-dev');
  assert.equal(resolveClaudeBin('./x/claude'), path.resolve('./x/claude'));
  const h = path.join(tmp, 'vs-home-a');
  assert.equal(resolveHome({ VS_HOME: h }), h);
  assert.ok(fs.statSync(h).isDirectory());
});

test('cli listenWithFallback: cổng bận → dùng cổng kế tiếp', async (t) => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  try {
    if (busy > 65500) return t.skip('cổng ngẫu nhiên quá sát 65535');
    await makeApp();
    const port = await listenWithFallback(app, { host: '127.0.0.1', port: busy, tries: 5 });
    assert.ok(port > busy && port <= busy + 5, `${busy} → ${port}`);
    assert.equal(app.server.address().address, '127.0.0.1');
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

async function quietly(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
  }
}

test('cli main(): --help in hướng dẫn, trả null', async () => {
  const { value, logs } = await quietly(() => main(['--help'], { VS_HOME: path.join(tmp, 'h') }));
  assert.equal(value, null);
  assert.match(logs.join('\n'), /--port/);
  assert.equal(fs.existsSync(path.join(tmp, 'h')), false, '--help không tạo thư mục dữ liệu');
});

test('cli main(): VS_HOME tạm, cổng 0, 127.0.0.1, in link không token + mã thiết lập; health/doctor/presets chạy; close sạch', async () => {
  const vsHome = path.join(tmp, 'vs-home');
  const bin = path.join(tmp, 'fake-claude-doctor.mjs');
  fs.writeFileSync(
    bin,
    `const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('1.2.3 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'fake@example.invalid', orgId: 'org-fake', orgName: 'Org Giả', subscriptionType: 'pro' })); process.exit(0); }
process.exit(64);
`,
  );
  const { value: s, logs } = await quietly(() => main(['--port', '0', '--no-open', '--dev'], { VS_HOME: vsHome, VS_TOKEN: TOKEN, VS_CLAUDE_BIN: bin, VS_UPDATE_CHECK: '0' }));
  try {
    assert.equal(s.home, vsHome);
    assert.equal(s.token, TOKEN);
    assert.ok(fs.existsSync(path.join(vsHome, 'studio.db')));
    assert.ok(s.port > 0);
    assert.equal(s.app.server.address().address, '127.0.0.1');
    assert.equal(s.url, `http://127.0.0.1:${s.port}/`);
    const out = logs.join('\n');
    assert.ok(out.includes(`Video Studio đang chạy: ${s.url}\n`));
    assert.match(out, /Lần đầu: tạo mật khẩu với mã thiết lập \d{6}/);
    assert.ok(!out.replace(/VS_TOKEN=\S+ npm run dev:web/, '').includes(TOKEN), 'token chỉ hiện ở gợi ý dev');
    assert.ok(out.includes(vsHome));
    assert.match(out, /npm run dev:web/);
    const base = `http://127.0.0.1:${s.port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    const dr = await fetch(`${base}/api/doctor`, { headers: { 'x-studio-token': TOKEN } });
    assert.equal(dr.status, 200);
    const doc = await dr.json();
    assert.equal(doc.claude.version, '1.2.3');
    assert.equal(doc.home, vsHome);
    assert.deepEqual(doc.auth, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' });
    assert.doesNotMatch(JSON.stringify(doc), /fake@example|org-fake|Org Giả/);
    const pr = await fetch(`${base}/api/presets`, { headers: { 'x-studio-token': TOKEN } });
    assert.equal(pr.status, 200);
    assert.ok(Array.isArray((await pr.json()).presets));
  } finally {
    await s.close();
  }
  assert.equal(s.app.server.listening, false);
});

test('cli main(): không có VS_TOKEN → token cố định trong VS_HOME/token (600), --open thì mở trình duyệt, mặc định chỉ in link', async () => {
  const vsHome = path.join(tmp, 'vs-home-tok');
  const opened = [];
  const openUrl = (u) => opened.push(u);
  const { value: a } = await quietly(() => main(['--port', '0', '--open'], { VS_HOME: vsHome }, { openUrl }));
  await a.close();
  const file = path.join(vsHome, 'token');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), a.token);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(opened, [a.url]);
  const { value: b } = await quietly(() => main(['--port', '0'], { VS_HOME: vsHome }, { openUrl }));
  await b.close();
  assert.equal(b.token, a.token, 'chạy lại vẫn dùng token cũ');
  assert.equal(opened.length, 1);
});

test('cli reset-password: xóa mật khẩu, in mã thiết lập mới', async () => {
  const vsHome = path.join(tmp, 'vs-home-reset');
  fs.mkdirSync(vsHome, { recursive: true });
  const st = openStore(path.join(vsHome, 'studio.db'));
  st.setSetting('login.password', 'scrypt$x');
  st.close();
  const { value, logs } = await quietly(() => main(['reset-password'], { VS_HOME: vsHome }));
  assert.equal(value.exitCode, 0);
  assert.match(logs.join('\n'), /mã thiết lập: \d{6}/);
  const st2 = openStore(path.join(vsHome, 'studio.db'));
  assert.equal(st2.getSetting('login.password'), null);
  assert.ok(st2.getSetting('login.setup'));
  st2.close();
});

test('update: không có updater → không báo bản mới; POST 503', async () => {
  await makeApp();
  const r = await req({ url: '/api/update' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().newer, false);
  assert.equal((await req({ method: 'POST', url: '/api/update', payload: {} })).statusCode, 503);
});

test('update: có bản mới → POST chạy cập nhật; đã mới nhất → 409; restart chỉ khi chạy nền; cần token', async () => {
  let started = 0;
  const mk = (tag, restart = null) =>
    createUpdater({
      current: '0.1.0',
      repo: 'o/r',
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: tag }) }),
      spawnUpdate: () => started++,
      restart,
    });
  await makeApp({ updater: mk('v0.1.0') });
  assert.equal((await req({ method: 'POST', url: '/api/update', payload: {} })).statusCode, 409);
  await app.close();
  await makeApp({ updater: mk('v0.2.0') });
  assert.equal((await anon({ url: '/api/update' })).statusCode, 401);
  const s = (await req({ url: '/api/update' })).json();
  assert.equal(s.newer, true);
  assert.equal(s.latest, '0.2.0');
  const p = await req({ method: 'POST', url: '/api/update', payload: {} });
  assert.equal(p.statusCode, 200);
  assert.equal(p.json().state, 'running');
  assert.equal(started, 1);
  assert.equal((await req({ method: 'POST', url: '/api/update/restart', payload: {} })).statusCode, 409);
});

test('assistant: không có → available:false, POST 503; có → tool là public, còn lại cần token; state đi qua SSE', async () => {
  await makeApp();
  assert.deepEqual((await req({ url: '/api/assistant' })).json(), { available: false, busy: false, messages: [] });
  const off = await req({ method: 'POST', url: '/api/assistant/message', payload: { text: 'chào' } });
  assert.equal(off.statusCode, 503);
  assert.equal(off.json().error, 'assistant_unavailable');
  assert.equal((await anon({ method: 'POST', url: '/api/assistant/tool', payload: { key: 'k' } })).statusCode, 401);
  await app.close();

  const calls = [];
  let listener;
  const fake = {
    state: () => ({ busy: false, messages: [] }),
    send: (text, o) => (calls.push(['send', text, o.tabId]), { busy: true, messages: [] }),
    stop: () => ({ busy: false, messages: [] }),
    reset: () => ({ busy: false, messages: [] }),
    callTool: (key, tool, args) => (calls.push(['tool', key, tool, args]), { text: 'trang', isError: false }),
    toolResult: (id, b) => (calls.push(['result', id, b]), { ok: true }),
    on: (fn) => ((listener = fn), () => {}),
  };
  await makeApp({ assistant: fake });
  assert.equal((await req({ url: '/api/assistant' })).json().available, true);
  assert.equal((await anon({ url: '/api/assistant' })).statusCode, 401);
  assert.equal((await anon({ method: 'POST', url: '/api/assistant/message', payload: { text: 'x' } })).statusCode, 401);
  assert.equal((await req({ method: 'POST', url: '/api/assistant/message', payload: { text: 1 } })).statusCode, 400);
  const s = await req({ method: 'POST', url: '/api/assistant/message', payload: { text: 'chào', tabId: 't'.repeat(100) } });
  assert.equal(s.json().busy, true);
  const t = await anon({ method: 'POST', url: '/api/assistant/tool', payload: { key: 'k', tool: 'read_page', args: {} } });
  assert.deepEqual(t.json(), { text: 'trang', isError: false });
  assert.equal((await anon({ method: 'POST', url: '/api/assistant/tool/1/result', payload: {} })).statusCode, 401);
  await req({ method: 'POST', url: '/api/assistant/tool/1/result', payload: { hold: true } });
  assert.deepEqual(calls, [
    ['send', 'chào', 't'.repeat(64)],
    ['tool', 'k', 'read_page', {}],
    ['result', '1', { hold: true }],
  ]);
  listener({ kind: 'state', state: { busy: false, messages: [] } });
  assert.deepEqual(sent.at(-1), ['assistant', { kind: 'state', state: { busy: false, messages: [] } }]);
});

test('mức dùng: không có → 503; có → GET summary, POST check (lỗi 429 đi qua), cần token, SSE usage', async () => {
  const { HttpError } = await import('../server/projects.js');
  await makeApp();
  const off = await req({ url: '/api/claude/usage' });
  assert.equal(off.statusCode, 503);
  assert.equal(off.json().error, 'usage_unavailable');
  await app.close();

  let listener;
  let n = 0;
  const args = [];
  const snap = { limits: { status: 'allowed', windows: { five_hour: { utilization: 0.5, resetsAt: 1 } } }, checking: false, tokens: null };
  const fake = {
    summary: () => snap,
    check: async (o) => {
      args.push(o);
      if (++n > 1) throw new HttpError(429, 'usage_cooldown', 'Vừa kiểm tra');
      return { ...snap, checking: false };
    },
    on: (fn) => ((listener = fn), () => {}),
  };
  await makeApp({ usage: fake });
  assert.equal((await anon({ url: '/api/claude/usage' })).statusCode, 401);
  assert.equal((await anon({ method: 'POST', url: '/api/claude/usage/check', payload: {} })).statusCode, 401);
  assert.deepEqual((await req({ url: '/api/claude/usage' })).json(), snap);
  const ok = await req({ method: 'POST', url: '/api/claude/usage/check', payload: {} });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().limits.status, 'allowed');
  const again = await req({ method: 'POST', url: '/api/claude/usage/check', payload: {} });
  assert.equal(again.statusCode, 429);
  assert.equal(again.json().error, 'usage_cooldown');
  await req({ method: 'POST', url: '/api/claude/usage/check', payload: { auto: true } });
  assert.deepEqual(args, [{ auto: false }, { auto: false }, { auto: true }]);
  listener(snap);
  assert.deepEqual(sent.at(-1), ['usage', snap]);
});

test('đặt lại: thiếu resetAll → 503; sai xác nhận → 400; còn bước chạy → 409; đúng → prepare', async () => {
  await makeApp();
  const none = await req({ method: 'POST', url: '/api/reset', payload: { confirm: 'RESET' } });
  assert.equal(none.statusCode, 503);
  assert.equal(none.json().error, 'reset_unavailable');
  await app.close();

  const calls = [];
  await makeApp({ resetAll: { prepare: async () => (calls.push('prepare'), { backup: '/x.bak', restarting: true }), run: async () => calls.push('run') } });
  const bad = await req({ method: 'POST', url: '/api/reset', payload: { confirm: 'reset' } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(calls, []);

  const p = await createProject();
  const run = projects.beginRun(p.id, 'hook', { prompt: 'x' });
  const busy = await req({ method: 'POST', url: '/api/reset', payload: { confirm: 'RESET' } });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error, 'runs_active');
  assert.deepEqual(calls, []);

  projects.finishRun(run.id, { state: 'stopped' });
  const ok = await req({ method: 'POST', url: '/api/reset', payload: { confirm: 'RESET' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { ok: true, backup: '/x.bak', restarting: true });
  assert.deepEqual(calls, ['prepare']); // run chạy sau 'finish' của socket thật (inject không phát)
});

test('POST /api/projects với reference: ghi .studio/reference.md; id sai → 400 invalid_reference; kênh chưa kết nối → vẫn tạo + cảnh báo', async () => {
  const youtube = { videos: async (id) => { if (id !== 'tiktok') { const e = new Error('Kênh chưa kết nối.'); e.status = 409; e.code = 'not_connected'; throw e; } return { videos: [{ id: 'v1', title: 'Video mẫu', description: 'mô tả', publishedAt: '2026-01-01T00:00:00Z', duration: 300, views: 99, avgViewDuration: 100 }] }; }, on: () => () => {} };
  await makeApp({ youtube });
  const ok = await createProject('Có tham khảo', { channelId: 'tiktok', reference: { channelId: 'tiktok', videoId: 'v1' } });
  const md = fs.readFileSync(path.join(ok.dir, '.studio', 'reference.md'), 'utf8');
  assert.match(md, /Video mẫu/);
  const bad = await req({ method: 'POST', url: '/api/projects', payload: { presetId: 'e2e-short', title: 'Sai id', reference: { channelId: 'tiktok', videoId: 'nope' } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_reference');
  const bad2 = await req({ method: 'POST', url: '/api/projects', payload: { presetId: 'e2e-short', title: 'Sai dạng', reference: 'x' } });
  assert.equal(bad2.json().error, 'invalid_reference');
  const warn = await req({ method: 'POST', url: '/api/projects', payload: { presetId: 'e2e-short', title: 'Chưa kết nối', reference: { channelId: 'khac', videoId: 'v1' } } });
  assert.equal(warn.statusCode, 201, warn.body);
  assert.ok(warn.json().referenceWarning);
});

test('POST /api/pick-dir: trả path / cancelled; unsupported → 501; lỗi → 500', async () => {
  const mk = (fn) => makeApp({ pickDir: fn });
  await mk(async () => ({ path: '/x/y' }));
  assert.deepEqual((await req({ method: 'POST', url: '/api/pick-dir', payload: {} })).json(), { path: '/x/y' });
  await app.close();
  await mk(async () => { throw Object.assign(new Error('u'), { code: 'unsupported' }); });
  assert.equal((await req({ method: 'POST', url: '/api/pick-dir', payload: {} })).statusCode, 501);
  await app.close();
  await mk(async () => { throw Object.assign(new Error('f'), { code: 'pick_failed' }); });
  assert.equal((await req({ method: 'POST', url: '/api/pick-dir', payload: {} })).statusCode, 500);
});

test('POST /api/projects/:id/permissions: thêm tool vào allow của dự án, từ chối Bash/deny/ask', async () => {
  await makeApp();
  const p = await createProject('Cấp quyền');
  const url = `/api/projects/${p.id}/permissions`;
  const post = (payload) => req({ method: 'POST', url, payload });
  const ok = await post({ tool: 'WebSearch' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().changed, true);
  assert.equal(store.getProject(p.id).pipeline.includes('"WebSearch"'), true);
  assert.equal(projects.presetOf(p.id).permissions.allow.includes('WebSearch'), true);
  assert.equal((await post({ tool: 'WebSearch' })).json().changed, false);
  const all = await post({ tool: 'Bash(ls *)', scope: 'pipeline' });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().savedUpdated, true);
  const { readGlobalAllow } = await import('../server/pipeline.js');
  assert.deepEqual(readGlobalAllow(home), ['Bash(ls *)']);
  assert.equal((await post({ tool: 'Bash' })).statusCode, 400);
  assert.equal((await post({ tool: 'Bash(rm *)' })).statusCode, 400);
  assert.equal((await post({ tool: 'Bash(curl *)' })).statusCode, 400);
  assert.equal((await post({ tool: 'Bash(mkdir -p *)' })).statusCode, 400);
  const bash = await post({ tool: 'Bash(mkdir *)' });
  assert.equal(bash.statusCode, 200, bash.body);
  assert.equal(projects.presetOf(p.id).permissions.allow.includes('Bash(mkdir *)'), true);
  assert.equal((await post({})).statusCode, 400);
  assert.equal((await post({ tool: 'WebFetch', scope: 'x' })).statusCode, 400);
  assert.equal((await req({ method: 'POST', url: '/api/projects/khong-co/permissions', payload: { tool: 'WebFetch' } })).statusCode, 404);
});
