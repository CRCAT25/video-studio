// Giọng đọc (text-to-speech): nhà cung cấp do người dùng thêm (ElevenLabs có sẵn, API HTTP tự định nghĩa, hoặc lệnh trên máy).
// Cấu hình ở <home>/tts.json (không chứa khóa); khóa API nằm trong kho bí mật (Keychain / file 600), không bao giờ log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Danh sách giọng gợi ý đi kèm app (giọng có sẵn của ElevenLabs + giọng tiếng Việt); không chứa khóa API.
const BUNDLED_VOICES = fileURLToPath(new URL('./tts-voices.json', import.meta.url));
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS = new Set(['elevenlabs', 'http', 'command', 'vieneu']);
const VIENEU_SCRIPT = fileURLToPath(new URL('./bin/vieneu_tts.py', import.meta.url));
// Giọng VieNeu có sẵn (tên preset của thư viện vieneu); giọng đầu là mặc định.
export const VIENEU_VOICES = [
  ['Thiện Minh', 'Nam · Bắc · kể chuyện'], ['Ngọc Linh', 'Nữ · Bắc · kể chuyện'], ['Thiền Tâm Đức', 'Nam · Bắc · kể chuyện'], ['Thanh Bình', 'Nam · Bắc · kể chuyện'],
  ['Mai Anh', 'Nữ · Bắc · tin tức'], ['Minh Đức', 'Nam · Bắc · tin tức'], ['Trúc Ly', 'Nữ · Bắc · tự nhiên'], ['Hải Đăng', 'Nam · Bắc · tự nhiên'],
  ['Ngọc Huyền', 'Nữ · Bắc · tự nhiên'], ['Quốc Tuấn', 'Nam · Bắc · tự nhiên'], ['Quỳnh Anh', 'Nữ · Bắc · đọc truyện'], ['Thùy Dung', 'Nữ · Nam · tin tức'],
  ['Thái Sơn', 'Nam · Nam · kể chuyện'], ['Thục Đoan', 'Nữ · Nam · kể chuyện'], ['Mỹ Duyên', 'Nữ · Nam · đọc truyện'], ['Quang Sơn', 'Nam · Trung · tự nhiên'], ['Ngọc Trân', 'Nữ · Trung · tự nhiên'],
].map(([id, desc]) => ({ id, name: id, desc }));
// Nhà cung cấp miễn phí luôn có: dùng khi chưa duyệt chi phí giọng trả phí.
const BUILTIN_FREE = { id: 'vieneu', name: 'VieNeu (miễn phí, trên máy)', kind: 'vieneu', voice: VIENEU_VOICES[0].id, price: { perChar: 0, label: '' }, builtin: true };
const RESPONSES = new Set(['audio', 'json-base64', 'json-url']);
export const MAX_TEXT = 200_000;
const CHUNK = 2500;
const TIMEOUT_MS = 120_000;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
// Khóa API chỉ gồm ký tự ASCII in được; gõ nhầm bộ gõ tiếng Việt (ẽ, ế…) sẽ làm fetch văng lỗi 500.
const checkKey = (k) => {
  const v = String(k ?? '').trim();
  if (v && !/^[\x21-\x7e]+$/.test(v)) throw fail(400, 'bad_key', 'Khóa API có ký tự lạ (dấu tiếng Việt hoặc khoảng trắng) — tắt bộ gõ tiếng Việt, hoặc copy-dán lại khóa từ ElevenLabs.');
  return v;
};
const secretName = (id) => `tts:${id}`;

