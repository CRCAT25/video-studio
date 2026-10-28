import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSkillRepo, scanDir } from '../server/skill-repo.js';
import { buildApp } from '../server/app.js';

const TOKEN = 'test-token-abcdefghijklmnop';
let tmp, home, lib, remote, repo, ghCalls;
const md = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;
const mk = (root, name, text, extra = {}) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), text);
  for (const [f, c] of Object.entries(extra)) fs.writeFileSync(path.join(root, name, f), c);
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t' } }).trim();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-repo-'));
  home = path.join(tmp, 'home');
  lib = path.join(home, 'skills');
  remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(lib, { recursive: true });
  git(tmp, 'init', '--bare', '-b', 'main', remote);
  ghCalls = [];
  repo = createSkillRepo({ home, gh: async (a) => (ghCalls.push(a), { code: -1, out: '', err: 'no gh' }) });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Remote cục bộ không khớp regex GitHub → ghi thẳng cấu hình sau init không url, rồi nối remote bằng git.
async function ready() {
  await repo.init({ dir: path.join(tmp, 'kho') });
  git(path.join(tmp, 'kho'), 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(home, 'skill-repo.json'), JSON.stringify({ dir: path.join(tmp, 'kho'), url: remote }));
}

test('init tạo đủ file, commit và sync.sh chạy được', async () => {
  const st = await repo.init({ dir: path.join(tmp, 'kho') });
  assert.equal(st.configured, true);
  for (const f of ['README.md', 'LICENSE', '.gitignore', 'sync.sh', 'sync.ps1']) assert.ok(fs.existsSync(path.join(tmp, 'kho', f)), f);
  assert.match(git(path.join(tmp, 'kho'), 'log', '--oneline'), /Initial commit/);
  assert.ok(fs.statSync(path.join(tmp, 'kho', 'sync.sh')).mode & 0o100);
});

test('init từ chối url không phải GitHub và thư mục có sẵn nội dung', async () => {
  await assert.rejects(repo.init({ url: 'http://evil.example/x', dir: path.join(tmp, 'a') }), { code: 'invalid_url' });
  fs.mkdirSync(path.join(tmp, 'b'));
  fs.writeFileSync(path.join(tmp, 'b', 'x'), '1');
  await assert.rejects(repo.init({ dir: path.join(tmp, 'b') }), { code: 'dir_not_empty' });
});

test('init nối remote khi có url GitHub', async () => {
  const fake = 'https://github.com/me/my-skills';
  const { run } = await import('../server/skill-repo.js');
  const r1 = createSkillRepo({ home, exec: (c, a, o) => run(c, a[0] === 'ls-remote' ? a.map((x) => (x === fake ? remote : x)) : a, o) });
  await r1.init({ url: fake, dir: path.join(tmp, 'kho') });
  assert.equal(git(path.join(tmp, 'kho'), 'remote', 'get-url', 'origin'), 'https://github.com/me/my-skills');
});

test('publish cần confirm, quét riêng tư, rồi push và cập nhật README', async () => {
  await ready();
  mk(lib, 'hay', md('hay', 'Skill hay'), { 'a.txt': 'ok' });
  mk(lib, 'ro', md('ro', 'Rò'), { 'n.txt': 'see /Users/bob/secret\nmail bob@example.com' });
  await assert.rejects(repo.publish({ names: ['hay'] }), { code: 'confirm_required' });
  await assert.rejects(repo.publish({ names: ['ro'], confirm: true }), (e) => e.code === 'private_info' && e.extra.findings.length === 2);
  assert.ok(!fs.existsSync(path.join(tmp, 'kho', 'ro')));
  const r = await repo.publish({ names: ['hay'], confirm: true });
  assert.equal(r.pushed, true);
  assert.equal(git(remote, 'log', '--oneline', 'main').split('\n').length, 2);
  assert.match(fs.readFileSync(path.join(tmp, 'kho', 'README.md'), 'utf8'), /\[hay\]\(hay\/\) \| Skill hay/);
  const forced = await repo.publish({ names: ['ro'], confirm: true, force: true });
  assert.equal(forced.pushed, true);
});

