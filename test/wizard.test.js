import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../server/presets.js';
import { createGcloud, downloadVerified, installTools } from '../server/youtube/gcloud.js';
import { APIS, cloudError, consoleLinks, createGoogleWizard, newProjectId } from '../server/youtube/wizard.js';
import { GoogleError } from '../server/youtube/http.js';
import { fakeClientSecretFor, startFakeGoogle } from './fixtures/fake-google.mjs';

const FAKE_GCLOUD = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-gcloud.mjs');
const PROFILES = { profiles: [{ dir: 'Profile 1', name: 'Công việc' }] };

let tmp;
let google;
let saved;
let opened;
let wiz;

// Chờ tới khi cond() đúng (tối đa 5s).
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const idle = () => until(() => !wiz.status().busy);

function make(extra = {}) {
  wiz = createGoogleWizard({
    home: path.join(tmp, 'home'),
    setClient: async (text) => {
      saved = text;
    },
    isConfigured: async () => false,
    googleBase: google.base,
    openUrl: (url, dir) => opened.push({ url, dir }),
    profiles: () => PROFILES,
    gcloudBin: FAKE_GCLOUD,
    browserScript: '/fake/browser.sh',
    env: { ...process.env, FAKE_GCLOUD_LOG: path.join(tmp, 'gcloud.jsonl'), VS_TOKEN: 'secret' },
    downloadsDir: path.join(tmp, 'Downloads'),
    trashDir: path.join(tmp, 'Trash'),
    platform: 'darwin',
    sleep: () => new Promise((r) => setImmediate(r)),
    pollMs: 1,
    watchMs: 10,
    ...extra,
  });
  return wiz;
}
const gcloudLog = () =>
  fs.existsSync(path.join(tmp, 'gcloud.jsonl'))
    ? fs.readFileSync(path.join(tmp, 'gcloud.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-wiz-'));
  fs.mkdirSync(path.join(tmp, 'home'));
  fs.mkdirSync(path.join(tmp, 'Downloads'));
  fs.mkdirSync(path.join(tmp, 'Trash'));
  google = await startFakeGoogle();
  saved = null;
  opened = [];
  wiz = null;
});

afterEach(async () => {
  wiz?.dispose();
  await google.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ---- Công cụ

test('newProjectId / consoleLinks / cloudError', () => {
  assert.match(newProjectId(), /^video-studio-[a-z0-9]{6}$/);
  const l = consoleLinks('https://c', 'video-studio-abc123');
  assert.equal(l.consent, 'https://c/auth/branding?project=video-studio-abc123');
  assert.equal(l.client, 'https://c/auth/clients/create?project=video-studio-abc123');
  assert.equal(cloudError(new GoogleError(400, 'FAILED_PRECONDITION', 'Callers must accept Terms of Service')).code, 'gc_tos');
  assert.equal(cloudError(new GoogleError(429, null, null)).code, 'gc_project_quota');
  assert.equal(cloudError(new GoogleError(401, null, null)).code, 'gc_reauth');
  assert.equal(cloudError(new GoogleError(0, 'network', null)).code, 'gc_network');
  assert.equal(cloudError(new GoogleError(500, null, null)).code, 'gc_error');
});

// Gói .tar.gz nhỏ giả bản gcloud; fetch giả trả đúng nội dung.
function tinyTool() {
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'google-cloud-sdk', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'google-cloud-sdk', 'bin', 'gcloud'), '#!/bin/sh\n');
  const tgz = path.join(tmp, 'tool.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', src, 'google-cloud-sdk']);
  const buf = fs.readFileSync(tgz);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  let fetches = 0;
  const fetch = async () => {
    fetches += 1;
    return new Response(buf);
  };
  return { buf, sha256, fetch, count: () => fetches };
}

