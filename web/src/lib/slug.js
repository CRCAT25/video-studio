// Bản sao y hệt slugify của server (server/paths.js, hợp đồng §2) — dùng để gợi ý slug khi tạo dự án.

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Tiêu đề tiếng Việt → slug: bỏ dấu, đ→d, chữ thường, ký tự lạ → '-', tối đa 60 ký tự; rỗng → 'du-an'.
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
