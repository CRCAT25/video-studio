import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirPicker } from '../server/pick-dir.js';

// run giả: không mở hộp thoại thật.
const fake = (err, stdout = '', stderr = '') => (bin, args, opts, cb) => setImmediate(() => cb(err, stdout, stderr));

test('pick-dir: chọn được → path bỏ dấu / cuối', async () => {
  const pick = createDirPicker({ platform: 'darwin', run: fake(null, '/Users/a/Videos/\n') });
  assert.deepEqual(await pick(), { path: '/Users/a/Videos' });
});

test('pick-dir: bấm Hủy (-128) hoặc stdout lạ → cancelled', async () => {
  const c = createDirPicker({ platform: 'darwin', run: fake(new Error('x'), '', 'execution error: User canceled. (-128)') });
  assert.deepEqual(await c(), { cancelled: true });
  const o = createDirPicker({ platform: 'darwin', run: fake(null, 'khong-phai-duong-dan') });
  assert.deepEqual(await o(), { cancelled: true });
});

test('pick-dir: lỗi khác → pick_failed; không phải macOS → unsupported', async () => {
  const f = createDirPicker({ platform: 'darwin', run: fake(new Error('boom')) });
  await assert.rejects(f(), { code: 'pick_failed' });
  const old = process.env.VS_PICK_DIR_BIN;
  delete process.env.VS_PICK_DIR_BIN;
  try {
    await assert.rejects(createDirPicker({ platform: 'linux', run: fake(null, '/x') })(), { code: 'unsupported' });
  } finally {
    if (old !== undefined) process.env.VS_PICK_DIR_BIN = old;
  }
});

test('pick-dir: chỉ mở một hộp thoại tại một thời điểm', async () => {
  let n = 0;
  const pick = createDirPicker({ platform: 'darwin', run: (b, a, o, cb) => { n++; setImmediate(() => cb(null, '/a/b', '')); } });
  const [x, y] = await Promise.all([pick(), pick()]);
  assert.equal(n, 1);
  assert.deepEqual(x, y);
});
