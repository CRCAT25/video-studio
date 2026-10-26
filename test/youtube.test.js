import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { openStore } from '../server/db.js';
import { createSecretStore, fileStore, keychainStore } from '../server/keychain.js';
import { REPO_ROOT } from '../server/presets.js';
import { createProjects } from '../server/projects.js';
import { addDays, analyticsRows, parseDuration, quotaDay } from '../server/youtube/api.js';
import { GoogleError, googleEndpoints, toHttpError } from '../server/youtube/http.js';
import { CALLBACK_PATH, createYouTube, slugify, uniqueId } from '../server/youtube/index.js';
import { READ_SCOPES, UPLOAD_SCOPES, clientHint, parseClientSecret, tokenName } from '../server/youtube/oauth.js';
import { FAKE_CLIENT_SECRET, startFakeGoogle } from './fixtures/fake-google.mjs';

const FAKE_SECURITY = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-security.mjs');
const TOKEN = 'test-token-abcdefghijklmnop';
const HOST = '127.0.0.1:4318';
// Kênh khác của app (từ channels.yaml) — mã kênh YouTube mới không được trùng.
const CHANNELS = [{ id: 'tiktok', name: 'TikTok', platform: 'tiktok', videos_dir: null }];
const OTHER = { id: 'UCfake000000000000000002', title: 'Kênh Phụ', customUrl: '@kenhphu', publishedAt: '2024-02-01T00:00:00Z', subscribers: '10', views: '20', videos: '1', hidden: false };
const REDIRECT = `http://127.0.0.1:4318${CALLBACK_PATH}`;

let tmp;
let store;
let secrets;
let google;
let yt;
let opened;
let changes;
let clock;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-yt-'));
  store = openStore(path.join(tmp, 'studio.db'));
  secrets = fileStore(path.join(tmp, 'secrets.json'));
  google = await startFakeGoogle();
  opened = [];
  changes = 0;
  clock = Date.parse('2026-10-25T05:00:00Z');
  yt = createYouTube({
    store,
    secrets,
    channels: () => CHANNELS,
    googleBase: google.base,
    openUrl: (url, dir) => opened.push({ url, dir }),
    profiles: () => ({ profiles: [{ dir: 'Profile 1', name: 'Công việc', color: null }] }),
    onChange: () => changes++,
    now: () => clock,
  });
});

