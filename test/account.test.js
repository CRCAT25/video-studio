import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { argbToHex, listChromeProfiles, localStatePath, parseDefaultBrowser, parseLocalState } from '../server/chrome-profiles.js';
import { createClaudeAccount } from '../server/claude-account.js';

// Local State GIẢ — có cả trường cá nhân để kiểm chúng không bao giờ lọt ra ngoài.
const FAKE_EMAIL = 'fake-user@example.invalid';
const LOCAL_STATE = {
  profile: {
    last_used: 'Profile 2',
    last_active_profiles: ['Default', 'Profile 2', 'Profile 99'],
    info_cache: {
      Default: { name: 'Cá nhân', active_time: 100, profile_highlight_color: -16776961, user_name: FAKE_EMAIL, gaia_name: 'Tên Giả' },
      'Profile 2': { name: '  Công việc  ', active_time: 50, default_avatar_fill_color: -1, gaia_given_name: 'Giả' },
      'Profile 3': { name: 'Mới', active_time: 300 },
      'Guest Profile': { name: 'Khách', is_ephemeral: true },
      '../etc': { name: 'lạ' },
    },
  },
};

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-acc-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Lệnh claude giả cho `auth login|logout`: ghi lại argv + BROWSER/VS_CHROME_PROFILE vào file log.
function fakeClaude({ loginMs = 0, exit = 0 } = {}) {
  const log = path.join(tmp, 'calls.jsonl');
  const bin = path.join(tmp, 'claude.mjs');
  fs.writeFileSync(
    bin,
    `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), browser: process.env.BROWSER || null, profile: process.env.VS_CHROME_PROFILE || null, cwd: process.cwd() }) + '\\n');
const wait = process.argv[3] === 'login' ? ${loginMs} : 0;
setTimeout(() => process.exit(${exit}), wait);
`,
  );
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return { bin, calls };
}

const PROFILES = () => ({ supported: true, profiles: parseLocalState(JSON.stringify(LOCAL_STATE)) });

// Chờ lệnh auth hiện tại xong (theo onChange).
function nextChange(events, n) {
  return new Promise((resolve) => {
    const tick = () => (events.length >= n ? resolve(events[n - 1]) : setTimeout(tick, 10));
    tick();
  });
}

test('parseLocalState: chỉ dir/name/color/lastUsed/open, dùng gần nhất lên đầu, bỏ ephemeral + dir lạ', () => {
  const list = parseLocalState(JSON.stringify(LOCAL_STATE));
  assert.deepEqual(
    list.map((p) => p.dir),
    ['Profile 2', 'Profile 3', 'Default'],
  );
  assert.deepEqual(list[0], { dir: 'Profile 2', name: 'Công việc', color: '#ffffff', lastUsed: true, open: false });
  assert.ok(list.every((p) => !p.open), 'Chrome không chạy thì không hồ sơ nào đang mở');
  assert.equal(list[2].color, '#0000ff');
  for (const p of list) assert.deepEqual(Object.keys(p).sort(), ['color', 'dir', 'lastUsed', 'name', 'open']);
  assert.ok(!JSON.stringify(list).includes(FAKE_EMAIL));
  assert.ok(!JSON.stringify(list).includes('Tên Giả'));
});

test('parseLocalState: Chrome đang chạy → hồ sơ trong last_active_profiles là open, xếp sau "gần nhất"', () => {
  const list = parseLocalState(JSON.stringify(LOCAL_STATE), { running: true });
  assert.deepEqual(
    list.map((p) => [p.dir, p.open]),
    [['Profile 2', true], ['Default', true], ['Profile 3', false]],
  );
});

test('parseDefaultBrowser: handler https → tên; không khai báo → Safari; lạ / hỏng → null', () => {
  const ls = (id, scheme = 'https') => JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }, { LSHandlerURLScheme: scheme, LSHandlerRoleAll: id }] });
  assert.equal(parseDefaultBrowser(ls('com.google.chrome')), 'Chrome');
  assert.equal(parseDefaultBrowser(ls('company.thebrowser.Browser', 'http')), 'Arc');
  assert.equal(parseDefaultBrowser(JSON.stringify({ LSHandlers: [] })), 'Safari');
  assert.equal(parseDefaultBrowser('{}'), 'Safari');
  assert.equal(parseDefaultBrowser(ls('com.example.lạ')), null);
  assert.equal(parseDefaultBrowser('{oops'), null);
});

test('parseLocalState: JSON hỏng / thiếu info_cache → []', () => {
  assert.deepEqual(parseLocalState('{oops'), []);
  assert.deepEqual(parseLocalState(''), []);
  assert.deepEqual(parseLocalState('{"profile":{}}'), []);
});

test('argbToHex + localStatePath + listChromeProfiles', () => {
  assert.equal(argbToHex(-16711936), '#00ff00');
  assert.equal(argbToHex('x'), null);
  assert.match(localStatePath({ platform: 'darwin', home: '/h' }), /Google\/Chrome\/Local State$/);
  assert.equal(localStatePath({ platform: 'linux', home: '/h', env: {} }), '/h/.config/google-chrome/Local State');
  assert.equal(localStatePath({ platform: 'win32', home: '/h' }), null);
  assert.deepEqual(listChromeProfiles({ platform: 'win32' }), { supported: false, profiles: [], defaultBrowser: null });
  assert.deepEqual(listChromeProfiles({ file: path.join(tmp, 'không-có'), defaultBrowser: 'Safari' }), { supported: true, profiles: [], defaultBrowser: 'Safari' });
  const f = path.join(tmp, 'Local State');
  fs.writeFileSync(f, JSON.stringify(LOCAL_STATE));
  assert.equal(listChromeProfiles({ file: f, running: false, defaultBrowser: null }).profiles.length, 3);
  assert.deepEqual(listChromeProfiles({ file: f, running: true, defaultBrowser: 'Chrome' }).profiles.filter((p) => p.open).map((p) => p.dir), ['Profile 2', 'Default']);
});