test('status so sánh thư viện với repo; pull + apply kéo bản mới về', async () => {
  await ready();
  mk(lib, 'hay', md('hay', 'v1'));
  await repo.publish({ names: ['hay'], confirm: true });
  assert.equal((await repo.status()).skills.find((s) => s.name === 'hay').state, 'same');
  // máy khác đẩy bản mới + skill mới
  const other = path.join(tmp, 'other');
  git(tmp, 'clone', remote, other);
  fs.writeFileSync(path.join(other, 'hay', 'SKILL.md'), md('hay', 'v2'));
  mk(other, 'moi', md('moi', 'Mới'));
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'x');
  git(other, 'push', 'origin', 'main');
  fs.writeFileSync(path.join(lib, 'hay', '.studio.json'), '{"channels":["k1"]}');
  const st = await repo.pull();
  assert.deepEqual(st.skills.map((s) => [s.name, s.state]), [['hay', 'changed'], ['moi', 'repo_only']]);
  repo.apply({ names: ['hay', 'moi'] });
  assert.match(fs.readFileSync(path.join(lib, 'hay', 'SKILL.md'), 'utf8'), /v2/);
  assert.ok(fs.existsSync(path.join(lib, 'moi', 'SKILL.md')));
  assert.equal(fs.readFileSync(path.join(lib, 'hay', '.studio.json'), 'utf8'), '{"channels":["k1"]}');
});

test('sync.sh kéo về và liên kết skill vào thư mục đích, bỏ qua thư mục thật', async () => {
  await ready();
  mk(lib, 'hay', md('hay', 'x'));
  mk(lib, 'co', md('co', 'x'));
  await repo.publish({ names: ['hay', 'co'], confirm: true });
  const dest = path.join(tmp, 'claude-skills');
  fs.mkdirSync(path.join(dest, 'co'), { recursive: true });
  const clone = path.join(tmp, 'clone');
  git(tmp, 'clone', remote, clone);
  const out = execFileSync('sh', [path.join(clone, 'sync.sh')], { encoding: 'utf8', env: { ...process.env, CLAUDE_SKILLS_DIR: dest } });
  assert.match(out, /linked hay/);
  assert.match(out, /skip co/);
  assert.ok(fs.lstatSync(path.join(dest, 'hay')).isSymbolicLink());
});

test('scanDir bắt token và bỏ qua file nhị phân', () => {
  mk(lib, 'x', md('x', 'd'), { 'k.txt': 'key ghp_abcdefghijklmnopqrstuvwxyz0123', 'b.bin': Buffer.from([0, 1, 2]) });
  const f = scanDir(path.join(lib, 'x'));
  assert.deepEqual(f.map((x) => x.kind), ['token']);
});

test('API: GET /api/skill-repo và lỗi khi chưa tạo kho', async () => {
  const app = await buildApp({ store: { tokensSince: () => 0 }, projects: { list: () => [] }, token: TOKEN, home, skillRepo: repo, skills: {} });
  const h = { host: '127.0.0.1:4318', 'x-studio-token': TOKEN };
  const g = await app.inject({ method: 'GET', url: '/api/skill-repo', headers: h });
  assert.equal(g.statusCode, 200);
  assert.equal(g.json().configured, false);
  const p = await app.inject({ method: 'POST', url: '/api/skill-repo/publish', headers: h, payload: { names: ['a'], confirm: true } });
  assert.equal(p.statusCode, 409);
  await repo.init({ dir: path.join(tmp, 'kho') });
  mk(lib, 'ro', md('ro', 'd'), { 'n.txt': '/Users/bob/x' });
  const q = await app.inject({ method: 'POST', url: '/api/skill-repo/publish', headers: h, payload: { names: ['ro'], confirm: true } });
  assert.equal(q.statusCode, 409);
  assert.equal(q.json().findings.length, 1);
  await app.close();
});

test('init với repo đã có skill: tải về, skill hiện là chỉ-có-trên-kho, apply lấy vào thư viện', async () => {
  const seed = path.join(tmp, 'seed');
  git(tmp, 'clone', remote, seed);
  mk(seed, 'san', md('san', 'Có sẵn'));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', 'origin', 'HEAD:main');
  const fake = 'https://github.com/me/my-skills';
  const { run } = await import('../server/skill-repo.js');
  const exec = (cmd, args, o) => run(cmd, args.map((a) => (a === fake ? remote : a)), o);
  const r2 = createSkillRepo({ home, exec, gh: async () => ({ code: -1, out: '', err: '' }) });
  const st = await r2.init({ url: fake, dir: path.join(tmp, 'kho') });
  assert.deepEqual(st.skills.map((s) => [s.name, s.state]), [['san', 'repo_only']]);
  assert.ok(fs.existsSync(path.join(tmp, 'kho', 'sync.sh')));
  r2.apply({ names: ['san'] });
  assert.ok(fs.existsSync(path.join(lib, 'san', 'SKILL.md')));
  await assert.rejects(createSkillRepo({ home: path.join(tmp, 'h2'), exec: (c, a, o) => run(c, a.map((x) => (x === fake ? path.join(tmp, 'none.git') : x)), o) }).init({ url: fake, dir: path.join(tmp, 'k2') }), { code: 'remote_unreachable' });
});
