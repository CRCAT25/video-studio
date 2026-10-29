#!/usr/bin/env node
// Giả lập `claude -p --output-format stream-json` cho test (hợp đồng M1 §12) — không mạng, không gọi claude thật.
// Kịch bản: dòng đầu của <cwd>/.fake-scenario, nếu không có thì env FAKE_SCENARIO, mặc định "done".
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const cwd = process.cwd();
const MODEL = 'claude-fake-1';
const SCENARIOS = new Set(['done', 'needs_input', 'fail', 'slow', 'denied', 'crash', 'bad_resume', 'session_in_use']);

function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function pickScenario() {
  try {
    const first = fs.readFileSync(path.join(cwd, '.fake-scenario'), 'utf8').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch {
    /* không có file kịch bản */
  }
  return (process.env.FAKE_SCENARIO || 'done').trim();
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- file hợp lệ theo đuôi
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// PNG 1×1 RGBA hợp lệ (CRC + zlib đúng chuẩn).
function png1x1() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.from([0, 0xd9, 0x4a, 0x2b, 0xff]); // filter 0 + 1 pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// WAV PCM 16-bit mono 8 kHz, 0,2 s im lặng.
function silentWav(seconds = 0.2, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const dataLen = samples * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataLen, 40);
  return b;
}

function fakeMp4() {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftypisom', 4, 'ascii');
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write('isommp41', 16, 'ascii');
  return ftyp;
}

function contentFor(rel, heading) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.png') return png1x1();
  if (ext === '.wav') return silentWav();
  if (ext === '.mp4') return fakeMp4();
  if (ext === '.json') return '{"fake":true}\n';
  return `${heading || '# Bước (giả)'}\n\nNội dung giả cho ${rel} — tạo bởi fake-claude.\n`;
}

function kindOf(rel) {
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  if (ext === 'md') return 'markdown';
  if (ext === 'json') return 'json';
  if (['srt', 'vtt', 'txt'].includes(ext)) return 'text';
  return 'other';
}

// Lấy mảng đầu ra từ dòng "Đầu ra bắt buộc: [...]" của prompt.
function requiredOutputs(prompt) {
  const line = prompt.split(/\r?\n/).find((l) => l.startsWith('Đầu ra bắt buộc:'));
  if (!line) return [];
  try {
    const arr = JSON.parse(line.slice('Đầu ra bắt buộc:'.length).trim());
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Tạo file cho từng đầu ra (glob * → fake-1); bỏ đường dẫn ra ngoài cwd. Trả danh sách đường dẫn tương đối.
function makeOutputs(prompt) {
  const heading = prompt.split(/\r?\n/).find((l) => l.startsWith('# ')) || '';
  const made = [];
  for (const pattern of requiredOutputs(prompt)) {
    const rel = pattern.replace(/\*+/g, 'fake-1').replace(/\?/g, 'x').replace(/^\.\//, '');
    if (!rel || path.isAbsolute(rel) || rel.startsWith('~')) continue;
    const abs = path.resolve(cwd, rel);
    if (!abs.startsWith(cwd + path.sep)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contentFor(rel, heading));
    made.push(path.relative(cwd, abs).split(path.sep).join('/'));
  }
  return made;
}

// ---- dòng stream-json
function initLine(sessionId) {
  return {
    type: 'system',
    subtype: 'init',
    cwd,
    session_id: sessionId,
    tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'StructuredOutput'],
    mcp_servers: [{ name: 'fake-mcp', status: 'connected' }],
    model: MODEL,
    permissionMode: argVal('--permission-mode') || 'default',
    slash_commands: ['fake'],
    apiKeySource: 'none',
    claude_code_version: '0.0.0-fake',
    output_style: 'default',
    agents: [],
    skills: [],
    plugins: [{ name: 'fake-plugin', path: '/nowhere' }],
    memory_paths: { user: '/nowhere/.claude/CLAUDE.md' },
    uuid: uuid(),
  };
}

const assistant = (sessionId, content) => ({
  type: 'assistant',
  message: { id: 'msg_' + uuid().slice(0, 8), type: 'message', role: 'assistant', model: MODEL, content },
  parent_tool_use_id: null,
  session_id: sessionId,
  uuid: uuid(),
});

const userToolResult = (sessionId, toolUseId, content, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] },
  parent_tool_use_id: null,
  session_id: sessionId,
  uuid: uuid(),
});

