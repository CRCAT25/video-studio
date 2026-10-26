// Trợ lý AI trong app: mỗi lượt chat chạy `claude -p` (tài khoản Claude đang đăng nhập) với đúng 1 MCP server
// (assistant-mcp.js) điều khiển trang; lệnh tool đi qua app → SSE → trình duyệt làm trên DOM → gửi kết quả về.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './assistant-mcp.js';
import { childEnv } from './checks.js';
import { HttpError } from './projects.js';
import { createLineSplitter, isApiKeySource } from './stream.js';

export const MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assistant-mcp.js');
export const TOOL_TIMEOUT_MS = 60_000; // trang không trả lời (tab đóng) → báo lỗi
export const HOLD_TIMEOUT_MS = 240_000; // đang chờ người dùng bấm Cho phép / Không
export const MAX_MESSAGES = 200;
export const MAX_INPUT = 4000;
export const KILL_GRACE_MS = 3000;
const ALLOWED = TOOLS.map((t) => `mcp__studio__${t.name}`);

export const ASSISTANT_PROTOCOL = `Bạn là Trợ lý AI bên trong Video Studio — app local làm video theo quy trình nhiều bước.
Bạn làm việc bằng cách điều khiển trang web của app thay người dùng, qua các tool mcp__studio__*:
read_page (xem trang, mỗi phần tử có số [ref]), click, fill, navigate (overview/pipelines/channels), wait.
Quy tắc:
- Luôn read_page trước khi thao tác; chỉ dùng ref của lần đọc gần nhất (click/fill/navigate đã trả về trang mới).
- Ô chọn (combobox) phải click để mở rồi click lựa chọn. Ô số: fill đúng số trong khoảng cho phép.
- Việc nhạy cảm (xóa, đăng xuất, cập nhật, dừng, chạy bước…) sẽ hiện thẻ để người dùng Cho phép / Không. Bị từ chối thì dừng và báo lại.
- Nút xác nhận chi phí (tốn tiền thật) bị chặn: mở tới hộp đó rồi nhờ người dùng tự bấm.
- Không đọc/ghi file, không chạy lệnh; chỉ làm qua trang. Việc trang không làm được thì nói rõ.
- Trả lời tiếng Việt, ngắn gọn; xong việc thì báo kết quả trong 1–2 câu.`;

