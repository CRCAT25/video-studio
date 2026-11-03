// VoiceStudio (app giọng đọc cài trên máy): chỉ gọi qua API cục bộ 127.0.0.1:3900, không chép mã của nó vào đây.
// Backend của app đã cài được bật khi cần và tự tắt sau khi rảnh; app VoiceStudio đang mở sẵn thì dùng luôn, không tắt giùm.
import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VS_PORT = 3900;
export const IDLE_MS = 10 * 60_000;
// Giọng mô tả bằng chữ (tiếng Anh) theo cách VoiceStudio hiểu; id `profile:<id>` = giọng đã lưu/nhân bản trong app.
export const VOICESTUDIO_VOICES = [
  ['male, young adult, high pitch', 'Nam · trẻ · giọng cao'],
  ['male, young adult, moderate pitch', 'Nam · trẻ · giọng vừa'],
  ['male, middle-aged, moderate pitch', 'Nam · trung niên · giọng vừa'],
  ['male, elderly, low pitch', 'Nam · lớn tuổi · giọng thấp'],
  ['female, young adult, moderate pitch', 'Nữ · trẻ · giọng vừa'],
  ['female, middle-aged, low pitch', 'Nữ · trung niên · giọng thấp'],
].map(([id, desc]) => ({ id, name: desc, desc }));

// Chủ đề có sẵn: giọng (thuộc tính VoiceStudio) + hiệu ứng hậu kỳ. fx: pitch = nửa cung, tempo = tốc độ, echo 0–1 = độ vang, dark = nén bớt âm cao.
export const VOICESTUDIO_THEMES = [
  { id: 'ghost', name: 'Kể chuyện ma, rùng rợn', voice: 'male, elderly, very low pitch', fx: { pitch: -1.5, tempo: 0.88, echo: 0.5, dark: true } },
  { id: 'mystery', name: 'Thì thầm bí ẩn', voice: 'female, young adult, low pitch, whisper', fx: { pitch: 0, tempo: 0.9, echo: 0.25, dark: false } },
  { id: 'bedtime', name: 'Kể chuyện đêm khuya, ấm áp', voice: 'female, middle-aged, low pitch', fx: { pitch: -0.5, tempo: 0.9, echo: 0.15, dark: false } },
  { id: 'fairy', name: 'Cổ tích, huyền bí', voice: 'female, elderly, low pitch', fx: { pitch: 0, tempo: 0.92, echo: 0.3, dark: false } },
  { id: 'doc', name: 'Tài liệu, thuyết minh', voice: 'male, middle-aged, low pitch', fx: { pitch: 0, tempo: 0.97, echo: 0, dark: false } },
  { id: 'news', name: 'Tin tức, thời sự', voice: 'female, young adult, moderate pitch', fx: { pitch: 0, tempo: 1.05, echo: 0, dark: false } },
  { id: 'energy', name: 'Quảng cáo, sôi động', voice: 'male, young adult, high pitch', fx: { pitch: 0.5, tempo: 1.1, echo: 0, dark: false } },
  { id: 'cartoon', name: 'Hoạt hình, trẻ em', voice: 'child, very high pitch', fx: { pitch: 0, tempo: 1.05, echo: 0, dark: false } },
];
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
// Chuẩn hóa hiệu ứng từ cấu hình/giao diện (kẹp trong khoảng an toàn).
export const cleanFx = (f = {}) => ({ pitch: num(f.pitch, -6, 3, 0), tempo: num(f.tempo, 0.7, 1.3, 1), echo: num(f.echo, 0, 1, 0), dark: !!f.dark });
// Bộ lọc ffmpeg cho hiệu ứng; không có hiệu ứng nào → null.
export function fxFilter(fx) {
  const f = cleanFx(fx);
  if (!f.pitch && f.tempo === 1 && !f.echo && !f.dark) return null;
  const sr = 44100;
  const out = [`aresample=${sr}`];
  if (f.pitch) {
    const r = 2 ** (f.pitch / 12);
    out.push(`asetrate=${Math.round(sr * r)}`, `aresample=${sr}`, `atempo=${(1 / r).toFixed(5)}`); // đổi cao độ, giữ tốc độ
  }
  if (f.tempo !== 1) out.push(`atempo=${f.tempo}`);
  if (f.dark) out.push('lowpass=f=3800', 'bass=g=4');
  if (f.echo) out.push(`aecho=0.8:0.85:${Math.round(40 + f.echo * 80)}|${Math.round(90 + f.echo * 140)}:${(0.15 + f.echo * 0.3).toFixed(2)}|${(0.1 + f.echo * 0.2).toFixed(2)}`);
  return out.join(',');
}