const syntheticEnforce = (sessionId) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '[structured-output-enforce] You MUST call the StructuredOutput tool now.' }] },
  parent_tool_use_id: null,
  session_id: sessionId,
  uuid: uuid(),
  isSynthetic: true,
});

function resultLine(sessionId, { structured, denials = [], isError = false, subtype = 'success', turns = 3, text = '' }) {
  const line = {
    type: 'result',
    subtype,
    is_error: isError,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: turns,
    result: text,
    stop_reason: isError ? null : 'end_turn',
    session_id: sessionId,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 50,
      server_tool_use: { web_search_requests: 0 },
      service_tier: 'standard',
    },
    modelUsage: { [MODEL]: { inputTokens: 10, outputTokens: 50, costUSD: 0.0123 } },
    permission_denials: denials,
    terminal_reason: isError ? 'error' : 'completed',
    uuid: uuid(),
  };
  if (structured !== undefined) line.structured_output = structured;
  return line;
}

// rate_limit_event như claude thật (gói Claude); % lấy từ FAKE_USAGE (JSON {five_hour, seven_day}) nếu có.
function rateLimitLine(sessionId) {
  let u = { five_hour: 0.42, seven_day: 0.17 };
  try {
    if (process.env.FAKE_USAGE) u = JSON.parse(process.env.FAKE_USAGE);
  } catch {
    /* giữ mặc định */
  }
  const resets = { five_hour: 1893456000, seven_day: 1894060800 };
  const unifiedWindows = Object.fromEntries(Object.entries(u).map(([k, v]) => [k, { utilization: v, resetsAt: resets[k] ?? 1893456000 }]));
  const full = Object.values(u).some((v) => v >= 1);
  return {
    type: 'rate_limit_event',
    rate_limit_info: { status: full ? 'rejected' : 'allowed', resetsAt: 1893456000, rateLimitType: 'five_hour', unifiedWindows },
    session_id: sessionId,
    uuid: uuid(),
  };
}

function structuredTurn(sessionId, structured) {
  const id = 'toolu_so_' + uuid().slice(0, 8);
  out(syntheticEnforce(sessionId));
  out(assistant(sessionId, [{ type: 'tool_use', id, name: 'StructuredOutput', input: structured }]));
  out(userToolResult(sessionId, id, 'Structured output provided successfully'));
}

// Trạng thái đăng nhập giả: FAKE_AUTH_FILE (nếu có) giữ {loggedIn, authMethod, subscriptionType}; không có → đã đăng nhập.
function readFakeAuth() {
  const f = process.env.FAKE_AUTH_FILE;
  if (f) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      /* chưa có file → mặc định */
    }
  }
  return { loggedIn: true, authMethod: 'fake', subscriptionType: 'fake' };
}

// Lệnh doctor (§9.5) + `auth login|logout` giả: không có email/org, không mở trình duyệt thật.
// login: gọi $BROWSER (nếu có) với link giả, chờ FAKE_LOGIN_MS, thoát với FAKE_LOGIN_EXIT (0 → ghi đã đăng nhập).
async function doctorCommand() {
  if (argv[0] === '--version' && argv.length === 1) {
    process.stdout.write('0.0.0-fake (Claude Code)\n');
    return true;
  }
  if (argv[0] !== 'auth') return false;
  if (argv[1] === 'status') {
    const a = readFakeAuth();
    process.stdout.write(JSON.stringify(a) + '\n');
    process.exitCode = a.loggedIn ? 0 : 1;
    return true;
  }
  if (argv[1] === 'login') {
    if (process.env.BROWSER && process.env.FAKE_BROWSER_LOG) {
      fs.appendFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify({ browser: process.env.BROWSER, profile: process.env.VS_CHROME_PROFILE || null }) + '\n');
    }
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LOGIN_MS) || 0));
    const code = Number(process.env.FAKE_LOGIN_EXIT) || 0;
    if (code === 0 && process.env.FAKE_AUTH_FILE) {
      const console_ = argv.includes('--console');
      fs.writeFileSync(process.env.FAKE_AUTH_FILE, JSON.stringify({ loggedIn: true, authMethod: console_ ? 'console' : 'claude.ai', subscriptionType: console_ ? null : 'max' }));
    }
    process.exitCode = code;
    return true;
  }
  if (argv[1] === 'logout') {
    if (process.env.FAKE_AUTH_FILE) fs.writeFileSync(process.env.FAKE_AUTH_FILE, JSON.stringify({ loggedIn: false, authMethod: 'none', subscriptionType: null }));
    return true;
  }
  return false;
}