afterEach(async () => {
  await google.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Đi hết luồng đăng nhập: connect (không id = thêm kênh mới) → "Google" duyệt → callback. Trả kết quả callback.
async function connectChannel(id, opts = {}) {
  const { authUrl } = await yt.connect({ ...(id ? { channelId: id } : {}), redirectUri: REDIRECT, ...opts });
  const r = await fetch(authUrl, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  return yt.callback({ state: loc.searchParams.get('state'), code: loc.searchParams.get('code'), error: loc.searchParams.get('error') });
}

// ---------- kho bí mật

test('fileStore: get/set/remove, file quyền 600, giá trị rỗng/không có → null', async () => {
  const f = path.join(tmp, 'sub', 's.json');
  const s = fileStore(f);
  assert.equal(s.kind, 'file');
  assert.equal(await s.get('a'), null);
  await s.set('yt:goc', '{"refresh_token":"x"}');
  assert.equal(await s.get('yt:goc'), '{"refresh_token":"x"}');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  await s.remove('yt:goc');
  await s.remove('khong-co');
  assert.equal(await s.get('yt:goc'), null);
  await assert.rejects(() => s.set('tên sai/../', 'x'), /không hợp lệ/);
});

test('keychainStore (security giả): bí mật đi qua stdin dạng hex, không có trên argv; 44 → null', async () => {
  const db = path.join(tmp, 'kc.json');
  const log = path.join(tmp, 'kc.log');
  process.env.FAKE_SECURITY_DB = db;
  process.env.FAKE_SECURITY_LOG = log;
  try {
    const s = keychainStore({ bin: FAKE_SECURITY, service: 'vs-test' });
    assert.equal(s.kind, 'keychain');
    assert.equal(await s.get('google-client'), null);
    const secret = '{"clientSecret":"GOCSPX-bí-mật \\"x\\""}';
    await s.set('google-client', secret);
    assert.equal(await s.get('google-client'), secret);
    await s.set('google-client', 'v2');
    assert.equal(await s.get('google-client'), 'v2');
    await s.remove('google-client');
    await s.remove('google-client');
    assert.equal(await s.get('google-client'), null);
    const argvs = fs.readFileSync(log, 'utf8');
    assert.ok(!argvs.includes('GOCSPX'), 'bí mật không được nằm trên argv');
    assert.ok(argvs.includes('["-i"]'));
    process.env.FAKE_SECURITY_FAIL = '1';
    await assert.rejects(() => s.get('x'), /mã 1/);
    await assert.rejects(() => s.set('x', 'y'), /mã 1/);
  } finally {
    delete process.env.FAKE_SECURITY_DB;
    delete process.env.FAKE_SECURITY_LOG;
    delete process.env.FAKE_SECURITY_FAIL;
  }
});

test('createSecretStore: darwin → keychain, khác → file trong home', () => {
  assert.equal(createSecretStore({ platform: 'darwin', home: tmp }).kind, 'keychain');
  assert.equal(createSecretStore({ platform: 'linux', home: tmp }).kind, 'file');
});

// ---------- hàm thuần

test('parseClientSecret / clientHint / tokenName', () => {
  assert.deepEqual(parseClientSecret(FAKE_CLIENT_SECRET), { clientId: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', clientSecret: 'GOCSPX-fake-secret' });
  assert.throws(() => parseClientSecret('{không phải json'), (e) => e.code === 'invalid_client_secret');
  assert.throws(() => parseClientSecret('{"web":{"client_id":"a.apps.googleusercontent.com","client_secret":"b"}}'), /Ứng dụng máy tính/);
  assert.throws(() => parseClientSecret('{"installed":{"client_id":"abc","client_secret":"b"}}'), (e) => e.status === 400);
  assert.throws(() => parseClientSecret('{"installed":{"client_id":"a.apps.googleusercontent.com"}}'), (e) => e.status === 400);
  assert.equal(clientHint('1234567890-abcdefghijklmnop.apps.googleusercontent.com'), '…efghijklmnop');
  assert.equal(clientHint('short.apps.googleusercontent.com'), 'short');
  assert.equal(tokenName('goc'), 'yt:goc');
});

test('quotaDay theo giờ Thái Bình Dương; addDays; parseDuration; analyticsRows', () => {
  assert.equal(quotaDay(new Date('2026-10-25T05:00:00Z')), '2026-10-24');
  assert.equal(quotaDay(new Date('2026-10-25T08:00:00Z')), '2026-10-25');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT58S'), 58);
  assert.equal(parseDuration('P1D'), 86400);
  assert.equal(parseDuration('xx'), null);
  assert.deepEqual(analyticsRows({ columnHeaders: [{ name: 'day' }, { name: 'views' }], rows: [['2026-10-01', 5]] }), [{ day: '2026-10-01', views: 5 }]);
  assert.deepEqual(analyticsRows(null), []);
});

test('toHttpError: map lỗi Google → mã app', () => {
  const m = (e) => toHttpError(e);
  assert.equal(m(new GoogleError(0, 'network')).code, 'yt_network');
  assert.equal(m(new GoogleError(400, 'invalid_grant')).code, 'yt_reauth');
  assert.equal(m(new GoogleError(401, 'authError')).status, 401);
  assert.equal(m(new GoogleError(403, 'quotaExceeded')).code, 'yt_quota');
  assert.equal(m(new GoogleError(403, 'accessNotConfigured')).code, 'yt_api_disabled');
  assert.equal(m(new GoogleError(401, 'invalid_client')).code, 'yt_reauth');
  assert.equal(m(new GoogleError(400, 'invalid_client')).code, 'yt_bad_client');
  assert.equal(m(new GoogleError(403, 'forbidden')).code, 'yt_forbidden');
  assert.equal(m(new GoogleError(500, null)).code, 'yt_error');
  const other = new Error('x');
  assert.equal(m(other), other);
  assert.equal(googleEndpoints().token, 'https://oauth2.googleapis.com/token');
  assert.equal(googleEndpoints('http://h:1/').data, 'http://h:1/youtube/v3');
});

// ---------- dịch vụ

test('slugify/uniqueId: bỏ dấu, đ→d, gạch nối; trùng → -2, -3', () => {
  assert.equal(slugify('Bếp Nhà Mình'), 'bep-nha-minh');
  assert.equal(slugify('Đêm Kể Chuyện!'), 'dem-ke-chuyen');
  assert.equal(slugify('Đường đi'), 'duong-di');
  assert.equal(slugify('★★★'), 'kenh');
  assert.ok(slugify('a'.repeat(80)).length <= 40);
  assert.equal(uniqueId('a', new Set()), 'a');
  assert.equal(uniqueId('a', new Set(['a', 'a-2'])), 'a-3');
});

test('status ban đầu: chưa thiết lập, chưa có kênh nào; không lộ secret', async () => {
  const s = await yt.status();
  assert.equal(s.configured, false);
  assert.equal(s.storage, 'file');
  assert.deepEqual(s.channels, []);
  assert.equal(s.adding, false);
  assert.equal(s.addError, null);
  assert.deepEqual(s.quota, { day: '2026-10-24', used: 0, limit: 10000 });
  await assert.rejects(() => yt.connect({ redirectUri: REDIRECT }), (e) => e.code === 'yt_not_configured');
  const after = await yt.setup(FAKE_CLIENT_SECRET);
  assert.equal(after.configured, true);
  assert.equal(after.client, '…efghijklmnop');
  assert.ok(!JSON.stringify(after).includes('GOCSPX'));
});

test('thêm kênh: URL Google đủ PKCE/offline, mở đúng hồ sơ Chrome, mã kênh theo tên, lưu refresh token, chỉ quyền đọc', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  const { authUrl, opened: wasOpened } = await yt.connect({ redirectUri: REDIRECT, profileDir: 'Profile 1' });
  assert.equal(wasOpened, true);
  assert.deepEqual(opened, [{ url: authUrl, dir: 'Profile 1' }]);
  const q = new URL(authUrl).searchParams;
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('redirect_uri'), REDIRECT);
  assert.deepEqual(q.get('scope').split(' '), READ_SCOPES);
  assert.ok(!/email|profile|openid/.test(q.get('scope')));
  assert.equal((await yt.status()).adding, true);

  const r = await fetch(authUrl, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  const done = await yt.callback({ state: loc.searchParams.get('state'), code: loc.searchParams.get('code') });
  assert.deepEqual(done, { ok: true, channelId: 'kenh-gia', title: 'Kênh Giả', added: true });
  const s = await yt.status();
  assert.equal(s.adding, false);
  assert.equal(s.channels.length, 1);
  const ch = s.channels[0];
  assert.equal(ch.id, 'kenh-gia');
  assert.equal(ch.name, 'Kênh Giả');
  assert.equal(ch.pending, false);
  assert.equal(ch.ytChannelId, 'UCfake000000000000000001');
  assert.equal(ch.canUpload, false);
  assert.equal(ch.status, 'ok');
  const saved = JSON.parse(await secrets.get('yt:kenh-gia'));
  assert.match(saved.refresh_token, /^rt-/);
  assert.ok(changes > 0);
  // state dùng một lần
  await assert.rejects(() => yt.callback({ state: loc.searchParams.get('state'), code: 'x' }), (e) => e.code === 'yt_bad_state');
});

test('thêm kênh thứ hai: mã riêng; tên trùng mã có sẵn (cả kênh khác của app) → hậu tố -2', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  google.state.channel = OTHER;
  assert.equal((await connectChannel()).channelId, 'kenh-phu');
  google.state.channel = { ...OTHER, id: 'UCfake000000000000000003' };
  assert.equal((await connectChannel()).channelId, 'kenh-phu-2');
  google.state.channel = { ...OTHER, id: 'UCfake000000000000000004', title: 'TikTok' };
  assert.equal((await connectChannel()).channelId, 'tiktok-2');
  assert.deepEqual((await yt.status()).channels.map((c) => c.id), ['kenh-gia', 'kenh-phu', 'kenh-phu-2', 'tiktok-2']);
});

test('thêm kênh: hồ sơ lạ → 400; kênh không có → 404; hủy chờ', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await assert.rejects(() => yt.connect({ redirectUri: REDIRECT, profileDir: 'Lạ' }), (e) => e.code === 'invalid_profile');
  await assert.rejects(() => yt.connect({ channelId: 'tiktok', redirectUri: REDIRECT }), (e) => e.status === 404);
  const { opened: o } = await yt.connect({ redirectUri: REDIRECT });
  assert.equal(o, false);
  assert.deepEqual(yt.cancelConnect(), { ok: true });
  assert.deepEqual(yt.cancelConnect(), { ok: false });
  assert.equal((await yt.status()).adding, false);
});

test('callback lỗi: từ chối quyền, không có refresh token, không có kênh, kênh đã thêm → addError, không lưu', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  google.state.denyConsent = true;
  await assert.rejects(() => connectChannel(), (e) => e.code === 'yt_denied');
  let s = await yt.status();
  assert.deepEqual(s.channels, []);
  assert.equal(s.addError.code, 'yt_denied');
  google.state.denyConsent = false;

  google.state.noRefresh = true;
  await assert.rejects(() => connectChannel(), (e) => e.code === 'yt_no_refresh');
  assert.equal((await yt.status()).addError.code, 'yt_no_refresh');
  google.state.noRefresh = false;

  google.state.noChannel = true;
  await assert.rejects(() => connectChannel(), (e) => e.code === 'yt_no_channel');
  assert.equal(await secrets.get('yt:kenh-gia'), null);
  google.state.noChannel = false;

  await connectChannel();
  assert.equal((await yt.status()).addError, null);
  await assert.rejects(() => connectChannel(), (e) => e.code === 'yt_dup' && e.status === 409 && /đã được thêm/.test(e.message));
  s = await yt.status();
  assert.equal(s.channels.length, 1);
  assert.equal(s.addError.code, 'yt_dup');
  assert.equal(await secrets.get('yt:kenh-gia-2'), null);
  // kênh đầu vẫn chạy (không bị thu hồi)
  assert.equal(google.state.revoked.size, 0);
});

test('stats: 28 ngày kết thúc hôm qua, tổng đúng, cache 6 giờ, refresh gọi lại, đếm hạn mức', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  const before = store.ytQuota('2026-10-24');
  const s = await yt.stats('kenh-gia');
  assert.equal(s.cached, false);
  assert.deepEqual(s.period, { start: '2026-09-26', end: '2026-10-23', days: 28 });
  assert.equal(s.days.length, 28);
  assert.equal(s.days[0].date, '2026-09-26');
  assert.equal(s.totals.views, s.days.reduce((a, d) => a + d.views, 0));
  assert.equal(s.totals.avgViewDuration, 60);
  assert.equal(s.channel.subscribers, 1234);
  assert.equal(s.channel.uploads, undefined);
  assert.equal(store.ytQuota('2026-10-24') - before, 1);

  const n = google.calls.length;
  const again = await yt.stats('kenh-gia');
  assert.equal(again.cached, true);
  assert.equal(google.calls.length, n);
  clock += 6 * 3600_000 + 1;
  assert.equal((await yt.stats('kenh-gia')).cached, false);
  const n2 = google.calls.length;
  assert.equal((await yt.stats('kenh-gia', { refresh: true })).cached, false);
  assert.ok(google.calls.length > n2);
  await assert.rejects(() => yt.stats('khong-co'), (e) => e.status === 404);
});

