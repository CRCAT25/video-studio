import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { createSkills, parseSkillMd, skillScope, skillsForChannel } from '../server/skills.js';

const TOKEN = 'test-token-abcdefghijklmnop';
let tmp, home, local, presetList, skills, channelList;

const mk = (root, name, text, extra = {}) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), text);
  for (const [f, c] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, name, f)), { recursive: true });
    fs.writeFileSync(path.join(root, name, f), c);
  }
};
const md = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nLàm theo.\n`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-skills-'));
  home = path.join(tmp, 'home');
  local = path.join(tmp, 'local');
  fs.mkdirSync(home);
  fs.mkdirSync(local);
  presetList = [];
  channelList = [{ id: 'ka', name: 'Kênh A' }, { id: 'kb', name: 'Kênh B' }];
  skills = createSkills({ home, localRoot: local, presets: () => ({ presets: presetList }), channels: () => channelList });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('parseSkillMd đọc name/description một dòng và khối >', () => {
  assert.deepEqual(parseSkillMd(md('a', 'mô tả')), { title: 'a', description: 'mô tả' });
  const r = parseSkillMd('---\nname: "x"\ndescription: >\n  dòng một\n  dòng hai\n---\nbody');
  assert.deepEqual(r, { title: 'x', description: 'dòng một dòng hai' });
  assert.deepEqual(parseSkillMd('không có frontmatter'), { title: '', description: '' });
});

test('nhập từ máy: liệt kê, chép cả thư mục, trùng tên → 409, rename → -2', () => {
  mk(local, 'edit-video', md('Edit video', 'cắt ghép'), { 'refs/a.txt': 'x' });
  fs.symlinkSync('/etc/hosts', path.join(local, 'edit-video', 'link'));
  assert.equal(skills.local()[0].imported, false);
  assert.deepEqual(skills.importLocal({ names: ['edit-video'] }), ['edit-video']);
  assert.equal(fs.readFileSync(path.join(skills.lib, 'edit-video', 'refs/a.txt'), 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(skills.lib, 'edit-video', 'link')), false);
  assert.equal(skills.local()[0].imported, true);
  assert.throws(() => skills.importLocal({ names: ['edit-video'] }), (e) => e.status === 409 && e.code === 'skill_exists');
  assert.deepEqual(skills.importLocal({ names: ['edit-video'], rename: true }), ['edit-video-2']);
  assert.throws(() => skills.importLocal({ names: ['không-có'] }), (e) => e.status === 400);
});

test('dán nội dung: lấy tên từ frontmatter, chặn tên lạ và nội dung rỗng/quá lớn', () => {
  assert.deepEqual(skills.importText({ content: md('Viết Hook', 'd') }), ['viet-hook']);
  assert.throws(() => skills.importText({ name: 'local', content: 'x' }), (e) => e.code === 'invalid_name');
  assert.throws(() => skills.importText({ name: 'a', content: '  ' }), (e) => e.code === 'invalid_body');
  assert.throws(() => skills.importText({ name: 'a', content: 'x'.repeat(201 * 1024) }), (e) => e.code === 'skill_too_big');
});

test('xem, sửa, xóa; tên có ../ không thoát khỏi thư viện', () => {
  skills.importText({ name: 'abc', content: md('abc', 'd') });
  assert.equal(skills.list()[0].description, 'd');
  assert.match(skills.read('abc').content, /Làm theo/);
  skills.write('abc', md('abc', 'mới'));
  assert.equal(skills.list()[0].description, 'mới');
  for (const bad of ['../x', '..', 'a/b', 'local', 'ABC']) assert.throws(() => skills.read(bad), (e) => e.status === 404);
  skills.remove('abc');
  assert.equal(skills.list().length, 0);
  assert.throws(() => skills.remove('abc'), (e) => e.status === 404);
});

test('usedBy: quy trình có trỏ tới thư mục skill', () => {
  skills.importText({ name: 'abc', content: md('abc', 'd') });
  presetList = [{ id: 'p1', name: 'P1', skills: [path.join(skills.lib, 'abc')] }, { id: 'p2', name: 'P2', skills: ['/khac'] }];
  assert.deepEqual(skills.list()[0].usedBy, [{ id: 'p1', name: 'P1' }]);
  assert.deepEqual(skills.remove('abc').usedBy, [{ id: 'p1', name: 'P1' }]);
});

test('GitHub: link lạ bị từ chối; quét → candidates; có names → nhập (clone giả bằng repo cục bộ)', async () => {
  const src = path.join(tmp, 'src');
  mk(path.join(src, 'skills'), 'one', md('one', 'm1'));
  mk(path.join(src, 'skills'), 'two', md('two', 'm2'));
  execFileSync('git', ['init', '-q', src]);
  const calls = [];
  const clone = async ({ url, branch, dir }) => {
    calls.push({ url, branch });
    fs.cpSync(src, dir, { recursive: true });
  };
  const s = createSkills({ home, localRoot: local, clone });
  for (const bad of ['http://github.com/a/b', 'https://evil.com/a/b', 'https://github.com/a', 'file:///etc', 'https://github.com/a/b/tree/main/../../x', '']) {
    await assert.rejects(() => s.importGithub({ url: bad }), (e) => e.status === 400, bad);
  }
  const r = await s.importGithub({ url: 'https://github.com/o/r/tree/dev' });
  assert.deepEqual(r.candidates.map((c) => c.name), ['one', 'two']);
  assert.deepEqual(calls[0], { url: 'https://github.com/o/r.git', branch: 'dev' });
  const r2 = await s.importGithub({ url: 'https://github.com/o/r', names: ['two'] });
  assert.deepEqual(r2.imported, ['two']);
  assert.equal(s.list().length, 1);
  const r3 = await s.importGithub({ url: 'https://github.com/o/r/tree/main/skills/one', names: ['one'] });
  assert.deepEqual(r3.imported, ['one']);
});

test('API: /api/skills* đi qua xác thực và trả lỗi chuẩn', async () => {
  const app = await buildApp({ store: { tokensSince: () => 0 }, projects: { list: () => [] }, token: TOKEN, home, skills });
  const h = { host: '127.0.0.1:4318', 'x-studio-token': TOKEN };
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/skills', headers: { host: h.host } })).statusCode, 401);
    const imp = await app.inject({ method: 'POST', url: '/api/skills/import', headers: h, payload: { source: 'text', name: 'abc', content: md('abc', 'd') } });
    assert.equal(imp.statusCode, 201);
    assert.deepEqual(imp.json().imported, ['abc']);
    const dup = await app.inject({ method: 'POST', url: '/api/skills/import', headers: h, payload: { source: 'text', name: 'abc', content: 'x' } });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error, 'skill_exists');
    assert.equal((await app.inject({ method: 'POST', url: '/api/skills/import', headers: h, payload: { source: 'x' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/skills', headers: h })).json().skills.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/skills/local', headers: h })).statusCode, 200);
    const put = await app.inject({ method: 'PUT', url: '/api/skills/abc', headers: h, payload: { content: md('abc', 'sửa') } });
    assert.match(put.json().content, /sửa/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/skills/nope', headers: h })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/skills/abc', headers: h, payload: {} })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('phạm vi kênh: mặc định dùng chung, chọn nhiều kênh, về dùng chung, kênh lạ → 400, đọc được định dạng cũ, .studio.json không bị chép', () => {
  assert.deepEqual(skills.importText({ name: 'chung', content: md('chung', 'd') }), ['chung']);
  const byName = (n) => skills.list().find((s) => s.name === n);
  assert.deepEqual([byName('chung').shared, byName('chung').channels], [true, []]);
  assert.equal(skills.setScope('chung', { channels: ['ka', 'kb', 'ka'] }).shared, false);
  assert.deepEqual(byName('chung').channels, ['ka', 'kb']);
  assert.deepEqual(skills.read('chung').channels, ['ka', 'kb']);
  assert.deepEqual(skillScope(path.join(skills.lib, 'chung')), { shared: false, channels: ['ka', 'kb'] });
  skills.setScope('chung', { channels: [] });
  assert.deepEqual([byName('chung').shared, byName('chung').channels], [false, []]);
  skills.setScope('chung', { all: true });
  assert.equal(byName('chung').shared, true);
  assert.equal(fs.existsSync(path.join(skills.lib, 'chung', '.studio.json')), false);
  assert.throws(() => skills.setScope('chung', { channels: ['lạ'] }), (e) => e.status === 400 && e.code === 'channel_not_found');
  assert.throws(() => skills.setScope('chung', { channels: [5] }), (e) => e.code === 'invalid_channel');
  assert.throws(() => skills.setScope('khong-co', { all: true }), (e) => e.status === 404);
  // Định dạng cũ {channel} vẫn đọc được.
  fs.writeFileSync(path.join(skills.lib, 'chung', '.studio.json'), '{"channel":"ka"}');
  assert.deepEqual(skillScope(path.join(skills.lib, 'chung')), { shared: false, channels: ['ka'] });
  // File phạm vi trong nguồn nhập (vd. repo GitHub) không được tự đặt phạm vi.
  mk(local, 'ngoai', md('ngoai', 'd'), { '.studio.json': '{"channels":["ka"]}' });
  skills.importLocal({ names: ['ngoai'] });
  assert.equal(byName('ngoai').shared, true);
});

test('skillsForChannel: giữ skill chung + skill có kênh trong danh sách; không kênh → chỉ skill chung', () => {
  for (const n of ['chung', 'a', 'b', 'ab']) skills.importText({ name: n, content: md(n, 'd') });
  skills.setScope('a', { channels: ['ka'] });
  skills.setScope('b', { channels: ['kb'] });
  skills.setScope('ab', { channels: ['ka', 'kb'] });
  const dirs = ['chung', 'a', 'b', 'ab'].map((n) => path.join(skills.lib, n));
  const names = (ch) => skillsForChannel(dirs, ch).map((d) => path.basename(d));
  assert.deepEqual(names('ka'), ['chung', 'a', 'ab']);
  assert.deepEqual(names('kb'), ['chung', 'b', 'ab']);
  assert.deepEqual(names(null), ['chung']);
  assert.deepEqual(names(undefined), ['chung']);
});

test('API: PUT /api/skills/:name/scope', async () => {
  const app = await buildApp({ store: { tokensSince: () => 0 }, projects: { list: () => [] }, token: TOKEN, home, skills });
  const h = { host: '127.0.0.1:4318', 'x-studio-token': TOKEN };
  try {
    await app.inject({ method: 'POST', url: '/api/skills/import', headers: h, payload: { source: 'text', name: 'abc', content: md('abc', 'd') } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/skills/abc', headers: h })).json().shared, true);
    const r = await app.inject({ method: 'PUT', url: '/api/skills/abc/scope', headers: h, payload: { channels: ['ka'] } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().shared, r.json().channels], [false, ['ka']]);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/skills/abc/scope', headers: h, payload: { all: true } })).json().shared, true);
    const bad = await app.inject({ method: 'PUT', url: '/api/skills/abc/scope', headers: h, payload: { channels: ['lạ'] } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'channel_not_found');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/skills/nope/scope', headers: h, payload: { all: true } })).statusCode, 404);
  } finally {
    await app.close();
  }
});