// Tham số dòng lệnh cho một lượt: phiên mới dùng --session-id, lượt sau --resume.
export function buildAssistantArgs({ sessionId, resume = false, mcpConfig, model = null }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push(resume ? '--resume' : '--session-id', sessionId);
  args.push('--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig);
  args.push('--allowedTools', ALLOWED.join(','));
  args.push('--append-system-prompt', ASSISTANT_PROTOCOL);
  if (model) args.push('--model', model);
  return args;
}

const now = () => new Date().toISOString();
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// Tạo trợ lý: {state, send, stop, reset, callTool, toolResult, on, dispose}. Mỗi lúc chỉ chạy một lượt.
// baseUrl() trả gốc app (biết sau khi listen); lịch sử lưu ở <home>/assistant/chat.json.
export function createAssistant({
  home,
  claudeBin = 'claude',
  baseUrl = () => null,
  model = null,
  env = {},
  usage = null, // createUsage(): nhận % mức dùng + token của mỗi lượt
  toolTimeoutMs = TOOL_TIMEOUT_MS,
  holdTimeoutMs = HOLD_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  if (!home) throw new Error('createAssistant cần home.');
  const bin = /[\\/]/.test(String(claudeBin)) ? path.resolve(String(claudeBin)) : String(claudeBin || 'claude');
  const dir = path.join(home, 'assistant');
  const file = path.join(dir, 'chat.json');
  const listeners = new Set();
  const pending = new Map(); // id → {resolve, timer}
  let turn = null; // {key, tabId, child, stopped, finished, cfgFile}
  let chat = load();
  let rev = 0;

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { sessionId: typeof d.sessionId === 'string' ? d.sessionId : null, started: !!d.started, messages: Array.isArray(d.messages) ? d.messages.slice(-MAX_MESSAGES) : [] };
    } catch {
      return { sessionId: null, started: false, messages: [] };
    }
  }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(chat), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* ghi lịch sử lỗi không làm hỏng lượt chat */
    }
  }

  // Ảnh chụp gửi cho UI.
  // rev tăng mỗi lần đổi: UI bỏ trạng thái cũ hơn (phản hồi HTTP có thể về sau SSE).
  function state() {
    return { busy: !!turn, messages: chat.messages, rev };
  }

  function emit(data) {
    for (const fn of listeners) {
      try {
        fn(data);
      } catch {
        /* bỏ qua */
      }
    }
  }
  const changed = () => {
    rev += 1;
    save();
    emit({ kind: 'state', state: state() });
  };

  function push(role, text, extra = {}) {
    chat.messages.push({ id: crypto.randomUUID(), role, text: String(text), at: now(), ...extra });
    if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
    changed();
  }

  // Đăng ký nghe {kind:'state'|'tool'}; trả hàm hủy.
  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function settleAll(text) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve({ text, isError: true });
    }
  }

  // Gửi một câu cho trợ lý; tabId = tab trình duyệt sẽ làm thao tác.
  function send(text, { tabId = null } = {}) {
    const msg = String(text ?? '').trim();
    if (!msg) throw new HttpError(400, 'invalid_body', 'Nhập nội dung cần trợ lý làm.');
    if (msg.length > MAX_INPUT) throw new HttpError(400, 'invalid_body', `Tin nhắn tối đa ${MAX_INPUT} ký tự.`);
    if (turn) throw new HttpError(409, 'assistant_busy', 'Trợ lý đang làm — chờ xong hoặc bấm Dừng.');
    const url = baseUrl();
    if (!url) throw new HttpError(503, 'assistant_unavailable', 'Trợ lý chưa sẵn sàng.');
    push('user', msg);
    start(msg, url, String(tabId || ''), false);
    return state();
  }

  function start(prompt, url, tabId, retried) {
    const resume = chat.started && !!chat.sessionId;
    if (!resume) chat.sessionId = crypto.randomUUID();
    const key = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    // Cấu hình MCP để trong file 600 (mã của lượt không lộ qua danh sách tiến trình); xóa khi lượt xong.
    const cfgFile = path.join(dir, `mcp-${key.slice(0, 12)}.json`);
    const cfg = {
      mcpServers: {
        studio: { type: 'stdio', command: process.execPath, args: [MCP_SCRIPT], env: { STUDIO_ASSIST_URL: url, STUDIO_ASSIST_KEY: key } },
      },
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
    const t = { key, tabId, child: null, stopped: false, finished: false, cfgFile, gotResult: false, stderr: '', resume };
    turn = t;
    const isScript = /\.(mjs|cjs|js)$/i.test(bin);
    const argv = buildAssistantArgs({ sessionId: chat.sessionId, resume, mcpConfig: cfgFile, model });
    let child;
    try {
      child = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...argv] : argv, {
        cwd: dir,
        env: childEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (e) {
      return finish(t, null, e);
    }
    t.child = child;
    const out = createLineSplitter((l) => onLine(t, l));
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => {
      t.stderr = (t.stderr + b.toString('utf8')).slice(-2000);
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      if (!child.pid) finish(t, null, e);
    });
    child.on('close', (code) => {
      out.end();
      // Phiên cũ không còn (claude đã dọn) → chạy lại một lần với phiên mới.
      const lost = !retried && resume && /no conversation found/i.test(t.stderr);
      finish(t, code, null, lost ? () => start(prompt, url, tabId, true) : null);
    });
    child.stdin.end(prompt);
    changed();
  }

  // 1 dòng stream-json → tin nhắn trong chat.
  function onLine(t, line) {
    if (t !== turn || !line.trim()) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.type === 'system' && o.subtype === 'init') {
      if (isApiKeySource(o.apiKeySource)) push('note', 'Lưu ý: claude đang dùng API key (tính tiền theo API), không phải gói Claude.');
      return;
    }
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b?.type === 'text' && b.text?.trim()) push('assistant', b.text.trim());
      return;
    }
    if (o.type === 'rate_limit_event') {
      usage?.observe(o.rate_limit_info);
      return;
    }
    if (o.type === 'result') {
      t.gotResult = true;
      if (o.usage && typeof o.usage === 'object') usage?.record('assistant', o.usage);
      if (o.is_error) push('error', resultError(o));
    }
  }

  function resultError(o) {
    const r = typeof o.result === 'string' ? o.result : '';
    if (/not logged in|login|invalid api key|authentication/i.test(r)) return 'Claude chưa đăng nhập — bấm nút Claude trên thanh trên để đăng nhập.';
    return r ? `Lỗi: ${r.slice(0, 300)}` : 'Trợ lý gặp lỗi khi trả lời.';
  }

  // Kết thúc lượt: dọn file cấu hình, trả lời các lệnh còn treo, báo UI. retry() → chạy lại (phiên cũ mất).
  function finish(t, code, err, retry = null) {
    if (t.finished) return;
    t.finished = true;
    clearTimeout(t.killTimer);
    try {
      fs.rmSync(t.cfgFile, { force: true });
    } catch {
      /* bỏ qua */
    }
    if (turn !== t) return; // đã bị Cuộc mới bỏ qua
    turn = null;
    settleAll('Lượt chat đã kết thúc.');
    if (retry && !t.stopped && code !== 0) {
      chat.started = false;
      push('note', 'Phiên trò chuyện cũ không còn — bắt đầu phiên mới.');
      return retry();
    }
    if (t.stopped) push('note', 'Đã dừng.');
    else if (err) push('error', err.code === 'ENOENT' ? 'Không tìm thấy lệnh claude — cài Claude Code trước.' : `Không chạy được claude: ${err.message}`);
    else if (!t.gotResult && code !== 0) {
      const tail = t.stderr.trim().split('\n').pop() || '';
      push('error', /not logged in|login/i.test(tail) ? 'Claude chưa đăng nhập — bấm nút Claude trên thanh trên để đăng nhập.' : `Trợ lý dừng bất thường${tail ? `: ${tail.slice(0, 300)}` : '.'}`);
    }
    if (t.gotResult || code === 0) chat.started = true;
    changed();
  }

  // Dừng lượt đang chạy (SIGTERM, quá hạn thì SIGKILL).
  function stop() {
    const t = turn;
    if (!t) return state();
    t.stopped = true;
    settleAll('Người dùng đã dừng trợ lý.');
    if (t.child) {
      try {
        t.child.kill('SIGTERM');
      } catch {
        /* đã thoát */
      }
      t.killTimer = setTimeout(() => {
        try {
          if (!t.finished) t.child.kill('SIGKILL');
        } catch {
          /* đã thoát */
        }
      }, killGraceMs);
    } else finish(t, null, null);
    return state();
  }

  // Cuộc mới: dừng lượt đang chạy, xóa lịch sử, phiên claude mới.
  function reset() {
    if (turn) {
      stop();
      turn = null; // lượt cũ đang tắt: finish() thấy turn khác thì không ghi gì vào cuộc mới
    }
    chat = { sessionId: null, started: false, messages: [] };
    changed();
    return state();
  }

  // MCP gọi về (route public): kiểm mã của lượt → gửi lệnh cho tab qua SSE → chờ kết quả.
  function callTool(key, tool, args) {
    const t = turn;
    if (!t || !safeEq(key, t.key)) throw new HttpError(403, 'forbidden', 'Mã lượt không hợp lệ.');
    if (!TOOLS.some((x) => x.name === tool) || tool === 'wait') throw new HttpError(400, 'invalid_body', 'Tool không hợp lệ.');
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = (ms) =>
        setTimeout(() => {
          pending.delete(id);
          resolve({ text: 'Trang Video Studio không phản hồi (tab có thể đã đóng). Nhờ người dùng mở lại trang rồi thử lại.', isError: true });
        }, ms);
      pending.set(id, { resolve, timer: timeout(toolTimeoutMs), timeout });
      emit({ kind: 'tool', id, tabId: t.tabId, tool, args: args && typeof args === 'object' ? args : {} });
    });
  }

  // Trình duyệt gửi kết quả: {hold:true} = đang chờ người dùng (gia hạn); {text, isError, label} = xong.
  function toolResult(id, body = {}) {
    const p = pending.get(id);
    if (!p) throw new HttpError(404, 'not_found', 'Lệnh đã hết hạn.');
    clearTimeout(p.timer);
    if (body.hold) {
      p.timer = p.timeout(holdTimeoutMs);
      return { ok: true };
    }
    pending.delete(id);
    if (typeof body.label === 'string' && body.label.trim()) push('action', body.label.trim().slice(0, 200), body.isError ? { failed: true } : {});
    p.resolve({ text: String(body.text ?? '').slice(0, 60_000), isError: !!body.isError });
    return { ok: true };
  }

  function dispose() {
    if (turn) stop();
    listeners.clear();
  }

  return { state, send, stop, reset, callTool, toolResult, on, dispose };
}
