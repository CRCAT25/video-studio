// Ảnh đính kèm cho Trợ lý AI: thu nhỏ ở trình duyệt (cạnh dài ≤ 1568 px, JPEG) để gửi nhẹ mà model vẫn đọc rõ.
export const MAX_IMAGES = 4; // tổng số mục đính kèm (ảnh + tệp chữ + video)
export const DRAG_TYPE = 'application/x-vs-image';
const MAX_SIDE = 1568;

// Blob/File ảnh → {name, mime, data(base64), url(xem trước)}.
export async function toAttachment(blob, name) {
  if (!/^image\//.test(blob.type)) throw new Error('not_image');
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
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
