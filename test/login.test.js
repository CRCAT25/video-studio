import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { openStore } from '../server/db.js';
import { fileStore } from '../server/keychain.js';
import { SESSION_COOKIE, SESSION_TTL_MS, createLogin, hashPassword, newSetupCode, ownerHash, resetPassword, verifyPassword } from '../server/login.js';
import { createProjects } from '../server/projects.js';
import { createYouTube } from '../server/youtube/index.js';
import { FAKE_CLIENT_SECRET, startFakeGoogle } from './fixtures/fake-google.mjs';

const TOKEN = 'test-token-abcdefghijklmnop';

let tmp;
let store;
let google;
let yt;
let login;
let app;
let base;
let clock;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-login-'));
  store = openStore(path.join(tmp, 'studio.db'));
  google = await startFakeGoogle();
  clock = Date.now();
  yt = createYouTube({ store, secrets: fileStore(path.join(tmp, 'secrets.json')), channels: () => [], googleBase: google.base });
  await yt.setup(FAKE_CLIENT_SECRET);
  login = createLogin({ store, getClient: () => yt.googleClient(), endpoints: yt.endpoints, now: () => clock });
  const projects = createProjects({ store, presets: () => ({ presets: [], errors: [] }), channels: () => [], home: tmp });
  app = await buildApp({ store, projects, token: TOKEN, webDist: path.join(tmp, 'no-dist'), youtube: yt, login, home: tmp, logError: () => {} });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

afterEach(async () => {
  await app.close();
  await google.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tokenH = () => ({ 'x-studio-token': TOKEN, 'content-type': 'application/json' });
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${SESSION_COOKIE}=`));

// Đi qua "Google" giả: authUrl → callback của app. Trả response callback.
async function viaGoogle(authUrl) {
  const g = await fetch(authUrl, { redirect: 'manual' });
  return fetch(g.headers.get('location'), { redirect: 'manual' });
}

// Bật đăng nhập (chủ = state.sub hiện tại) bằng request có token.
async function enable() {
  const r = await fetch(`${base}/api/auth/google/enable`, { method: 'POST', headers: tokenH(), body: '{}' });
  assert.equal(r.status, 200);
  const { authUrl } = await r.json();
  const q = new URL(authUrl).searchParams;
  assert.equal(q.get('scope'), 'openid');
  assert.equal(q.get('redirect_uri'), `${base}/auth/callback`);
  return viaGoogle(authUrl);
}

// Đăng nhập từ trang đăng nhập (/auth/google).
async function signIn() {
  const r = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  return viaGoogle(r.headers.get('location'));
}

test('chưa bật: trang đăng nhập = form tạo mật khẩu, không nút Google; /auth/google báo chưa bật; enable cần đăng nhập', async () => {
  const p = await fetch(`${base}/`);
  assert.equal(p.status, 401);
  const html = await p.text();
  assert.match(html, /action="\/auth\/setup"/);
  assert.ok(!html.includes('/auth/google'));
  const g = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(g.status, 409);
  assert.match(await g.text(), /chưa bật/);
  const e = await fetch(`${base}/api/auth/google/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(e.status, 401);
  const a = await fetch(`${base}/api/auth`, { headers: tokenH() });
  assert.deepEqual(await a.json(), { google: { available: true, enabled: false, configured: true }, password: false, via: 'token' });
});

test('bật → chủ = băm sub (không lưu sub/email); đúng chủ đăng nhập được, cookie phiên vào được app', async () => {
  const cb = await enable();
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /http-equiv="refresh" content="0;url=\/#\/channels"/);
  assert.equal(store.getSetting('login.owner'), ownerHash('fake-sub-owner'));
  const dump = JSON.stringify(store.db.prepare('SELECT * FROM settings').all()) + JSON.stringify(store.db.prepare('SELECT * FROM sessions').all());
  assert.ok(!dump.includes('fake-sub-owner'));

  const page = await fetch(`${base}/`);
  assert.match(await page.text(), /Đăng nhập bằng Google/);
  const r = await signIn();
  assert.equal(r.status, 200);
  const sc = r.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE));
  assert.match(sc, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
  const cookie = cookieOf(r);
  const a = await fetch(`${base}/api/auth`, { headers: { cookie } });
  assert.equal(a.status, 200);
  assert.equal((await a.json()).via, 'session');
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 200);
  // Scope chỉ openid, không có refresh token / email.
  const auths = google.calls.filter((c) => c.path === '/o/oauth2/v2/auth');
  assert.ok(auths.every((c) => c.query.scope === 'openid'));
});

