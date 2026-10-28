// Giọng đọc (text-to-speech): nhà cung cấp do người dùng thêm (ElevenLabs có sẵn, API HTTP tự định nghĩa, hoặc lệnh trên máy).
// Cấu hình ở <home>/tts.json (không chứa khóa); khóa API nằm trong kho bí mật (Keychain / file 600), không bao giờ log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS = new Set(['elevenlabs', 'http', 'command']);
const RESPONSES = new Set(['audio', 'json-base64', 'json-url']);
export const MAX_TEXT = 200_000;
const CHUNK = 2500;
const TIMEOUT_MS = 120_000;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
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
  const perChar = Number.isFinite(per) && per > 0 ? per : kind === 'elevenlabs' && p.price == null ? 1 : 0;
  o.price = { perChar, label: String(p.price?.label || (kind === 'elevenlabs' ? 'credit' : '')).trim().slice(0, 20) };
  if (kind === 'elevenlabs') {
    if (!o.voice) throw fail(400, 'bad_voice', 'Cần nhập ID giọng (voice id) của ElevenLabs.');
    o.model = String(p.model || 'eleven_multilingual_v2').trim().slice(0, 60);
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
      return { default: typeof o.default === 'string' ? o.default : null, providers: Array.isArray(o.providers) ? o.providers : [] };
    } catch {
      return { default: null, providers: [] };
    }
  };
  const write = (o) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(o, null, 2), { mode: 0o600 });
  };
  const keyOf = async (id) => (secrets ? await secrets.get(secretName(id)) : null);

  async function list() {
    const c = read();
    const providers = [];
    for (const p of c.providers) providers.push({ ...p, hasKey: !!(await keyOf(p.id)) });
    return { default: c.providers.some((p) => p.id === c.default) ? c.default : null, providers };
  }

  // key: undefined = giữ khóa cũ; '' = xóa khóa; chuỗi = đặt khóa mới.
  async function save(input, key) {
    const c = read();
    const p = cleanProvider(input);
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
      if (key.trim()) await secrets.set(secretName(p.id), key.trim());
      else await secrets.remove(secretName(p.id));
    }
    return p;
  }

  async function remove(id) {
    const c = read();
    if (!c.providers.some((p) => p.id === id)) throw fail(404, 'not_found', 'Không có nhà cung cấp này.');
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
    const p = c.providers.find((x) => x.id === (id || c.default));
    if (!p) throw fail(404, 'no_provider', 'Chưa có nhà cung cấp giọng đọc — thêm ở tab Giọng đọc.');
    return p;
  }

  const isPaid = (p) => (p.price?.perChar ?? 0) > 0;
  const estimate = (p, text) => {
    const chars = String(text).trim().length;
    return { chars, paid: isPaid(p), cost: isPaid(p) ? Math.round(chars * p.price.perChar) : 0, label: p.price?.label || '' };
  };

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
      if (!res.ok) throw fail(502, 'tts_failed', `ElevenLabs trả lỗi ${res.status}${res.status === 401 ? ' — kiểm tra khóa API' : ''}.`);
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

  function runCommand(p, text, out, voice, key) {
    const dir = fs.mkdtempSync(path.join(path.dirname(out), '.tts-'));
    const inFile = path.join(dir, 'in.txt');
    fs.writeFileSync(inFile, text);
    const [bin, ...args] = splitCommand(p.command).map((a) => a.replaceAll('{in}', inFile).replaceAll('{out}', out).replaceAll('{voice}', voice));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...(key ? { TTS_KEY: key } : {}) }, timeout: timeoutMs * 3 });
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

  // Đọc `text` bằng nhà cung cấp `id` (mặc định nếu bỏ trống) và ghi vào `out`. Trả thông tin để báo cáo.
  async function synth({ provider = null, text, out, voice = '' }) {
    const body = String(text ?? '').trim();
    if (!body) throw fail(400, 'empty_text', 'Văn bản trống.');
    if (body.length > MAX_TEXT) throw fail(400, 'too_long', `Văn bản dài quá ${MAX_TEXT} ký tự — chia nhỏ rồi chạy từng phần.`);
    const p = pick(provider);
    const v = voice || p.voice;
    const key = await keyOf(p.id);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (p.kind === 'command') {
      await runCommand(p, body, out, v, key);
    } else {
      const parts = chunkText(body);
      if (parts.length > 1 && !/\.mp3$/i.test(out)) throw fail(400, 'need_mp3', 'Văn bản dài được chia nhiều đoạn — hãy ghi ra file .mp3.');
      const bufs = [];
      for (const part of parts) bufs.push(await callApi(p, part, v, key));
      fs.writeFileSync(out, Buffer.concat(bufs));
    }
    return { out, provider: p.id, ...estimate(p, body) };
  }

  // Nhà cung cấp mặc định cho runner: không lộ khóa.
  function runInfo() {
    const c = read();
    const p = c.providers.find((x) => x.id === c.default);
    return p ? { id: p.id, name: p.name, paid: isPaid(p), label: p.price?.label || '' } : null;
  }

  return { list, save, remove, setDefault, synth, estimate: (id, text) => estimate(pick(id), text), runInfo, pick };
}
