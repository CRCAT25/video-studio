import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_UNKNOWN_PROBLEM,
  NOT_FOUND_PROBLEM,
  NOT_LOGGED_IN_PROBLEM,
  commandFor,
  filterAuth,
  parseVersion,
  resolveBin,
  runDoctor,
} from '../server/doctor.js';

// Dữ liệu tài khoản GIẢ — chỉ để kiểm chúng bị lọc khỏi kết quả.
const FAKE_EMAIL = 'fake-user@example.invalid';
const FAKE_ORG_ID = 'org-fake-0000-1111';
const FAKE_ORG_NAME = 'Fake Org Không Có Thật';
const FAKE_AUTH = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: FAKE_EMAIL,
  orgId: FAKE_ORG_ID,
  orgName: FAKE_ORG_NAME,
  subscriptionType: 'max',
};

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Tạo bin giả .mjs: ghi argv + cwd vào calls.jsonl cạnh nó, rồi in theo cấu hình.
function fakeMjs(name, { version = '2.1.309 (Claude Code)', auth = JSON.stringify(FAKE_AUTH), versionExit = 0, authExit = 0, sleepMs = 0 } = {}) {
  const file = path.join(tmp, `${name}.mjs`);
  const src = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, ${JSON.stringify(`${name}.calls.jsonl`)}), JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
process.stderr.write('stderr có ${FAKE_EMAIL} ${FAKE_ORG_ID}\\n');
const go = () => {
  if (args[0] === '--version') { process.stdout.write(${JSON.stringify(version)} + '\\n'); process.exit(${versionExit}); }
  if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(${JSON.stringify(auth)} + '\\n'); process.exit(${authExit}); }
  process.stderr.write('lệnh lạ\\n'); process.exit(64);
};
${sleepMs ? `setTimeout(go, ${sleepMs});` : 'go();'}
`;
  fs.writeFileSync(file, src);
  return file;
}

function calls(name) {
  const f = path.join(tmp, `${name}.calls.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function assertNoAccountInfo(result) {
  const s = JSON.stringify(result);
  for (const secret of [FAKE_EMAIL, FAKE_ORG_ID, FAKE_ORG_NAME, 'email', 'orgId', 'orgName']) {
    assert.ok(!s.includes(secret), `kết quả doctor không được chứa ${secret}: ${s}`);
  }
}

test('bin giả .mjs in JSON có email/orgId → auth chỉ còn loggedIn/authMethod/subscriptionType', async () => {
  const bin = fakeMjs('claude-ok');
  const r = await runDoctor({ claudeBin: bin, timeoutMs: 10_000 });
  assert.deepEqual(r.claude, { found: true, path: bin, version: '2.1.309' });
  assert.deepEqual(r.auth, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.node, process.version);
  assert.equal(r.platform, process.platform);
  assertNoAccountInfo(r);

  // chỉ gọi đúng 2 lệnh không gửi prompt, chạy trong thư mục tạm riêng đã bị xóa
  const c = calls('claude-ok');
  assert.deepEqual(c.map((x) => x.args).sort(), [['--version'], ['auth', 'status']].sort());
  for (const x of c) {
    assert.notEqual(x.cwd, process.cwd());
    assert.match(path.basename(x.cwd), /^vs-doctor-/);
    assert.equal(fs.existsSync(x.cwd), false, 'thư mục tạm của doctor phải được dọn');
  }
});