test('tài khoản khác → "Tài khoản này không có quyền", không có cookie phiên', async () => {
  await enable();
  google.state.sub = 'nguoi-la';
  const r = await signIn();
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Tài khoản này không có quyền/);
  assert.equal(cookieOf(r), undefined);
});

test('state sai / hủy / hết hạn luồng → lỗi rõ, không tạo phiên', async () => {
  await enable();
  const bad = await fetch(`${base}/auth/callback?state=sai&code=x`);
  assert.equal(bad.status, 400);
  const denied = await fetch(`${base}/auth/callback?error=access_denied&state=x`);
  assert.match(await denied.text(), /hủy đăng nhập/);
  const r = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  clock += 11 * 60_000;
  const late = await viaGoogle(r.headers.get('location'));
  assert.equal(late.status, 400);
  assert.equal(cookieOf(late), undefined);
});

test('phiên hết hạn sau 30 ngày → 401', async () => {
  await enable();
  const cookie = cookieOf(await signIn());
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 200);
  clock += SESSION_TTL_MS + 1000;
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 401);
});

test('đăng xuất xóa phiên + cookie; tắt → mọi phiên vô hiệu, link token vẫn dùng được', async () => {
  await enable();
  const cookie = cookieOf(await signIn());
  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(out.status, 200);
  const cleared = out.headers.getSetCookie();
  assert.ok(cleared.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes('Max-Age=0')));
  assert.ok(cleared.some((c) => c.startsWith('vs_token=;') && c.includes('Max-Age=0')));
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 401);

  const c2 = cookieOf(await signIn());
  const off = await fetch(`${base}/api/auth/google/disable`, { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(off.status, 200);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie: c2 } })).status, 401);
  assert.equal(store.getSetting('login.owner'), null);
  // Link token (fallback) vẫn vào được.
  const t = await fetch(`${base}/?t=${TOKEN}`, { redirect: 'manual' });
  assert.equal(t.status, 302);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { 'x-studio-token': TOKEN } })).status, 200);
});

