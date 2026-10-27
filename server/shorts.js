// Công cụ phía server cho Trợ lý AI: xem ảnh của dự án và dựng Short dọc 9:16 từ ảnh có sẵn (ffmpeg + Pillow vẽ phụ đề + giọng hệ thống).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IMG_RE = /\.(png|jpe?g|webp)$/i;
const W = 1080;
const H = 1920;
const FONTS = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];
// Vẽ phụ đề thành PNG trong suốt (ffmpeg máy này thiếu drawtext/subtitles).
const CAPTION_PY = `
import sys
from PIL import Image, ImageDraw, ImageFont
out, text, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
font = None
for p in sys.argv[5:]:
    try:
        font = ImageFont.truetype(p, 58); break
    except Exception: pass
if font is None: font = ImageFont.load_default()
img = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
lines, cur = [], ''
for word in text.split():
    t = (cur + ' ' + word).strip()
    if d.textlength(t, font=font) <= w - 160 or not cur: cur = t
    else: lines.append(cur); cur = word
if cur: lines.append(cur)
lh = 78; top = h - 330 - lh * len(lines)
d.rounded_rectangle((60, top - 24, w - 60, top + lh * len(lines) + 16), 28, fill=(0, 0, 0, 150))
for i, l in enumerate(lines):
    x = (w - d.textlength(l, font=font)) / 2
    d.text((x, top + i * lh), l, font=font, fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))
img.save(out)
`;

// Hiệu ứng "vẽ dần": từ giấy trắng, nét đậm hiện lần lượt theo hàng (như tay viết) rồi mảng màu hiện sau; ghi video câm qua ffmpeg.
const DRAW_PY = `
import sys, subprocess
import numpy as np
from PIL import Image
src, out, dur, ffmpeg, W = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4], int(sys.argv[5])
im = Image.open(src).convert('RGB')
h = int(round(im.height * W / im.width / 2)) * 2
im = im.resize((W, h), Image.LANCZOS)
a = np.asarray(im).astype(np.int16)
edge = np.concatenate([a[:6].reshape(-1, 3), a[-6:].reshape(-1, 3)])
bgc = np.median(edge, axis=0).astype(np.int16)
diff = np.abs(a - bgc).sum(axis=2)
ink = diff > 40
line = ink & (a.sum(axis=2) < 330)
C, B = 20, 3
ys, xs = np.mgrid[0:h, 0:W]
cx, cy = xs // C, ys // C
band = cy // B
order = band * 10000 + np.where(band % 2 == 0, cx, 9999 - cx)
frac = (xs % C) / C
def rank(mask):
    r = np.full((h, W), 2.0)
    if mask.any():
        o = order[mask].astype(np.float64)
        u = np.unique(o)
        idx = np.searchsorted(u, o)
        r[mask] = idx / max(len(u), 1) + frac[mask] * (1.0 / max(len(u), 1)) * 3
    return r
T = 0.78
rt = np.full((h, W), 0.0)
rl = rank(line)
rf = rank(ink & ~line)
rt = np.where(line, rl * 0.7, np.where(ink, 0.7 + rf * 0.3, 0.0)) * T
fps = 30
n = max(2, int(round(dur * fps)))
bg = np.broadcast_to(bgc.astype(np.uint8), (h, W, 3))
full = np.asarray(im)
p = subprocess.Popen([ffmpeg, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{h}', '-r', str(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-y', out], stdin=subprocess.PIPE)
for f in range(n):
    t = f / (n - 1)
    shown = (rt <= t) | ~ink
    p.stdin.write(np.where(shown[..., None], full, bg).astype(np.uint8).tobytes())
p.stdin.close()
sys.exit(p.wait())
`;

const fail = (text) => ({ text, isError: true });
const slug = (s) => String(s || 'short').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'short';
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Ảnh phải nằm trong thư mục dự án và đúng đuôi ảnh.
function imgPath(dir, rel) {
  const abs = path.resolve(dir, String(rel || ''));
  if (!abs.startsWith(path.resolve(dir) + path.sep) || !IMG_RE.test(abs) || !exists(abs)) return null;
  return abs;
}

function walkImages(dir, base = dir, out = [], depth = 0) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'shorts' || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory() && depth < 2) walkImages(abs, base, out, depth + 1);
    else if (e.isFile() && IMG_RE.test(e.name)) out.push({ path: path.relative(base, abs), kb: Math.round(fs.statSync(abs).size / 1024) });
  }
  return out;
}

function readNotes(dir) {
  const parts = [];
  for (const f of ['storyboard.md', 'script.md']) {
    try {
      parts.push(`--- ${f} ---\n${fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000)}`);
    } catch { /* thiếu thì bỏ qua */ }
  }
  return parts.join('\n\n');
}

