// Lấy vài khung hình đều nhau từ video bằng ffmpeg để Trợ lý AI "xem" (model không nhận video trực tiếp).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './projects.js';

const run = promisify(execFile);
export const FRAME_COUNT = 6;
const WIDTH = 768;

// abs → {info, frames:[{name, mime, data}]}; không có ffmpeg/ffprobe hoặc file hỏng → 400/503.
export async function extractFrames(abs, label, { count = FRAME_COUNT, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  let dur;
  let w;
  let h;
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', abs], { timeout: 15000 });
    const j = JSON.parse(stdout);
    dur = Number(j.format?.duration);
    w = j.streams?.[0]?.width;
    h = j.streams?.[0]?.height;
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(503, 'ffmpeg_missing', 'Máy chưa cài ffmpeg nên chưa xem được video.');
    throw new HttpError(400, 'invalid_body', 'Không đọc được video này.');
  }
  if (!(dur > 0) || !w) throw new HttpError(400, 'invalid_body', 'Không đọc được video này.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-frames-'));
  try {
    const frames = [];
    for (let i = 0; i < count; i++) {
      const at = (dur * (i + 0.5)) / count;
      const out = path.join(tmp, `f${i}.jpg`);
      await run(ffmpeg, ['-v', 'error', '-ss', at.toFixed(2), '-i', abs, '-frames:v', '1', '-vf', `scale='min(${WIDTH},iw)':-2`, '-q:v', '4', '-y', out], { timeout: 30000 });
      frames.push({ name: `${label} @${at.toFixed(1)}s`, mime: 'image/jpeg', data: fs.readFileSync(out).toString('base64') });
    }
    return { info: `${label}: ${dur.toFixed(1)}s, ${w}x${h}, ${count} khung hình đều nhau (không có tiếng, không thấy chuyển động)`, frames };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid_body', 'Không lấy được khung hình từ video này.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
