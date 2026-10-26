// Chuẩn hóa stream-json của `claude -p` thành NormEvent theo whitelist (hợp đồng M1 §7).
// Chỉ chép những field được liệt kê — email/orgId/tools/mcp_servers… không bao giờ lọt vào event.
import { StringDecoder } from 'node:string_decoder';

export const TEXT_MAX = 500;
export const INPUT_STR_MAX = 2000;
export const RESULT_STR_MAX = 2000;
const TOOL_JSON_MAX = 200;
const ENFORCE_PREFIX = '[structured-output-enforce]';
const INIT_FIELDS = ['session_id', 'model', 'cwd', 'permissionMode', 'apiKeySource', 'claude_code_version'];
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Cắt chuỗi tối đa max ký tự (tính theo code point), thêm "…" nếu bị cắt.
export function truncate(s, max = TEXT_MAX) {
  const str = s == null ? '' : String(s);
  if (str.length <= max) return str;
  const cps = Array.from(str);
  if (cps.length <= max) return str;
  return cps.slice(0, Math.max(0, max - 1)).join('') + '…';
}

// Gộp nhiều dòng thành 1 dòng ngắn để hiện ở log.
function oneLine(s, max = TEXT_MAX) {
  return truncate(String(s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim(), max);
}

// Sao chép sâu, cắt mọi chuỗi dài hơn max (giới hạn độ sâu để tránh object khổng lồ).
export function truncateDeep(v, max = INPUT_STR_MAX, depth = 0) {
  if (typeof v === 'string') return truncate(v, max);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 8) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => truncateDeep(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = truncateDeep(x, max, depth + 1);
  return out;
}

function shortJson(v, max) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return truncate(s ?? '', max);
}

function relPath(p, cwd) {
  if (typeof p !== 'string') return p;
  if (cwd && typeof cwd === 'string') {
    const base = cwd.endsWith('/') ? cwd : cwd + '/';
    if (p.startsWith(base)) return p.slice(base.length) || p;
  }
  return p;
}

// Tóm tắt input của tool_use: Bash → command; Edit/Write/Read → file_path; Glob/Grep → pattern; khác → JSON ≤ 200.
function toolSummary(name, input, ctx) {
  const inp = isObj(input) ? input : {};
  if (name === 'Bash' && typeof inp.command === 'string') return inp.command;
  if (['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const fp = inp.file_path ?? inp.notebook_path;
    if (typeof fp === 'string') return relPath(fp, ctx.cwd);
  }
  if ((name === 'Glob' || name === 'Grep') && typeof inp.pattern === 'string') return inp.pattern;
  return shortJson(input ?? {}, TOOL_JSON_MAX);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : shortJson(content, TEXT_MAX);
  return content
    .map((c) => {
      if (typeof c === 'string') return c;
      if (!isObj(c)) return '';
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'image') return '[ảnh]';
      return c.type ? `[${c.type}]` : '';
    })
    .filter(Boolean)
    .join(' ');
}

function isEnforceText(s) {
  return typeof s === 'string' && s.trimStart().startsWith(ENFORCE_PREFIX);
}

function isSyntheticUser(obj) {
  if (obj.isSynthetic === true) return true;
  const c = obj.message && obj.message.content;
  if (typeof c === 'string') return isEnforceText(c);
  if (Array.isArray(c)) return c.some((x) => isObj(x) && x.type === 'text' && isEnforceText(x.text));
  return false;
}

// Bản đã lọc của dòng system/init: chỉ type, subtype + field whitelist §7.
export function filterInit(obj) {
  const out = { type: 'system', subtype: 'init' };
  for (const k of INIT_FIELDS) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Dòng system/hook_* (bị bỏ khỏi event và khỏi stream.jsonl).
export function isHookLine(obj) {
  return isObj(obj) && obj.type === 'system' && typeof obj.subtype === 'string' && obj.subtype.startsWith('hook_');
}

// Dòng sẽ ghi vào stream.jsonl: null = bỏ (hook), init → bản lọc, còn lại → chính obj (ghi nguyên văn).
export function logLineFor(obj) {
  if (isHookLine(obj)) return null;
  if (isObj(obj) && obj.type === 'system' && obj.subtype === 'init') return filterInit(obj);
  return obj;
}

function usageOf(u) {
  const out = {};
  for (const k of USAGE_FIELDS) out[k] = num(isObj(u) ? u[k] : 0);
  return out;
}

// Có tính tiền theo API key không (apiKeySource khác 'none' và có giá trị).
export function isApiKeySource(src) {
  return typeof src === 'string' && src !== '' && src !== 'none';
}

function resultEvent(obj, ctx) {
  const usage = usageOf(obj.usage);
  const inTok = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const secs = Math.round(num(obj.duration_ms) / 100) / 10;
  const turns = num(obj.num_turns);
  const head = obj.is_error ? `Kết thúc lỗi (${obj.subtype ?? 'error'}) sau` : 'Hoàn tất sau';
  let text = `${head} ${secs}s · ${turns} lượt · in ${inTok} / out ${usage.output_tokens} token`;
  if (isApiKeySource(ctx.apiKeySource) && typeof obj.total_cost_usd === 'number') {
    text += ` · $${obj.total_cost_usd.toFixed(4)}`;
  }
  const denials = Array.isArray(obj.permission_denials)
    ? obj.permission_denials.filter(isObj).map((d) => ({ tool_name: d.tool_name ?? null, tool_input: truncateDeep(d.tool_input ?? null) }))
    : [];
  let result = obj.result;
  if (result != null && typeof result !== 'string') result = shortJson(result, RESULT_STR_MAX);
  return {
    kind: 'result',
    text: oneLine(text),
    payload: {
      subtype: obj.subtype ?? null,
      is_error: obj.is_error === true,
      duration_ms: num(obj.duration_ms),
      num_turns: turns,
      total_cost_usd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
      usage,
      permission_denials: denials,
      structured_output: obj.structured_output === undefined ? null : truncateDeep(obj.structured_output, 20000),
      terminal_reason: obj.terminal_reason ?? null,
      result: result == null ? null : truncate(result, RESULT_STR_MAX),
    },
  };
}

function assistantEvents(obj, ctx) {
  const content = obj.message && obj.message.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === 'thinking') {
      if (typeof c.thinking === 'string' && c.thinking.trim()) out.push({ kind: 'thinking', text: oneLine(c.thinking), payload: null });
    } else if (c.type === 'text') {
      if (typeof c.text === 'string' && c.text.trim()) out.push({ kind: 'text', text: oneLine(c.text), payload: null });
    } else if (c.type === 'tool_use') {
      if (c.name === 'StructuredOutput') {
        const status = isObj(c.input) && typeof c.input.status === 'string' ? c.input.status : '?';
        out.push({ kind: 'structured', text: oneLine(`Kết quả bước: ${status}`), payload: { input: truncateDeep(c.input ?? null) } });
      } else {
        const name = typeof c.name === 'string' ? c.name : 'tool';
        out.push({
          kind: 'tool',
          text: oneLine(`${name} ${toolSummary(name, c.input, ctx)}`),
          payload: { id: c.id ?? null, name, input: truncateDeep(c.input ?? null) },
        });
      }
    }
  }
  return out;
}

