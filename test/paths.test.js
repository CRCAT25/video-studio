import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLUG_RE, expandHome, isInside, isValidSlug, safeJoin, shellQuote, slugify, studioHome } from '../server/paths.js';

test('slugify: tiếng Việt có dấu', () => {
  assert.equal(slugify('Chuyến xe buýt cuối số 13'), 'chuyen-xe-buyt-cuoi-so-13');
  assert.equal(slugify('Đà Lạt — mùa mưa!'), 'da-lat-mua-mua');
  assert.equal(slugify('Người Việt ăn phở ở đâu?'), 'nguoi-viet-an-pho-o-dau');
  assert.equal(slugify('ĐƯỜNG ĐI   ĐÂU'), 'duong-di-dau');
});

test('slugify: ký tự lạ, gộp dấu gạch, bỏ gạch đầu/cuối', () => {
  assert.equal(slugify('  --Hello__World!!  '), 'hello-world');
  assert.equal(slugify('a/b\\c.d'), 'a-b-c-d');
  assert.equal(slugify('🔥 Top 10 😱 bí ẩn'), 'top-10-bi-an');
  assert.equal(slugify('日本語 abc'), 'abc');
});

test('slugify: rỗng → du-an', () => {
  assert.equal(slugify(''), 'du-an');
  assert.equal(slugify('   '), 'du-an');
  assert.equal(slugify('!!!'), 'du-an');
  assert.equal(slugify('日本語'), 'du-an');
  assert.equal(slugify(null), 'du-an');
  assert.equal(slugify(undefined), 'du-an');
});

test('slugify: dài → cắt 60 ký tự, không để "-" ở cuối', () => {
  const long = 'Một tiêu đề rất rất dài '.repeat(10);
  const s = slugify(long);
  assert.ok(s.length <= 60, s);
  assert.ok(!s.endsWith('-'), s);
  assert.ok(SLUG_RE.test(s));
  // chỗ cắt rơi đúng vào dấu '-' → bỏ
  const t = slugify('a'.repeat(59) + ' bcd');
  assert.equal(t, 'a'.repeat(59));
  assert.equal(slugify('x'.repeat(100)).length, 60);
});

test('slugify: kết quả luôn là slug hợp lệ', () => {
  for (const s of ['Ăn gì', '123 abc', '-a-', 'Ổ bánh mì', 'ß ç ñ', 'x'.repeat(200)]) {
    assert.ok(isValidSlug(slugify(s)), `${s} → ${slugify(s)}`);
  }
  assert.equal(isValidSlug('Abc'), false);
  assert.equal(isValidSlug('-abc'), false);
  assert.equal(isValidSlug('a'.repeat(65)), false);
  assert.equal(isValidSlug('a'.repeat(64)), true);
  assert.equal(isValidSlug(42), false);
});

test('safeJoin: đường dẫn hợp lệ trong root', () => {
  const root = path.join(os.tmpdir(), 'vs-root');
  assert.equal(safeJoin(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.equal(safeJoin(root, './x/../y'), path.join(root, 'y'));
  assert.equal(safeJoin(root, '.'), path.resolve(root));
  assert.equal(safeJoin(root, 'a..b'), path.join(root, 'a..b'));
});

test('safeJoin: chặn ../, tuyệt đối, \\0 (code EPATH)', () => {
  const root = path.join(os.tmpdir(), 'vs-root');
  for (const bad of ['../x', 'a/../../x', '..', '/etc/passwd', 'a\0b', path.join(root, 'x')]) {
    assert.throws(() => safeJoin(root, bad), (e) => e.code === 'EPATH', `phải chặn: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => safeJoin(root, null), (e) => e.code === 'EPATH');
  assert.throws(() => safeJoin('', 'a'), (e) => e.code === 'EPATH');
  // root có tiền tố giống nhau không được tính là "bên trong"
  assert.throws(() => safeJoin(root, '../vs-root-evil/x'), (e) => e.code === 'EPATH');
});

test('isInside', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c/d'), true);
  assert.equal(isInside('/a/b/', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
  assert.equal(isInside('/a/b', '/a/b/../c'), false);
  assert.equal(isInside('/', '/anything'), true);
});

test('expandHome', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/x/y'), path.join(os.homedir(), 'x/y'));
  assert.equal(expandHome('/abs/~/x'), '/abs/~/x');
  assert.equal(expandHome('rel/x'), 'rel/x');
  assert.equal(expandHome('~user/x'), '~user/x');
});

test('studioHome: dùng VS_HOME, tạo thư mục, trả đường dẫn tuyệt đối', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  const old = process.env.VS_HOME;
  try {
    const target = path.join(tmp, 'nested', 'home');
    process.env.VS_HOME = target;
    const h = studioHome();
    assert.equal(h, target);
    assert.ok(fs.statSync(h).isDirectory());
    assert.ok(path.isAbsolute(h));
  } finally {
    if (old === undefined) delete process.env.VS_HOME;
    else process.env.VS_HOME = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shellQuote: nháy đơn kiểu POSIX', () => {
  assert.equal(shellQuote('abc'), "'abc'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('/Users/a b/skill'), "'/Users/a b/skill'");
  assert.equal(shellQuote(''), "''");
});
