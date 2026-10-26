import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/db.js';
import { REPO_ROOT } from '../server/presets.js';
import { createPlanApi, PlanError, planToRateLimit, readClaudeToken } from '../server/claude-plan.js';
import { createUsage, dayStarts, parseRateLimit } from '../server/usage.js';
import { FAKE_PLAN_TOKEN, fakeCredentials, startFakeClaudeApi } from './fixtures/fake-claude-api.mjs';

const FAKE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const INFO = {
  status: 'allowed',
  resetsAt: 1893456000,
  rateLimitType: 'five_hour',
  unifiedWindows: { five_hour: { utilization: 0.54, resetsAt: 1893456000 }, seven_day: { utilization: 0.29, resetsAt: 1894060800 } },
};

let tmp;
let home;
let store;
let usage;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usage-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  store = openStore(path.join(home, 'studio.db'));
});

afterEach(() => {
  usage?.dispose();
  usage = null;
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.FAKE_USAGE_MODE;
  delete process.env.FAKE_USAGE;
});

const mk = (over = {}) => (usage = createUsage({ home, store, claudeBin: FAKE, ...over }));

test('parseRateLimit: lấy % và giờ mở lại, kẹp số, bỏ rác', () => {
  const p = parseRateLimit(INFO);
  assert.deepEqual(p, {
    status: 'allowed',
    type: 'five_hour',
    resetsAt: 1893456000,
    windows: { five_hour: { utilization: 0.54, resetsAt: 1893456000 }, seven_day: { utilization: 0.29, resetsAt: 1894060800 } },
  });
  assert.equal(parseRateLimit({ unifiedWindows: { five_hour: { utilization: 9 } } }).windows.five_hour.utilization, 1.5);
  assert.equal(parseRateLimit({ unifiedWindows: { five_hour: { utilization: -1 } } }).windows.five_hour.utilization, 0);
  assert.deepEqual(parseRateLimit({ status: 'allowed' }).windows, {});
  assert.equal(parseRateLimit(null), null);
  assert.equal(parseRateLimit([]), null);
  assert.equal(parseRateLimit({ unifiedWindows: { five_hour: { utilization: 'x' } } }), null);
});

test('dayStarts: nửa đêm giờ máy, tuần = 6 ngày trước', () => {
  const at = new Date(2026, 9, 26, 15, 30);
  const { today, week } = dayStarts(at);
  assert.equal(new Date(today).getTime(), new Date(2026, 9, 26).getTime());
  assert.equal(new Date(week).getTime(), new Date(2026, 9, 20).getTime());
});

test('observe: lưu file 600, phát sự kiện, nạp lại khi khởi động; event thiếu cửa sổ giữ % cũ', () => {
  const u = mk();
  const seen = [];
  u.on((s) => seen.push(s));
  assert.equal(u.summary().limits, null);
  assert.equal(u.observe({ junk: 1 }), false);
  assert.equal(u.observe(INFO), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].limits.windows.five_hour.utilization, 0.54);
  const file = path.join(home, 'usage.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  u.observe({ status: 'rejected', rateLimitType: 'five_hour' });
  assert.equal(u.summary().limits.status, 'rejected');
  assert.equal(u.summary().limits.windows.seven_day.utilization, 0.29);

  u.dispose();
  usage = createUsage({ home, store });
  const l = usage.summary().limits;
  assert.equal(l.status, 'rejected');
  assert.equal(l.windows.five_hour.utilization, 0.54);
  assert.ok(l.at);
});

test('record + summary: token theo nguồn hôm nay / 7 ngày; không store → tokens null', () => {
  const u = mk();
  u.record('assistant', { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 10 });
  u.record('assistant', 'rác');
  const t = u.summary().tokens;
  assert.deepEqual(t.today.assistant, { input: 5, output: 2, cache: 10, total: 17 });
  assert.equal(t.week.assistant.total, 17);
  assert.equal(t.today.check.total, 0);
  assert.equal(createUsage({ home }).summary().tokens, null);
});

