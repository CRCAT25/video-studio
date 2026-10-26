// Phục vụ file trong thư mục dự án (hợp đồng M1 §9.4): chặn thoát thư mục/symlink/dotfile, hỗ trợ Range 206/416.
import fs from 'node:fs';
import path from 'node:path';
import { CSP } from './auth.js';
import { isInside, safeJoin } from './paths.js';
import { HttpError } from './projects.js';

const TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8', srt: 'text/plain; charset=utf-8', vtt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', jsonl: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  // Không bao giờ cho trình duyệt chạy HTML/JS từ thư mục dự án dưới origin của app.
  html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8',
  mjs: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8',
  json: 'application/json', pdf: 'application/pdf',
};

// Content-Type theo đuôi file (md/srt/vtt/txt → text/plain utf-8, json → application/json…); lạ → octet-stream.
export function contentTypeFor(file) {
  const ext = path.extname(String(file || '')).slice(1).toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

// Phân tích header Range cho file size byte → null (không có/không phải bytes=: gửi cả file),
// {start, end} (một khoảng hợp lệ), hoặc 'invalid' (sai cú pháp / ngoài file / nhiều khoảng → 416).
export function parseRange(header, size) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const h = header.trim();
  if (!/^bytes\s*=/i.test(h)) return null;
  const spec = h.replace(/^bytes\s*=\s*/i, '');
  if (spec.includes(',')) return 'invalid';
  const m = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  if (!(size > 0)) return 'invalid';
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!(n > 0)) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!Number.isSafeInteger(start) || start >= size || end < start) return 'invalid';
  }
  return { start, end };
}

// Kiểm từng phần tử đường dẫn: không rỗng hợp lệ, không bắt đầu bằng '.', trừ .studio/runs/… khi allowStudio.
function dotAllowed(segments, allowStudio) {
  let rest = segments;
  if (allowStudio && segments[0] === '.studio' && segments[1] === 'runs' && segments.length > 2) rest = segments.slice(2);
  return rest.every((s) => !s.startsWith('.'));
}

const forbidden = (message = 'Đường dẫn nằm ngoài thư mục dự án hoặc là file ẩn.') => new HttpError(403, 'forbidden_path', message);
const notFound = (message = 'Không tìm thấy file.') => new HttpError(404, 'not_found', message);

// Giải đường dẫn media an toàn: safeJoin + realpath nằm trong realpath(dir) + chặn dotfile; trả {abs, stat}.
// Throw HttpError 403 forbidden_path / 404 not_found.
export function resolveMediaPath(dir, rel, { studio = false } = {}) {
  if (typeof rel !== 'string' || !rel) throw notFound();
  if (rel.includes('\0')) throw forbidden('Đường dẫn không hợp lệ.');
  const segments = rel.split(/[\\/]+/).filter((s) => s !== '');
  if (!segments.length) throw notFound();
  if (!dotAllowed(segments, studio)) throw forbidden();
  let abs;
  try {
    abs = safeJoin(dir, segments.join('/'));
  } catch {
    throw forbidden();
  }
  let realDir;
  let realAbs;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    throw notFound('Thư mục dự án không còn trên đĩa.');
  }
  try {
    realAbs = fs.realpathSync(abs);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw notFound();
    throw forbidden('Không đọc được file.');
  }
  if (!isInside(realDir, realAbs) || realAbs === realDir) throw forbidden();
  const realSegs = path.relative(realDir, realAbs).split(path.sep);
  if (!dotAllowed(realSegs, studio)) throw forbidden();
  let stat;
  try {
    stat = fs.statSync(realAbs);
  } catch {
    throw notFound();
  }
  if (!stat.isFile()) throw notFound('Đường dẫn không phải file.');
  return { abs: realAbs, stat };
}

// Gửi file đã giải (abs, stat) qua reply Fastify: 200 cả file hoặc 206/416 theo Range; stream bằng createReadStream.
export function sendFile(req, reply, { abs, stat }) {
  const size = stat.size;
  reply.header('accept-ranges', 'bytes');
  reply.header('cache-control', 'no-cache');
  reply.header('last-modified', stat.mtime.toUTCString());
  // Khi file bị mở trực tiếp như tài liệu: cô lập (sandbox) để SVG/HTML không chạy script dưới origin app.
  reply.header('content-security-policy', `${CSP}; sandbox`);
  // File rỗng: bỏ qua Range (trả 200 rỗng) để client xem trước chữ không gặp 416 vô lý.
  const range = size > 0 ? parseRange(req.headers.range, size) : null;
  if (range === 'invalid') {
    reply.code(416).header('content-range', `bytes */${size}`).type('application/json; charset=utf-8');
    return reply.send({ error: 'range_not_satisfiable', message: 'Khoảng byte yêu cầu không hợp lệ.' });
  }
  reply.header('content-type', contentTypeFor(abs));
  let start = 0;
  let end = size - 1;
  if (range) {
    ({ start, end } = range);
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
  } else {
    reply.code(200);
  }
  const length = size === 0 ? 0 : end - start + 1;
  reply.header('content-length', length);
  if (req.method === 'HEAD') return reply.send(); // giữ content-length thật, không đọc file
  if (length === 0) return reply.send('');
  return reply.send(fs.createReadStream(abs, { start, end }));
}

// Tạo handler cho GET /media/:projectId/*: dự án phải tồn tại; ?studio=1 mở được .studio/runs/….
export function mediaHandler({ store }) {
  return async function media(req, reply) {
    const project = store.getProject(req.params.projectId);
    if (!project) throw notFound(`Không tìm thấy dự án "${req.params.projectId}".`);
    const rel = req.params['*'];
    const studio = req.query?.studio === '1';
    const file = resolveMediaPath(project.dir, rel, { studio });
    return sendFile(req, reply, file);
  };
}
