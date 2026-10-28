// Hồ sơ phong cách của người dùng: <home>/style.md, gắn vào lời nhắc của mọi bước chạy AI.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_STYLE = 20 * 1024;

export const stylePath = (home) => path.join(home, 'style.md');

// Đọc style.md; chưa có / lỗi → ''.
export function readStyle(home) {
  try {
    return fs.readFileSync(stylePath(home), 'utf8').slice(0, MAX_STYLE);
  } catch {
    return '';
  }
}

export function writeStyle(home, text) {
  const t = String(text ?? '');
  if (Buffer.byteLength(t) > MAX_STYLE) {
    const e = new Error('Hồ sơ phong cách quá dài (tối đa 20 KB).');
    e.status = 400;
    e.code = 'style_too_long';
    throw e;
  }
  fs.mkdirSync(home, { recursive: true });
  if (!t.trim()) {
    fs.rmSync(stylePath(home), { force: true });
    return '';
  }
  fs.writeFileSync(stylePath(home), t);
  return t;
}