test('stats: hai lượt cùng lúc chỉ gọi Google một lần', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  const n = google.calls.length;
  const [a, b] = await Promise.all([yt.stats('kenh-gia', { refresh: true }), yt.stats('kenh-gia', { refresh: true })]);
  assert.deepEqual(a, b);
  assert.equal(google.calls.filter((c, i) => i >= n && c.path === '/v2/reports').length, 1);
});

test('videos: mới nhất trước, gộp số liệu Data + Analytics, thời lượng giây', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  const v = await yt.videos('kenh-gia');
  assert.equal(v.truncated, false);
  assert.deepEqual(v.videos.map((x) => x.id), ['vid3', 'vid2', 'vid1']);
  const one = v.videos.find((x) => x.id === 'vid1');
  assert.equal(one.duration, 690);
  assert.equal(one.views, 1000);
  assert.equal(one.likes, 50);
  assert.equal(one.avgViewDuration, 120);
  assert.equal(one.subsGained, 3);
  assert.equal(v.videos[0].privacy, 'private');
  assert.equal(v.videos[0].avgViewDuration, null);
  const rep = google.calls.find((c) => c.path === '/v2/reports' && c.query.dimensions === 'video');
  assert.equal(rep.query.startDate, '2024-01-15');
  assert.equal(rep.query.ids, 'channel==MINE');
});