test('bin giả shell script (chmod +x) cũng chạy được; stderr không lọt vào kết quả', async () => {
  const bin = path.join(tmp, 'claude-sh');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "stderr ${FAKE_EMAIL}" >&2
if [ "$1" = "--version" ]; then echo "2.0.1 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '${JSON.stringify({ ...FAKE_AUTH, subscriptionType: 'pro' })}'; exit 0; fi
exit 64
`,
  );
  fs.chmodSync(bin, 0o755);
  const r = await runDoctor({ claudeBin: bin });
  assert.equal(r.claude.found, true);
  assert.equal(r.claude.version, '2.0.1');
  assert.equal(r.claude.path, bin);
  assert.deepEqual(r.auth, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' });
  assert.deepEqual(r.problems, []);
  assertNoAccountInfo(r);
});

test('bin không tồn tại → found:false + problem "Không tìm thấy lệnh claude…"', async () => {
  const r = await runDoctor({ claudeBin: path.join(tmp, 'khong-co', 'claude') });
  assert.equal(r.claude.found, false);
  assert.equal(r.claude.path, null);
  assert.equal(r.claude.version, null);
  assert.equal(r.auth, null);
  assert.deepEqual(r.problems, [NOT_FOUND_PROBLEM]);

  const r2 = await runDoctor({ claudeBin: 'claude-khong-ton-tai-vs-test-xyz' });
  assert.equal(r2.claude.found, false);
  assert.deepEqual(r2.problems, [NOT_FOUND_PROBLEM]);
});

test('file có nhưng không chạy được (thiếu quyền x) → found:false + NOT_FOUND_PROBLEM', async () => {
  const bin = path.join(tmp, 'claude-noexec');
  fs.writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n');
  fs.chmodSync(bin, 0o644);
  const r = await runDoctor({ claudeBin: bin });
  assert.equal(r.claude.found, false);
  assert.deepEqual(r.problems, [NOT_FOUND_PROBLEM]);
});

test('loggedIn:false → problem chưa đăng nhập; auth vẫn đã lọc', async () => {
  const bin = fakeMjs('claude-logout', { auth: JSON.stringify({ ...FAKE_AUTH, loggedIn: false, subscriptionType: null }) });
  const r = await runDoctor({ claudeBin: bin });
  assert.equal(r.claude.found, true);
  assert.deepEqual(r.auth, { loggedIn: false, authMethod: 'claude.ai', subscriptionType: null });
  assert.deepEqual(r.problems, [NOT_LOGGED_IN_PROBLEM]);
  assertNoAccountInfo(r);
});

test('auth status không phải JSON / lỗi → auth null + AUTH_UNKNOWN_PROBLEM', async () => {
  const bin = fakeMjs('claude-text', { auth: `Logged in as ${FAKE_EMAIL}` });
  const r = await runDoctor({ claudeBin: bin });
  assert.equal(r.claude.found, true);
  assert.equal(r.auth, null);
  assert.deepEqual(r.problems, [AUTH_UNKNOWN_PROBLEM]);
  assertNoAccountInfo(r);

  const bin2 = fakeMjs('claude-autherr', { auth: '', authExit: 1 });
  const r2 = await runDoctor({ claudeBin: bin2 });
  assert.equal(r2.auth, null);
  assert.deepEqual(r2.problems, [AUTH_UNKNOWN_PROBLEM]);
});

test('--version thoát mã khác 0 → found:false + problem có mã thoát', async () => {
  const bin = fakeMjs('claude-broken', { versionExit: 3 });
  const r = await runDoctor({ claudeBin: bin });
  assert.equal(r.claude.found, false);
  assert.equal(r.claude.path, bin);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /mã thoát 3/);
  assert.equal(r.auth, null);
});

test('bin treo → bị kill sau timeoutMs, problem "không phản hồi"', async () => {
  const bin = fakeMjs('claude-hang', { sleepMs: 20_000 });
  const t0 = Date.now();
  const r = await runDoctor({ claudeBin: bin, timeoutMs: 400 });
  assert.ok(Date.now() - t0 < 5000, 'không được chờ hết 20 s');
  assert.equal(r.claude.found, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /không phản hồi/);
});

test('đường dẫn bin tương đối được resolve theo cwd của server', async () => {
  const bin = fakeMjs('claude-rel');
  const rel = path.relative(process.cwd(), bin);
  const r = await runDoctor({ claudeBin: rel });
  assert.equal(r.claude.found, true);
  assert.equal(r.claude.path, path.resolve(rel));
});

test('filterAuth: chỉ giữ 3 field, chuỗi quá dài/không phải chuỗi → null, rác → null', () => {
  assert.deepEqual(filterAuth(JSON.stringify(FAKE_AUTH)), { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
  assert.deepEqual(filterAuth(`Cảnh báo gì đó\n${JSON.stringify(FAKE_AUTH)}\n`), { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
  assert.deepEqual(filterAuth('{"loggedIn":"true","authMethod":5,"subscriptionType":"' + 'x'.repeat(200) + '"}'), {
    loggedIn: false,
    authMethod: null,
    subscriptionType: null,
  });
  assert.equal(filterAuth(''), null);
  assert.equal(filterAuth(null), null);
  assert.equal(filterAuth('không phải json'), null);
  assert.equal(filterAuth('[1,2]'), null);
  assert.equal(filterAuth('"chuỗi"'), null);
  assertNoAccountInfo(filterAuth(JSON.stringify(FAKE_AUTH)));
});

test('parseVersion, commandFor, resolveBin', () => {
  assert.equal(parseVersion('2.1.309 (Claude Code)\n'), '2.1.309');
  assert.equal(parseVersion('claude 1.0.0-beta.2'), '1.0.0-beta.2');
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('dev-build\nline2'), 'dev-build');

  assert.deepEqual(commandFor('/x/fake.mjs', ['--version']), { file: process.execPath, args: ['/x/fake.mjs', '--version'] });
  assert.deepEqual(commandFor('claude', ['auth', 'status']), { file: 'claude', args: ['auth', 'status'] });

  const bin = path.join(tmp, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  fs.chmodSync(bin, 0o755);
  assert.equal(resolveBin('claude', `${path.join(tmp, 'khong')}${path.delimiter}${tmp}`), bin);
  assert.equal(resolveBin(bin), bin);
  assert.equal(resolveBin('claude', path.join(tmp, 'khong')), null);
  assert.equal(resolveBin(path.join(tmp, 'khong-co')), null);
  assert.equal(resolveBin(tmp), null, 'thư mục không phải bin');
});
