// Mọi chuỗi literal đưa vào t()/tr()/T() trong web/src phải có bản tiếng Anh; en.js không thừa khóa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import en from '../web/src/locales/en.js';
import { lookup } from '../web/src/lib/lookup.js';

const SRC = new URL('../web/src/', import.meta.url).pathname;
const RE = /\b(?:t|tr|T)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
const VI = /[À-ÖØ-öø-ỹ]/;

function walk(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) {
      if (f.name !== 'locales') walk(p, out);
    } else if (/\.jsx?$/.test(f.name)) out.push(p);
  }
  return out;
}

function keys() {
  const found = new Map();
  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(RE)) {
      const k = (m[1] ?? m[2]).replace(/\\(.)/g, '$1');
      if (VI.test(k)) found.set(k, path.relative(SRC, f));
    }
  }
  return found;
}

test('mọi khóa tiếng Việt trong code đều có bản tiếng Anh', () => {
  const miss = [...keys()].filter(([k]) => !(k in en)).map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(miss, []);
});

test('bản tiếng Anh giữ nguyên các {biến}', () => {
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  const bad = Object.entries(en).filter(([k, v]) => vars(k) !== vars(v));
  assert.deepEqual(bad, []);
});

const look = (lang, k) => lookup({ en }, lang, k);

test('tên bước, check và 60 tên định dạng từ server đều có bản Anh', async () => {
  const { formatName } = await import('../server/pipeline.js');
  let n = 0;
  for (const length of ['short', 'long'])
    for (const orientation of ['vertical', 'horizontal', 'square'])
      for (const aspect of ['9:16', '4:5', '16:9', '21:9', '1:1'])
        for (const hd4k of [false, true]) {
          const name = formatName({ length, orientation, aspect, hd4k });
          assert.notEqual(look('en', name), name, name);
          n++;
        }
  assert.equal(n, 60);
  for (const k of ['Đủ đầu ra', 'Nghiên cứu & dàn ý', 'Gói đăng', 'Dựng & nhạc']) assert.notEqual(look('en', k), k, k);
});

test('lỗi server đã nội suy khớp khóa mẫu và ra tiếng Anh', () => {
  assert.equal(look('en', 'Không tìm thấy dự án "abc".'), 'Project "abc" not found.');
  assert.equal(look('vi', 'Không tìm thấy dự án "abc".'), 'Không tìm thấy dự án "abc".');
  assert.equal(look('en', 'Câu lạ không có bản dịch.'), 'Câu lạ không có bản dịch.');
});
