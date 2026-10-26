import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/db.js';
import { backupDb, createService, persistentToken, plistXml, rotateLog, runServiceCommand } from '../server/service.js';

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-svc-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// launchctl giả: ghi lại lệnh; bootstrap → đã nạp, bootout → gỡ.
function fakeLaunchctl() {
  const calls = [];
  let loaded = false;
  const fn = (args) => {
    calls.push(args);
    if (args[0] === 'print') return { status: loaded ? 0 : 113, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    return { status: 0, stdout: '', stderr: '' };
  };
  return { fn, calls, isLoaded: () => loaded };
}

test('token cố định: tạo 1 lần, quyền 600, lần sau đọc lại đúng token', () => {
  const t1 = persistentToken(tmp);
  assert.ok(t1.length >= 24);
  assert.equal(fs.statSync(path.join(tmp, 'token')).mode & 0o777, 0o600);
  assert.equal(persistentToken(tmp), t1);
});

test('plist: chạy node cli --service ở cổng cố định, PATH + VS_HOME, tự chạy lại khi lỗi, escape XML', () => {
  const x = plistXml({ label: 'com.t', node: '/n/node', cli: '/a&b/cli.js', port: 4318, home: '/h', workdir: '/w', pathEnv: '/bin:/x', logFile: '/h/logs/server.log' });
  assert.match(x, /<string>\/n\/node<\/string>\s*<string>\/a&amp;b\/cli.js<\/string>\s*<string>--service<\/string>\s*<string>--port<\/string>\s*<string>4318<\/string>/);
  assert.match(x, /<key>PATH<\/key><string>\/bin:\/x<\/string>/);
  assert.match(x, /<key>VS_HOME<\/key><string>\/h<\/string>/);
  assert.match(x, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(x, /<key>SuccessfulExit<\/key><false\/>/);
  assert.ok(!x.includes('VS_TOKEN'));
});

test('install/status/restart/uninstall với launchctl giả + server health giả', async () => {
  const srv = http.createServer((req, res) => res.end(req.url === '/api/health' ? '{"ok":true}' : ''));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const lc = fakeLaunchctl();
  const agentsDir = path.join(tmp, 'LaunchAgents');
  const svc = createService({ home: tmp, port, label: 'com.videostudio.test', agentsDir, uid: 501, launchctl: lc.fn, platform: 'darwin' });
  // Cổng đã có server khác (không phải dịch vụ) → từ chối cài.
  await assert.rejects(svc.install(), /đang có Video Studio khác/);
  assert.ok(!fs.existsSync(svc.plistFile));

  // Giả lập: dịch vụ đã nạp (bản cũ) → cài lại = bootout rồi bootstrap.
  lc.fn(['bootstrap', 'gui/501', 'x']);
  lc.calls.length = 0;
  fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'logs', 'server.log'), 'x'.repeat(20));
  const r = await svc.install();
  assert.equal(r.healthy, true);
  assert.ok(fs.existsSync(path.join(tmp, 'token')));
  assert.match(fs.readFileSync(svc.plistFile, 'utf8'), /com\.videostudio\.test/);
  assert.deepEqual(lc.calls.filter((c) => c[0] !== 'print'), [['bootout', 'gui/501/com.videostudio.test'], ['bootstrap', 'gui/501', svc.plistFile]]);

  assert.deepEqual(await svc.status(), { installed: true, loaded: true, healthy: true, port, logFile: svc.logFile });
  assert.equal((await svc.restart()).healthy, true);
  assert.deepEqual(lc.calls.at(-1), ['kickstart', '-k', 'gui/501/com.videostudio.test']);

  assert.equal(svc.uninstall().removed, true);
  assert.ok(!fs.existsSync(svc.plistFile));
  assert.equal(lc.isLoaded(), false);
  assert.equal(svc.uninstall().removed, false);
  await assert.rejects(svc.restart(), /chưa cài/);
  srv.close();
});

test('open: mở link không token; chưa có mật khẩu → mã thiết lập mới; không phải macOS → báo lỗi rõ', async () => {
  const opened = [];
  const svc = createService({ home: tmp, port: 4999, agentsDir: tmp, openUrl: (u) => opened.push(u), launchctl: () => ({ status: 1 }), platform: 'linux' });
  const r = svc.open();
  assert.equal(opened[0], 'http://127.0.0.1:4999/');
  assert.match(r.setupCode, /^\d{6}$/);
  const store = openStore(path.join(tmp, 'studio.db'));
  store.setSetting('login.password', 'scrypt$x');
  store.close();
  assert.equal(svc.open().setupCode, null);
  await assert.rejects(svc.install(), /chỉ có trên macOS/);
});

test('runServiceCommand: help, tham số sai, status', async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.equal(await runServiceCommand([], { home: tmp, env: {}, log }), 0);
  assert.match(logs[0], /install/);
  assert.equal(await runServiceCommand(['lung-tung'], { home: tmp, env: {}, log }), 1);
  await assert.rejects(runServiceCommand(['status', '--port', 'abc'], { home: tmp, env: {}, log }), /--port/);
  const code = await runServiceCommand(['status', '--port', '1'], { home: tmp, env: {}, log, agentsDir: tmp, launchctl: () => ({ status: 113 }) });
  assert.equal(code, 1);
  assert.match(logs.at(-1), /Cài: không/);
});

test('sao lưu DB: 1 bản/ngày, mở được, giữ 7 bản mới nhất', async () => {
  const store = openStore(path.join(tmp, 'studio.db'));
  store.setSetting('k', 'v');
  const dir = path.join(tmp, 'backups');
  const made = await backupDb(store.db, dir, { now: new Date(2026, 9, 26) });
  assert.equal(path.basename(made), 'studio-2026-10-26.db');
  assert.equal(await backupDb(store.db, dir, { now: new Date(2026, 9, 26, 23) }), null);
  const copy = openStore(made);
  assert.equal(copy.getSetting('k'), 'v');
  copy.close();
  for (let d = 1; d <= 9; d++) await backupDb(store.db, dir, { now: new Date(2026, 10, d) });
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'studio-2026-11-03.db');
  store.close();
});

test('xoay log: quá ngưỡng → .1', () => {
  const f = path.join(tmp, 'server.log');
  fs.writeFileSync(f, 'abc');
  rotateLog(f, 10);
  assert.ok(fs.existsSync(f));
  rotateLog(f, 2);
  assert.ok(!fs.existsSync(f));
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8'), 'abc');
});
