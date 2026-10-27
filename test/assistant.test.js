import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { forward, handle, serve, TOOLS, WAIT_MAX_MS } from '../server/assistant-mcp.js';
import { buildAssistantArgs, createAssistant } from '../server/assistant.js';
import { REPO_ROOT } from '../server/presets.js';

const FAKE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chờ tới khi cond() đúng (tối đa ms).
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('hết giờ chờ');
    await sleep(20);
  }
}

let tmp;
let home;
let server;
let assistant;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ai-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});

afterEach(async () => {
  assistant?.dispose();
  assistant = null;
  if (server) await new Promise((r) => server.close(r));
  server = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// App giả tối thiểu: chỉ route MCP gọi về (POST /api/assistant/tool) → assistant.callTool.
async function startHttp() {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const b = JSON.parse(body || '{}');
      try {
        const out = await assistant.callTool(b.key, b.tool, b.args);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.code, message: e.message }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

// Trình duyệt giả: trả trang có nút "+ Dự án mới" và ô "Thời lượng"; ghi lại lệnh nhận được.
function fakeBrowser(a, { answer } = {}) {
  const calls = [];
  a.on((d) => {
    if (d.kind !== 'tool') return;
    calls.push(d);
    const page = 'Trang: #/ · Video Studio\nPhần tử:\n[1] button "+ Dự án mới"\n[2] input number "Thời lượng" value="45" (5–180)\n[3] button "Xóa dự án"';
    setTimeout(() => {
      if (answer) return answer(d, page);
      const label = d.tool === 'click' ? `Đã bấm [${d.args.ref}]` : d.tool === 'fill' ? `Đã nhập "${d.args.value}"` : null;
      a.toolResult(d.id, { text: page, isError: false, label });
    }, 5);
  });
  return calls;
}

// ---------- MCP server

test('MCP: initialize giữ protocolVersion, tools/list, ping, method lạ, notification', async () => {
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'studio');
  assert.equal((await handle({ id: 2, method: 'initialize' })).result.protocolVersion, '2024-11-05');
  const list = await handle({ id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['read_page', 'click', 'fill', 'navigate', 'wait']);
  assert.deepEqual((await handle({ id: 4, method: 'ping' })).result, {});
  assert.equal((await handle({ id: 5, method: 'bogus' })).error.code, -32601);
  assert.equal(await handle({ method: 'notifications/initialized' }), null);
  const bad = await handle({ id: 6, method: 'tools/call', params: { name: 'rm_rf' } });
  assert.equal(bad.result.isError, true);
});

test('MCP: tools/call chuyển về app kèm key; wait ngủ rồi read_page; lỗi HTTP/mạng → isError', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body), ct: init.headers['content-type'] });
    return { ok: true, status: 200, json: async () => ({ text: 'trang', isError: false }) };
  };
  const r = await handle({ id: 1, method: 'tools/call', params: { name: 'click', arguments: { ref: 3 } } }, { url: 'http://h:1', key: 'k', fetchFn });
  assert.deepEqual(r.result, { content: [{ type: 'text', text: 'trang' }] });
  assert.deepEqual(seen[0], { url: 'http://h:1/api/assistant/tool', body: { key: 'k', tool: 'click', args: { ref: 3 } }, ct: 'application/json' });

  const t0 = Date.now();
  await handle({ id: 2, method: 'tools/call', params: { name: 'wait', arguments: { ms: 150 } } }, { url: 'http://h:1', key: 'k', fetchFn });
  assert.ok(Date.now() - t0 >= 140);
  assert.equal(seen[1].body.tool, 'read_page');
  assert.ok(TOOLS.find((t) => t.name === 'wait').inputSchema.properties.ms.maximum === WAIT_MAX_MS);

  const http403 = await forward({ url: 'http://h:1', key: 'x', tool: 'read_page', fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ message: 'Mã lượt không hợp lệ.' }) }) });
  assert.deepEqual(http403, { text: 'Mã lượt không hợp lệ.', isError: true });
  const down = await forward({ url: 'http://h:1', key: 'x', tool: 'read_page', fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.isError, true);
  assert.match(down.text, /ECONNREFUSED/);
});

