// "Tôi có sẵn": người dùng tự thêm file (kịch bản, giọng, hình, video) cho một bước; "Để trợ lý giúp bạn": chọn cách làm của bước.
// File được đặt vào đúng chỗ theo đầu ra của bước; danh sách file người dùng thêm ghi ở .studio/own/<bước>.json.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline as pump } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { safeJoin } from './paths.js';

export const MAX_OWN_FILE = 4 * 1024 * 1024 * 1024; // 4 GB mỗi file
export const MAX_OWN_TEXT = 500 * 1024;
const TEXT = ['md', 'txt', 'srt', 'json'];
const KINDS = {
  text: TEXT,
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'm4v'],
};
const ALL = new Set(Object.values(KINDS).flat());
const kindOf = (ext) => Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || null;
const extOf = (p) => path.extname(String(p)).slice(1).toLowerCase();
// Thư mục chứa loại file gì (vd. images/* chỉ nhận hình) — thư mục lạ thì nhận mọi loại media.
const DIR_KINDS = { images: ['image', 'video'], thumbnails: ['image'], audio: ['audio'], previews: ['video'], exports: ['video'], shorts: ['video'] };

// Cách làm gợi ý theo đầu ra của bước; hint đưa vào prompt mục "## Cách làm".
const METHODS = [
  {
    when: (o) => o.includes('script.md'),
    list: [
      { id: 'idea', label: 'Viết từ ý tưởng', hint: 'Viết kịch bản trực tiếp từ tên/ý tưởng của dự án; tự chọn góc nhìn và hook.' },
      { id: 'outline', label: 'Viết theo dàn ý', hint: 'Bám sát outline.md (dàn ý đã có): giữ thứ tự và ý chính của từng chương, chỉ viết thành lời đọc.' },
    ],
  },
  {
    when: (o) => o.some((x) => /^images\//.test(x)),
    list: [
      { id: 'code', label: 'Vẽ bằng code', hint: 'Tự dựng toàn bộ hình bằng code (SVG/canvas/three.js/ffmpeg), không tải ảnh ngoài.' },
      { id: 'cc0', label: 'Ảnh/video CC0', hint: 'Dùng ảnh/video thật giấy phép CC0 hoặc không cần ghi công (Pexels, Pixabay, Wikimedia CC0); ghi nguồn từng file vào LICENSES.md.' },
    ],
  },
];

// Đầu ra của bước có nhận file người dùng không, nhận đuôi gì; text = có ô dán chữ (đầu ra là file .md/.txt/.srt).
export function ownSpec(step) {
  const outs = (step?.outputs ?? []).map(String);
  const exts = new Set();
  let text = null;
  const textOk = TEXT.includes(extOf(outs[0] ?? '')); // chỉ nhận chữ khi đầu ra chính là văn bản (không nhận vào LICENSES.md của bước hình)
  for (const o of outs) {
    const dir = o.includes('/') ? o.split('/')[0] : null;
    const e = extOf(o);
    if (!o.includes('*')) {
      if (TEXT.includes(e)) {
        if (!textOk) continue;
        (e === 'md' || e === 'txt' ? ['md', 'txt'] : [e]).forEach((x) => exts.add(x));
        if (!text && e !== 'json') text = o;
      } else if (ALL.has(e)) exts.add(e);
    } else if (e && e !== '*' && ALL.has(e)) {
      exts.add(e);
    } else if (dir) {
      (DIR_KINDS[dir] || ['image', 'audio', 'video']).forEach((k) => KINDS[k].forEach((x) => exts.add(x)));
    }
  }
  const methods = METHODS.filter((m) => m.when(outs)).flatMap((m) => m.list).map(({ id, label }) => ({ id, label }));
  return { accept: [...exts], text, methods };
}

// Cách làm theo id (null nếu bước không có cách đó).
export function findMethod(step, id) {
  if (typeof id !== 'string' || !id) return null;
  const outs = (step?.outputs ?? []).map(String);
  return METHODS.filter((m) => m.when(outs)).flatMap((m) => m.list).find((m) => m.id === id) || null;
}

// Tên file người dùng gửi → tên an toàn (chỉ phần tên, bỏ ký tự điều khiển/ký tự đặc biệt của đường dẫn).
export function cleanName(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).normalize('NFC');
  const n = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!n || n.startsWith('.') || n.length > 120) return null;
  return n;
}