test('videos: nhiều hơn 200 → cắt + truncated', async () => {
  google.state.videos = Array.from({ length: 230 }, (_, i) => ({ id: `v${i}`, title: `V ${i}`, publishedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, duration: 'PT1M', privacy: 'public', views: '1', likes: '0', comments: '0' }));
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  const v = await yt.videos('kenh-gia');
  assert.equal(v.videos.length, 200);
  assert.equal(v.truncated, true);
});

test('access token hết hạn → làm mới; refresh bị thu hồi → reauth; kết nối lại sai kênh → 409, đúng kênh → ok', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  clock += 2 * 3600_000;
  await yt.stats('kenh-gia', { refresh: true });
  assert.ok(google.calls.some((c) => c.path === '/token' && c.body.includes('grant_type=refresh_token')));

  google.state.access.clear();
  google.state.revoked.add(JSON.parse(await secrets.get('yt:kenh-gia')).refresh_token);
  await assert.rejects(() => yt.stats('kenh-gia', { refresh: true }), (e) => e.code === 'yt_reauth' && e.status === 401);
  assert.equal((await yt.status()).channels[0].status, 'reauth');

  const real = google.state.channel;
  google.state.channel = OTHER;
  await assert.rejects(() => connectChannel('kenh-gia'), (e) => e.code === 'yt_wrong_channel' && e.status === 409);
  let ch = (await yt.status()).channels[0];
  assert.equal(ch.status, 'reauth');
  assert.equal(ch.lastError.code, 'yt_wrong_channel');
  google.state.channel = real;

  assert.deepEqual(await connectChannel('kenh-gia'), { ok: true, channelId: 'kenh-gia', title: 'Kênh Giả', added: false });
  ch = (await yt.status()).channels[0];
  assert.equal(ch.status, 'ok');
  assert.equal(ch.lastError, null);
  assert.equal((await yt.status()).channels.length, 1);
  assert.equal((await yt.stats('kenh-gia', { refresh: true })).cached, false);
});