// Cắt văn bản ≤ max ký tự theo câu/đoạn để mỗi lần gọi API không vượt giới hạn.
export function chunkText(text, max = CHUNK) {
  const t = String(text).replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t ? [t] : [];
  const out = [];
  let cur = '';
  const parts = t.split(/(?<=[.!?…。\n])\s+/);
  for (let p of parts) {
    while (p.length > max) {
      const cut = Math.max(p.lastIndexOf(' ', max), Math.floor(max / 2));
      if (cur) { out.push(cur); cur = ''; }
      out.push(p.slice(0, cut));
      p = p.slice(cut).trim();
    }
    if ((cur + ' ' + p).trim().length > max) { out.push(cur); cur = p; } else cur = (cur + ' ' + p).trim();
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

// Chèn giá trị vào mẫu; trong thân JSON thì thoát ký tự đặc biệt để không phá cấu trúc.
const fillJson = (tpl, vars) => tpl.replace(/\{(text|voice)\}/g, (_, k) => JSON.stringify(String(vars[k] ?? '')).slice(1, -1));
const fillPlain = (tpl, vars) => tpl.replace(/\{(key|voice)\}/g, (_, k) => String(vars[k] ?? ''));
const dig = (obj, p) => String(p || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);

// Tách lệnh thành argv (hỗ trợ "..." và '...'), không qua shell.
export function splitCommand(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s)))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function cleanProvider(p) {
  if (!p || typeof p !== 'object') throw fail(400, 'bad_body', 'Thiếu thông tin nhà cung cấp.');
  const kind = String(p.kind || '');
  if (!KINDS.has(kind)) throw fail(400, 'bad_kind', 'Loại nhà cung cấp không hợp lệ.');
  const name = String(p.name || '').trim().slice(0, 60);
  if (!name) throw fail(400, 'bad_name', 'Cần đặt tên cho nhà cung cấp.');
  const o = { id: String(p.id || ''), name, kind, voice: String(p.voice || '').trim().slice(0, 200) };
  const per = Number(p.price?.perChar);
  // ElevenLabs tự quy định giá theo model (Flash/Turbo = 0,5 credit/ký tự, còn lại 1) — không nhận giá do người dùng nhập.
  const elModel = String(p.model || 'eleven_multilingual_v2');
  const perChar = kind === 'elevenlabs' ? (/flash|turbo/i.test(elModel) ? 0.5 : 1) : Number.isFinite(per) && per > 0 ? per : 0;
  o.price = { perChar, label: String(p.price?.label || (kind === 'elevenlabs' ? 'credit' : '')).trim().slice(0, 20) };
  if (kind === 'elevenlabs') {
    if (!o.voice) throw fail(400, 'bad_voice', 'Cần nhập ID giọng (voice id) của ElevenLabs.');
    o.model = String(p.model || 'eleven_multilingual_v2').trim().slice(0, 60);
  } else if (kind === 'vieneu') {
    o.voice = o.voice || VIENEU_VOICES[0].id;
  } else if (kind === 'http') {
    const h = p.http || {};
    let u;
    try {
      u = new URL(String(h.url || ''));
    } catch {
      throw fail(400, 'bad_url', 'Địa chỉ API không hợp lệ.');
    }
    if (!/^https?:$/.test(u.protocol)) throw fail(400, 'bad_url', 'Địa chỉ API phải bắt đầu bằng http:// hoặc https://.');
    const response = RESPONSES.has(h.response) ? h.response : 'audio';
    const headers = {};
    for (const [k, v] of Object.entries(h.headers && typeof h.headers === 'object' ? h.headers : {})) {
      if (/^[A-Za-z0-9-]{1,60}$/.test(k)) headers[k] = String(v).slice(0, 500);
    }
    o.http = { url: u.toString(), method: /^(GET|POST|PUT)$/i.test(h.method) ? h.method.toUpperCase() : 'POST', headers, body: String(h.body || '').slice(0, 5000), response, jsonPath: String(h.jsonPath || '').slice(0, 100) };
  } else {
    const cmd = String(p.command || '').trim();
    if (!cmd || !/\{out\}/.test(cmd)) throw fail(400, 'bad_command', 'Lệnh cần có {out} (nơi ghi file âm thanh) và nên có {in} (file văn bản).');
    o.command = cmd.slice(0, 1000);
  }
  return o;
}

