// Trợ lý AI trong app: mỗi lượt chat chạy `claude -p` (tài khoản Claude đang đăng nhập) với đúng 1 MCP server
// (assistant-mcp.js) điều khiển trang; lệnh tool đi qua app → SSE → trình duyệt làm trên DOM → gửi kết quả về.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN, expandCommand, listCommands, parseSlash } from './assistant-cmds.js';
import { PERMISSION_TOOL, TOOLS } from './assistant-mcp.js';
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
export const MODES = ['page', 'plan', 'ask', 'edit']; // page = chỉ thao tác trang; plan = chỉ đọc + lập kế hoạch; ask = hỏi trước khi sửa/chạy; edit = tự sửa file, hỏi khi chạy lệnh
export const CONTEXT_LIMIT = 200_000; // token; vượt AUTO_COMPACT_AT thì nén trước khi gửi tin kế
export const AUTO_COMPACT_AT = 0.8;
export const MAX_QUEUE = 5;
export const MAX_PERMISSIONS = 20;
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
export const WRITE_TOOLS = ['Edit', 'Write', 'Bash'];
const ALLOWED = TOOLS.map((t) => `mcp__studio__${t.name}`);

export const ASSISTANT_PROTOCOL = `Bạn là Trợ lý AI bên trong Video Studio — app local làm video theo quy trình nhiều bước.
Bạn làm việc bằng cách điều khiển trang web của app thay người dùng, qua các tool mcp__studio__*:
read_page (xem trang, mỗi phần tử có số [ref]), click, fill, navigate (overview/pipelines/channels), wait.
Quy tắc:
- Luôn read_page trước khi thao tác; chỉ dùng ref của lần đọc gần nhất (click/fill/navigate đã trả về trang mới).
- Ô chọn (combobox) phải click để mở rồi click lựa chọn. Ô số: fill đúng số trong khoảng cho phép.
- Việc nhạy cảm (xóa, đăng xuất, cập nhật, dừng, chạy bước…) sẽ hiện thẻ để người dùng Cho phép / Không. Bị từ chối thì dừng và báo lại.
- Nút xác nhận chi phí (tốn tiền thật) bị chặn: mở tới hộp đó rồi nhờ người dùng tự bấm.
- read_page có mục "Cách dùng màn này" thì làm đúng theo đó — đó là cách dùng chuẩn của app, ưu tiên hơn tự đoán (vd đổi giọng: click thẻ giọng ở bước, KHÔNG sửa lời dặn/quy trình).
- Chỉ làm qua trang và các tool dưới đây, trừ khi được cấp thêm tool đọc/sửa file (khi đó mỗi lần sửa file hoặc chạy lệnh người dùng sẽ được hỏi). Việc không làm được thì nói rõ.
Tạo Short từ ảnh dự án: project_images (liệt kê ảnh + trích storyboard/script; bỏ projectId để xem dự án), view_images (xem tối đa 4 ảnh), make_short (dựng Short 9:16).
Trước khi gọi make_short PHẢI hỏi người dùng (trong chat, chờ trả lời): (1) Short dài bao nhiêu giây và làm mấy Short; (2) có giọng đọc không — không giọng, hoặc giọng máy miễn phí (Linh); giọng ElevenLabs tốn tiền thì không tự dùng, nhờ người dùng duyệt chi phí riêng; (3) có phụ đề không; (4) có hiệu ứng vẽ dần từ giấy trắng không (reveal=draw cho từng cảnh; mặc định cả ảnh hiện ngay). Không tự đề nghị tạo dự án mới chỉ để có hiệu ứng vẽ. Chọn ảnh theo nội dung (xem bằng view_images), chia thời lượng cảnh cho khớp tổng, rồi báo file; luôn ghi NGUYÊN đường dẫn /media/… (không rút gọn, không bọc dấu nháy) để người dùng bấm nút xem ngay.
Bộ não: mục "## Bộ não" (nếu có) là điều người dùng đã duyệt cho bạn nhớ — làm theo. Khi người dùng nói rõ một sở thích/quy tắc lâu dài, hoặc bạn vừa làm sai và rút ra bài học, gọi brain_propose (1 câu, không trùng điều đã có); người dùng sẽ duyệt sau, đừng hỏi lại trong chat.
- Trả lời tiếng Việt, ngắn gọn; xong việc thì báo kết quả trong 1–2 câu.`;

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