export function createShortTools({ store, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', python = 'python3', sayBin = 'say' } = {}) {
  const proj = (id) => {
    const p = store.getProject(String(id || ''));
    return p ? { p, dir: p.dir } : null;
  };

  async function projectImages(a) {
    if (!a.projectId) {
      const list = store.listProjects().slice(0, 30).map((p) => `${p.id} — ${p.title}`);
      return { text: `Chưa có projectId. Các dự án:\n${list.join('\n')}` };
    }
    const r = proj(a.projectId);
    if (!r) return fail('Không có dự án này.');
    const imgs = walkImages(r.dir);
    if (!imgs.length) return fail('Dự án chưa có ảnh nào.');
    return { text: `Dự án "${r.p.title}" có ${imgs.length} ảnh:\n${imgs.map((i) => `${i.path} (${i.kb}KB)`).join('\n')}\n\n${readNotes(r.dir)}` };
  }

  async function viewImages(a) {
    const r = proj(a.projectId);
    if (!r) return fail('Không có dự án này.');
    const paths = Array.isArray(a.paths) ? a.paths.slice(0, 4) : [];
    if (!paths.length) return fail('Cần paths (tối đa 4 ảnh).');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-view-'));
    try {
      const images = [];
      for (const [i, rel] of paths.entries()) {
        const abs = imgPath(r.dir, rel);
        if (!abs) return fail(`Không tìm thấy ảnh ${rel}.`);
        const out = path.join(tmp, `v${i}.jpg`);
        await run(ffmpeg, ['-v', 'error', '-i', abs, '-vf', "scale='min(640,iw)':-2", '-q:v', '5', '-frames:v', '1', '-y', out], { timeout: 30000 });
        images.push({ data: fs.readFileSync(out).toString('base64'), mimeType: 'image/jpeg' });
      }
      return { text: `Đây là ${images.length} ảnh theo thứ tự: ${paths.join(', ')}`, images };
    } catch (e) {
      return fail(e.code === 'ENOENT' ? 'Máy chưa cài ffmpeg.' : 'Không đọc được ảnh.');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function duration(file) {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 15000 });
    return Number(stdout.trim()) || 0;
  }

  async function makeShort(a) {
    const r = proj(a.projectId);
    if (!r) return fail('Không có dự án này.');
    const scenes = Array.isArray(a.scenes) ? a.scenes.slice(0, 40) : [];
    if (!scenes.length) return fail('Cần ít nhất 1 cảnh.');
    const voice = a.voice === 'system' ? 'system' : 'none';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-short-'));
    try {
      const parts = [];
      for (const [i, s] of scenes.entries()) {
        const img = imgPath(r.dir, s.image);
        if (!img) return fail(`Cảnh ${i + 1}: không tìm thấy ảnh ${s.image}.`);
        let d = Math.min(30, Math.max(1, Number(s.seconds) || 3));
        const args = [];
        const caption = String(s.caption || '').trim();
        const narr = String(s.narration || '').trim();
        let cap = null;
        let aud = null;
        if (caption) {
          cap = path.join(tmp, `c${i}.png`);
          try {
            await run(python, ['-c', CAPTION_PY, cap, caption, String(W), String(H), ...FONTS], { timeout: 30000, cwd: tmp });
          } catch {
            return fail('Chưa vẽ được phụ đề: máy cần python3 có thư viện Pillow (pip3 install pillow). Có thể tạo Short không phụ đề.');
          }
          args.push('-loop', '1', '-framerate', '30', '-i', cap);
        }
        if (voice === 'system' && narr) {
          aud = path.join(tmp, `a${i}.aiff`);
          try {
            await run(sayBin, ['-v', 'Linh', '-o', aud, narr], { timeout: 60000 });
          } catch {
            return fail('Chưa đọc được bằng giọng hệ thống (macOS "say -v Linh"). Có thể tạo Short không giọng.');
          }
          d = Math.min(40, Math.max(d, (await duration(aud)) + 0.4));
          args.push('-i', aud);
        } else {
          args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
        }
        if (s.reveal === 'draw') {
          const dv = path.join(tmp, `d${i}.mp4`);
          try {
            await run(python, ['-c', DRAW_PY, img, dv, d.toFixed(2), ffmpeg, String(W)], { timeout: 240000, cwd: tmp });
          } catch {
            return fail('Chưa dựng được hiệu ứng vẽ dần: máy cần python3 có Pillow và numpy (pip3 install pillow numpy). Có thể tạo Short không hiệu ứng.');
          }
          args.unshift('-i', dv);
        } else args.unshift('-loop', '1', '-framerate', '30', '-i', img);
        args.unshift('-v', 'error');
        const ai = cap ? 2 : 1;
        const fc = `[0:v]split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:5[bg];[b]scale=${W}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${cap ? '[v0];[v0][1:v]overlay=0:0' : ''},format=yuv420p[v]`;
        const out = path.join(tmp, `s${i}.mp4`);
        args.push('-filter_complex', fc, '-map', '[v]', '-map', `${ai}:a`, '-af', 'apad', '-t', d.toFixed(2), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-y', out);
        await run(ffmpeg, args, { timeout: 180000 });
        parts.push(out);
      }
      const list = path.join(tmp, 'list.txt');
      fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
      const outDir = path.join(r.dir, 'shorts');
      fs.mkdirSync(outDir, { recursive: true });
      let name = `${slug(a.title)}.mp4`;
      for (let n = 2; exists(path.join(outDir, name)); n++) name = `${slug(a.title)}-${n}.mp4`;
      const final = path.join(outDir, name);
      await run(ffmpeg, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', final], { timeout: 120000 });
      const total = await duration(final);
      return { text: `Đã tạo Short ${total.toFixed(1)}s (9:16, ${scenes.length} cảnh, ${voice === 'system' ? 'có giọng hệ thống' : 'không giọng'}).\nFile: shorts/${name} trong thư mục dự án.\nXem tại: /media/${r.p.id}/shorts/${name}` };
    } catch (e) {
      return fail(e.code === 'ENOENT' ? 'Máy chưa cài ffmpeg.' : `Dựng Short lỗi: ${String(e.stderr || e.message).slice(0, 300)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return { project_images: projectImages, view_images: viewImages, make_short: makeShort };
}
