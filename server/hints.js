// Bản sửa "Kiến thức gốc" của người dùng: <home>/hints.json = {id: text}, đè lên HINTS có sẵn khi trợ lý đọc trang.
import fs from 'node:fs';
import path from 'node:path';
import { HINTS } from '../web/src/lib/aiHints.js';

export const MAX_HINT = 600;

export const hintsPath = (home) => path.join(home, 'hints.json');

// Đọc bản sửa; bỏ id lạ / giá trị hỏng. Chưa có / lỗi → {}.
export function readHints(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(hintsPath(home), 'utf8'));
    const out = {};
    for (const [id, text] of Object.entries(raw || {})) if (id in HINTS && typeof text === 'string' && text.trim()) out[id] = text.slice(0, MAX_HINT);
    return out;
  } catch {
    return {};
  }
}

const bad = (msg, code) => Object.assign(new Error(msg), { status: 400, code });

// Ghi bản sửa của 1 mục; text rỗng → bỏ bản sửa (về mặc định). Trả toàn bộ bản sửa.
export function writeHint(home, id, text) {
  if (!Object.hasOwn(HINTS, id)) throw bad('Không có mục kiến thức gốc này.', 'hint_unknown');
  const t = String(text ?? '').trim();
  if (t.length > MAX_HINT) throw bad(`Nội dung dài quá ${MAX_HINT} ký tự.`, 'hint_too_long');
  const all = readHints(home);
  if (!t || t === HINTS[id].text) delete all[id];
  else all[id] = t;
  fs.mkdirSync(home, { recursive: true });
  if (Object.keys(all).length) fs.writeFileSync(hintsPath(home), `${JSON.stringify(all, null, 2)}\n`);
  else fs.rmSync(hintsPath(home), { force: true });
  return all;
}