test('login với hồ sơ Chrome: --claudeai, BROWSER = script, VS_CHROME_PROFILE = dir, xong → ok', async () => {
  const fake = fakeClaude();
  const events = [];
  const acc = createClaudeAccount({ claudeBin: fake.bin, browserScript: '/x/open.sh', profiles: PROFILES, onChange: (s) => events.push(s), env: { PATH: process.env.PATH } });
  const st = acc.login({ method: 'claudeai', profileDir: 'Profile 3' });
  assert.equal(st.busy, 'login');
  assert.deepEqual(st.profile, { dir: 'Profile 3', name: 'Mới' });
  assert.equal(acc.isBusy(), true);
  const done = await nextChange(events, 2);
  assert.equal(done.busy, null);
  assert.equal(done.last.action, 'login');
  assert.equal(done.last.reason, 'ok');
  const [call] = fake.calls();
  assert.deepEqual(call.argv, ['auth', 'login', '--claudeai']);
  assert.equal(call.browser, '/x/open.sh');
  assert.equal(call.profile, 'Profile 3');
  assert.ok(!fs.existsSync(call.cwd), 'thư mục tạm của lệnh auth phải được xóa');
});

test('login console + trình duyệt mặc định: không đặt BROWSER', async () => {
  const fake = fakeClaude();
  const events = [];
  const acc = createClaudeAccount({ claudeBin: fake.bin, profiles: PROFILES, onChange: (s) => events.push(s), env: { PATH: process.env.PATH } });
  acc.login({ method: 'console', profileDir: null });
  await nextChange(events, 2);
  const [call] = fake.calls();
  assert.deepEqual(call.argv, ['auth', 'login', '--console']);
  assert.equal(call.browser, null);
  assert.equal(call.profile, null);
});

test('login: method sai / hồ sơ không có trong danh sách → 400; đang chờ → 409', async () => {
  const fake = fakeClaude({ loginMs: 5000 });
  const acc = createClaudeAccount({ claudeBin: fake.bin, profiles: PROFILES, killGraceMs: 200, env: { PATH: process.env.PATH } });
  assert.throws(() => acc.login({ method: 'sso' }), (e) => e.status === 400 && e.code === 'invalid_body');
  assert.throws(() => acc.login({ profileDir: '../../evil; rm -rf' }), (e) => e.status === 400 && e.code === 'invalid_profile');
  acc.login({});
  assert.throws(() => acc.login({}), (e) => e.status === 409 && e.code === 'account_busy');
  await assert.rejects(acc.logout(), (e) => e.status === 409 && e.code === 'account_busy');
  const st = await acc.cancel();
  assert.equal(st.busy, null);
  assert.equal(st.last.reason, 'cancelled');
});

test('cancel khi không có lượt đăng nhập → 409 not_logging_in', async () => {
  const acc = createClaudeAccount({ claudeBin: fakeClaude().bin, profiles: PROFILES });
  await assert.rejects(acc.cancel(), (e) => e.status === 409 && e.code === 'not_logging_in');
});

test('login quá hạn → timeout; mã thoát ≠ 0 → failed kèm code', async () => {
  const events = [];
  const slow = createClaudeAccount({ claudeBin: fakeClaude({ loginMs: 5000 }).bin, profiles: PROFILES, loginTimeoutMs: 100, killGraceMs: 200, onChange: (s) => events.push(s), env: { PATH: process.env.PATH } });
  slow.login({});
  const t = await nextChange(events, 2);
  assert.equal(t.last.reason, 'timeout');

  fs.rmSync(path.join(tmp, 'calls.jsonl'), { force: true });
  const failEvents = [];
  const bad = createClaudeAccount({ claudeBin: fakeClaude({ exit: 3 }).bin, profiles: PROFILES, onChange: (s) => failEvents.push(s), env: { PATH: process.env.PATH } });
  bad.login({});
  const f = await nextChange(failEvents, 2);
  assert.equal(f.last.reason, 'failed');
  assert.equal(f.last.code, 3);
});

test('logout chờ xong và trả last; bin không tồn tại → not_found', async () => {
  const fake = fakeClaude();
  const acc = createClaudeAccount({ claudeBin: fake.bin, profiles: PROFILES, env: { PATH: process.env.PATH } });
  const st = await acc.logout();
  assert.equal(st.last.action, 'logout');
  assert.equal(st.last.reason, 'ok');
  assert.deepEqual(fake.calls()[0].argv, ['auth', 'logout']);

  const missing = createClaudeAccount({ claudeBin: path.join(tmp, 'không-có-claude'), profiles: PROFILES });
  const m = await missing.logout();
  assert.equal(m.last.reason, 'not_found');
});

test('dispose dừng lượt đăng nhập đang chờ', async () => {
  const events = [];
  const acc = createClaudeAccount({ claudeBin: fakeClaude({ loginMs: 5000 }).bin, profiles: PROFILES, killGraceMs: 200, onChange: (s) => events.push(s), env: { PATH: process.env.PATH } });
  acc.login({});
  acc.dispose();
  const s = await nextChange(events, 2);
  assert.equal(s.last.reason, 'cancelled');
  assert.equal(acc.isBusy(), false);
});