export function createTts({ home, secrets = null, fetchImpl = (...a) => fetch(...a), timeoutMs = TIMEOUT_MS } = {}) {
  const file = path.join(home, 'tts.json');
  const read = () => {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      return withFree({ default: typeof o.default === 'string' ? o.default : null, providers: Array.isArray(o.providers) ? o.providers : [] });
    } catch {
      return withFree({ default: null, providers: [] });
    }
  };
  // Luôn kèm VieNeu miễn phí (nếu người dùng chưa tự lưu một nhà cung cấp VieNeu).
  const withFree = (c) => (c.providers.some((p) => p.kind === 'vieneu') ? c : { ...c, providers: [...c.providers, { ...BUILTIN_FREE }] });
  const write = (o) => {
    fs.mkdirSync(home, { recursive: true });
    const providers = o.providers.filter((p) => !p.builtin);
    fs.writeFileSync(file, JSON.stringify({ ...o, providers }, null, 2), { mode: 0o600 });
  };
  const keyOf = async (id) => (secrets ? await secrets.get(secretName(id)) : null);

  async function list() {
    const c = read();
    const providers = [];
    for (const p of c.providers) providers.push({ ...p, hasKey: !!(await keyOf(p.id)) });
    return { default: c.providers.some((p) => p.id === c.default) ? c.default : providers[0]?.id ?? null, providers, vieneuVoices: VIENEU_VOICES };
  }

  // key: undefined = giữ khóa cũ; '' = xóa khóa; chuỗi = đặt khóa mới.
  async function save(input, key) {
    const c = read();
    const p = cleanProvider(input);
    if (typeof key === 'string') key = checkKey(key);
    if (!p.id) {
      const base = p.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'tts';
      let id = base, n = 2;
      while (c.providers.some((x) => x.id === id)) id = `${base}-${n++}`;
      p.id = id;
    } else if (!ID_RE.test(p.id)) throw fail(400, 'bad_id', 'Mã nhà cung cấp không hợp lệ.');
    const i = c.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) c.providers[i] = p; else c.providers.push(p);
    if (!c.default) c.default = p.id;
    write(c);
    if (secrets && typeof key === 'string') {
      if (key) await secrets.set(secretName(p.id), key.trim());
      else await secrets.remove(secretName(p.id));
    }
    return p;
  }

  async function remove(id) {
    const c = read();
    const x = c.providers.find((p) => p.id === id);
    if (!x) throw fail(404, 'not_found', 'Không có nhà cung cấp này.');
    if (x.builtin) throw fail(400, 'builtin', 'Giọng miễn phí có sẵn — không xóa được.');
    c.providers = c.providers.filter((p) => p.id !== id);
    if (c.default === id) c.default = c.providers[0]?.id ?? null;
    write(c);
    if (secrets) await secrets.remove(secretName(id));
  }

  function setDefault(id) {
    const c = read();
    if (!c.providers.some((p) => p.id === id)) throw fail(404, 'not_found', 'Không có nhà cung cấp này.');
    c.default = id;
    write(c);
  }

  function pick(id) {
    const c = read();
    const p = c.providers.find((x) => x.id === (id || c.default)) || (!id ? c.providers[0] : null);
    if (!p) throw fail(404, 'no_provider', 'Chưa có nhà cung cấp giọng đọc — thêm ở tab Giọng đọc.');
    return p;
  }

  const isPaid = (p) => (p.price?.perChar ?? 0) > 0;
  const freeOf = (c) => c.providers.find((x) => !isPaid(x) && x.kind === 'vieneu') || c.providers.find((x) => !isPaid(x));
  const estimate = (p, text) => {
    const chars = String(text).trim().length;
    return { chars, paid: isPaid(p), cost: isPaid(p) ? Math.round(chars * p.price.perChar) : 0, label: p.price?.label || '' };
  };

  // Đổi lỗi ElevenLabs thành câu dễ hiểu (đọc status/message trong thân phản hồi).
  async function elevenError(res) {
    const j = await res.json().catch(() => ({}));
    const d = j?.detail || {};
    const raw = JSON.stringify(j);
    const msg = String(d.message || (typeof j?.detail === 'string' ? j.detail : '') || '').slice(0, 160);
    const more = msg ? ` (${msg})` : '';
    if (/missing_permissions|text_to_speech/i.test(raw) && res.status === 401) return `Khóa API thiếu quyền "Text to Speech" — tạo khóa mới và bật quyền này${more}.`;
    if (res.status === 401) return `Khóa API không đúng hoặc đã bị thu hồi — dán lại khóa mới${more}.`;
    if (res.status === 402 || /paid_plan_required|payment_required|library/i.test(raw)) return `Giọng này thuộc thư viện cộng đồng — gói miễn phí không dùng được qua API. Hãy nâng gói hoặc chọn giọng có sẵn (premade)${more}.`;
    if (res.status === 404 || /voice_not_found/i.test(raw)) return `Không tìm thấy giọng này trong tài khoản — kiểm tra ID giọng${more}.`;
    if (/quota_exceeded/i.test(raw)) return `Tài khoản ElevenLabs đã hết credit${more}.`;
    if (res.status === 429) return 'ElevenLabs đang giới hạn số yêu cầu — đợi một lát rồi thử lại.';
    return `ElevenLabs trả lỗi ${res.status}${more}.`;
  }
  async function callApi(p, text, voice, key) {
    const ctl = AbortSignal.timeout(timeoutMs);
    let res;
    if (p.kind === 'elevenlabs') {
      if (!key) throw fail(400, 'no_key', 'Chưa nhập khóa API ElevenLabs.');
      res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: p.model || 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        signal: ctl,
      });
      if (!res.ok) throw fail(502, 'tts_failed', await elevenError(res));
      return Buffer.from(await res.arrayBuffer());
    }
    const h = p.http;
    const headers = {};
    for (const [k, v] of Object.entries(h.headers)) headers[k] = fillPlain(v, { key: key || '', voice });
    const hasBody = h.method !== 'GET';
    res = await fetchImpl(fillPlain(h.url, { voice: encodeURIComponent(voice), key: '' }), { method: h.method, headers, body: hasBody ? fillJson(h.body, { text, voice }) : undefined, signal: ctl });
    if (!res.ok) throw fail(502, 'tts_failed', `${p.name} trả lỗi ${res.status}.`);
    if (h.response === 'audio') return Buffer.from(await res.arrayBuffer());
    const j = await res.json();
    const v = dig(j, h.jsonPath);
    if (typeof v !== 'string' || !v) throw fail(502, 'tts_failed', `Không tìm thấy "${h.jsonPath || '(đường dẫn rỗng)'}" trong kết quả JSON của ${p.name}.`);
    if (h.response === 'json-base64') return Buffer.from(v.replace(/^data:[^,]*,/, ''), 'base64');
    const r2 = await fetchImpl(v, { signal: ctl });
    if (!r2.ok) throw fail(502, 'tts_failed', `Tải file âm thanh từ ${p.name} lỗi ${r2.status}.`);
    return Buffer.from(await r2.arrayBuffer());
  }

  function runCommand(p, text, out, voice, key, limitMs = timeoutMs * 3) {
    const dir = fs.mkdtempSync(path.join(path.dirname(out), '.tts-'));
    const inFile = path.join(dir, 'in.txt');
    fs.writeFileSync(inFile, text);
    const [bin, ...args] = splitCommand(p.command).map((a) => a.replaceAll('{in}', inFile).replaceAll('{out}', out).replaceAll('{voice}', voice));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...(key ? { TTS_KEY: key } : {}) }, timeout: limitMs });
      } catch (e) {
        reject(fail(502, 'tts_failed', `Không chạy được lệnh: ${e.message}`));
        return;
      }
      let err = '';
      child.stderr.on('data', (d) => { err = (err + d).slice(-500); });
      child.on('error', (e) => reject(fail(502, 'tts_failed', `Không chạy được lệnh: ${e.message}`)));
      child.on('close', (code) => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (code !== 0) reject(fail(502, 'tts_failed', `Lệnh giọng đọc thoát mã ${code}. ${err.trim()}`.trim()));
        else if (!fs.existsSync(out)) reject(fail(502, 'tts_failed', 'Lệnh chạy xong nhưng không ghi file {out}.'));
        else resolve();
      });
    });
  }

  // VieNeu chạy bằng uv (tự cài thư viện lần đầu); ghi thẳng ra `out` (.mp3/.wav).
  function runVieneu(text, out, voice) {
    const uv = process.env.VS_UV || [path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv'].find((f) => fs.existsSync(f)) || 'uv';
    const cmd = `${uv} run --no-project --python 3.12 --with vieneu --with "onnxruntime<1.23" --with soundfile python "${VIENEU_SCRIPT}" --in {in} --out {out} --voice "{voice}"`;
    return runCommand({ command: cmd }, text, out, voice, null, timeoutMs * 15);
  }

  // Đọc `text` bằng nhà cung cấp `id` (mặc định nếu bỏ trống) và ghi vào `out`. Trả thông tin để báo cáo.
  // allowPaid=false: nhà cung cấp trả phí được thay bằng giọng miễn phí (VieNeu) — không bao giờ tốn tiền khi chưa duyệt.
  async function synth({ provider = null, text, out, voice = '', allowPaid = true }) {
    const body = String(text ?? '').trim();
    if (!body) throw fail(400, 'empty_text', 'Văn bản trống.');
    if (body.length > MAX_TEXT) throw fail(400, 'too_long', `Văn bản dài quá ${MAX_TEXT} ký tự — chia nhỏ rồi chạy từng phần.`);
    let p = pick(provider);
    let fallback = null;
    if (isPaid(p) && !allowPaid) {
      fallback = { from: p.name, reason: 'Chưa duyệt chi phí — dùng giọng miễn phí.' };
      p = freeOf(read());
      voice = '';
    }
    const v = voice || p.voice;
    const key = await keyOf(p.id);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (p.kind === 'vieneu') {
      await runVieneu(body, out, v);
    } else if (p.kind === 'command') {
      await runCommand(p, body, out, v, key);
    } else {
      const parts = chunkText(body);
      if (parts.length > 1 && !/\.mp3$/i.test(out)) throw fail(400, 'need_mp3', 'Văn bản dài được chia nhiều đoạn — hãy ghi ra file .mp3.');
      const bufs = [];
      for (const part of parts) bufs.push(await callApi(p, part, v, key));
      fs.writeFileSync(out, Buffer.concat(bufs));
    }
    return { out, provider: p.id, name: p.name, voice: v, ...(fallback ? { fallback } : {}), ...estimate(p, body) };
  }

  // Danh sách giọng của ElevenLabs: dùng khóa vừa nhập (chưa lưu) hoặc khóa đã lưu của nhà cung cấp `id`.
  async function voices({ id = null, key = '' } = {}) {
    const k = checkKey(key) || (id ? await keyOf(id) : null);
    if (!k) return { voices: JSON.parse(fs.readFileSync(BUNDLED_VOICES, 'utf8')), bundled: true };
    const res = await fetchImpl('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': k, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) {
      const j = await res.json().catch(() => ({}));
      const missing = /voices_read|missing_permissions/.test(JSON.stringify(j));
      throw fail(400, 'tts_failed', missing ? 'Khóa API thiếu quyền đọc danh sách giọng — tạo khóa mới và bật quyền "Voices: Read".' : 'Khóa API không đúng.');
    }
    if (!res.ok) throw fail(502, 'tts_failed', `ElevenLabs trả lỗi ${res.status}.`);
    const j = await res.json();
    // Gói miễn phí không đọc được giọng thư viện/chuyên nghiệp qua API → chỉ giữ giọng dùng được. Không đọc được gói thì giữ tất cả.
    const tier = await fetchImpl('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': k, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => (r.ok ? r.json() : null)).then((x) => String(x?.tier || '')).catch(() => '');
    const all = Array.isArray(j.voices) ? j.voices : [];
    const usable = tier === 'free' ? all.filter((v) => !['professional', 'famous'].includes(v.category) && !v.sharing?.public_owner_id) : all;
    return { tier, hidden: all.length - usable.length, voices: usable.map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category || '',
      desc: [v.labels?.language, v.labels?.gender, v.labels?.accent, v.labels?.descriptive || v.labels?.use_case].filter(Boolean).join(' · '),
      preview: v.preview_url || '',
    })).filter((v) => v.id && v.name) };
  }

  // Kiểm tra khóa ElevenLabs: hợp lệ không, có những quyền nào (không tốn credit), gói + credit còn lại.
  // Quyền Text to Speech thử bằng ID giọng không tồn tại: thiếu quyền → 401, đủ quyền → 404/422 (không đọc gì cả).
  async function check({ id = null, key = '' } = {}) {
    const k = checkKey(key) || (id ? await keyOf(id) : null);
    if (!k) throw fail(400, 'no_key', 'Chưa có khóa API để kiểm tra.');
    const H = { 'xi-api-key': k, accept: 'application/json' };
    const go = (url, init = {}) => fetchImpl(url, { ...init, headers: { ...H, ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
    const perm = async (res) => {
      if (res.status === 401) {
        const raw = JSON.stringify(await res.json().catch(() => ({})));
        return /missing_permissions/.test(raw) ? 'no' : 'invalid';
      }
      return res.status === 403 ? 'no' : res.status < 500 ? 'yes' : 'unknown';
    };
    const [v, u, s] = await Promise.all([
      go('https://api.elevenlabs.io/v1/voices').then(perm, () => 'unknown'),
      go('https://api.elevenlabs.io/v1/user/subscription'),
      go('https://api.elevenlabs.io/v1/text-to-speech/vs-permission-probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '.' }) }).then(perm, () => 'unknown'),
    ].map((x) => x.catch?.(() => 'unknown') ?? x));
    let sub = null;
    let userPerm = 'unknown';
    if (u && typeof u === 'object') {
      userPerm = await perm(u);
      if (u.ok) sub = await u.json().catch(() => null);
    }
    if ([v, s, userPerm].includes('invalid')) return { valid: false };
    return {
      valid: true,
      perms: { tts: s, voices: v, user: userPerm },
      tier: String(sub?.tier || ''),
      credits: sub ? { used: Number(sub.character_count) || 0, limit: Number(sub.character_limit) || 0 } : null,
    };
  }

  // Đọc thử một câu ngắn với giọng/khóa đang nhập (chưa lưu) — trả mp3 dạng buffer + chi phí ước tính.
  async function sample({ id = null, key = '', voice = '', text = '' } = {}) {
    const k = checkKey(key) || (id ? await keyOf(id) : null);
    if (!voice) throw fail(400, 'no_voice', 'Hãy chọn giọng trước.');
    const body = String(text || 'Xin chào, đây là giọng đọc thử.').trim().slice(0, 120);
    const audio = await callApi({ kind: 'elevenlabs', name: 'ElevenLabs', model: 'eleven_multilingual_v2' }, body, voice, k);
    return { audio, chars: body.length, cost: body.length, label: 'credit' };
  }

  // Nhà cung cấp mặc định cho runner: không lộ khóa.
  function runInfo() {
    const c = read();
    const p = c.providers.find((x) => x.id === c.default) || c.providers[0];
    const f = freeOf(c);
    return p ? { id: p.id, name: p.name, paid: isPaid(p), label: p.price?.label || '', free: f ? { id: f.id, name: f.name } : null } : null;
  }

  return { voices, check, sample, list, save, remove, setDefault, synth, estimate: (id, text) => estimate(pick(id), text), runInfo, pick };
}
