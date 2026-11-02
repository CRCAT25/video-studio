import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWatcher, vttToText, youtubeId } from '../server/watch.js';

test('watch: youtubeId chỉ nhận link YouTube', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=mqyBRC_avHY'), 'mqyBRC_avHY');
  assert.equal(youtubeId('https://youtu.be/mqyBRC_avHY?t=3'), 'mqyBRC_avHY');
  assert.equal(youtubeId('https://www.youtube.com/shorts/mqyBRC_avHY'), 'mqyBRC_avHY');
  assert.equal(youtubeId('https://evil.com/watch?v=mqyBRC_avHY'), null);
  assert.equal(youtubeId('không phải link'), null);
});

test('watch: vttToText bỏ mốc thời gian, thẻ và dòng lặp', () => {
  const vtt = 'WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:02.000\nXin <c>chào</c>\n\n00:00:02.000 --> 00:00:03.000\nXin chào\nbạn\n';
  assert.equal(vttToText(vtt), 'Xin chào bạn');
});

test('watch: tải → cắt khung → phân tích; xóa video; dùng lại cache', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-watch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const ytdlp = path.join(bin, 'yt-dlp.mjs');
  fs.writeFileSync(ytdlp, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('-J')) console.log(JSON.stringify({ title: 'Mẫu', uploader: 'K', duration: 60, view_count: 5 }));
else if (a.includes('--skip-download')) fs.writeFileSync(a[a.indexOf('-o') + 1] + '.vi.vtt', 'WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\nXin chào\\n');
else fs.writeFileSync(a[a.indexOf('-o') + 1], 'x');
`);
  const ffmpeg = path.join(bin, 'ffmpeg.mjs');
  fs.writeFileSync(ffmpeg, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.argv[process.argv.length - 1], 'jpg');
`);
  const claude = path.join(bin, 'claude.mjs');
  fs.writeFileSync(claude, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { summary: 'S', style: 'ST', structure: 'C', improve: 'I' } }));
`);
  for (const f of [ytdlp, ffmpeg]) fs.chmodSync(f, 0o755);
  const w = createWatcher({ home, claudeBin: claude, ytdlp, ffmpeg });
  const r = await w.watch('https://youtu.be/mqyBRC_avHY');
  assert.equal(r.title, 'Mẫu');
  assert.match(r.analysisMd, /Xin chào/);
  assert.match(r.analysisMd, /\*\*Phong cách hình\/âm:\*\* ST/);
  assert.equal(fs.readdirSync(path.join(r.dir, 'frames')).length, 12);
  assert.equal(fs.existsSync(path.join(r.dir, 'v.mp4')), false);
  assert.equal(w.get('mqyBRC_avHY').id, 'mqyBRC_avHY');
  const dest = path.join(home, 'proj', '.studio', 'reference');
  assert.equal(w.copyTo('mqyBRC_avHY', dest), true);
  assert.ok(fs.existsSync(path.join(dest, 'frames')));
  await assert.rejects(() => w.watch('https://evil.com/x'), { code: 'invalid_url' });
});
