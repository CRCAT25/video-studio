#!/usr/bin/env node
// Lệnh giọng đọc cho Claude: đọc cấu hình & khóa từ Video Studio, ghi file âm thanh, in JSON kết quả.
// Dùng: studio-tts --in script.txt --out audio.mp3 [--provider id] [--voice id] [--estimate]
// Giọng trả phí chỉ dùng khi Video Studio đặt VS_TTS_ALLOW_PAID=1 (người dùng đã duyệt chi phí); không thì tự dùng VieNeu miễn phí.
import fs from 'node:fs';
import path from 'node:path';
import { studioHome } from '../paths.js';
import { createSecretStore } from '../keychain.js';
import { createTts } from '../tts.js';

const a = process.argv.slice(2);
const get = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const done = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(code); };

try {
  const home = studioHome();
  const tts = createTts({ home, secrets: createSecretStore({ home, platform: process.env.VS_SECRETS === 'file' ? 'file' : process.platform }) });
  const inFile = get('in');
  const text = get('text') ?? (inFile ? fs.readFileSync(inFile, 'utf8') : '');
  if (a.includes('--estimate')) done({ ok: true, ...tts.estimate(get('provider'), text) });
  const out = get('out');
  if (!out) done({ ok: false, error: 'Thiếu --out <file âm thanh>.' }, 2);
  const r = await tts.synth({ provider: get('provider'), text, out: path.resolve(out), voice: get('voice') || '', allowPaid: process.env.VS_TTS_ALLOW_PAID === '1' });
  done({ ok: true, ...r });
} catch (e) {
  done({ ok: false, error: e.message }, 1);
}
