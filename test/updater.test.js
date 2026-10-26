import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, githubRepo, isNewer, parseVersion } from '../server/updater.js';

// fetch giả trả Release (null → 404; 'boom' → lỗi mạng); đếm số lượt gọi.
function fakeFetch(release) {
  const f = async (url) => {
    f.calls.push(url);
    if (release === 'boom') throw new Error('offline');
    if (release === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => release };
  };
  f.calls = [];
  return f;
}
const REL = { tag_name: 'v0.2.0', name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0' };

test('parseVersion / isNewer so đúng số, bỏ định dạng lạ', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('1.0.0-beta', '0.1.0'), false);
});

test('githubRepo đọc field repository', () => {
  assert.equal(githubRepo({ repository: { url: 'https://github.com/CRCAT25/video-studio.git' } }), 'CRCAT25/video-studio');
  assert.equal(githubRepo({ repository: 'git@github.com:a/b.git' }), 'a/b');
  assert.equal(githubRepo({ repository: 'https://gitlab.com/a/b' }), null);
  assert.equal(githubRepo({}), null);
});

test('check: có Release mới hơn → newer; cache theo ttl; force gọi lại', async () => {
  let t = 1_000;
  const fetchFn = fakeFetch(REL);
  const u = createUpdater({ current: '0.1.0', repo: 'o/r', apiBase: 'http://gh', fetchFn, now: () => t, ttlMs: 100 });
  const s = await u.check();
  assert.equal(fetchFn.calls[0], 'http://gh/repos/o/r/releases/latest');
  assert.equal(s.newer, true);
  assert.equal(s.latest, '0.2.0');
  assert.equal(s.url, REL.html_url);
  await u.check();
  assert.equal(fetchFn.calls.length, 1);
  t += 200;
  await u.check();
  assert.equal(fetchFn.calls.length, 2);
  await u.check({ force: true });
  assert.equal(fetchFn.calls.length, 3);
});

test('check: cùng bản / chưa có Release / mạng lỗi / tắt → không báo', async () => {
  assert.equal((await createUpdater({ current: '0.2.0', repo: 'o/r', fetchFn: fakeFetch(REL) }).check()).newer, false);
  assert.equal((await createUpdater({ current: '0.1.0', repo: 'o/r', fetchFn: fakeFetch(null) }).check()).newer, false);
  const s = await createUpdater({ current: '0.1.0', repo: 'o/r', fetchFn: fakeFetch('boom') }).check();
  assert.equal(s.newer, false);
  assert.equal(s.checkedAt, null);
  const off = fakeFetch(REL);
  assert.equal((await createUpdater({ current: '0.1.0', repo: 'o/r', fetchFn: off, enabled: false }).check()).newer, false);
  assert.equal(off.calls.length, 0);
});

test('check: link Release ngoài github.com bị bỏ', async () => {
  const s = await createUpdater({ current: '0.1.0', repo: 'o/r', fetchFn: fakeFetch({ ...REL, html_url: 'https://evil.example/x' }) }).check();
  assert.equal(s.newer, true);
  assert.equal(s.url, null);
});

test('start: running → done; không chạy trùng; lỗi → error kèm log; báo listener', async () => {
  let exit;
  let spawned = 0;
  const u = createUpdater({
    current: '0.1.0',
    repo: 'o/r',
    fetchFn: fakeFetch(REL),
    spawnUpdate: ({ onOutput, onExit }) => {
      spawned++;
      onOutput('git pull lỗi\n');
      exit = onExit;
    },
  });
  const seen = [];
  u.on(() => seen.push(u.status().state));
  assert.equal(u.start().state, 'running');
  u.start();
  assert.equal(spawned, 1);
  exit(1);
  assert.equal(u.status().state, 'error');
  assert.match(u.status().log, /git pull lỗi/);
  u.start();
  exit(0);
  assert.equal(u.status().state, 'done');
  assert.equal(u.status().log, null);
  u.start();
  assert.equal(spawned, 2);
  assert.deepEqual(seen, ['running', 'error', 'running', 'done']);
});

test('restart chỉ có khi được truyền hàm restart', () => {
  assert.equal(createUpdater({ repo: null }).status().canRestart, false);
  let n = 0;
  const u = createUpdater({ repo: null, restart: () => n++ });
  assert.equal(u.status().canRestart, true);
  u.restart();
  assert.equal(n, 1);
});