const fail = (message, code = 'tts_failed') => Object.assign(new Error(message), { status: 502, code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Cùng một mô tả giọng → cùng seed, để các câu đọc rời nhau vẫn nghe như một người.
export const seedOf = (voice) => crypto.createHash('sha1').update(String(voice)).digest().readUInt32BE(0) % 2_000_000_000;

// Thư mục backend của app VoiceStudio đã cài (đổi bằng VS_VOICESTUDIO_DIR); không có → null.
export function voicestudioDir(env = process.env) {
  const dir = env.VS_VOICESTUDIO_DIR || path.join(os.homedir(), 'Library/Application Support/VoiceStudio/runtime/project');
  return fs.existsSync(path.join(dir, 'backend/main.py')) && fs.existsSync(path.join(dir, '.venv/bin/python')) ? dir : null;
}

export function createVoiceStudio({ home, port = VS_PORT, dir = voicestudioDir(), fetchImpl = (...a) => fetch(...a), spawnImpl = spawn, idleMs = IDLE_MS, startMs = 240_000, partMs = 15 * 60_000, retries = 4, retryMs = 5000, ffmpeg = process.env.VS_FFMPEG || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg') } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const pidFile = path.join(home, 'voicestudio.pid');
  const usedFile = path.join(home, 'voicestudio.used');
  let queue = Promise.resolve();
  let starting = null;
  let timer = null;

  const up = () => fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  const touch = () => { try { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(usedFile, String(Date.now())); } catch { /* chỉ là mốc nhàn rỗi */ } };
  const ownPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8')) || 0; } catch { return 0; } };

  // Bật backend nếu chưa chạy; nhiều lời gọi cùng lúc (server + studio-tts) chỉ có một bên bật được, bên kia chờ /health.
  async function ensure() {
    if (!dir) throw fail('Chưa cài app VoiceStudio — cài VoiceStudio rồi thử lại.', 'no_voicestudio');
    if (await up()) return;
    starting ??= (async () => {
      fs.mkdirSync(home, { recursive: true });
      const log = fs.openSync(path.join(home, 'voicestudio.log'), 'a');
      const proc = spawnImpl(path.join(dir, '.venv/bin/python'), ['-m', 'uvicorn', 'main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', String(port)], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      proc.on?.('error', () => {});
      proc.unref?.();
      fs.closeSync(log);
      if (proc.pid) fs.writeFileSync(pidFile, String(proc.pid));
      let dead = false;
      proc.on?.('close', () => { dead = true; });
      const until = Date.now() + startMs;
      while (Date.now() < until) {
        if (await up()) return;
        // cổng đã có bên khác bật (bản này thoát vì trùng cổng) → chỉ cần chờ bên đó sẵn sàng
        if (dead) await sleep(1500);
        else await sleep(1000);
      }
      throw fail('VoiceStudio bật quá lâu — mở app VoiceStudio để xem lỗi (log: ' + path.join(home, 'voicestudio.log') + ').');
    })().finally(() => { starting = null; });
    await starting;
  }

  const wavOf = async (text, voice) => {
    const form = new FormData();
    form.set('text', text);
    form.set('language', 'Vietnamese');
    form.set('seed', String(seedOf(voice)));
    if (voice.startsWith('profile:')) form.set('profile_id', voice.slice(8));
    else if (voice) form.set('instruct', voice);
    // Vừa bật xong, /health đã OK nhưng engine còn nạp dở ("not available") → đợi rồi thử lại vài lần
    for (let i = 0; ; i++) {
      const res = await fetchImpl(`${base}/generate`, { method: 'POST', body: form, signal: AbortSignal.timeout(partMs) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      const t = (await res.text().catch(() => '')).slice(0, 200);
      if (i < retries && (res.status >= 500 || /not available|loading|starting/i.test(t))) { await sleep(retryMs); continue; }
      throw fail(`VoiceStudio trả lỗi ${res.status}. ${t}`.trim());
    }
  };

  const toFile = (wavs, out, fx) => {
    const dirTmp = fs.mkdtempSync(path.join(path.dirname(out), '.vs-'));
    const files = wavs.map((w, i) => { const f = path.join(dirTmp, `${i}.wav`); fs.writeFileSync(f, w); return f; });
    const list = path.join(dirTmp, 'list.txt');
    fs.writeFileSync(list, files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'));
    // mp3 → mã hóa lại; wav → ghép nguyên (có hiệu ứng thì cũng phải mã hóa lại)
    const filter = fxFilter(fx);
    const codec = [...(filter ? ['-af', filter] : []), ...(/\.mp3$/i.test(out) ? ['-codec:a', 'libmp3lame', '-b:a', '128k'] : filter ? [] : ['-c', 'copy'])];
    return new Promise((resolve, reject) => {
      execFile(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...codec, out], (e, _o, err) => {
        fs.rmSync(dirTmp, { recursive: true, force: true });
        if (e) reject(fail(`Không ghép được file âm thanh: ${(err || e.message).trim().slice(-200)}`));
        else resolve();
      });
    });
  };

  // Đọc các đoạn (đã chia sẵn) lần lượt — card đồ họa chỉ xử lý một việc mỗi lúc; ghi ra `out` (.mp3/.wav).
  function run({ parts, out, voice, fx, onProgress }) {
    const job = async () => {
      await ensure();
      const wavs = [];
      const total = parts.reduce((n, p) => n + p.length, 0) || 1;
      let done = 0;
      onProgress?.({ done: 0, total, part: 0, parts: parts.length });
      for (const p of parts) {
        touch();
        wavs.push(await wavOf(p, voice));
        done += p.length;
        onProgress?.({ done, total, part: wavs.length, parts: parts.length });
      }
      touch();
      await toFile(wavs, out, fx);
    };
    return (queue = queue.catch(() => {}).then(job));
  }

  const profiles = async () => {
    await ensure();
    const res = await fetchImpl(`${base}/profiles`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw fail(`VoiceStudio trả lỗi ${res.status}.`);
    const j = await res.json();
    return (Array.isArray(j) ? j : j.profiles || []).map((p) => ({ id: `profile:${p.id}`, name: p.name || p.id, desc: 'Giọng đã lưu trong VoiceStudio' }));
  };

  // Rảnh quá idleMs thì tắt backend do mình bật (có pid file); backend của app đang mở thì không có pid file nên không đụng tới.
  function sweep() {
    const pid = ownPid();
    if (!pid) return;
    let last = 0;
    try { last = Number(fs.readFileSync(usedFile, 'utf8')) || 0; } catch { /* chưa dùng */ }
    if (Date.now() - last < idleMs) return;
    stop();
  }
  function stop() {
    const pid = ownPid();
    // pid cũ có thể đã được tiến trình khác dùng lại → chỉ tắt khi đúng là uvicorn
    const isOurs = (() => { try { return /uvicorn/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return false; } })();
    if (pid && isOurs) { try { process.kill(pid, 'SIGTERM'); } catch { /* đã tắt */ } }
    fs.rmSync(pidFile, { force: true });
  }
  const watch = (every = 60_000) => { timer ??= setInterval(sweep, every); timer.unref?.(); return () => { clearInterval(timer); timer = null; }; };

  return { available: () => !!dir, isUp: up, ensure, run, profiles, sweep, stop, watch };
}