test('bật đăng nhập → chặn xóa thiết lập Google; /auth/google qua localhost → chuyển về 127.0.0.1', async () => {
  await enable();
  const clr = await fetch(`${base}/api/youtube/setup/clear`, { method: 'POST', headers: tokenH(), body: '{}' });
  assert.equal(clr.status, 409);
  const port = app.server.address().port;
  const r = await fetch(`http://localhost:${port}/auth/google`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${base}/auth/google`);
});

// ---- Mật khẩu cục bộ
const PW = 'mat-khau-dai-123';
const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams(o).toString() });
// Tạo mật khẩu qua form với mã thiết lập mới. Trả response.
const setup = (o = {}) => fetch(`${base}/auth/setup`, form({ code: newSetupCode(store), password: PW, confirm: PW, ...o }));

test('băm mật khẩu: scrypt + muối, đúng/sai/chuỗi hỏng', async () => {
  const h = await hashPassword(PW);
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!h.includes(PW));
  assert.notEqual(await hashPassword(PW), h, 'muối ngẫu nhiên');
  assert.equal(await verifyPassword(PW, h), true);
  assert.equal(await verifyPassword('sai', h), false);
  assert.equal(await verifyPassword(PW, 'scrypt$1$2'), false);
  assert.equal(await verifyPassword(PW, null), false);
});

test('tạo mật khẩu lần đầu: sai mã / ngắn / không khớp → lỗi; đúng → 303 + cookie phiên, mã hết hiệu lực', async () => {
  const bad = await fetch(`${base}/auth/setup`, form({ code: '000000x', password: PW, confirm: PW }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Mã thiết lập không đúng/);
  assert.equal(cookieOf(bad), undefined);
  assert.match(await (await setup({ password: 'ngan', confirm: 'ngan' })).text(), /ít nhất 8 ký tự/);
  assert.match(await (await setup({ confirm: 'khac-han-123' })).text(), /không khớp/);
  assert.equal(store.getSetting('login.password'), null);

  const ok = await setup();
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  const cookie = cookieOf(ok);
  assert.ok(cookie);
  assert.equal(store.getSetting('login.setup'), null);
  const dump = JSON.stringify(store.db.prepare('SELECT * FROM settings').all());
  assert.ok(!dump.includes(PW));
  const a = await (await fetch(`${base}/api/auth`, { headers: { cookie } })).json();
  assert.equal(a.password, true);
  assert.equal(a.via, 'session');
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 200);
  // Đã có mật khẩu → không tạo lại được.
  assert.equal((await setup()).status, 409);
});

test('đăng nhập bằng mật khẩu: trang hiện ô mật khẩu; sai → 401; đúng → cookie; Origin lạ → 403; /api không nhận form', async () => {
  await setup();
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /action="\/auth\/password"/);
  assert.match(page, /video-studio reset-password/);
  assert.ok(!page.includes('/auth/setup'));
  const wrong = await fetch(`${base}/auth/password`, form({ password: 'sai-roi-nhe' }));
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Mật khẩu không đúng/);
  const ok = await fetch(`${base}/auth/password`, form({ password: PW }));
  assert.equal(ok.status, 303);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie: cookieOf(ok) } })).status, 200);
  const evil = await fetch(`${base}/auth/password`, { ...form({ password: PW }), headers: { ...form({}).headers, origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  const api = await fetch(`${base}/api/auth/logout`, { ...form({}), headers: { ...form({}).headers, cookie: cookieOf(ok) } });
  assert.equal(api.status, 415);
});

test('khóa: sai mã thiết lập 5 lần → mã mới; sai mật khẩu 5 lần → khóa 30 giây', async () => {
  const codes = [];
  const l = createLogin({ store, now: () => clock, onSetupCode: (c) => codes.push(c) });
  const old = newSetupCode(store);
  for (let i = 0; i < 4; i++) await assert.rejects(l.setupPassword({ code: '999999x', password: PW, confirm: PW }), /không đúng/);
  await assert.rejects(l.setupPassword({ code: '999999x', password: PW, confirm: PW }), (e) => e.status === 429);
  assert.equal(codes.length, 1);
  await assert.rejects(l.setupPassword({ code: old, password: PW, confirm: PW }), /không đúng/, 'mã cũ hết hiệu lực');
  assert.ok(await l.setupPassword({ code: codes[0], password: PW, confirm: PW }));

  for (let i = 0; i < 5; i++) await assert.rejects(l.loginPassword('sai'), (e) => e.status === 401);
  await assert.rejects(l.loginPassword(PW), (e) => e.status === 429 && /30 giây/.test(e.message));
  clock += 31_000;
  assert.ok(await l.loginPassword(PW));
});

test('reset-password: xóa mật khẩu + mọi phiên, mã mới dùng được; tắt Google không đá phiên mật khẩu', async () => {
  const cookie = cookieOf(await setup());
  await enable();
  const c2 = cookieOf(await fetch(`${base}/auth/password`, form({ password: PW })));
  const off = await fetch(`${base}/api/auth/google/disable`, { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(off.status, 200);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie: c2 } })).status, 200);

  const code = resetPassword(store);
  assert.match(code, /^\d{6}$/);
  assert.equal(store.getSetting('login.password'), null);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie: c2 } })).status, 401);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 401);
  assert.match(await (await fetch(`${base}/`)).text(), /action="\/auth\/setup"/);
  const again = await fetch(`${base}/auth/setup`, form({ code, password: 'mat-khau-moi-456', confirm: 'mat-khau-moi-456' }));
  assert.equal(again.status, 303);
});
