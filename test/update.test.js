import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UpdateError, runUpdate } from '../server/update.js';

let tmp, origin, work, clone;
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const commit = (dir, file, text) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `sửa ${file}`);
};
// git thật, npm giả (ghi lại lệnh); fail = tên lệnh npm sẽ lỗi.
function runner({ fail } = {}) {
  const npm = [];
  const run = (cmd, args, { cwd } = {}) => {
    if (cmd === 'npm') {
      npm.push(args.join(' '));
      return { status: args.join(' ') === fail ? 1 : 0, stdout: '', stderr: '' };
    }
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: ENV });
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  };
  return { run, npm };
}
const quiet = () => {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-upd-'));
  origin = path.join(tmp, 'origin.git');
  work = path.join(tmp, 'work');
  clone = path.join(tmp, 'clone');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'package.json', '{"v":1}');
  git(work, 'push', '-q', 'origin', 'main');
  git(tmp, 'clone', '-q', origin, clone);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('đã mới nhất → không build', () => {
  const r = runner();
  assert.deepEqual(runUpdate({ root: clone, run: r.run, log: quiet }).updated, false);
  assert.deepEqual(r.npm, []);
});

test('có commit mới, package không đổi → pull + build, không npm install', () => {
  commit(work, 'a.js', '1');
  commit(work, 'b.js', '2');
  git(work, 'push', '-q', 'origin', 'main');
  const r = runner();
  const res = runUpdate({ root: clone, run: r.run, log: quiet });
  assert.equal(res.updated, true);
  assert.equal(res.commits, 2);
  assert.equal(res.installed, false);
  assert.deepEqual(r.npm, ['run build']);
  assert.ok(fs.existsSync(path.join(clone, 'b.js')));
});

test('package.json đổi → npm install rồi build; build lỗi → UpdateError', () => {
  commit(work, 'package.json', '{"v":2}');
  git(work, 'push', '-q', 'origin', 'main');
  const r = runner({ fail: 'run build' });
  assert.throws(() => runUpdate({ root: clone, run: r.run, log: quiet }), (e) => e instanceof UpdateError && /build lỗi/.test(e.message));
  assert.deepEqual(r.npm, ['install', 'run build']);
});

test('file đã sửa chưa commit → từ chối, không pull', () => {
  commit(work, 'a.js', '1');
  git(work, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(clone, 'package.json'), '{"local":true}');
  fs.writeFileSync(path.join(clone, 'rac.txt'), 'file lạ không chặn');
  const r = runner();
  assert.throws(() => runUpdate({ root: clone, run: r.run, log: quiet }), /chưa commit[\s\S]*package\.json/);
  assert.ok(!fs.existsSync(path.join(clone, 'a.js')));
});

test('nhánh lệch (không fast-forward được) → UpdateError; không phải repo git → UpdateError', () => {
  commit(work, 'a.js', 'remote');
  git(work, 'push', '-q', 'origin', 'main');
  commit(clone, 'local.js', 'local');
  const r = runner();
  assert.throws(() => runUpdate({ root: clone, run: r.run, log: quiet }), /git pull không thành công/);
  assert.deepEqual(r.npm, []);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-upd-plain-'));
  try {
    assert.throws(() => runUpdate({ root: plain, run: r.run, log: quiet }), /không phải repo git/);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('cli: --update và update gọi runUpdate; UpdateError → mã thoát 1', async () => {
  const { main } = await import('../server/cli.js');
  let n = 0;
  assert.deepEqual(await main(['--update'], {}, { update: () => n++ }), { exitCode: 0 });
  assert.deepEqual(await main(['update'], {}, { update: () => n++ }), { exitCode: 0 });
  assert.equal(n, 2);
  const err = console.error;
  console.error = quiet;
  try {
    const r = await main(['--update'], {}, {
      update: () => {
        throw new UpdateError('x');
      },
    });
    assert.deepEqual(r, { exitCode: 1 });
  } finally {
    console.error = err;
  }
});