test('lỗi API: hết hạn mức → 429 yt_quota; API chưa bật → yt_api_disabled; lỗi không cache', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  google.state.fail.reports = { status: 403, reason: 'quotaExceeded' };
  await assert.rejects(() => yt.stats('kenh-gia'), (e) => e.code === 'yt_quota' && e.status === 429);
  google.state.fail.reports = { status: 403, reason: 'accessNotConfigured' };
  await assert.rejects(() => yt.stats('kenh-gia'), (e) => e.code === 'yt_api_disabled');
  delete google.state.fail.reports;
  assert.equal((await yt.stats('kenh-gia')).cached, false);
  assert.equal((await yt.status()).channels[0].status, 'ok');
});

test('xóa kênh: thu hồi ở Google, xóa token + DB + cache; xóa thiết lập chỉ khi không còn kênh', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel();
  await yt.stats('kenh-gia');
  await assert.rejects(() => yt.clearSetup(), (e) => e.code === 'yt_has_channels');
  const rt = JSON.parse(await secrets.get('yt:kenh-gia')).refresh_token;
  assert.deepEqual(await yt.disconnect('kenh-gia'), { ok: true, revoked: true });
  assert.ok(google.state.revoked.has(rt));
  assert.equal(await secrets.get('yt:kenh-gia'), null);
  assert.equal(store.ytChannel('kenh-gia'), null);
  assert.equal(store.ytCacheGet('kenh-gia', 'stats'), null);
  assert.deepEqual((await yt.status()).channels, []);
  await assert.rejects(() => yt.disconnect('kenh-gia'), (e) => e.status === 404);
  // thu hồi lỗi vẫn xóa local; thêm lại được, cùng mã
  assert.equal((await connectChannel()).channelId, 'kenh-gia');
  google.state.fail.revoke = { status: 500, reason: 'x' };
  assert.deepEqual(await yt.disconnect('kenh-gia'), { ok: true, revoked: false });
  assert.equal(await secrets.get('yt:kenh-gia'), null);
  const s = await yt.clearSetup();
  assert.equal(s.configured, false);
  assert.equal(await secrets.get('google-client'), null);
});