// Chỗ đặt file theo đầu ra của bước: file cố định cùng đuôi → đúng tên đó; thư mục (dir/*, dir/*.ext) → dir/<tên>. Không hợp → null.
export function destFor(step, name) {
  const n = cleanName(name);
  const e = n ? extOf(n) : '';
  if (!n || !ALL.has(e)) return null;
  const k = kindOf(e);
  const outs = (step?.outputs ?? []).map(String);
  // Cùng đuôi (đổi tên được); .txt và .md coi như nhau
  const same = (oe) => oe === e || (['md', 'txt'].includes(oe) && ['md', 'txt'].includes(e));
  const textOk = TEXT.includes(extOf(outs[0] ?? ''));
  const fixed = outs.find((o) => !o.includes('*') && same(extOf(o)) && (textOk || !TEXT.includes(extOf(o))));
  if (fixed) return fixed;
  const typed = outs.find((o) => /\/\*\.\w+$/.test(o) && same(extOf(o)));
  if (typed) return `${typed.split('/')[0]}/${n}`;
  const loose = outs.find((o) => /^[^*/]+\/\*$/.test(o) && (DIR_KINDS[o.split('/')[0]] || ['image', 'audio', 'video']).includes(k));
  if (loose) return `${loose.split('/')[0]}/${n}`;
  return null;
}

const recPath = (dir, key) => safeJoin(dir, path.join('.studio', 'own', `${key}.json`));

// Danh sách file người dùng đã thêm cho bước (chỉ file còn trên đĩa), kèm cỡ.
export function listOwn(dir, key) {
  let files = [];
  try {
    files = JSON.parse(fs.readFileSync(recPath(dir, key), 'utf8')).files;
  } catch {
    files = [];
  }
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const rel of files) {
    try {
      const st = fs.statSync(safeJoin(dir, rel));
      if (st.isFile()) out.push({ path: rel, size: st.size });
    } catch {
      /* file đã bị xóa → bỏ */
    }
  }
  return out;
}

function writeRec(dir, key, files) {
  const f = recPath(dir, key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ files: [...new Set(files)] }, null, 2));
}
const addRec = (dir, key, rel) => writeRec(dir, key, [...listOwn(dir, key).map((x) => x.path), rel]);

// Ghi luồng file vào chỗ của nó (qua file tạm rồi đổi tên); quá cỡ → lỗi 'too_large'.
export async function saveOwnStream(dir, key, rel, stream, max = MAX_OWN_FILE) {
  const abs = safeJoin(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.part-${process.pid}`;
  let n = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > max) return cb(Object.assign(new Error('too_large'), { code: 'too_large' }));
      cb(null, chunk);
    },
  });
  try {
    await pump(stream, count, fs.createWriteStream(tmp));
    if (n === 0) throw Object.assign(new Error('empty'), { code: 'empty' });
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  addRec(dir, key, rel);
  return { path: rel, size: n };
}

// Ghi chữ người dùng dán vào file văn bản chính của bước.
export function saveOwnText(dir, key, rel, text) {
  const abs = safeJoin(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text.endsWith('\n') ? text : text + '\n');
  addRec(dir, key, rel);
  return { path: rel, size: Buffer.byteLength(text) };
}

// Gỡ một file người dùng đã thêm (xóa khỏi đĩa + danh sách); không có trong danh sách → false.
export function removeOwn(dir, key, rel) {
  const files = listOwn(dir, key).map((x) => x.path);
  if (!files.includes(rel)) return false;
  fs.rmSync(safeJoin(dir, rel), { force: true });
  writeRec(dir, key, files.filter((x) => x !== rel));
  return true;
}
