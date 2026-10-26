import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { CSP } from '../server/auth.js';
import { openStore } from '../server/db.js';
import { contentTypeFor, parseRange, resolveMediaPath } from '../server/media.js';
import { loadChannels, loadPresets, REPO_ROOT } from '../server/presets.js';
import { createProjects } from '../server/projects.js';

const FIXTURE_PRESETS = path.join(REPO_ROOT, 'test', 'fixtures', 'presets');
const REPO_PRESETS = path.join(REPO_ROOT, 'presets');
const TOKEN = 'media-token-0123456789';
const HOST = '127.0.0.1:4318';
const BYTES = Buffer.from('0123456789abcdefghij'); // 20 byte

let tmp;
let home;
let store;
let app;
let dir;

const get = (url, headers = {}, method = 'GET') =>
  app.inject({ method, url, headers: { host: HOST, 'x-studio-token': TOKEN, ...headers } });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  store = openStore(path.join(home, 'studio.db'));
  const presets = () => loadPresets([FIXTURE_PRESETS]);
  const channels = () => loadChannels([REPO_PRESETS]);
  const projects = createProjects({ store, presets, channels, home });
  const v = projects.create({ presetId: 'e2e-short', title: 'Phim mèo' });
  dir = v.dir;
  fs.mkdirSync(path.join(dir, 'out', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'video.mp4'), BYTES);
  fs.writeFileSync(path.join(dir, 'script.md'), '# Kịch bản\nXin chào');
  fs.writeFileSync(path.join(dir, 'out', 'sub', 'phu-de.srt'), '1\n00:00:00,000 --> 00:00:01,000\nChào\n');
  fs.writeFileSync(path.join(dir, 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(dir, 'trang.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  fs.writeFileSync(path.join(dir, 'tên có dấu.txt'), 'ok');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(dir, '.studio', 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio', 'runs', 'r1', 'prompt.md'), 'prompt giả');
  fs.writeFileSync(path.join(dir, '.studio', 'lock'), '{"pid":1}');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'NGOÀI DỰ ÁN');
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(dir, 'link-ra-ngoai.txt'));
  fs.symlinkSync(path.join(dir, 'script.md'), path.join(dir, 'link-trong.md'));
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'link-env.txt'));
  fs.symlinkSync(tmp, path.join(dir, 'thu-muc-ngoai'));
  app = await buildApp({ store, projects, runner: null, presets, channels, token: TOKEN, webDist: path.join(tmp, 'no-dist'), home, logError: () => {} });
});