test('thêm kênh kèm upload → xin thêm quyền tải lên, canUpload=true', async () => {
  await yt.setup(FAKE_CLIENT_SECRET);
  await connectChannel(undefined, { upload: true });
  assert.equal((await yt.status()).channels[0].canUpload, true);
  const auth = google.calls.find((c) => c.path === '/o/oauth2/v2/auth');
  assert.deepEqual(auth.query.scope.split(' '), [...READ_SCOPES, ...UPLOAD_SCOPES]);
});

// ---------- route HTTP

async function makeApp(youtube) {
  const projects = createProjects({ store, presets: () => ({ presets: [], errors: [] }), channels: () => CHANNELS, home: tmp });
  return buildApp({ store, projects, channels: () => CHANNELS, token: TOKEN, webDist: path.join(tmp, 'no-dist'), youtube, home: tmp, logError: () => {} });
}

test('route: thiếu youtube → 503; cần token; POST cần JSON (415); setup không trả secret', async () => {
  let app = await makeApp(null);
  const h = { host: HOST, 'x-studio-token': TOKEN };
  assert.equal((await app.inject({ url: '/api/youtube', headers: h })).statusCode, 503);
  assert.equal((await app.inject({ url: CALLBACK_PATH, headers: { host: HOST } })).statusCode, 401);
  await app.close();

  app = await makeApp(yt);
  try {
    assert.equal((await app.inject({ url: '/api/youtube', headers: { host: HOST } })).statusCode, 401);
    const s = await app.inject({ url: '/api/youtube', headers: h });
    assert.equal(s.statusCode, 200);
    assert.equal(s.json().configured, false);
    const noJson = await app.inject({ method: 'POST', url: '/api/youtube/setup', headers: { ...h, 'content-type': 'text/plain' }, payload: FAKE_CLIENT_SECRET });
    assert.equal(noJson.statusCode, 415);
    const empty = await app.inject({ method: 'POST', url: '/api/youtube/setup', headers: h, payload: { clientSecret: ' ' } });
    assert.equal(empty.statusCode, 400);
    const bad = await app.inject({ method: 'POST', url: '/api/youtube/setup', headers: h, payload: { clientSecret: '{"web":{}}' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'invalid_client_secret');
    const ok = await app.inject({ method: 'POST', url: '/api/youtube/setup', headers: h, payload: { clientSecret: FAKE_CLIENT_SECRET } });
    assert.equal(ok.statusCode, 200);
    assert.ok(!ok.body.includes('GOCSPX'));
    const badProfile = await app.inject({ method: 'POST', url: '/api/youtube/channels/add', headers: h, payload: { profileDir: 5 } });
    assert.equal(badProfile.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('route: thêm kênh → callback công khai (không cần token, chỉ cần state) → HTML; stats/videos; xóa kênh', async () => {
  const app = await makeApp(yt);
  const h = { host: HOST, 'x-studio-token': TOKEN };
  try {
    await app.inject({ method: 'POST', url: '/api/youtube/setup', headers: h, payload: { clientSecret: FAKE_CLIENT_SECRET } });
    const c = await app.inject({ method: 'POST', url: '/api/youtube/channels/add', headers: h, payload: {} });
    assert.equal(c.statusCode, 200, c.body);
    const { authUrl, opened: o } = c.json();
    assert.equal(o, false);
    assert.match(new URL(authUrl).searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/api\/youtube\/oauth\/callback$/);
    const cancel = await app.inject({ method: 'POST', url: '/api/youtube/channels/add/cancel', headers: h, payload: {} });
    assert.deepEqual(cancel.json(), { ok: true });
    const { authUrl: url2 } = (await app.inject({ method: 'POST', url: '/api/youtube/channels/add', headers: h, payload: {} })).json();
    const r = await fetch(url2, { redirect: 'manual' });
    const loc = new URL(r.headers.get('location'));
    // Google chỉ quay về đúng redirect_uri đã xin; ở đây dùng inject với query giống hệt.
    const bad = await app.inject({ url: `${CALLBACK_PATH}?state=sai&code=x`, headers: { host: HOST } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /Chưa kết nối được/);
    const cb = await app.inject({ url: `${CALLBACK_PATH}${loc.search}`, headers: { host: HOST } });
    assert.equal(cb.statusCode, 200);
    assert.match(cb.headers['content-type'], /text\/html/);
    assert.equal(cb.headers['cache-control'], 'no-store');
    assert.match(cb.body, /Đã thêm/);
    assert.match(cb.body, /Kênh Giả/);
    assert.ok(!cb.body.includes(loc.searchParams.get('code')));
    const xss = await app.inject({ url: `${CALLBACK_PATH}?error=%3Cscript%3E`, headers: { host: HOST } });
    assert.ok(!xss.body.includes('<script>'));
    const s = await app.inject({ url: '/api/youtube/channels/kenh-gia/stats', headers: h });
    assert.equal(s.statusCode, 200);
    assert.equal(s.json().days.length, 28);
    const v = await app.inject({ url: '/api/youtube/channels/kenh-gia/videos?refresh=1', headers: h });
    assert.equal(v.json().videos.length, 3);
    const none = await app.inject({ url: '/api/youtube/channels/khong-co/stats', headers: h });
    assert.equal(none.statusCode, 404);
    const st = await app.inject({ url: '/api/youtube', headers: h });
    assert.ok(!/rt-|at-|GOCSPX/.test(st.body));
    const d = await app.inject({ method: 'POST', url: '/api/youtube/channels/kenh-gia/disconnect', headers: h, payload: {} });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().revoked, true);
  } finally {
    await app.close();
  }
});