test('installTools: tải, kiểm sha256, giải nén, lần sau bỏ qua', async () => {
  const t = tinyTool();
  const dir = path.join(tmp, 'tools');
  const manifest = { 'test-x': { gcloud: { url: 'https://x/g.tgz', size: t.buf.length, sha256: t.sha256 } } };
  const prog = [];
  const p = await installTools({ dir, platform: 'test', arch: 'x', manifest, fetch: t.fetch, onProgress: (x) => prog.push(x) });
  assert.equal(p.gcloud, path.join(dir, 'google-cloud-sdk', 'bin', 'gcloud'));
  assert.equal(p.python, null);
  assert.ok(fs.existsSync(p.gcloud));
  assert.ok(!fs.existsSync(path.join(dir, 'gcloud.tar.gz')));
  assert.equal(prog.at(-1).bytes, t.buf.length);
  await installTools({ dir, platform: 'test', arch: 'x', manifest, fetch: t.fetch });
  assert.equal(t.count(), 1);
  await assert.rejects(installTools({ dir, platform: 'plan9', arch: 'x', manifest, fetch: t.fetch }), /Chưa hỗ trợ/);
});

test('downloadVerified: sai sha256 / sai kích thước → xóa file', async () => {
  const t = tinyTool();
  const dest = path.join(tmp, 'x.tgz');
  await assert.rejects(downloadVerified('u', dest, { size: t.buf.length, sha256: '0'.repeat(64), fetch: t.fetch }), /sha256/);
  assert.ok(!fs.existsSync(dest));
  await assert.rejects(downloadVerified('u', dest, { size: t.buf.length + 1, sha256: t.sha256, fetch: t.fetch }), /dung lượng/);
  await assert.rejects(downloadVerified('u', dest, { size: 3, sha256: t.sha256, fetch: t.fetch }), /lớn hơn/);
  assert.ok(!fs.existsSync(dest));
  await assert.rejects(downloadVerified('u', dest, { sha256: t.sha256, fetch: async () => new Response('x', { status: 404 }) }), /HTTP 404/);
});

test('createGcloud: env riêng, BROWSER chỉ khi có hồ sơ, revoke xóa cấu hình', async () => {
  const configDir = path.join(tmp, 'gc');
  const log = path.join(tmp, 'g.jsonl');
  const g = createGcloud({ bin: FAKE_GCLOUD, python: '/py/python3', configDir, browserScript: '/b.sh', env: { ...process.env, FAKE_GCLOUD_LOG: log, VS_TOKEN: 's', BROWSER: 'x' } });
  assert.equal(await g.token(), null);
  assert.equal(await g.login({ profileDir: 'Profile 1' }), true);
  assert.equal(await g.token(), 'fake-cloud-token');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[1], { args: ['auth', 'login', '--brief'], browser: '/b.sh', profile: 'Profile 1', python: '/py/python3' });
  assert.equal(lines[0].browser, null); // BROWSER của người dùng bị bỏ
  await g.revoke();
  assert.ok(!fs.existsSync(configDir));
  const bad = createGcloud({ bin: FAKE_GCLOUD, configDir, env: { ...process.env, FAKE_GCLOUD_LOGIN: 'fail' } });
  assert.equal(await bad.login(), false);
  const missing = createGcloud({ bin: path.join(tmp, 'nope'), configDir });
  assert.equal(await missing.token(), null);
});

// ---- Luồng đầy đủ