const PLAN_PROTOCOL = `
CHẾ ĐỘ LẬP KẾ HOẠCH: bạn chỉ được đọc (không sửa file, không chạy lệnh). Khảo sát xong, trình bày kế hoạch ngắn gọn theo các bước đánh số rồi dừng lại, chờ người dùng duyệt. Không tự thực hiện.`;

// Tham số dòng lệnh cho một lượt: phiên mới dùng --session-id, lượt sau --resume.
// mode: page = không tool file (--tools ''), plan = chỉ đọc, ask/edit = có đọc/sửa/chạy lệnh, mỗi việc nhạy cảm hỏi qua tool approve.
export function buildAssistantArgs({ sessionId, resume = false, mcpConfig, model = null, effort = null, images = false, mode = 'page', protect = [], memory = '' }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (images) args.push('--input-format', 'stream-json'); // ảnh đi qua khối base64, model không cần quyền đọc file
  args.push(resume ? '--resume' : '--session-id', sessionId);
  const tools = mode === 'page' ? [] : mode === 'plan' ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS];
  args.push('--tools', tools.join(','), '--strict-mcp-config', '--mcp-config', mcpConfig);
  const ask = `mcp__studio__${PERMISSION_TOOL.name}`;
  args.push('--allowedTools', (mode === 'page' ? ALLOWED : [...ALLOWED, ask]).join(','));
  if (mode !== 'page') args.push('--permission-mode', mode === 'edit' ? 'acceptEdits' : 'default', '--permission-prompt-tool', ask);
  // thư mục bí mật (token, khóa): chặn cả đọc lẫn sửa, kể cả khi không qua bước hỏi quyền
  const guard = [...new Set(protect.filter(Boolean).map((d) => path.resolve(d)))].flatMap((d) => ['Read', 'Edit', 'Write'].map((t) => `${t}(/${d}/**)`));
  if (mode !== 'page' && guard.length) args.push('--disallowedTools', guard.join(','));
  // Bộ não gửi lại mỗi lượt (kể cả --resume) nên luôn là bản mới nhất người dùng đã duyệt.
  const sys = (mode === 'plan' ? ASSISTANT_PROTOCOL + PLAN_PROTOCOL : ASSISTANT_PROTOCOL) + (memory && memory.trim() ? `\n\n${memory.trim()}` : '');
  args.push('--append-system-prompt', sys);
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
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
const fmtN = (n) => Number(n || 0).toLocaleString('en-US');

// Mô tả ngắn một yêu cầu quyền (hiện trên thẻ xin phép).
export function describePermission(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') return clip(i.command, 300);
  if (i.file_path || i.path) return clip(i.file_path || i.path, 300);
  if (i.url) return clip(i.url, 300);
  if (i.pattern) return clip(i.pattern, 300);
  return clip(JSON.stringify(i), 300);
}

