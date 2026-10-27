import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShortTools } from '../server/shorts.js';
import { handle } from '../server/assistant-mcp.js';

const has = (bin) => { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-shorts-'));
  fs.mkdirSync(path.join(dir, 'images'));
  if (has('ffmpeg')) for (const n of ['a', 'b']) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360', '-frames:v', '1', '-y', path.join(dir, 'images', `${n}.png`)]);
  fs.writeFileSync(path.join(dir, 'storyboard.md'), 'Cảnh 1: mở đầu');
  const store = { getProject: (id) => (id === 'p1' ? { id: 'p1', title: 'Thử', dir } : null), listProjects: () => [{ id: 'p1', title: 'Thử' }] };
  return { dir, tools: createShortTools({ store }) };
}

test('shorts: liệt kê ảnh + trích storyboard; chặn đường dẫn ra ngoài dự án', async () => {
  const { dir, tools } = setup();
  assert.match((await tools.project_images({})).text, /p1 — Thử/);
  if (!has('ffmpeg')) return;
  const l = await tools.project_images({ projectId: 'p1' });
  assert.match(l.text, /images\/a\.png/);
  assert.match(l.text, /mở đầu/);
  const bad = await tools.make_short({ projectId: 'p1', title: 'x', scenes: [{ image: '../x.png', seconds: 2 }] });
  assert.equal(bad.isError, true);
  assert.equal((await tools.view_images({ projectId: 'zz', paths: ['images/a.png'] })).isError, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shorts: view_images trả ảnh; make_short dựng mp4 9:16 vào shorts/', async (t) => {
  if (!has('ffmpeg')) return t.skip('không có ffmpeg');
  const { dir, tools } = setup();
  const v = await tools.view_images({ projectId: 'p1', paths: ['images/a.png'] });
  assert.equal(v.images.length, 1);
  const r = await tools.make_short({ projectId: 'p1', title: 'Thử nghiệm', scenes: [{ image: 'images/a.png', seconds: 1 }, { image: 'images/b.png', seconds: 1 }] });
  assert.ok(!r.isError, r.text);
  const f = path.join(dir, 'shorts', 'thu-nghiem.mp4');
  assert.ok(fs.statSync(f).size > 1000);
  assert.match(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString(), /1080,1920/);
  const again = await tools.make_short({ projectId: 'p1', title: 'Thử nghiệm', scenes: [{ image: 'images/a.png', seconds: 1 }] });
  assert.match(again.text, /thu-nghiem-2\.mp4/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mcp: tool trả ảnh thành khối image', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ text: 'ok', images: [{ data: 'QUJD', mimeType: 'image/jpeg' }] }) });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'view_images', arguments: { projectId: 'p1', paths: ['a.png'] } } }, { url: 'http://x', key: 'k', fetchFn });
  assert.equal(r.result.content[0].type, 'image');
  assert.equal(r.result.content[1].text, 'ok');
});

test('shorts: reveal=draw dựng được cảnh vẽ dần (cần Pillow+numpy, thiếu thì báo rõ)', async (t) => {
  if (!has('ffmpeg')) return t.skip('không có ffmpeg');
  const { dir, tools } = setup();
  const r = await tools.make_short({ projectId: 'p1', title: 'Ve', scenes: [{ image: 'images/a.png', seconds: 1, reveal: 'draw' }] });
  if (r.isError) assert.match(r.text, /Pillow và numpy/);
  else assert.ok(fs.existsSync(path.join(dir, 'shorts', 've.mp4')));
  fs.rmSync(dir, { recursive: true, force: true });
});
