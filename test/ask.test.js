import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAskPrompt, createAsk } from '../server/ask.js';

const src = { dir: '', title: 'P', stepName: 'Hình', state: 'done', promptTemplate: 'vẽ', runCount: 3, lastSummary: 'xong', lastError: '', lastResult: 'r', feedbacks: ['đổi hình'], artifacts: ['images/a.png'] };

test('ask: prompt gói dữ liệu và câu hỏi', () => {
  const p = buildAskPrompt(src, 'Vì sao hình không đổi?', [{ q: 'a', a: 'b' }]);
  assert.match(p, /BẮT ĐẦU DỮ LIỆU/);
  assert.match(p, /images\/a\.png/);
  assert.match(p, /Câu hỏi: Vì sao hình không đổi\?/);
  assert.match(p, /Hỏi: a\nĐáp: b/);
});

test('ask: chạy claude giả trong thư mục dự án, câu hỏi rỗng → 400', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ask-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const claude = path.join(d, 'claude.mjs');
  fs.writeFileSync(claude, "#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'result',is_error:false,structured_output:{answer:'Vì code vẽ lại giống nhau',rerun_feedback:'Vẽ lại sáng hơn'}}));\n");
  const a = createAsk({ claudeBin: claude });
  assert.deepEqual(await a.ask({ ...src, dir: d }, 'Vì sao?'), { answer: 'Vì code vẽ lại giống nhau', rerunFeedback: 'Vẽ lại sáng hơn' });
  await assert.rejects(() => a.ask({ ...src, dir: d }, '  '), { code: 'bad_message' });
});