// ---- Trợ lý AI (có --mcp-config): làm MCP client thật tới server "studio" trong file cấu hình, kịch bản theo câu hỏi.
function mcpClient(cfgFile) {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.studio;
  const child = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  let seq = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.result?.content?.[0]?.text || '', isError: !!r.result?.isError };
  };
  return { rpc, call, close: () => child.kill() };
}

// Tìm số ref của dòng phần tử có tên khớp re trong kết quả read_page.
function refOf(page, re) {
  for (const line of page.split('\n')) {
    const m = /^\[(\d+)\] [^"]*"([^"]*)"/.exec(line);
    if (m && re.test(m[2])) return Number(m[1]);
  }
  return null;
}

async function assistantMode() {
  const prompt = await readStdin();
  try {
    fs.appendFileSync(path.join(cwd, '.fake-assist.jsonl'), JSON.stringify({ argv, prompt }) + '\n');
  } catch {
    /* bỏ qua */
  }
  const sessionId = argVal('--resume') || argVal('--session-id') || uuid();
  const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: sessionId, uuid: uuid() });
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, apiKeySource: 'none', tools: [], mcp_servers: [{ name: 'studio', status: 'connected' }] });
  out(rateLimitLine(sessionId));
  if (/chưa đăng nhập/i.test(prompt)) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: sessionId });
    return;
  }
  const mcp = mcpClient(argVal('--mcp-config'));
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  let reply = 'Chào bạn! Tôi có thể giúp gì?';
  if (/chậm/i.test(prompt)) {
    say('Để tôi xem…');
    await sleep(60_000);
  } else if (/60/.test(prompt)) {
    let page = (await mcp.call('read_page')).text;
    const add = refOf(page, /Dự án mới/);
    page = (await mcp.call('click', { ref: add })).text;
    const dur = refOf(page, /^Thời lượng$/);
    const r = await mcp.call('fill', { ref: dur, value: '60' });
    reply = r.isError ? `Không đặt được: ${r.text.split('\n')[0]}` : 'Đã đặt thời lượng 60 giây.';
  } else if (/xóa/i.test(prompt)) {
    const page = (await mcp.call('read_page')).text;
    const del = refOf(page, /^Xóa/);
    if (!del) reply = 'Không thấy nút Xóa.';
    else {
      const r = await mcp.call('click', { ref: del });
      reply = r.isError ? `Không xóa: ${r.text.split('\n')[0]}` : 'Đã bấm Xóa.';
    }
  } else if (/trang/i.test(prompt)) {
    const r = await mcp.call('read_page');
    reply = `Bạn đang ở ${r.text.split('\n')[0]}`;
  }
  mcp.close();
  say(reply);
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, num_turns: 2, session_id: sessionId, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 20 } });
}

// ---- Kiểm tra mức dùng (--no-session-persistence): FAKE_USAGE_MODE = none (không gửi %) | logout | slow.
async function usageCheckMode() {
  await readStdin();
  try {
    fs.appendFileSync(path.join(cwd, '.fake-usage.jsonl'), JSON.stringify({ argv }) + '\n');
  } catch {
    /* bỏ qua */
  }
  const mode = process.env.FAKE_USAGE_MODE || '';
  if (mode === 'logout') {
    process.stderr.write('Not logged in · Please run /login\n');
    process.exitCode = 1;
    return;
  }
  if (mode === 'slow') await sleep(60_000);
  const sessionId = uuid();
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, apiKeySource: 'none', tools: [] });
  if (mode !== 'none') out(rateLimitLine(sessionId));
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, session_id: sessionId, uuid: uuid() });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 30 } });
}