test('MCP serve: đọc từng dòng, JSON lỗi → -32700, trả lời theo id', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.setEncoding('utf8');
  output.on('data', (c) => lines.push(...c.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  serve({ input, output, url: 'http://h:1', key: 'k' });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{oops\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await until(() => lines.length === 3, 2000);
  assert.deepEqual(lines.find((l) => l.id === 1).result, {});
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
  assert.equal(lines.find((l) => l.id === 2).result.tools.length, 5);
});

// ---------- tham số + vòng đời lượt

test('buildAssistantArgs: chỉ tool studio, không --model khi mặc định, resume dùng --resume', () => {
  const a = buildAssistantArgs({ sessionId: 's1', mcpConfig: '/c.json' });
  assert.deepEqual(a.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 's1']);
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--mcp-config') + 1], '/c.json');
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'mcp__studio__read_page,mcp__studio__click,mcp__studio__fill,mcp__studio__navigate,mcp__studio__wait');
  assert.ok(!a.includes('--model'));
  const b = buildAssistantArgs({ sessionId: 's1', resume: true, mcpConfig: '/c.json', model: 'opus' });
  assert.equal(b[b.indexOf('--resume') + 1], 's1');
  assert.equal(b[b.indexOf('--model') + 1], 'opus');
  assert.ok(!a.includes('--effort'));
  assert.equal(buildAssistantArgs({ sessionId: 's1', mcpConfig: '/c.json', effort: 'low' }).at(-1), 'low');
});

test('lượt chat thật qua fake-claude → MCP (env từ file cấu hình) → trình duyệt giả: mở modal, nhập 60', async () => {
  const url = await startHttp();
  const seen = { limits: [], tokens: [] };
  const usage = { observe: (i) => seen.limits.push(i), record: (src, u) => seen.tokens.push([src, u]) };
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url, usage });
  const calls = fakeBrowser(assistant);
  const states = [];
  assistant.on((d) => d.kind === 'state' && states.push(d.state.busy));
  assert.throws(() => assistant.send('   '), { status: 400 });
  const s = assistant.send('đặt thời lượng 60', { tabId: 'tab-a' });
  assert.equal(s.busy, true);
  assert.throws(() => assistant.send('nữa'), { status: 409, code: 'assistant_busy' });
  await until(() => !assistant.state().busy);
  assert.deepEqual(calls.map((c) => [c.tool, c.tabId]), [['read_page', 'tab-a'], ['click', 'tab-a'], ['fill', 'tab-a']]);
  assert.deepEqual(calls[1].args, { ref: 1 });
  assert.deepEqual(calls[2].args, { ref: 2, value: '60' });
  const msgs = assistant.state().messages.map((m) => [m.role, m.text]);
  assert.deepEqual(msgs, [
    ['user', 'đặt thời lượng 60'],
    ['action', 'Đã bấm [1]'],
    ['action', 'Đã nhập "60"'],
    ['assistant', 'Đã đặt thời lượng 60 giây.'],
  ]);
  assert.ok(states.includes(true) && states.at(-1) === false);
  // mức dùng: % từ rate_limit_event, token của lượt ghi nguồn 'assistant'
  assert.equal(seen.limits[0].unifiedWindows.five_hour.utilization, 0.42);
  assert.deepEqual(seen.tokens, [['assistant', { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 20 }]]);
  // file cấu hình MCP (chứa mã lượt) đã xóa; lịch sử lưu quyền 600
  const dir = path.join(home, 'assistant');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('mcp-')), []);
  assert.equal(fs.statSync(path.join(dir, 'chat.json')).mode & 0o777, 0o600);
  // lần gọi claude: không lộ biến VS_*, có --session-id; lượt 2 dùng --resume cùng phiên
  const log1 = fs.readFileSync(path.join(dir, '.fake-assist.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sid = log1[0].argv[log1[0].argv.indexOf('--session-id') + 1];
  assistant.send('đang ở trang nào?', { tabId: 'tab-a' });
  await until(() => !assistant.state().busy);
  const log2 = fs.readFileSync(path.join(dir, '.fake-assist.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log2[1].argv[log2[1].argv.indexOf('--resume') + 1], sid);
  assert.match(assistant.state().messages.at(-1).text, /Bạn đang ở Trang: #\//);
  // lịch sử còn sau khi tạo lại (khởi động lại app)
  assistant.dispose();
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url });
  assert.equal(assistant.state().messages.length, 6);
});

test('callTool: sai key → 403; tool lạ/wait → 400; không có lượt → 403', async () => {
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => 'http://127.0.0.1:9' });
  assert.throws(() => assistant.callTool('x', 'read_page', {}), { status: 403 });
  assistant.send('chậm thôi', { tabId: 't' });
  assert.throws(() => assistant.callTool('sai-key', 'read_page', {}), { status: 403 });
  const key = JSON.parse(fs.readFileSync(path.join(home, 'assistant', fs.readdirSync(path.join(home, 'assistant')).find((f) => f.startsWith('mcp-'))), 'utf8')).mcpServers.studio.env.STUDIO_ASSIST_KEY;
  assert.throws(() => assistant.callTool(key, 'wait', {}), { status: 400 });
  assert.throws(() => assistant.callTool(key, 'exec', {}), { status: 400 });
  assistant.stop();
  await until(() => !assistant.state().busy);
});

