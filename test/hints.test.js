// Bản sửa "Kiến thức gốc" (server/hints.js) và cách trợ lý lấy bản đang dùng (hint()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hintsPath, readHints, writeHint } from '../server/hints.js';
import { HINTS, hint, setHintOverrides } from '../web/src/lib/aiHints.js';

test('hints.json: ghi/đọc, trùng gốc hoặc rỗng = về mặc định, bỏ id lạ', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-hints-'));
  assert.deepEqual(readHints(home), {});
  assert.deepEqual(writeHint(home, 'cost', '  Hỏi người dùng trước.  '), { cost: 'Hỏi người dùng trước.' });
  assert.deepEqual(readHints(home), { cost: 'Hỏi người dùng trước.' });
  assert.throws(() => writeHint(home, 'khongco', 'x'), /Không có mục/);
  assert.throws(() => writeHint(home, '__proto__', 'x'), /Không có mục/);
  assert.throws(() => writeHint(home, 'cost', 'x'.repeat(601)), /dài quá/);
  assert.deepEqual(writeHint(home, 'cost', HINTS.cost.text), {});
  assert.equal(fs.existsSync(hintsPath(home)), false);
  fs.writeFileSync(hintsPath(home), JSON.stringify({ cost: 'A', khongco: 'B', tts: 5 }));
  assert.deepEqual(readHints(home), { cost: 'A' });
  fs.writeFileSync(hintsPath(home), '{hỏng');
  assert.deepEqual(readHints(home), {});
  fs.rmSync(home, { recursive: true });
});

test('hint(): bản sửa đè nội dung, giữ tiêu đề', () => {
  setHintOverrides({ cost: 'Riêng.' });
  assert.deepEqual(hint('cost'), { title: HINTS.cost.title, text: 'Riêng.', custom: true });
  assert.equal(hint('tts').text, HINTS.tts.text);
  assert.equal(hint('tts').custom, false);
  assert.equal(hint('khongco'), null);
  setHintOverrides(null);
  assert.equal(hint('cost').text, HINTS.cost.text);
});