afterEach(async () => {
  await app.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseRange: một khoảng, a-, -n, sai/ngoài file/nhiều khoảng → invalid, không có → null', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('', 100), null);
  assert.equal(parseRange('items=0-5', 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  for (const h of ['bytes=100-', 'bytes=150-200', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'bytes=a-b', 'bytes=0-1,5-6', 'bytes=1.5-3']) {
    assert.equal(parseRange(h, 100), 'invalid', h);
  }
});

test('contentTypeFor: md/srt/txt → text/plain utf-8, json, mp4, wav, png; html/js không chạy được; lạ → octet-stream', () => {
  assert.equal(contentTypeFor('a/b.md'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeFor('x.SRT'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeFor('x.vtt'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeFor('x.json'), 'application/json');
  assert.equal(contentTypeFor('x.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('x.wav'), 'audio/wav');
  assert.equal(contentTypeFor('x.png'), 'image/png');
  assert.equal(contentTypeFor('x.html'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeFor('x.js'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeFor('x.bin'), 'application/octet-stream');
  assert.equal(contentTypeFor('khong-duoi'), 'application/octet-stream');
});

test('GET cả file 200 + accept-ranges + content-type theo đuôi; CSP có sandbox', async () => {
  const r = await get('/media/phim-meo/out/video.mp4');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.equal(r.headers['content-length'], '20');
  assert.deepEqual(r.rawPayload, BYTES);
  assert.equal(r.headers['content-security-policy'], `${CSP}; sandbox`);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');

  const md = await get('/media/phim-meo/script.md');
  assert.equal(md.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(md.body, '# Kịch bản\nXin chào');
  assert.equal((await get('/media/phim-meo/out/sub/phu-de.srt')).headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal((await get('/media/phim-meo/data.json')).headers['content-type'], 'application/json');
  const html = await get('/media/phim-meo/trang.html');
  assert.equal(html.headers['content-type'], 'text/plain; charset=utf-8');

  const enc = await get(`/media/phim-meo/${encodeURIComponent('tên có dấu.txt')}`);
  assert.equal(enc.statusCode, 200);
  assert.equal(enc.body, 'ok');
  const inner = await get('/media/phim-meo/link-trong.md');
  assert.equal(inner.statusCode, 200, 'symlink trỏ trong dự án vẫn đọc được');
});

test('Range: 206 bytes=a-b, a-, -n; 416 ngoài file/nhiều khoảng kèm content-range */size', async () => {
  const a = await get('/media/phim-meo/out/video.mp4', { range: 'bytes=0-3' });
  assert.equal(a.statusCode, 206);
  assert.equal(a.headers['content-range'], 'bytes 0-3/20');
  assert.equal(a.headers['content-length'], '4');
  assert.equal(a.body, '0123');

  const b = await get('/media/phim-meo/out/video.mp4', { range: 'bytes=15-' });
  assert.equal(b.statusCode, 206);
  assert.equal(b.headers['content-range'], 'bytes 15-19/20');
  assert.equal(b.body, 'fghij');

  const c = await get('/media/phim-meo/out/video.mp4', { range: 'bytes=-3' });
  assert.equal(c.statusCode, 206);
  assert.equal(c.body, 'hij');

  const d = await get('/media/phim-meo/out/video.mp4', { range: 'bytes=10-999' });
  assert.equal(d.statusCode, 206);
  assert.equal(d.headers['content-range'], 'bytes 10-19/20');

  for (const range of ['bytes=20-', 'bytes=30-40', 'bytes=0-1,4-5', 'bytes=x-y']) {
    const r = await get('/media/phim-meo/out/video.mp4', { range });
    assert.equal(r.statusCode, 416, range);
    assert.equal(r.headers['content-range'], 'bytes */20');
    assert.equal(r.json().error, 'range_not_satisfiable');
  }

  // client xem trước chữ gửi Range cho file rỗng → 200 rỗng, không 416
  const empty = await get('/media/phim-meo/empty.txt', { range: 'bytes=0-262143' });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body, '');
  const small = await get('/media/phim-meo/script.md', { range: 'bytes=0-262143' });
  assert.equal(small.statusCode, 206);
  assert.equal(small.body, '# Kịch bản\nXin chào');
});

test('HEAD giữ content-length thật, không có body', async () => {
  const r = await get('/media/phim-meo/out/video.mp4', {}, 'HEAD');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-length'], '20');
  assert.equal(r.body, '');
  const p = await get('/media/phim-meo/out/video.mp4', { range: 'bytes=0-4' }, 'HEAD');
  assert.equal(p.statusCode, 206);
  assert.equal(p.headers['content-length'], '5');
});

test('chặn thoát thư mục: ../ (thô và mã hóa), %00, đường dẫn tuyệt đối, symlink ra ngoài', async () => {
  const bad = [
    '/media/phim-meo/..%2f..%2foutside.txt',
    '/media/phim-meo/%2e%2e%2f%2e%2e%2foutside.txt',
    '/media/phim-meo/%2e%2e/%2e%2e/outside.txt',
    '/media/phim-meo/out/..%2f..%2f..%2foutside.txt',
    '/media/phim-meo/..%5c..%5coutside.txt',
    '/media/phim-meo/script.md%00.png',
    '/media/phim-meo/link-ra-ngoai.txt',
    '/media/phim-meo/link-env.txt',
    '/media/phim-meo/thu-muc-ngoai/outside.txt',
  ];
  for (const url of bad) {
    const r = await get(url);
    assert.ok([400, 403, 404].includes(r.statusCode), `${url} → ${r.statusCode}`);
    assert.doesNotMatch(r.body, /NGOÀI DỰ ÁN|SECRET/, url);
  }
  assert.equal((await get('/media/phim-meo/link-ra-ngoai.txt')).statusCode, 403);
  assert.equal((await get('/media/phim-meo/link-ra-ngoai.txt')).json().error, 'forbidden_path');
  assert.equal((await get('/media/phim-meo/..%2f..%2foutside.txt')).statusCode, 403);
  assert.equal((await get('/media/phim-meo/script.md%00.png')).statusCode, 403);
  // url "thô" có ../ được chuẩn hóa trước khi định tuyến cũng không ra ngoài
  const raw = await get('/media/phim-meo/../../outside.txt');
  assert.ok(raw.statusCode >= 400);
  assert.doesNotMatch(raw.body, /NGOÀI DỰ ÁN/);
});

test('dotfile và .studio bị chặn; ?studio=1 chỉ mở .studio/runs/…', async () => {
  const env = await get('/media/phim-meo/.env');
  assert.equal(env.statusCode, 403);
  assert.equal(env.json().error, 'forbidden_path');
  assert.equal((await get('/media/phim-meo/.studio/runs/r1/prompt.md')).statusCode, 403);
  assert.equal((await get('/media/phim-meo/.studio/lock?studio=1')).statusCode, 403);
  assert.equal((await get('/media/phim-meo/.studio/runs/..%2flock?studio=1')).statusCode, 403);
  assert.equal((await get('/media/phim-meo/.studio/runs/r1/..%2f..%2flock?studio=1')).statusCode, 403);
  assert.equal((await get('/media/phim-meo/.env?studio=1')).statusCode, 403);
  const ok = await get('/media/phim-meo/.studio/runs/r1/prompt.md?studio=1');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, 'prompt giả');
});

test('404: file không có, thư mục, rỗng, dự án lạ; 401 khi thiếu token', async () => {
  for (const url of ['/media/phim-meo/khong-co.mp4', '/media/phim-meo/out', '/media/phim-meo/out/', '/media/phim-meo/', '/media/khong-co/script.md']) {
    const r = await get(url);
    assert.equal(r.statusCode, 404, url);
    assert.equal(r.json().error, 'not_found');
  }
  const anon = await app.inject({ url: '/media/phim-meo/script.md', headers: { host: HOST } });
  assert.equal(anon.statusCode, 401);
  const cookie = await app.inject({ url: '/media/phim-meo/script.md', headers: { host: HOST, cookie: `vs_token=${TOKEN}` } });
  assert.equal(cookie.statusCode, 200);
  const host = await app.inject({ url: '/media/phim-meo/script.md', headers: { host: 'evil.com', 'x-studio-token': TOKEN } });
  assert.equal(host.statusCode, 421);
});

test('resolveMediaPath trực tiếp: trả realpath + stat; thư mục dự án mất → 404', () => {
  const r = resolveMediaPath(dir, 'out/video.mp4');
  assert.equal(r.abs, fs.realpathSync(path.join(dir, 'out', 'video.mp4')));
  assert.equal(r.stat.size, 20);
  assert.throws(() => resolveMediaPath(dir, '../outside.txt'), (e) => e.status === 403);
  assert.throws(() => resolveMediaPath(dir, '/etc/passwd'), (e) => e.status === 403 || e.status === 404);
  assert.throws(() => resolveMediaPath(path.join(tmp, 'mat-roi'), 'a.txt'), (e) => e.status === 404);
  assert.throws(() => resolveMediaPath(dir, ''), (e) => e.status === 404);
});