// Tạo trợ lý: {state, send, stop, reset, callTool, toolResult, on, dispose, …}. Mỗi cuộc chat chạy tối đa một lượt, nhiều cuộc chạy song song.
// baseUrl() trả gốc app (biết sau khi listen); lịch sử lưu ở <home>/assistant/chat.json.
export function createAssistant({
  home,
  claudeBin = 'claude',
  baseUrl = () => null,
  model = null,
  env = {},
  usage = null, // createUsage(): nhận % mức dùng + token của mỗi lượt
  serverTools = {}, // {tên: async (args) → {text, isError, images}} chạy ngay trên server
  brain = null, // createBrain(): nạp nhánh của trợ lý vào lời nhắc hệ thống
  claudeHome = path.join(os.homedir(), '.claude'), // nơi tìm skill / lệnh tự định nghĩa cho "/"
  workDir = null, // thư mục làm việc khi trợ lý được đọc/sửa file (mặc định <home>/assistant/work)
  toolTimeoutMs = TOOL_TIMEOUT_MS,
  holdTimeoutMs = HOLD_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  if (!home) throw new Error('createAssistant cần home.');
  const bin = /[\\/]/.test(String(claudeBin)) ? path.resolve(String(claudeBin)) : String(claudeBin || 'claude');
  const dir = path.join(home, 'assistant');
  const file = path.join(dir, 'chat.json');
  const work = workDir ? path.resolve(workDir) : path.join(dir, 'work');
  const listeners = new Set();
  const pending = new Map(); // id → {resolve, timer} lệnh thao tác trang
  // Bộ não lỗi đọc thì trợ lý vẫn chạy, chỉ thiếu phần ghi nhớ.
  const brainText = () => {
    try {
      return brain ? brain.forPrompt('assistant') : '';
    } catch {
      return '';
    }
  };
  const perms = new Map(); // id → {resolve, timer, chatId, tool, input, summary} xin quyền sửa file / chạy lệnh
  const turns = new Map(); // chatId → {key, tabId, child, stopped, finished, cfgFile, chat…}
  const queues = new Map(); // chatId → [entry] tin nhắn chờ khi trợ lý đang bận
  const newChat = (from = null) => ({ id: crypto.randomUUID(), title: '', sessionId: null, started: false, messages: [], model: from?.model ?? null, effort: from?.effort ?? null, mode: from?.mode ?? 'page', pinned: false, ctx: 0, stats: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, updatedAt: now() });
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const cleanChat = (d) => ({
    id: typeof d.id === 'string' && d.id ? d.id : crypto.randomUUID(),
    title: typeof d.title === 'string' ? d.title.slice(0, 80) : '',
    sessionId: typeof d.sessionId === 'string' ? d.sessionId : null,
    started: !!d.started,
    messages: Array.isArray(d.messages) ? d.messages.slice(-MAX_MESSAGES) : [],
    model: MODELS.includes(d.model) ? d.model : null,
    effort: EFFORTS.includes(d.effort) ? d.effort : null,
    mode: MODES.includes(d.mode) ? d.mode : 'page',
    pinned: d.pinned === true,
    ctx: num(d.ctx),
    stats: { turns: num(d.stats?.turns), input: num(d.stats?.input), output: num(d.stats?.output), cacheRead: num(d.stats?.cacheRead), cacheWrite: num(d.stats?.cacheWrite), cost: num(d.stats?.cost) },
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : now(),
  });
  let chats = []; // mọi cuộc chat (kể cả cuộc hiện tại)
  let chat = load();
  let rev = 0;
  const turnOf = (c = chat) => turns.get(c.id) || null;

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

  const ctxInfo = (c = chat) => ({ tokens: c.ctx, limit: CONTEXT_LIMIT, pct: Math.min(1, c.ctx / CONTEXT_LIMIT) });
  const permsOf = (c = chat) => [...perms.entries()].filter(([, p]) => p.chatId === c.id).map(([id, p]) => ({ id, tool: p.tool, summary: p.summary }));
  const lastIsAssistant = () => chat.messages[chat.messages.length - 1]?.role === 'assistant';

  // Ảnh chụp gửi cho UI (cuộc đang mở).
  // rev tăng mỗi lần đổi: UI bỏ trạng thái cũ hơn (phản hồi HTTP có thể về sau SSE).
  function state() {
    const q = queues.get(chat.id) || [];
    return {
      busy: !!turnOf(),
      messages: chat.messages,
      rev,
      chatId: chat.id,
      model: chat.model,
      effort: chat.effort,
      mode: chat.mode,
      canCompact: chat.started && !turnOf(),
      context: ctxInfo(),
      queue: q.map((e) => e.msg),
      permissions: permsOf(),
      planReady: chat.mode === 'plan' && chat.started && !turnOf() && !q.length && lastIsAssistant(),
      running: [...turns.keys()],
    };
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

  function push(c, role, text, extra = {}) {
    c.messages.push({ id: crypto.randomUUID(), role, text: String(text), at: now(), ...extra });
    c.updatedAt = now();
    if (!c.title && role === 'user') c.title = titleOf(c);
    if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
    changed();
  }

  // Đăng ký nghe {kind:'state'|'tool'}; trả hàm hủy.
  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function settleAll(c, text) {
    for (const [id, p] of pending) {
      if (p.chatId !== c.id) continue;
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve({ text, isError: true });
    }
    for (const [id, p] of perms) {
      if (p.chatId !== c.id) continue;
      clearTimeout(p.timer);
      perms.delete(id);
      p.resolve({ text: JSON.stringify({ behavior: 'deny', message: text }) });
    }
  }

  // Gom tin (tệp, video, lệnh "/…") thành lời nhắc đầy đủ cho model; tin hiển thị giữ nguyên.
  function buildEntry(msg, { tabId, lang, images, files, videos }) {
    // videos = [{name, info, frames}] do server tự lấy từ file trong dự án (đã tin cậy)
    const clean = cleanImages(images);
    const imgs = clean.concat(videos.flatMap((v) => v.frames));
    const docs = cleanFiles(files);
    const names = [...clean.map((i) => i.name), ...videos.map((v) => v.name), ...docs.map((d) => d.name)];
    const ctx = [
      ...docs.map((d) => `[Tệp đính kèm: ${d.name}${d.cut ? ' (đã cắt bớt)' : ''}]\n\`\`\`\n${d.text}\n\`\`\``),
      ...videos.map((v) => `[Video đính kèm — ${v.info}; các ảnh kèm theo là khung hình của video này]`),
    ];
    const body = expandCommand(msg, claudeHome) || msg;
    const full = ctx.length ? `${ctx.join('\n\n')}\n\n${body}` : body;
    // giao diện tiếng Anh → nhắc trả lời tiếng Anh (chỉ trong lời gửi cho model)
    return { msg, prompt: lang === 'en' ? `[Reply in English.]\n${full}` : full, imgs, names, tabId: String(tabId || '') };
  }

  // Gửi một câu cho trợ lý; tabId = tab trình duyệt sẽ làm thao tác. Đang bận → xếp hàng; "/lệnh có sẵn" → chạy lệnh.
  function send(text, { tabId = null, lang = 'vi', images = [], files = [], videos = [] } = {}) {
    const msg = String(text ?? '').trim();
    if (!msg) throw new HttpError(400, 'invalid_body', 'Nhập nội dung cần trợ lý làm.');
    if (msg.length > MAX_INPUT) throw new HttpError(400, 'invalid_body', `Tin nhắn tối đa ${MAX_INPUT} ký tự.`);
    const sl = parseSlash(msg);
    if (sl && BUILTIN.some((b) => b.name === sl.name)) return command(sl.name, sl.args, { tabId, lang });
    const url = baseUrl();
    if (!url) throw new HttpError(503, 'assistant_unavailable', 'Trợ lý chưa sẵn sàng.');
    const entry = buildEntry(msg, { tabId, lang, images, files, videos });
    if (turnOf()) {
      const q = queues.get(chat.id) || [];
      if (q.length >= MAX_QUEUE) throw new HttpError(409, 'queue_full', `Hàng đợi đã đầy (tối đa ${MAX_QUEUE} tin).`);
      queues.set(chat.id, [...q, entry]);
      changed();
      return state();
    }
    dispatch(chat, entry, url);
    return state();
  }

  // Bắt đầu một lượt cho tin trong hàng/đang gửi; ngữ cảnh gần đầy thì nén trước rồi mới gửi tiếp.
  function dispatch(c, entry, url = baseUrl()) {
    if (!url) {
      push(c, 'error', 'Trợ lý chưa sẵn sàng.');
      return;
    }
    if (c.started && c.ctx / CONTEXT_LIMIT >= AUTO_COMPACT_AT && !entry.compacted) {
      queues.set(c.id, [{ ...entry, compacted: true }, ...(queues.get(c.id) || [])]);
      push(c, 'note', 'Ngữ cảnh gần đầy — tự nén trước khi tiếp tục.');
      runCompact(c, url, '');
      return;
    }
    push(c, 'user', entry.msg, entry.names.length ? { images: entry.names } : {});
    start(c, entry.prompt, url, entry.tabId, false, entry.imgs);
  }

  function start(c, prompt, url, tabId, retried, imgs = []) {
    const resume = c.started && !!c.sessionId;
    if (!resume) c.sessionId = crypto.randomUUID();
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
    const t = { key, tabId, child: null, stopped: false, finished: false, cfgFile, gotResult: false, stderr: '', resume, chat: c, lastCtx: 0 };
    turns.set(c.id, t);
    const isScript = /\.(mjs|cjs|js)$/i.test(bin);
    const argv = buildAssistantArgs({ sessionId: c.sessionId, resume, mcpConfig: cfgFile, model: c.model || model, effort: c.effort, images: imgs.length > 0, mode: c.mode, protect: [home, path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), path.join(claudeHome)], memory: brainText() });
    let cwd = dir;
    if (c.mode !== 'page') {
      try {
        fs.mkdirSync(work, { recursive: true });
        cwd = work;
      } catch {
        /* không tạo được → dùng thư mục trợ lý */
      }
    }
    let child;
    try {
      child = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...argv] : argv, {
        cwd,
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
      finish(t, code, null, lost ? () => start(c, prompt, url, tabId, true, imgs) : null);
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
    const c = t.chat;
    if (turns.get(c.id) !== t || !line.trim()) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.type === 'system' && o.subtype === 'init') {
      if (isApiKeySource(o.apiKeySource)) push(c, 'note', 'Lưu ý: claude đang dùng API key (tính tiền theo API), không phải gói Claude.');
      return;
    }
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const u = o.message.usage;
      if (u) t.lastCtx = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      for (const b of o.message.content) if (b?.type === 'text' && b.text?.trim()) push(c, 'assistant', b.text.trim());
      return;
    }
    if (o.type === 'rate_limit_event') {
      usage?.observe(o.rate_limit_info);
      return;
    }
    if (o.type === 'result') {
      t.gotResult = true;
      const u = o.usage && typeof o.usage === 'object' ? o.usage : null;
      if (u) {
        usage?.record('assistant', u);
        c.stats.turns += 1;
        c.stats.input += num(u.input_tokens);
        c.stats.output += num(u.output_tokens);
        c.stats.cacheRead += num(u.cache_read_input_tokens);
        c.stats.cacheWrite += num(u.cache_creation_input_tokens);
        c.stats.cost += num(o.total_cost_usd);
        c.ctx = t.lastCtx || num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      }
      if (o.is_error) push(c, 'error', resultError(o));
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
    const c = t.chat;
    try {
      fs.rmSync(t.cfgFile, { force: true });
    } catch {
      /* bỏ qua */
    }
    if (turns.get(c.id) !== t) return; // đã bị Cuộc mới / Xóa bỏ qua
    turns.delete(c.id);
    settleAll(c, 'Lượt chat đã kết thúc.');
    if (retry && !t.stopped && code !== 0) {
      c.started = false;
      push(c, 'note', 'Phiên trò chuyện cũ không còn — bắt đầu phiên mới.');
      return retry();
    }
    let failed = false;
    if (t.stopped) push(c, 'note', 'Đã dừng.');
    else if (err) {
      failed = true;
      push(c, 'error', err.code === 'ENOENT' ? 'Không tìm thấy lệnh claude — cài Claude Code trước.' : `Không chạy được claude: ${err.message}`);
    } else if (!t.gotResult && code !== 0) {
      failed = true;
      const tail = t.stderr.trim().split('\n').pop() || '';
      push(c, 'error', /not logged in|login/i.test(tail) ? 'Claude chưa đăng nhập — bấm nút Claude trên thanh trên để đăng nhập.' : `Trợ lý dừng bất thường${tail ? `: ${tail.slice(0, 300)}` : '.'}`);
    }
    if (t.gotResult || code === 0) c.started = true;
    if (t.compact && t.gotResult && !t.stopped && !err) {
      c.ctx = 0;
      push(c, 'note', 'Đã nén cuộc trò chuyện.');
    }
    changed();
    // Hàng đợi: lượt ổn thì chạy tin kế, dừng/lỗi thì bỏ cả hàng.
    const q = queues.get(c.id) || [];
    if (!q.length) return;
    if (t.stopped || failed) {
      queues.delete(c.id);
      push(c, 'note', 'Đã bỏ các tin đang chờ.');
      return;
    }
    const [next, ...rest] = q;
    if (rest.length) queues.set(c.id, rest);
    else queues.delete(c.id);
    dispatch(c, next);
  }

  // Dừng lượt đang chạy của một cuộc (SIGTERM, quá hạn thì SIGKILL); bỏ luôn hàng đợi.
  function stop(c = chat) {
    const t = turnOf(c);
    queues.delete(c.id);
    if (!t) return state();
    t.stopped = true;
    settleAll(c, 'Người dùng đã dừng trợ lý.');
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

  // Dừng hẳn lượt của một cuộc trước khi xóa: lượt cũ đang tắt, finish() thấy không còn trong turns thì không ghi gì.
  function dropTurn(c) {
    if (turnOf(c)) {
      stop(c);
      turns.delete(c.id);
    }
    queues.delete(c.id);
  }

  // Giữ tối đa MAX_CHATS cuộc: bỏ cuộc cũ nhất không ghim, không đang chạy, không đang mở.
  function prune() {
    while (chats.length > MAX_CHATS) {
      let i = -1;
      for (let k = chats.length - 1; k >= 0; k--) if (!chats[k].pinned && !turns.has(chats[k].id) && chats[k].id !== chat.id) { i = k; break; }
      if (i < 0) break;
      chats.splice(i, 1);
    }
  }

  // Cuộc mới: giữ cuộc cũ trong lịch sử (cuộc cũ đang chạy thì cứ chạy nền; cuộc trống thì dùng lại), giữ model/effort/chế độ đang chọn.
  function reset() {
    if (chat.messages.length || turnOf()) {
      chat = newChat(chat);
      chats.unshift(chat);
      prune();
    } else {
      chat = { ...newChat(chat), id: chat.id };
      chats[chats.findIndex((c) => c.id === chat.id)] = chat;
    }
    changed();
    return state();
  }

  // Danh sách cuộc chat (ghim trước, rồi mới nhất trước) cho nút Lịch sử; q = tìm trong tiêu đề và nội dung.
  function list(q = '') {
    const needle = String(q || '').trim().toLowerCase();
    return chats
      .filter((c) => c.messages.length || c.id === chat.id)
      .filter((c) => !needle || (c.title || '').toLowerCase().includes(needle) || c.messages.some((m) => String(m.text).toLowerCase().includes(needle)))
      .map((c) => ({ id: c.id, title: c.title || '', updatedAt: c.updatedAt, count: c.messages.length, current: c.id === chat.id, pinned: c.pinned, busy: turns.has(c.id), mode: c.mode }))
      .sort((a, b) => (a.pinned === b.pinned ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.pinned ? -1 : 1));
  }

  function busyCheck() {
    if (turnOf()) throw new HttpError(409, 'assistant_busy', 'Trợ lý đang làm — chờ xong hoặc bấm Dừng.');
  }
  const find = (id) => {
    const c = chats.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'not_found', 'Không tìm thấy cuộc trò chuyện.');
    return c;
  };

  // Mở lại một cuộc chat cũ (tiếp tục bằng --resume phiên của nó); cuộc đó đang chạy nền thì xem được luôn.
  function open(id) {
    chat = find(id);
    changed();
    return state();
  }

  // Xóa một cuộc chat khỏi lịch sử (dừng lượt của nó); xóa cuộc đang mở thì sang cuộc trống mới.
  function remove(id) {
    const c = find(id);
    dropTurn(c);
    chats.splice(chats.indexOf(c), 1);
    if (c.id === chat.id) {
      chat = newChat(chat);
      chats.unshift(chat);
    }
    changed();
    return state();
  }

  // Đổi tên / ghim một cuộc chat bất kỳ.
  function rename(id, title) {
    const c = find(id);
    const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!t) throw new HttpError(400, 'invalid_body', 'Tên cuộc trò chuyện không được để trống.');
    c.title = t;
    changed();
    return state();
  }
  function pin(id, on = null) {
    const c = find(id);
    c.pinned = on === null ? !c.pinned : !!on;
    changed();
    return state();
  }

  // Chọn model / effort / chế độ cho cuộc đang mở (null hoặc '' = mặc định); áp dụng từ lượt kế tiếp.
  function settings(body = {}) {
    busyCheck();
    for (const [k, allowed] of [['model', MODELS], ['effort', EFFORTS]]) {
      if (!(k in body)) continue;
      const v = body[k] || null;
      if (v !== null && !allowed.includes(v)) throw new HttpError(400, 'invalid_body', `Giá trị ${k} không hợp lệ.`);
      chat[k] = v;
    }
    if ('mode' in body) {
      const v = body.mode || 'page';
      if (!MODES.includes(v)) throw new HttpError(400, 'invalid_body', 'Giá trị mode không hợp lệ.');
      chat.mode = v;
    }
    changed();
    return state();
  }

  // Duyệt kế hoạch: chuyển sang chế độ làm việc (ask / edit) rồi bảo trợ lý thực hiện.
  function approvePlan(mode = 'ask', opts = {}) {
    if (!['ask', 'edit'].includes(mode)) throw new HttpError(400, 'invalid_body', 'Giá trị mode không hợp lệ.');
    busyCheck();
    if (chat.mode !== 'plan' || !chat.started) throw new HttpError(409, 'no_plan', 'Chưa có kế hoạch nào để duyệt.');
    chat.mode = mode;
    return send('Kế hoạch đã được duyệt. Hãy thực hiện ngay theo kế hoạch.', opts);
  }

  // Nén ngữ cảnh phiên hiện tại bằng /compact (cần phiên đã bắt đầu, trợ lý rảnh); instructions = gợi ý tóm tắt.
  function compact(instructions = '') {
    busyCheck();
    if (!chat.started || !chat.sessionId) throw new HttpError(409, 'compact_none', 'Chưa có gì để nén — hãy trò chuyện trước.');
    const url = baseUrl();
    if (!url) throw new HttpError(503, 'assistant_unavailable', 'Trợ lý chưa sẵn sàng.');
    runCompact(chat, url, instructions);
    return state();
  }
  function runCompact(c, url, instructions) {
    push(c, 'note', 'Đang nén cuộc trò chuyện…');
    start(c, `/compact${instructions ? ` ${String(instructions).slice(0, 500)}` : ''}`, url, '', true);
    const t = turnOf(c);
    if (t) t.compact = true;
  }

  // Lệnh "/" có sẵn (trừ các lệnh chỉ giao diện làm được): trả trạng thái mới.
  function command(name, args = '', { tabId = null, lang = 'vi' } = {}) {
    const a = String(args || '').trim();
    const note = (text) => {
      push(chat, 'note', text);
      return state();
    };
    switch (name) {
      case 'compact':
        return compact(a);
      case 'clear':
      case 'new':
        return reset();
      case 'model':
      case 'effort': {
        if (!a) return note(`${name === 'model' ? 'Model' : 'Effort'} hiện tại: ${chat[name] || 'mặc định'}`);
        const v = /^(default|mặc định|none)$/i.test(a) ? null : a.toLowerCase();
        settings({ [name]: v });
        return note(`Đã chọn ${name}: ${v || 'mặc định'}`);
      }
      case 'mode':
      case 'plan': {
        if (name === 'plan' || a) {
          const v = name === 'plan' ? 'plan' : a.toLowerCase().split(/\s+/)[0];
          settings({ mode: v });
          if (name === 'plan' && a) return send(a, { tabId, lang });
          return note(`Chế độ: ${v}`);
        }
        return note(`Chế độ hiện tại: ${chat.mode} (page, plan, ask, edit)`);
      }
      case 'context': {
        const c = ctxInfo();
        return note(`Ngữ cảnh: ${fmtN(c.tokens)} / ${fmtN(c.limit)} token (${Math.round(c.pct * 100)}%). Tự nén khi đạt ${Math.round(AUTO_COMPACT_AT * 100)}%.`);
      }
      case 'cost': {
        const s = chat.stats;
        const money = s.cost > 0 ? ` · ước tính $${s.cost.toFixed(2)}` : '';
        return note(`Cuộc này: ${s.turns} lượt · vào ${fmtN(s.input)} · ra ${fmtN(s.output)} · cache đọc ${fmtN(s.cacheRead)} · cache ghi ${fmtN(s.cacheWrite)}${money}. Dùng gói Claude nên không tính tiền theo token.`);
      }
      case 'status':
        return note(`Model: ${chat.model || 'mặc định'} · effort: ${chat.effort || 'mặc định'} · chế độ: ${chat.mode} · phiên: ${chat.sessionId ? chat.sessionId.slice(0, 8) : 'chưa có'}`);
      case 'rename':
        if (!a) return note('Cú pháp: /rename <tên mới>');
        return rename(chat.id, a);
      case 'pin':
        return pin(chat.id);
      case 'help':
        return note(listCommands(claudeHome).map((x) => `/${x.name}${x.hint ? ` ${x.hint}` : ''} — ${x.desc}`).join('\n'));
      default:
        return state(); // lệnh chỉ giao diện (resume, export, memory, mcp)
    }
  }

  const commands = () => listCommands(claudeHome);

  // MCP gọi về (route public): kiểm mã của lượt → gửi lệnh cho tab qua SSE → chờ kết quả.
  function turnByKey(key) {
    for (const t of turns.values()) if (safeEq(key, t.key)) return t;
    return null;
  }
  const SENSITIVE = [/\.video-studio[\\/](token|secrets)/i, /security\s+(find|dump|delete)-/i, /\.ssh[\\/]/, /\.aws[\\/]/, /\.claude[\\/]\.credentials/i];

  // Xin quyền sửa file / chạy lệnh: file bí mật bị từ chối ngay, còn lại hiện thẻ cho người dùng.
  function askPermission(t, args) {
    const c = t.chat;
    const tool = String(args?.tool_name || 'tool').slice(0, 60);
    const input = args?.input && typeof args.input === 'object' ? args.input : {};
    const flat = JSON.stringify(input);
    if (SENSITIVE.some((re) => re.test(flat))) {
      return Promise.resolve({ text: JSON.stringify({ behavior: 'deny', message: 'Không được truy cập tệp bí mật (token, khóa, Keychain).' }) });
    }
    const summary = describePermission(tool, input);
    if ([...perms.values()].filter((p) => p.chatId === c.id).length >= MAX_PERMISSIONS) {
      return Promise.resolve({ text: JSON.stringify({ behavior: 'deny', message: 'Quá nhiều yêu cầu quyền chờ xử lý.' }) });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        perms.delete(id);
        resolve({ text: JSON.stringify({ behavior: 'deny', message: 'Người dùng không trả lời kịp.' }) });
        changed();
      }, holdTimeoutMs);
      perms.set(id, { resolve, timer, chatId: c.id, tool, input, summary });
      push(c, 'action', `Xin phép: ${tool} — ${summary}`.slice(0, 200));
    });
  }

  // Người dùng bấm Cho phép / Không trên thẻ xin quyền.
  function answerPermission(id, allow) {
    const p = perms.get(id);
    if (!p) throw new HttpError(404, 'not_found', 'Yêu cầu đã hết hạn.');
    clearTimeout(p.timer);
    perms.delete(id);
    p.resolve({
      text: JSON.stringify(allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'Người dùng không cho phép thao tác này.' }),
    });
    changed();
    return state();
  }

  function callTool(key, tool, args) {
    const t = turnByKey(key);
    if (!t) throw new HttpError(403, 'forbidden', 'Mã lượt không hợp lệ.');
    if (tool === PERMISSION_TOOL.name) return askPermission(t, args);
    if (!TOOLS.some((x) => x.name === tool) || tool === 'wait') throw new HttpError(400, 'invalid_body', 'Tool không hợp lệ.');
    if (serverTools[tool]) {
      return Promise.resolve(serverTools[tool](args && typeof args === 'object' ? args : {})).then(
        (r) => {
          push(t.chat, 'action', `${tool}${r.isError ? ' (lỗi)' : ''}`, r.isError ? { failed: true } : {});
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
      pending.set(id, { resolve, timer: timeout(toolTimeoutMs), timeout, chatId: t.chat.id });
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
    const c = chats.find((x) => x.id === p.chatId) || chat;
    if (typeof body.label === 'string' && body.label.trim()) push(c, 'action', body.label.trim().slice(0, 200), body.isError ? { failed: true } : {});
    p.resolve({ text: String(body.text ?? '').slice(0, 60_000), isError: !!body.isError });
    return { ok: true };
  }

  function dispose() {
    for (const c of chats) if (turns.has(c.id)) stop(c);
    listeners.clear();
  }

  return { state, send, stop, reset, list, open, remove, rename, pin, settings, approvePlan, compact, command, commands, answerPermission, callTool, toolResult, on, dispose };
}