test('luồng đủ: đăng nhập → tạo dự án → bật API → dọn gcloud → mở trang → nhặt client trong Downloads → bỏ vào Thùng rác', async () => {
  make();
  fs.mkdirSync(path.join(tmp, 'home', 'tools'));
  assert.equal(wiz.status().step, 'login');
  const s0 = wiz.start({ profileDir: 'Profile 1' });
  assert.equal(s0.busy, 'login');
  await idle();
  const s = wiz.status();
  assert.equal(s.error, null);
  assert.equal(s.step, 'consent');
  assert.match(s.projectId, /^video-studio-/);
  assert.deepEqual(s.profile, { dir: 'Profile 1', name: 'Công việc' });
  assert.deepEqual([...google.state.cloud.enabled.get(s.projectId)], APIS);
  assert.equal(google.state.cloud.projects.get(s.projectId).displayName, 'Video Studio');
  // Dọn: đã thu hồi gcloud, xóa công cụ + cấu hình.
  assert.ok(gcloudLog().some((l) => l.args[1] === 'revoke'));
  assert.ok(!fs.existsSync(path.join(tmp, 'home', 'tools')));
  assert.ok(!fs.existsSync(path.join(tmp, 'home', 'gcloud')));
  // Đăng nhập mở trong hồ sơ Chrome; env VS_* không lọt vào gcloud.
  assert.equal(gcloudLog().find((l) => l.args[1] === 'login').profile, 'Profile 1');
  assert.deepEqual(opened, [{ url: `${google.base}/console/auth/branding?project=${s.projectId}`, dir: 'Profile 1' }]);
  const file = JSON.parse(fs.readFileSync(path.join(tmp, 'home', 'google-setup.json'), 'utf8'));
  assert.equal(file.projectId, s.projectId);
  assert.ok(!JSON.stringify(file).includes('fake-cloud-token'));

  const n = await wiz.next();
  assert.equal(n.step, 'client');
  assert.deepEqual(n.open, { url: `${google.base}/console/auth/clients/create?project=${s.projectId}`, opened: true });

  const dl = (name, text) => fs.writeFileSync(path.join(tmp, 'Downloads', name), text);
  dl('client_secret_other.json', fakeClientSecretFor('other-project'));
  dl('notes.json', fakeClientSecretFor(s.projectId));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(wiz.status().step, 'client');
  dl('client_secret_web.json', fakeClientSecretFor(s.projectId, { web: true }));
  await until(() => wiz.status().error?.code === 'gc_client_type');
  fs.rmSync(path.join(tmp, 'Downloads', 'client_secret_web.json'));
  dl('client_secret_123.apps.googleusercontent.com.json', fakeClientSecretFor(s.projectId));
  await until(() => wiz.status().step === 'done');
  assert.equal(saved, fakeClientSecretFor(s.projectId));
  assert.equal(wiz.status().error, null);
  assert.deepEqual(wiz.status().found, { name: 'client_secret_123.apps.googleusercontent.com.json' });

  const h = wiz.handleDownload({ keep: false });
  assert.equal(h.trashed, true);
  assert.equal(h.found, null);
  assert.ok(fs.existsSync(path.join(tmp, 'Trash', 'client_secret_123.apps.googleusercontent.com.json')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Downloads', 'client_secret_123.apps.googleusercontent.com.json')));
  assert.throws(() => wiz.handleDownload({}), (e) => e.code === 'gc_no_file');

  // Xóa client → quay về bước tạo client.
  wiz.clientCleared();
  assert.equal(wiz.status().step, 'client');
  wiz.manualDone();
  assert.equal(wiz.status().step, 'done');
});

test('trình duyệt mặc định: không mở hộ (UI tự mở), giữ file Tải về khi keep', async () => {
  make();
  wiz.start({});
  await idle();
  assert.equal(wiz.status().step, 'consent');
  assert.deepEqual(opened, []);
  assert.equal(gcloudLog().find((l) => l.args[1] === 'login').browser, null);
  const n = await wiz.next();
  assert.equal(n.open.opened, false);
  const f = path.join(tmp, 'Downloads', 'client_secret_x.json');
  fs.writeFileSync(f, fakeClientSecretFor(n.projectId));
  await until(() => wiz.status().step === 'done');
  assert.equal(wiz.handleDownload({ keep: true }).trashed, false);
  assert.ok(fs.existsSync(f));
});

test('chưa đồng ý Điều khoản → gc_tos; đồng ý rồi Thử lại (không đăng nhập lại)', async () => {
  google.state.cloud.tosRequired = true;
  make();
  wiz.start({});
  await idle();
  assert.equal(wiz.status().error.code, 'gc_tos');
  assert.equal(wiz.status().step, 'project');
  google.state.cloud.tosRequired = false;
  wiz.start({});
  await idle();
  assert.equal(wiz.status().step, 'consent');
  assert.equal(gcloudLog().filter((l) => l.args[1] === 'login').length, 1);
});

test('hết lượt tạo dự án → danh sách dự án có sẵn → useProject', async () => {
  google.state.cloud.projectQuota = true;
  google.state.cloud.projects.set('my-old', { projectId: 'my-old', displayName: 'Cũ', state: 'ACTIVE' });
  make();
  wiz.start({});
  await idle();
  const s = wiz.status();
  assert.equal(s.error.code, 'gc_project_quota');
  assert.deepEqual(s.projects, [{ projectId: 'my-old', name: 'Cũ' }]);
  assert.throws(() => wiz.useProject('khac'), (e) => e.code === 'invalid_body');
  wiz.useProject('my-old');
  await idle();
  assert.equal(wiz.status().step, 'consent');
  assert.equal(wiz.status().projectId, 'my-old');
  assert.equal(wiz.status().projects, null);
});

test('dự án mới chưa sẵn sàng → bật API thử lại; Thử lại dùng lại dự án đã tạo', async () => {
  google.state.cloud.enableFailTimes = 2;
  make();
  wiz.start({});
  await idle();
  assert.equal(wiz.status().step, 'consent');
  assert.equal(google.state.cloud.projects.size, 1);

  // Lỗi bật API kéo dài → lỗi; Thử lại không tạo thêm dự án.
  await wiz.reset();
  google.state.cloud.projects.clear();
  google.state.cloud.enableFailTimes = 99;
  wiz.start({});
  await idle();
  assert.equal(wiz.status().error.code, 'gc_error');
  const pid = wiz.status().projectId;
  google.state.cloud.enableFailTimes = 0;
  wiz.start({});
  await idle();
  assert.equal(wiz.status().step, 'consent');
  assert.equal(wiz.status().projectId, pid);
  assert.equal(google.state.cloud.projects.size, 1);
});

test('đăng nhập thất bại → gc_login; hồ sơ lạ → invalid_profile; sai bước → gc_step', async () => {
  make({ env: { ...process.env, FAKE_GCLOUD_LOGIN: 'fail' } });
  assert.throws(() => wiz.start({ profileDir: 'Profile 9' }), (e) => e.code === 'invalid_profile');
  wiz.start({});
  assert.throws(() => wiz.start({}), (e) => e.code === 'gc_busy');
  await idle();
  assert.equal(wiz.status().error.code, 'gc_login');
  assert.equal(wiz.status().step, 'login');
  await assert.rejects(wiz.next(), (e) => e.code === 'gc_step');
  assert.throws(() => wiz.back(), (e) => e.code === 'gc_step');
});

test('Hủy khi đang chờ đăng nhập; Làm lại từ đầu xóa trạng thái', async () => {
  make({ env: { ...process.env, FAKE_GCLOUD_LOG: path.join(tmp, 'gcloud.jsonl'), FAKE_GCLOUD_LOGIN_MS: '5000' } });
  wiz.start({});
  await until(() => wiz.status().busy === 'login' && gcloudLog().some((l) => l.args[1] === 'login'));
  const t = Date.now();
  const s = await wiz.cancel();
  assert.ok(Date.now() - t < 4000);
  assert.equal(s.busy, null);
  assert.equal(s.error, null);
  await wiz.reset();
  assert.equal(wiz.status().step, 'login');
  assert.ok(!fs.existsSync(path.join(tmp, 'home', 'google-setup.json')));
});

test('trạng thái lưu lại: mở lại app ở bước client → tự theo dõi Downloads; back về consent', async () => {
  make();
  wiz.start({});
  await idle();
  const { projectId } = await wiz.next();
  wiz.dispose();
  make();
  assert.equal(wiz.status().step, 'client');
  assert.deepEqual(wiz.back().step, 'consent');
  await wiz.next();
  fs.writeFileSync(path.join(tmp, 'Downloads', 'client_secret_a.json'), fakeClientSecretFor(projectId));
  await until(() => wiz.status().step === 'done');
});

test('không đọc được Downloads → watchError; đã cấu hình bằng cách khác → done', async () => {
  let configured = false;
  make({ downloadsDir: path.join(tmp, 'missing'), isConfigured: async () => configured });
  wiz.start({});
  await idle();
  await wiz.next();
  await until(() => wiz.status().watchError);
  configured = true;
  await until(() => wiz.status().step === 'done');
});
