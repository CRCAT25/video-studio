// Ảnh đính kèm cho Trợ lý AI: thu nhỏ ở trình duyệt (cạnh dài ≤ 1568 px, JPEG) để gửi nhẹ mà model vẫn đọc rõ.
export const MAX_IMAGES = 4; // tổng số mục đính kèm (ảnh + tệp chữ + video)
export const DRAG_TYPE = 'application/x-vs-image';
const MAX_SIDE = 1568;
export const SEND_MAX_IMAGES = 8; // server nhận tối đa ngần này ảnh / tệp chữ mỗi tin
export const SEND_MAX_FILES = 8;
const FOLDER_IMAGES = 6; // thư mục: lấy mẫu đều ngần này ảnh
const FOLDER_TEXTS = 4; // + 1 tệp danh sách
const FOLDER_SCAN = 400;

// Blob/File ảnh → {name, mime, data(base64), url(xem trước)}.
export async function toAttachment(blob, name, maxSide = MAX_SIDE) {
  if (!/^image\//.test(blob.type)) throw new Error('not_image');
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; // PNG trong suốt → nền trắng
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const url = c.toDataURL('image/jpeg', 0.85);
  return { kind: 'image', name: String(name || blob.name || 'image').slice(0, 80), mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url };
}

// Ảnh kéo từ danh sách Đầu ra: tải qua cùng địa chỉ trang đang xem.
export async function fromUrl(src, name) {
  const r = await fetch(src, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('fetch_failed');
  return toAttachment(await r.blob(), name);
}

// Mục kéo từ danh sách Đầu ra: {kind:'image'|'text'|'video', src, name, projectId, path}.
export function dragItem(e, item) {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'copy';
}
export const dragImage = (e, src, name) => dragItem(e, { kind: 'image', src, name });

const TEXT_RE = /\.(txt|md|markdown|json|jsonl|srt|vtt|csv|log|ya?ml|xml|html?|css|m?js|jsx?|tsx?|py|sh)$/i;
export const isTextFile = (f) => /^text\//.test(f.type) || TEXT_RE.test(f.name || '');

// Tệp chữ → {kind:'text', name, text}; tối đa ~100.000 ký tự (server cũng cắt).
export async function textAttachment(blob, name) {
  const text = (await blob.text()).slice(0, 100000);
  if (text.includes('\0')) throw new Error('binary');
  return { kind: 'text', name: String(name || blob.name || 'file').slice(0, 80), text };
}
export async function textFromUrl(src, name) {
  const r = await fetch(src, { credentials: 'same-origin', headers: { range: 'bytes=0-199999' } });
  if (!r.ok) throw new Error('fetch_failed');
  return textAttachment(await r.blob(), name);
}

// ---- Thư mục kéo từ Finder: đọc đệ quy (webkitGetAsEntry), lấy mẫu ảnh + tệp chữ, kèm tệp danh sách.
const readEntries = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
const fileOf = (entry) => new Promise((res, rej) => entry.file(res, rej));

async function walk(entry, out, depth) {
  if (out.length >= FOLDER_SCAN || /^\./.test(entry.name) || entry.name === 'node_modules') return;
  if (entry.isFile) {
    out.push(entry);
    return;
  }
  if (!entry.isDirectory || depth > 4) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await readEntries(reader);
    if (!batch.length) break;
    for (const e of batch) await walk(e, out, depth + 1);
  }
}

const pickEven = (arr, n) => (arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor(((i + 0.5) * arr.length) / n)]));

// DirectoryEntry → {kind:'folder', name, images:[…], files:[…], total, nImages, nTexts}
export async function folderAttachment(dir) {
  const entries = [];
  await walk(dir, entries, 0);
  entries.sort((a, b) => a.fullPath.localeCompare(b.fullPath, undefined, { numeric: true }));
  const rel = (e) => e.fullPath.replace(/^\/[^/]+\//, '');
  const isImg = (e) => /\.(png|jpe?g|webp|gif)$/i.test(e.name);
  const isTxt = (e) => isTextFile({ name: e.name, type: '' });
  const imgs = entries.filter(isImg);
  const txts = entries.filter(isTxt);
  const images = [];
  for (const e of pickEven(imgs, FOLDER_IMAGES)) {
    try {
      images.push(await toAttachment(await fileOf(e), rel(e), 1024));
    } catch {
      /* bỏ ảnh hỏng */
    }
  }
  const files = [];
  for (const e of txts.slice(0, FOLDER_TEXTS)) {
    try {
      files.push(await textAttachment(await fileOf(e), rel(e)));
    } catch {
      /* bỏ tệp nhị phân */
    }
  }
  const list = entries.map((e) => rel(e)).join('\n');
  files.unshift({
    kind: 'text',
    name: `${dir.name}-danh-sach.txt`.slice(0, 80),
    text: `Thư mục ${dir.name}: ${entries.length} tệp (${imgs.length} ảnh, ${txts.length} tệp chữ).\nGửi kèm ${images.length} ảnh lấy mẫu đều (${images.map((i) => i.name).join(', ')}) và ${files.length} tệp chữ đầu.\n\n${list}`.slice(0, 100000),
  });
  return { kind: 'folder', name: dir.name, images, files, nImages: imgs.length, nTexts: txts.length, total: entries.length };
}

// Các thư mục trong lần thả (gọi đồng bộ trong onDrop — dataTransfer.items hết hạn sau await).
export function droppedFolders(dt) {
  return [...(dt.items || [])].map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null)).filter((e) => e?.isDirectory);
}