// Tìm skill bằng AI: trả structured_output theo FAKE_SKILL_SEARCH (JSON) hoặc mặc định khớp skill đầu tiên được nhắc trong prompt.
async function skillSearchMode() {
  const prompt = await readStdin();
  try {
    fs.appendFileSync(path.join(cwd, '.fake-skill-search.jsonl'), JSON.stringify({ argv, prompt }) + '\n');
  } catch {
    /* bỏ qua */
  }
  if (process.env.FAKE_SKILL_SEARCH_FAIL) {
    process.stderr.write('boom\n');
    process.exitCode = 1;
    return;
  }
  let so = { matches: [], suggestions: [] };
  if (argv.join(' ').includes('"done"')) so = process.env.FAKE_SKILL_CLARIFY ? JSON.parse(process.env.FAKE_SKILL_CLARIFY) : { done: true, refined: 'nhu cầu rõ ràng' };
  else if (process.env.FAKE_SKILL_SEARCH) so = JSON.parse(process.env.FAKE_SKILL_SEARCH);
  if (prompt.includes('KHONGCO') && !argv.join(' ').includes('"done"')) so = { matches: [], suggestions: [], alternatives: ['từ khóa B', 'từ khóa C'], tip: 'Cần skill dựng cảnh 3D.' };
  // Có danh sách kênh trong prompt thì chấm giả: kênh đầu 80%, còn lại 30% (kèm một id lạ để thử lọc).
  const chIds = [...prompt.matchAll(/^- (\S+) \| .+ \| \S+$/gm)].map((m) => m[1]);
  const fakeScores = () => [...chIds.map((c, i) => ({ channel: c, percent: i ? 30 : 80 })), { channel: 'kenh-la', percent: 99 }];
  if (chIds.length && Array.isArray(so.matches)) so.matches = so.matches.map((m) => (m.scores ? m : { ...m, scores: fakeScores() }));
  if (chIds.length && Array.isArray(so.suggestions)) so.suggestions = so.suggestions.map((m) => (m.scores ? m : { ...m, scores: fakeScores() }));
  const sessionId = uuid();
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, tools: [] });
  out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: so, session_id: sessionId, usage: { input_tokens: 2, output_tokens: 1 } });
}

// Nén bộ não: ghi lại argv/prompt; mặc định giữ mục đầu của mỗi nhánh (FAKE_BRAIN_COMPACT = JSON để ép kết quả).
async function brainCompactMode() {
  const prompt = await readStdin();
  try {
    fs.appendFileSync(path.join(cwd, '.fake-brain-compact.jsonl'), JSON.stringify({ argv, prompt }) + '\n');
  } catch {
    /* bỏ qua */
  }
  const branches = [];
  for (const line of prompt.split('\n')) {
    const h = /^## (.+)$/.exec(line);
    if (h) branches.push({ path: h[1], items: [] });
    const it = /^- \[[^\]]*\] (.+)$/.exec(line);
    if (it && branches.length && !branches[branches.length - 1].items.length) branches[branches.length - 1].items.push(it[1]);
  }
  const so = process.env.FAKE_BRAIN_COMPACT ? JSON.parse(process.env.FAKE_BRAIN_COMPACT) : { branches, summary: 'Giữ mục đầu mỗi nhánh.' };
  const sessionId = uuid();
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, tools: [] });
  out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: so, session_id: sessionId, usage: { input_tokens: 2, output_tokens: 1 } });
}

