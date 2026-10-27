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
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_FILES = 8;
export const MAX_FILE_CHARS = 100000;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Kiểm ảnh đính kèm → [{name, mime, data(base64)}]; sai loại/quá lớn/quá nhiều → 400.
export function cleanImages(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > MAX_IMAGES) throw new HttpError(400, 'invalid_body', `Tối đa ${MAX_IMAGES} ảnh mỗi tin.`);
  return list.map((im) => {
    const mime = String(im?.mime || '');
    const data = String(im?.data || '');
    if (!IMAGE_MIME.has(mime) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, 'invalid_body', 'Chỉ nhận ảnh PNG, JPG, WebP hoặc GIF.');
    if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) throw new HttpError(400, 'invalid_body', 'Ảnh quá lớn (tối đa 3 MB mỗi ảnh).');
    return { name: String(im.name || 'image').replace(/[\r\n]/g, ' ').slice(0, 80), mime, data };
  });
}
export const KILL_GRACE_MS = 3000;
export const MAX_CHATS = 30;
export const MODELS = ['opus', 'sonnet', 'haiku']; // alias → luôn bản mới nhất
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALLOWED = TOOLS.map((t) => `mcp__studio__${t.name}`);

export const ASSISTANT_PROTOCOL = `Bạn là Trợ lý AI bên trong Video Studio — app local làm video theo quy trình nhiều bước.
Bạn làm việc bằng cách điều khiển trang web của app thay người dùng, qua các tool mcp__studio__*:
read_page (xem trang, mỗi phần tử có số [ref]), click, fill, navigate (overview/pipelines/channels), wait.
Quy tắc:
- Luôn read_page trước khi thao tác; chỉ dùng ref của lần đọc gần nhất (click/fill/navigate đã trả về trang mới).
- Ô chọn (combobox) phải click để mở rồi click lựa chọn. Ô số: fill đúng số trong khoảng cho phép.
- Việc nhạy cảm (xóa, đăng xuất, cập nhật, dừng, chạy bước…) sẽ hiện thẻ để người dùng Cho phép / Không. Bị từ chối thì dừng và báo lại.
- Nút xác nhận chi phí (tốn tiền thật) bị chặn: mở tới hộp đó rồi nhờ người dùng tự bấm.
- Không đọc/ghi file, không chạy lệnh; chỉ làm qua trang và các tool dưới đây. Việc trang không làm được thì nói rõ.
Tạo Short từ ảnh dự án: project_images (liệt kê ảnh + trích storyboard/script; bỏ projectId để xem dự án), view_images (xem tối đa 4 ảnh), make_short (dựng Short 9:16).
Trước khi gọi make_short PHẢI hỏi người dùng (trong chat, chờ trả lời): (1) Short dài bao nhiêu giây và làm mấy Short; (2) có giọng đọc không — không giọng, hoặc giọng máy miễn phí (Linh); giọng ElevenLabs tốn tiền thì không tự dùng, nhờ người dùng duyệt chi phí riêng; (3) có phụ đề không; (4) có hiệu ứng vẽ dần từ giấy trắng không (reveal=draw cho từng cảnh; mặc định cả ảnh hiện ngay). Không tự đề nghị tạo dự án mới chỉ để có hiệu ứng vẽ. Chọn ảnh theo nội dung (xem bằng view_images), chia thời lượng cảnh cho khớp tổng, rồi báo file; luôn ghi NGUYÊN đường dẫn /media/… (không rút gọn, không bọc dấu nháy) để người dùng bấm nút xem ngay.
- Trả lời tiếng Việt, ngắn gọn; xong việc thì báo kết quả trong 1–2 câu.`;

// Tham số dòng lệnh cho một lượt: phiên mới dùng --session-id, lượt sau --resume.
// Tệp chữ đính kèm → [{name, text}] (cắt ở MAX_FILE_CHARS).
export function cleanFiles(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > MAX_FILES) throw new HttpError(400, 'invalid_body', `Tối đa ${MAX_FILES} tệp mỗi tin.`);
  return list.map((f) => {
    if (typeof f?.text !== 'string') throw new HttpError(400, 'invalid_body', 'Tệp đính kèm không hợp lệ.');
    const cut = f.text.length > MAX_FILE_CHARS;
    return { name: String(f.name || 'file').replace(/[\r\n]/g, ' ').slice(0, 80), text: f.text.slice(0, MAX_FILE_CHARS), cut };
  });
}

