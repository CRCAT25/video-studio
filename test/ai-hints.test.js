// Chỉ dẫn cho Trợ lý AI (lib/aiHints.js): mỗi mục gọn, và khớp 1–1 với các chỗ gắn data-ai-help / aiHelp trong web/src.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HINTS } from '../web/src/lib/aiHints.js';

const SRC = new URL('../web/src/', import.meta.url).pathname;
const RE = /(?:data-ai-help|aiHelp)="([\w-]+)"/g;
const TEXT_MAX = 600;

function walk(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(f.name)) out.push(p);
  }
  return out;
}

// id → file đầu tiên gắn id đó.
function tagged() {
  const found = new Map();
  for (const f of walk(SRC)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(RE)) if (!found.has(m[1])) found.set(m[1], path.relative(SRC, f));
  }
  return found;
}

test('mỗi chỉ dẫn có tiêu đề và nội dung gọn', () => {
  const bad = Object.entries(HINTS)
    .filter(([, h]) => !h?.title?.trim() || !h?.text?.trim() || h.text.length > TEXT_MAX)
    .map(([id]) => id);
  assert.deepEqual(bad, []);
});

test('mọi chỗ gắn data-ai-help đều có chỉ dẫn', () => {
  const miss = [...tagged()].filter(([id]) => !(id in HINTS)).map(([id, f]) => `${f}: ${id}`);
  assert.deepEqual(miss, []);
});

test('chỉ dẫn nào cũng được gắn lên màn hình', () => {
  const used = tagged();
  assert.deepEqual(Object.keys(HINTS).filter((id) => !used.has(id)), []);
});