test('check: chạy claude không tool/không lưu phiên, lấy % mới + ghi token kiểm tra', async () => {
  process.env.FAKE_USAGE = JSON.stringify({ five_hour: 0.81, seven_day: 0.2 });
  const u = mk();
  const seen = [];
  u.on((s) => seen.push(s.checking));
  const p1 = u.check();
  const p2 = u.check(); // đang chạy → dùng chung, không chạy lần 2
  assert.equal(u.summary().checking, true);
  const [s, s2] = await Promise.all([p1, p2]);
  assert.equal(s.checking, false, 'kết quả trả về không còn cờ đang kiểm');
  assert.equal(s2.limits.windows.five_hour.utilization, 0.81);
  assert.equal(s.limits.windows.five_hour.utilization, 0.81);
  assert.equal(s.tokens.today.check.total, 33);
  assert.equal(u.summary().checking, false);
  assert.ok(seen.includes(true) && seen.at(-1) === false);
  const call = JSON.parse(fs.readFileSync(path.join(home, 'usage-check', '.fake-usage.jsonl'), 'utf8').trim());
  for (const f of ['--no-session-persistence', '--strict-mcp-config', '--tools']) assert.ok(call.argv.includes(f), f);
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], '');
});

test('check: cooldown → 429; hết cooldown chạy được', async () => {
  let t = 1_000_000;
  const u = mk({ now: () => t, cooldownMs: 60_000 });
  await u.check();
  assert.throws(() => u.check(), (e) => e.status === 429 && e.code === 'usage_cooldown');
  t += 61_000;
  await u.check();
});

test('check: không có số liệu → 502; chưa đăng nhập → báo đăng nhập', async () => {
  process.env.FAKE_USAGE_MODE = 'none';
  await assert.rejects(mk({ cooldownMs: 0 }).check(), (e) => e.status === 502 && e.code === 'usage_unavailable');
  process.env.FAKE_USAGE_MODE = 'logout';
  await assert.rejects(usage.check(), (e) => e.status === 502 && /đăng nhập/.test(e.message));
});

test('check: không có lệnh claude → 503; quá giờ → 504 và giết tiến trình', async () => {
  await assert.rejects(mk({ claudeBin: path.join(tmp, 'khong-co-claude') }).check(), (e) => e.status === 503);
  usage.dispose();
  process.env.FAKE_USAGE_MODE = 'slow';
  const t0 = Date.now();
  await assert.rejects(mk({ timeoutMs: 300 }).check(), (e) => e.status === 504 && e.code === 'usage_timeout');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(usage.summary().checking, false);
});

// ---- Hỏi API như /usage (không tốn token), lỗi thì quay về claude -p

test('planToRateLimit: % → 0..1, resets_at ISO → giây, status theo mức cao nhất; dữ liệu lạ → null', () => {
  const r = planToRateLimit({ five_hour: { utilization: 85, resets_at: '2030-01-01T05:00:00Z' }, seven_day: { utilization: 20, resets_at: null }, seven_day_opus: null });
  assert.deepEqual(r, {
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    resetsAt: Date.UTC(2030, 0, 1, 5) / 1000,
    unifiedWindows: { five_hour: { utilization: 0.85, resetsAt: Date.UTC(2030, 0, 1, 5) / 1000 }, seven_day: { utilization: 0.2, resetsAt: null } },
  });
  assert.equal(planToRateLimit({ seven_day: { utilization: 100 } }).status, 'rejected');
  assert.equal(planToRateLimit({ five_hour: { utilization: 3 } }).status, 'allowed');
  assert.equal(planToRateLimit({ five_hour: null }), null);
  assert.equal(planToRateLimit('x'), null);
});

test('readClaudeToken: đọc file VS_CLAUDE_CREDENTIALS / CLAUDE_CONFIG_DIR; thiếu/hỏng → no_token; không đụng Keychain', async () => {
  const f = path.join(tmp, 'cred.json');
  fs.writeFileSync(f, fakeCredentials({ expiresAt: 123 }));
  assert.deepEqual(await readClaudeToken({ env: { VS_CLAUDE_CREDENTIALS: f }, platform: 'darwin', securityBin: '/khong-co' }), { token: FAKE_PLAN_TOKEN, expiresAt: 123 });
  fs.writeFileSync(path.join(tmp, '.credentials.json'), fakeCredentials());
  assert.equal((await readClaudeToken({ env: { CLAUDE_CONFIG_DIR: tmp }, platform: 'darwin', securityBin: '/khong-co' })).token, FAKE_PLAN_TOKEN);
  fs.writeFileSync(f, '{"claudeAiOauth":{}}');
  await assert.rejects(readClaudeToken({ env: { VS_CLAUDE_CREDENTIALS: f } }), (e) => e instanceof PlanError && e.reason === 'no_token');
  await assert.rejects(readClaudeToken({ env: { VS_CLAUDE_CREDENTIALS: path.join(tmp, 'khong') } }), (e) => e.reason === 'no_token');
});