export function buildAssistantArgs({ sessionId, resume = false, mcpConfig, model = null, effort = null, images = false }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (images) args.push('--input-format', 'stream-json'); // ảnh đi qua khối base64, model không cần quyền đọc file
  args.push(resume ? '--resume' : '--session-id', sessionId);
  args.push('--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig);
  args.push('--allowedTools', ALLOWED.join(','));
  args.push('--append-system-prompt', ASSISTANT_PROTOCOL);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
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
  serverTools = {}, // {tên: async (args) → {text, isError, images}} chạy ngay trên server
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
  const newChat = (from = null) => ({ id: crypto.randomUUID(), title: '', sessionId: null, started: false, messages: [], model: from?.model ?? null, effort: from?.effort ?? null, updatedAt: now() });
  const cleanChat = (d) => ({
    id: typeof d.id === 'string' && d.id ? d.id : crypto.randomUUID(),
    title: typeof d.title === 'string' ? d.title.slice(0, 80) : '',
    sessionId: typeof d.sessionId === 'string' ? d.sessionId : null,
    started: !!d.started,
    messages: Array.isArray(d.messages) ? d.messages.slice(-MAX_MESSAGES) : [],
    model: MODELS.includes(d.model) ? d.model : null,
    effort: EFFORTS.includes(d.effort) ? d.effort : null,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : now(),
  });
  let chats = []; // mọi cuộc chat (kể cả cuộc hiện tại)
  let chat = load();
  let rev = 0;

  // Đọc chat.json: dạng mới {currentId, chats:[…]}; dạng cũ (một cuộc) được đổi thành cuộc đầu tiên.
  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(d.chats) ? d.chats : [d];
      chats = list.slice(0, MAX_CHATS).map(cleanChat);
      const cur = chats.find((c) => c.id === d.currentId) || chats[0];
      if (cur) {
        if (!cur.title) cur.title = titleOf(cur);
        return cur;
      }
    } catch {
      /* chưa có hoặc hỏng → cuộc trống */
    }
    const c = newChat();
    chats = [c];
    return c;
  }
  function titleOf(c) {
    const u = c.messages.find((m) => m.role === 'user');
    return u ? String(u.text).replace(/\s+/g, ' ').slice(0, 60) : '';
  }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ currentId: chat.id, chats }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* ghi lịch sử lỗi không làm hỏng lượt chat */
    }
  }

  // Ảnh chụp gửi cho UI.
  // rev tăng mỗi lần đổi: UI bỏ trạng thái cũ hơn (phản hồi HTTP có thể về sau SSE).
  function state() {
    return { busy: !!turn, messages: chat.messages, rev, chatId: chat.id, model: chat.model, effort: chat.effort, canCompact: chat.started && !turn };
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
    chat.updatedAt = now();
    if (!chat.title && role === 'user') chat.title = titleOf(chat);
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
  function send(text, { tabId = null, lang = 'vi', images = [], files = [], videos = [] } = {}) {
    const msg = String(text ?? '').trim();
    // videos = [{name, info, frames}] do server tự lấy từ file trong dự án (đã tin cậy)
    const imgs = cleanImages(images).concat(videos.flatMap((v) => v.frames));
    const docs = cleanFiles(files);
    if (!msg) throw new HttpError(400, 'invalid_body', 'Nhập nội dung cần trợ lý làm.');
    if (msg.length > MAX_INPUT) throw new HttpError(400, 'invalid_body', `Tin nhắn tối đa ${MAX_INPUT} ký tự.`);
    if (turn) throw new HttpError(409, 'assistant_busy', 'Trợ lý đang làm — chờ xong hoặc bấm Dừng.');
    const url = baseUrl();
    if (!url) throw new HttpError(503, 'assistant_unavailable', 'Trợ lý chưa sẵn sàng.');
    const names = [...cleanImages(images).map((i) => i.name), ...videos.map((v) => v.name), ...docs.map((d) => d.name)];
    push('user', msg, names.length ? { images: names } : {});
    const ctx = [
      ...docs.map((d) => `[Tệp đính kèm: ${d.name}${d.cut ? ' (đã cắt bớt)' : ''}]\n\`\`\`\n${d.text}\n\`\`\``),
      ...videos.map((v) => `[Video đính kèm — ${v.info}; các ảnh kèm theo là khung hình của video này]`),
    ];
    const full = ctx.length ? `${ctx.join('\n\n')}\n\n${msg}` : msg;
    // giao diện tiếng Anh → nhắc trả lời tiếng Anh (chỉ trong lời gửi cho model, tin hiển thị giữ nguyên)
    start(lang === 'en' ? `[Reply in English.]\n${full}` : full, url, String(tabId || ''), false, imgs);
    return state();
  }

  function start(prompt, url, tabId, retried, imgs = []) {
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
    const argv = buildAssistantArgs({ sessionId: chat.sessionId, resume, mcpConfig: cfgFile, model: chat.model || model, effort: chat.effort, images: imgs.length > 0 });
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
      finish(t, code, null, lost ? () => start(prompt, url, tabId, true, imgs) : null);
    });
    child.stdin.end(
      imgs.length
        ? JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [...imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: prompt }] },
          }) + '\n'
        : prompt,
    );
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
    if (t.compact && t.gotResult && !t.stopped && !err) push('note', 'Đã nén cuộc trò chuyện.');
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

  // Dừng lượt đang chạy khi đổi cuộc: lượt cũ đang tắt, finish() thấy turn khác thì không ghi gì vào cuộc mới.
  function dropTurn() {
    if (turn) {
      stop();
      turn = null;
    }
  }

  // Cuộc mới: dừng lượt đang chạy, giữ cuộc cũ trong lịch sử (cuộc trống thì dùng lại), giữ model/effort đang chọn.
  function reset() {
    dropTurn();
    if (chat.messages.length) {
      chat = newChat(chat);
      chats.unshift(chat);
      if (chats.length > MAX_CHATS) chats.length = MAX_CHATS;
    } else {
      chat = { ...newChat(chat), id: chat.id };
      chats[chats.findIndex((c) => c.id === chat.id)] = chat;
    }
    changed();
    return state();
  }

  // Danh sách cuộc chat (mới nhất trước) cho nút Lịch sử.
  function list() {
    return chats
      .filter((c) => c.messages.length || c.id === chat.id)
      .map((c) => ({ id: c.id, title: c.title || '', updatedAt: c.updatedAt, count: c.messages.length, current: c.id === chat.id }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  function busyCheck() {
    if (turn) throw new HttpError(409, 'assistant_busy', 'Trợ lý đang làm — chờ xong hoặc bấm Dừng.');
  }

  // Mở lại một cuộc chat cũ (tiếp tục bằng --resume phiên của nó).
  function open(id) {
    busyCheck();
    const c = chats.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'not_found', 'Không tìm thấy cuộc trò chuyện.');
    chat = c;
    changed();
    return state();
  }

  // Xóa một cuộc chat khỏi lịch sử; xóa cuộc đang mở thì sang cuộc trống mới.
  function remove(id) {
    busyCheck();
    const i = chats.findIndex((x) => x.id === id);
    if (i < 0) throw new HttpError(404, 'not_found', 'Không tìm thấy cuộc trò chuyện.');
    const wasCurrent = chats[i].id === chat.id;
    chats.splice(i, 1);
    if (wasCurrent) {
      chat = newChat(chat);
      chats.unshift(chat);
    }
    changed();
    return state();
  }

  // Chọn model / effort cho cuộc đang mở (null hoặc '' = mặc định); áp dụng từ lượt kế tiếp.
  function settings(body = {}) {
    busyCheck();
    for (const [k, allowed] of [['model', MODELS], ['effort', EFFORTS]]) {
      if (!(k in body)) continue;
      const v = body[k] || null;
      if (v !== null && !allowed.includes(v)) throw new HttpError(400, 'invalid_body', `Giá trị ${k} không hợp lệ.`);
      chat[k] = v;
    }
    changed();
    return state();
  }

  // Nén ngữ cảnh phiên hiện tại bằng /compact (cần phiên đã bắt đầu, trợ lý rảnh).
  function compact() {
    busyCheck();
    if (!chat.started || !chat.sessionId) throw new HttpError(409, 'compact_none', 'Chưa có gì để nén — hãy trò chuyện trước.');
    const url = baseUrl();
    if (!url) throw new HttpError(503, 'assistant_unavailable', 'Trợ lý chưa sẵn sàng.');
    push('note', 'Đang nén cuộc trò chuyện…');
    start('/compact', url, '', true);
    if (turn) turn.compact = true;
    return state();
  }

  // MCP gọi về (route public): kiểm mã của lượt → gửi lệnh cho tab qua SSE → chờ kết quả.
  function callTool(key, tool, args) {
    const t = turn;
    if (!t || !safeEq(key, t.key)) throw new HttpError(403, 'forbidden', 'Mã lượt không hợp lệ.');
    if (!TOOLS.some((x) => x.name === tool) || tool === 'wait') throw new HttpError(400, 'invalid_body', 'Tool không hợp lệ.');
    if (serverTools[tool]) {
      return Promise.resolve(serverTools[tool](args && typeof args === 'object' ? args : {})).then(
        (r) => {
          push('action', `${tool}${r.isError ? ' (lỗi)' : ''}`, r.isError ? { failed: true } : {});
          return r;
        },
        (e) => ({ text: `Lỗi: ${e?.message || e}`, isError: true }),
      );
    }
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

  return { state, send, stop, reset, list, open, remove, settings, compact, callTool, toolResult, on, dispose };
}
