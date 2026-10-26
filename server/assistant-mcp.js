#!/usr/bin/env node
// MCP server (stdio, JSON-RPC mỗi dòng một bản tin) cho Trợ lý AI: claude gọi tool → chuyển về app qua HTTP kèm mã của lượt.
// Env: STUDIO_ASSIST_URL (gốc app, vd http://127.0.0.1:4317), STUDIO_ASSIST_KEY (mã bí mật của lượt).
import { pathToFileURL } from 'node:url';

export const SERVER_NAME = 'studio';
export const WAIT_MAX_MS = 10_000;

const REF = { type: 'integer', minimum: 1, description: 'Số [ref] của phần tử, lấy từ lần read_page gần nhất.' };

export const TOOLS = [
  {
    name: 'read_page',
    description: 'Đọc trang Video Studio đang mở: đường dẫn, tiêu đề, hộp thoại (nếu có) và danh sách phần tử thao tác được, mỗi phần tử có số [ref].',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'click',
    description: 'Bấm một phần tử (nút, liên kết, ô chọn, lựa chọn trong danh sách). Trả về trang sau khi bấm.',
    inputSchema: { type: 'object', properties: { ref: REF }, required: ['ref'], additionalProperties: false },
  },
  {
    name: 'fill',
    description: 'Gõ giá trị vào ô nhập (thay toàn bộ nội dung cũ). Trả về trang sau khi gõ.',
    inputSchema: {
      type: 'object',
      properties: { ref: REF, value: { type: 'string', description: 'Giá trị mới.' } },
      required: ['ref', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Chuyển tới một màn chính của app. Trả về trang mới.',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'string', enum: ['overview', 'pipelines', 'channels'], description: 'overview = Tổng quan, pipelines = Quy trình, channels = Kênh.' } },
      required: ['page'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: `Chờ trang tải/chạy xong (tối đa ${WAIT_MAX_MS / 1000} giây) rồi đọc lại trang.`,
    inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 100, maximum: WAIT_MAX_MS } }, additionalProperties: false },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: String(t) }], ...(isError ? { isError: true } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gửi 1 lệnh về app; trả {text, isError}. Lỗi mạng/HTTP → isError kèm lý do.
export async function forward({ url, key, tool, args, fetchFn = fetch }) {
  let res;
  try {
    res = await fetchFn(new URL('/api/assistant/tool', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, tool, args: args || {} }),
    });
  } catch (e) {
    return { text: `Không kết nối được Video Studio: ${e?.message || e}`, isError: true };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) return { text: body?.message || `Video Studio trả lỗi ${res.status}.`, isError: true };
  return { text: String(body?.text ?? ''), isError: !!body?.isError };
}

// Xử lý 1 bản tin JSON-RPC; trả object trả lời, hoặc null với notification.
export async function handle(msg, { url, key, fetchFn } = {}) {
  const id = msg?.id;
  const isNote = id === undefined || id === null;
  const reply = (result) => (isNote ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNote ? null : { jsonrpc: '2.0', id, error: { code, message } });
  switch (msg?.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (!TOOLS.some((t) => t.name === name)) return reply(text(`Không có tool ${name}.`, true));
      if (name === 'wait') {
        const ms = Math.min(WAIT_MAX_MS, Math.max(100, Number(args.ms) || 1500));
        await sleep(ms);
        const r = await forward({ url, key, tool: 'read_page', args: {}, fetchFn });
        return reply(text(r.text, r.isError));
      }
      const r = await forward({ url, key, tool: name, args, fetchFn });
      return reply(text(r.text, r.isError));
    }
    default:
      if (typeof msg?.method === 'string' && msg.method.startsWith('notifications/')) return null;
      return fail(-32601, `Không hỗ trợ ${msg?.method}`);
  }
}

// Vòng đọc stdin → ghi stdout; mỗi bản tin xử lý độc lập (tool chậm không chặn ping).
export function serve({ input = process.stdin, output = process.stdout, url, key, fetchFn } = {}) {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON lỗi' } }) + '\n');
        continue;
      }
      handle(msg, { url, key, fetchFn }).then((out) => out && output.write(JSON.stringify(out) + '\n'));
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  serve({ url: process.env.STUDIO_ASSIST_URL, key: process.env.STUDIO_ASSIST_KEY });
}