test('toolResult: hết giờ → lỗi "không phản hồi"; hold gia hạn; id lạ → 404; Dừng/kết thúc trả lời lệnh còn treo', async () => {
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => 'http://127.0.0.1:9', toolTimeoutMs: 80, holdTimeoutMs: 300, killGraceMs: 200 });
  const ids = [];
  assistant.on((d) => d.kind === 'tool' && ids.push(d.id));
  assistant.send('chậm thôi', { tabId: 't' });
  const dir = path.join(home, 'assistant');
  const key = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('mcp-'))), 'utf8')).mcpServers.studio.env.STUDIO_ASSIST_KEY;

  const timedOut = await assistant.callTool(key, 'read_page', {});
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.text, /không phản hồi/);
  assert.throws(() => assistant.toolResult(ids[0], { text: 'muộn' }), { status: 404 });

  const p = assistant.callTool(key, 'click', { ref: 1 });
  await sleep(10);
  assistant.toolResult(ids[1], { hold: true });
  await sleep(150); // quá toolTimeout 80 ms nhưng đang hold 300 ms
  assistant.toolResult(ids[1], { text: 'xong', label: 'Không cho phép: Bấm "Xóa"', isError: true });
  assert.deepEqual(await p, { text: 'xong', isError: true });
  const act = assistant.state().messages.at(-1);
  assert.equal(act.role, 'action');
  assert.equal(act.failed, true);

  const hanging = assistant.callTool(key, 'read_page', {});
  assistant.stop();
  assert.equal((await hanging).isError, true);
  await until(() => !assistant.state().busy);
  assert.equal(assistant.state().messages.at(-1).text, 'Đã dừng.');
});

test('Cuộc mới khi đang chạy: dừng lượt, xóa lịch sử, lượt cũ không ghi gì vào cuộc mới; phiên mới', async () => {
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => 'http://127.0.0.1:9', killGraceMs: 200 });
  assistant.send('chậm thôi', { tabId: 't' });
  await sleep(150);
  const before = assistant.state().rev;
  const r = assistant.reset();
  assert.deepEqual({ busy: r.busy, messages: r.messages }, { busy: false, messages: [] });
  assert.ok(r.rev > before, 'rev tăng để UI bỏ trạng thái cũ');
  await sleep(400);
  assert.deepEqual(assistant.state().messages, []);
  const url = await startHttp();
  assistant.dispose();
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url });
  fakeBrowser(assistant);
  assistant.send('chào', { tabId: 't' });
  await until(() => !assistant.state().busy);
  const log = fs.readFileSync(path.join(home, 'assistant', '.fake-assist.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log[1].argv.includes('--session-id'));
  assert.notEqual(log[1].argv[log[1].argv.indexOf('--session-id') + 1], log[0].argv[log[0].argv.indexOf('--session-id') + 1]);
});