function userEvents(obj) {
  if (isSyntheticUser(obj)) return [];
  const content = obj.message && obj.message.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!isObj(c) || c.type !== 'tool_result') continue;
    out.push({
      kind: 'tool_result',
      text: oneLine(contentText(c.content)),
      payload: { tool_use_id: c.tool_use_id ?? null, is_error: c.is_error === true },
    });
  }
  return out;
}

// 1 dòng stream đã parse (hoặc chuỗi chưa parse) → NormEvent[] {kind, text, payload}; ctx = {apiKeySource, cwd}.
export function normalizeLine(obj, ctx = {}) {
  const c = ctx || {};
  if (typeof obj === 'string') {
    const line = obj.trim();
    if (!line) return [];
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [{ kind: 'raw', text: oneLine(line), payload: null }];
    }
    return normalizeLine(parsed, c);
  }
  if (!isObj(obj)) return [{ kind: 'raw', text: oneLine(shortJson(obj, TEXT_MAX)), payload: null }];

  switch (obj.type) {
    case 'system': {
      if (obj.subtype === 'init') {
        const payload = {};
        for (const k of INIT_FIELDS) payload[k] = obj[k] ?? null;
        const sid = typeof obj.session_id === 'string' ? obj.session_id.slice(0, 8) : '?';
        const n = Array.isArray(obj.tools) ? obj.tools.length : 0;
        return [{ kind: 'init', text: oneLine(`Phiên ${sid} · model ${obj.model ?? '?'} · ${n} tool`), payload }];
      }
      if (obj.subtype === 'permission_denied') {
        return [{
          kind: 'denied',
          text: oneLine(`Chặn ${obj.tool_name ?? '?'}: ${obj.message ?? ''}`),
          payload: { tool_name: obj.tool_name ?? null, tool_use_id: obj.tool_use_id ?? null },
        }];
      }
      return []; // hook_* và system khác: bỏ
    }
    case 'assistant':
      return assistantEvents(obj, c);
    case 'user':
      return userEvents(obj);
    case 'rate_limit_event': {
      const info = isObj(obj.rate_limit_info) ? obj.rate_limit_info : {};
      const status = info.status ?? obj.status ?? null;
      if (status === 'allowed' || status == null) return [];
      const resetsAt = info.resetsAt ?? null;
      let text = `Giới hạn sử dụng: ${status}`;
      if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
        text += ` · mở lại lúc ${new Date(resetsAt * 1000).toISOString()}`;
      }
      return [{ kind: 'rate_limit', text: oneLine(text), payload: { status, resetsAt } }];
    }
    case 'result':
      return [resultEvent(obj, c)];
    default:
      return [];
  }
}

// Tách chuỗi JSONL thành mảng: phần tử là object đã parse, hoặc chuỗi gốc nếu dòng không phải JSON.
export function parseJsonLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

// Bộ tách dòng: push(Buffer|chuỗi) từng mẩu, gọi onLine(line) cho mỗi dòng hoàn chỉnh; end() xả phần dư.
// Giải mã UTF-8 bằng StringDecoder nên ký tự nhiều byte bị cắt giữa 2 mẩu vẫn đúng.
export function createLineSplitter(onLine) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let ended = false;
  const emit = (line) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  function push(chunk) {
    if (ended || chunk == null) return;
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      emit(line);
    }
  }
  function end() {
    if (ended) return;
    ended = true;
    buf += decoder.end();
    if (buf.length) {
      const rest = buf;
      buf = '';
      emit(rest);
    }
  }
  return { push, write: push, end, flush: end };
}
