import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyStyle, styleDefaults } from '../web/src/lib/style.js';
import { formatCatalog, suggestPipeline } from '../server/pipeline.js';
import { buildPrompt } from '../server/runner.js';
import { readStyle, writeStyle } from '../server/style.js';

const lib = formatCatalog().steps;
const ids = (p) => p.steps.filter((s) => s.enabled !== false).map((s) => s.id);

test('applyStyle: bỏ giọng đọc, thêm phụ đề/thumbnail/Shorts vào đúng chỗ; không đụng bản gốc', () => {
  const base = suggestPipeline({ length: 'long', orientation: 'horizontal', aspect: '16:9' });
  const before = JSON.stringify(base);
  assert.deepEqual(styleDefaults(base), { review: 'all', voice: true, subtitles: false, thumbnail: true, shorts: false });
  const p = applyStyle(base, { voice: false, subtitles: true, shorts: true }, lib);
  assert.ok(!ids(p).includes('giong-doc'));
  assert.ok(ids(p).indexOf('phu-de') < ids(p).indexOf('dung-video'));
  assert.ok(ids(p).includes('cat-shorts'));
  assert.equal(JSON.stringify(base), before);
});

test('applyStyle: duyệt nhẹ → tự duyệt khi đủ đầu ra, trừ bước tốn tiền / dựng / xem lại', () => {
  const p = applyStyle(suggestPipeline({ length: 'long', orientation: 'horizontal', aspect: '16:9' }), { review: 'light' }, lib);
  const by = (id) => p.steps.find((s) => s.id === id);
  assert.equal(by('nghien-cuu').gate.mode, 'auto_if_checks');
  assert.ok(by('nghien-cuu').checks.length);
  assert.equal(by('giong-doc').gate.mode, 'manual');
  assert.equal(by('dung-video').gate.mode, 'manual');
  assert.equal(by('xem-lai').gate.mode, 'manual');
});

test('style.md: đọc/ghi/xóa, giới hạn 20 KB; buildPrompt gắn phong cách', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-style-'));
  assert.equal(readStyle(home), '');
  writeStyle(home, 'Giọng ấm.');
  assert.equal(readStyle(home), 'Giọng ấm.');
  assert.throws(() => writeStyle(home, 'x'.repeat(21000)), /quá dài/);
  const step = { key: 'a', name: 'A', prompt: 'làm', outputs: [] };
  const preset = { id: 'p', name: 'P', steps: [step] };
  assert.match(buildPrompt({ project: { id: 'x', title: 't', dir: home }, preset, step, style: 'Giọng ấm.' }), /Phong cách của người dùng[\s\S]*Giọng ấm\./);
  assert.doesNotMatch(buildPrompt({ project: { id: 'x', title: 't', dir: home }, preset, step }), /Phong cách của người dùng/);
  writeStyle(home, '');
  assert.equal(readStyle(home), '');
  fs.rmSync(home, { recursive: true });
});