test('lỗi: chưa đăng nhập → thông báo đăng nhập; không tìm thấy claude → ENOENT; chưa có url → 503', async () => {
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => 'http://127.0.0.1:9' });
  assistant.send('chưa đăng nhập', { tabId: 't' });
  await until(() => !assistant.state().busy);
  assert.match(assistant.state().messages.at(-1).text, /chưa đăng nhập/);
  assistant.dispose();

  assistant = createAssistant({ home: path.join(tmp, 'h2'), claudeBin: '/khong/co/claude', baseUrl: () => 'http://127.0.0.1:9' });
  assistant.send('chào', { tabId: 't' });
  await until(() => !assistant.state().busy);
  assert.match(assistant.state().messages.at(-1).text, /Không tìm thấy lệnh claude/);
  assistant.dispose();

  assistant = createAssistant({ home, claudeBin: FAKE });
  assert.throws(() => assistant.send('chào'), { status: 503 });
});

const readLog = () => fs.readFileSync(path.join(home, 'assistant', '.fake-assist.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const arg = (log, flag) => log.argv[log.argv.indexOf(flag) + 1];

test('chat.json cũ (một cuộc) tự nâng cấp thành cuộc đầu; tiêu đề lấy từ tin đầu', () => {
  fs.mkdirSync(path.join(home, 'assistant'));
  fs.writeFileSync(path.join(home, 'assistant', 'chat.json'), JSON.stringify({ sessionId: 's9', started: true, messages: [{ id: 'a', role: 'user', text: 'Mở  trang\nQuy trình', at: 'x' }] }));
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => null });
  const l = assistant.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].title, 'Mở trang Quy trình');
  assert.equal(assistant.state().messages.length, 1);
});

test('lịch sử: Cuộc mới giữ cuộc cũ, mở lại, xóa; model/effort theo cuộc và vào đối số claude', async () => {
  const url = await startHttp();
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url });
  fakeBrowser(assistant);
  assert.throws(() => assistant.settings({ model: 'gpt' }), /không hợp lệ/);
  assert.throws(() => assistant.settings({ effort: 'ultra' }), /không hợp lệ/);
  assistant.settings({ model: 'haiku', effort: 'low' });
  assistant.send('câu một', { tabId: 't' });
  assert.throws(() => assistant.settings({ model: 'opus' }), /đang làm/);
  assert.throws(() => assistant.open('x'), /đang làm/);
  await until(() => !assistant.state().busy);
  const first = assistant.state().chatId;
  const log = readLog()[0];
  assert.equal(arg(log, '--model'), 'haiku');
  assert.equal(arg(log, '--effort'), 'low');
  const r = assistant.reset();
  assert.deepEqual(r.messages, []);
  assert.notEqual(r.chatId, first);
  assert.equal(r.model, 'haiku', 'cuộc mới giữ model/effort đang chọn');
  assert.equal(assistant.list().length, 2);
  assistant.settings({ model: null });
  const o = assistant.open(first);
  assert.equal(o.messages[0].text, 'câu một');
  assert.equal(o.model, 'haiku');
  // lưu và nạp lại
  assistant.dispose();
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url });
  assert.equal(assistant.state().chatId, first);
  assert.throws(() => assistant.open('khong-co'), /Không tìm/);
  assistant.remove(first);
  assert.ok(!assistant.list().some((c) => c.id === first));
  assert.deepEqual(assistant.state().messages, []);
});

test('compact: cần phiên đã bắt đầu; gửi /compact bằng --resume và ghi chú trong chat', async () => {
  const url = await startHttp();
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url });
  fakeBrowser(assistant);
  assert.throws(() => assistant.compact(), /Chưa có gì để nén/);
  assistant.send('chào', { tabId: 't' });
  assert.throws(() => assistant.compact(), /đang làm/);
  await until(() => !assistant.state().busy);
  assert.equal(assistant.state().canCompact, true);
  assistant.compact();
  await until(() => !assistant.state().busy);
  const log = readLog();
  assert.ok(log[1].argv.includes('--resume'));
  assert.equal(log[1].stdin ?? '/compact', '/compact');
  const notes = assistant.state().messages.filter((m) => m.role === 'note').map((m) => m.text);
  assert.ok(notes.includes('Đã nén cuộc trò chuyện.'));
});

