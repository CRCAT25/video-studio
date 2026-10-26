// Đường dẫn & thư mục người dùng (hợp đồng M1 §2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Slug hợp lệ cho id dự án / preset / bước. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Thư mục dữ liệu của app: $VS_HOME hoặc ~/.video-studio; tạo nếu chưa có, trả đường dẫn tuyệt đối.
export function studioHome() {
  const raw = process.env.VS_HOME && process.env.VS_HOME.trim();
  const home = raw ? path.resolve(expandHome(raw)) : path.join(os.homedir(), '.video-studio');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

// Đổi '~' hoặc '~/x' thành thư mục nhà của người dùng; chuỗi khác giữ nguyên.
export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return os.homedir() + p.slice(1);
  return p;
}

function pathError(message) {
  const err = new Error(message);
  err.code = 'EPATH';
  return err;
}

// Nối rel vào root an toàn: chặn đường dẫn tuyệt đối, '\0' và mọi thứ thoát ra ngoài root (code 'EPATH').
export function safeJoin(root, rel) {
  if (typeof root !== 'string' || !root) throw pathError('Thư mục gốc không hợp lệ.');
  if (typeof rel !== 'string') throw pathError('Đường dẫn không hợp lệ.');
  if (rel.includes('\0') || root.includes('\0')) throw pathError('Đường dẫn chứa ký tự không hợp lệ.');
  if (path.isAbsolute(rel)) throw pathError(`Không cho phép đường dẫn tuyệt đối: ${rel}`);
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (!isInside(base, abs)) throw pathError(`Đường dẫn ra ngoài thư mục cho phép: ${rel}`);
  return abs;
}

// true nếu abs chính là root hoặc nằm bên trong root (so sánh sau path.resolve).
export function isInside(root, abs) {
  if (typeof root !== 'string' || typeof abs !== 'string') return false;
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return a.startsWith(prefix);
}

// Chuỗi bất kỳ (tiếng Việt) → slug a-z0-9 nối '-', tối đa 60 ký tự; rỗng → 'du-an'.
export function slugify(s) {
  let t = String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  t = t.slice(0, 60).replace(/-+$/, '');
  return t || 'du-an';
}

// Kiểm slug hợp lệ theo SLUG_RE.
export function isValidSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

// Bọc chuỗi trong nháy đơn kiểu POSIX (' → '\'') để dùng an toàn trong lệnh shell.
export function shellQuote(s) {
  return "'" + String(s ?? '').replace(/'/g, "'\\''") + "'";
}