test('createPlanApi: gửi Bearer + anthropic-beta; hết hạn → expired; 401 → đọc lại token một lần', async () => {
  const fake = await startFakeClaudeApi({ five_hour: 61, seven_day: 9 });
  try {
    let reads = 0;
    let tok = FAKE_PLAN_TOKEN;
    const api = createPlanApi({ base: fake.base, readToken: async () => (reads++, { token: tok, expiresAt: null }) });
    const info = await api.fetch();
    assert.equal(info.unifiedWindows.five_hour.utilization, 0.61);
    assert.deepEqual(fake.calls[0], { auth: `Bearer ${FAKE_PLAN_TOKEN}`, beta: 'oauth-2025-04-20' });
    await api.fetch();
    assert.equal(reads, 1, 'token nhớ trong RAM');

    tok = 'cu';
    const api2 = createPlanApi({ base: fake.base, readToken: async () => (reads++, { token: tok, expiresAt: null }) });
    reads = 0;
    const p = api2.fetch();
    tok = FAKE_PLAN_TOKEN; // Claude Code "vừa làm mới" token
    await p;
    assert.equal(reads, 2);

    await assert.rejects(createPlanApi({ base: fake.base, readToken: async () => ({ token: 'x', expiresAt: 1 }) }).fetch(), (e) => e.reason === 'expired');
    fake.set({ status: 500 });
    await assert.rejects(api.fetch(), (e) => e.reason === 'http' && !e.message.includes(FAKE_PLAN_TOKEN));
    await assert.rejects(createPlanApi({ base: 'http://127.0.0.1:9', readToken: async () => ({ token: 't' }) }).fetch(), (e) => e.reason === 'network');
  } finally {
    await fake.close();
  }
});

test('check qua API: không chạy claude, không ghi token, giãn cách 10 s; auto trong cooldown trả summary', async () => {
  let t = 1_000_000;
  const plan = { n: 0, fetch: async () => (plan.n++, planToRateLimit({ five_hour: { utilization: 47 }, seven_day: { utilization: 18 } })) };
  const u = mk({ planApi: plan, now: () => t });
  const s = await u.check();
  assert.equal(s.via, 'api');
  assert.equal(s.limits.windows.five_hour.utilization, 0.47);
  assert.equal(s.tokens.today.check.total, 0);
  assert.equal(s.nextCheckAt, t + 10_000);
  assert.ok(!fs.existsSync(path.join(home, 'usage-check', '.fake-usage.jsonl')), 'không chạy claude');
  assert.throws(() => u.check(), (e) => e.status === 429);
  assert.equal((await u.check({ auto: true })).via, 'api');
  assert.equal(plan.n, 1);
  t += 10_001;
  assert.equal(u.summary().nextCheckAt, null);
  await u.check({ auto: true });
  assert.equal(plan.n, 2);
});

test('check: API lỗi → bấm tay quay về claude -p kèm apiError; auto thì không tốn token và không khóa nút', async () => {
  let t = 1_000_000;
  let fail = new PlanError('denied', 'Chưa được phép đọc Keychain.');
  const plan = { n: 0, fetch: async () => (plan.n++, Promise.reject(fail)) };
  const u = mk({ planApi: plan, now: () => t });
  const a = await u.check({ auto: true });
  assert.equal(a.apiError, undefined);
  assert.equal(a.nextCheckAt, null, 'auto hỏng không khóa nút');
  assert.ok(!fs.existsSync(path.join(home, 'usage-check')), 'auto không chạy claude');
  await u.check({ auto: true }); // bị từ chối Keychain → auto sau không hỏi lại
  assert.equal(plan.n, 1);

  const s = await u.check();
  assert.equal(plan.n, 2, 'bấm tay vẫn thử API lại');
  assert.equal(s.via, 'claude');
  assert.match(s.apiError, /Keychain/);
  assert.equal(s.limits.windows.five_hour.utilization, 0.42);
  assert.equal(s.tokens.today.check.total, 33);
  assert.equal(s.nextCheckAt, t + 60_000);

  t += 60_001;
  fail = null;
  plan.fetch = async () => (plan.n++, planToRateLimit({ five_hour: { utilization: 50 } }));
  const s2 = await u.check();
  assert.equal(s2.via, 'api');
  assert.equal(s2.apiError, undefined);
  t += 10_001;
  await u.check({ auto: true }); // API chạy lại được → auto dùng lại
  assert.equal(plan.n, 4);
});