test('ảnh đính kèm: gửi qua stream-json base64, kiểm loại/số lượng/kích thước', async () => {
  const url = await startHttp();
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url });
  fakeBrowser(assistant);
  const png = Buffer.from('xx').toString('base64');
  assert.throws(() => assistant.send('x', { images: [{ name: 'a', mime: 'text/html', data: png }] }), { status: 400 });
  assert.throws(() => assistant.send('x', { images: [{ name: 'a', mime: 'image/png', data: '<script>' }] }), { status: 400 });
  assert.throws(() => assistant.send('x', { images: Array(5).fill({ name: 'a', mime: 'image/png', data: png }) }), { status: 400 });
  assert.throws(() => assistant.send('x', { images: [{ name: 'a', mime: 'image/png', data: 'A'.repeat(4 * 1024 * 1024 + 4) }] }), { status: 400 });
  assistant.send('mô tả ảnh này', { images: [{ name: 'a.jpg', mime: 'image/jpeg', data: png }] });
  await until(() => !assistant.state().busy);
  assert.deepEqual(assistant.state().messages.find((m) => m.role === 'user').images, ['a.jpg']);
  const log = fs.readFileSync(path.join(home, 'assistant', '.fake-assist.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log[0].argv.includes('--input-format'));
  const sent = JSON.parse(log[0].prompt);
  assert.equal(sent.message.content[0].source.data, png);
  assert.equal(sent.message.content[1].text, 'mô tả ảnh này');
});

test('tệp chữ + video: chèn nội dung vào lời gửi, khung hình đi như ảnh, kiểm giới hạn', async () => {
  const url = await startHttp();
  assistant = createAssistant({ home, claudeBin: FAKE, baseUrl: () => url });
  fakeBrowser(assistant);
  assert.throws(() => assistant.send('x', { files: [{ name: 'a.txt' }] }), { status: 400 });
  assert.throws(() => assistant.send('x', { files: Array(5).fill({ name: 'a', text: 'b' }) }), { status: 400 });
  assistant.send('đọc giúp', {
    files: [{ name: 'k.srt', text: 'xin chào' }],
    videos: [{ name: 'v.mp4', info: 'v.mp4: 3s', frames: [{ name: 'v.mp4 @1s', mime: 'image/jpeg', data: Buffer.from('f').toString('base64') }] }],
  });
  await until(() => !assistant.state().busy);
  assert.deepEqual(assistant.state().messages.find((m) => m.role === 'user').images, ['v.mp4', 'k.srt']);
  assert.equal(assistant.state().messages.find((m) => m.role === 'user').text, 'đọc giúp');
  const log = fs.readFileSync(path.join(home, 'assistant', '.fake-assist.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sent = JSON.parse(log[0].prompt);
  assert.equal(sent.message.content.length, 2);
  assert.match(sent.message.content[1].text, /k\.srt[\s\S]*xin chào[\s\S]*Video đính kèm[\s\S]*đọc giúp/);
});

test('extractFrames: lấy đủ khung hình từ video thật (cần ffmpeg)', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { extractFrames } = await import('../server/frames.js');
  const f = path.join(home, 'v.mp4');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3', '-pix_fmt', 'yuv420p', '-y', f]);
  } catch {
    return t.skip('không có ffmpeg');
  }
  const r = await extractFrames(f, 'v.mp4', { count: 3 });
  assert.equal(r.frames.length, 3);
  assert.match(r.info, /3\.0s, 320x240/);
  assert.equal(Buffer.from(r.frames[0].data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  fs.writeFileSync(path.join(home, 'bad.mp4'), 'nope');
  await assert.rejects(extractFrames(path.join(home, 'bad.mp4'), 'bad.mp4'), { status: 400 });
});