// ---- kịch bản
async function main() {
  if (await doctorCommand()) return;
  if (argv.includes('--mcp-config')) return assistantMode();
  if (argv.includes('--json-schema') && argv.join(' ').includes('"branches"')) return brainCompactMode();
  if (argv.includes('--json-schema') && argv.includes('--no-session-persistence')) return skillSearchMode();
  if (argv.includes('--no-session-persistence')) return usageCheckMode();
  const scenario = pickScenario();
  const prompt = await readStdin();
  try {
    const envVs = Object.keys(process.env).filter((k) => k.startsWith('VS_')).sort();
    fs.appendFileSync(path.join(cwd, '.fake-calls.jsonl'), JSON.stringify({ argv, prompt, scenario, env_vs: envVs }) + '\n');
  } catch {
    /* thư mục không ghi được → bỏ qua */
  }

  if (!SCENARIOS.has(scenario)) {
    process.stderr.write(`fake-claude: kịch bản lạ "${scenario}"\n`);
    process.exitCode = 3;
    return;
  }

  const resume = argVal('--resume');
  const sessionId = resume || argVal('--session-id') || uuid();

  if (scenario === 'bad_resume' && resume) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exitCode = 1;
    return;
  }
  // claude thật đã lưu transcript của --session-id này (lượt trước chết trước init) → từ chối; --resume thì chạy như done
  if (scenario === 'session_in_use' && !resume) {
    process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
    process.exitCode = 1;
    return;
  }
  if (scenario === 'crash') {
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","te');
    process.exitCode = 2;
    return;
  }

  out({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:startup', session_id: sessionId, uuid: uuid() });
  out({ type: 'system', subtype: 'hook_response', hook_id: 'h1', output: 'secret hook output', exit_code: 0, session_id: sessionId, uuid: uuid() });
  out(initLine(sessionId));
  out(rateLimitLine(sessionId));

  if (scenario === 'fail') {
    out(resultLine(sessionId, { isError: true, subtype: 'error_during_execution', turns: 1, text: 'Lỗi giả lập khi chạy.' }));
    process.exitCode = 1;
    return;
  }

  if (scenario === 'slow') {
    process.on('SIGTERM', () => process.exit(143));
    for (let i = 1; i <= 200; i++) {
      out(assistant(sessionId, [{ type: 'text', text: `Đang làm… ${i}` }]));
      await sleep(300);
    }
    const structured = { status: 'done', summary: 'Xong sau khi chạy chậm.', artifacts: [] };
    structuredTurn(sessionId, structured);
    out(resultLine(sessionId, { structured, turns: 2 }));
    return;
  }

  if (scenario === 'denied') {
    const id = 'toolu_bash_1';
    const command = 'sudo rm -rf /tmp/khong-co-that';
    out(assistant(sessionId, [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Lệnh bị chặn' } }]));
    out({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: id,
      decision_reason_type: 'rule',
      message: `Permission to use Bash with command ${command} has been denied.`,
      session_id: sessionId,
      uuid: uuid(),
    });
    out(userToolResult(sessionId, id, `Permission to use Bash with command ${command} has been denied.`, true));
    out(assistant(sessionId, [{ type: 'text', text: 'Lệnh bị chặn quyền, không tìm đường vòng.' }]));
    const structured = { status: 'done', summary: 'Lệnh sudo bị chặn quyền; đã ghi lại.', artifacts: [] };
    structuredTurn(sessionId, structured);
    out(resultLine(sessionId, { structured, denials: [{ tool_name: 'Bash', tool_use_id: id, tool_input: { command } }], turns: 2 }));
    return;
  }

  // done | needs_input | bad_resume (không có --resume → như done)
  out(assistant(sessionId, [
    { type: 'thinking', thinking: '', signature: 'c2lnbmF0dXJl' },
    { type: 'text', text: 'Bắt đầu làm bước được giao.' },
  ]));
  if (scenario === 'needs_input') {
    const structured = {
      status: 'needs_input',
      summary: 'Cần người dùng chọn giọng đọc trước khi làm tiếp.',
      artifacts: [],
      questions: ['Bạn muốn giọng nam hay nữ?'],
    };
    structuredTurn(sessionId, structured);
    out(resultLine(sessionId, { structured, turns: 2 }));
    return;
  }

  const outputs = requiredOutputs(prompt);
  const writeId = 'toolu_write_1';
  const first = outputs[0] ? path.join(cwd, outputs[0].replace(/\*+/g, 'fake-1')) : path.join(cwd, 'fake.txt');
  out(assistant(sessionId, [{ type: 'tool_use', id: writeId, name: 'Write', input: { file_path: first, content: '…' } }]));
  const made = makeOutputs(prompt);
  out(userToolResult(sessionId, writeId, `File created successfully at: ${first}`));
  out(assistant(sessionId, [{ type: 'text', text: `Đã tạo ${made.length} file.` }]));
  const structured = {
    status: 'done',
    summary: `Đã tạo ${made.length} file đầu ra cho bước.`,
    artifacts: made.map((p) => ({ path: p, kind: kindOf(p) })),
    notes_for_next_step: 'Ghi chú giả cho bước sau.',
  };
  structuredTurn(sessionId, structured);
  out(resultLine(sessionId, { structured, turns: 3, text: structured.summary }));
}

main().catch((e) => {
  process.stderr.write(`fake-claude lỗi: ${e && e.stack ? e.stack : e}\n`);
  process.exitCode = 9;
});
