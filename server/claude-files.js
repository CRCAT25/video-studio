// Sửa CLAUDE.md + memory của Claude Code, và xem / thêm / xóa MCP server (đọc ~/.claude.json, ghi qua `claude mcp`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HttpError } from './projects.js';

export const MAX_FILE = 200 * 1024;
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

// id → đường dẫn tuyệt đối; chỉ nhận id trong danh sách trắng (không nhận đường dẫn tự do).
function resolveId(claudeHome, id) {
  const s = String(id || '');
  if (s === 'claude-md') return path.join(claudeHome, 'CLAUDE.md');
  const m = /^mem:([^/\\]+)\/([^/\\]+\.md)$/.exec(s);
  if (m && m[1] !== '..' && m[2] !== '..') return path.join(claudeHome, 'projects', m[1], 'memory', m[2]);
  throw new HttpError(400, 'invalid_body', 'Tệp không hợp lệ.');
}

export function createClaudeFiles({ claudeHome = path.join(os.homedir(), '.claude'), claudeJson = path.join(os.homedir(), '.claude.json'), claudeBin = 'claude', env = process.env } = {}) {
  const stat = (f) => {
    try {
      const st = fs.statSync(f);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  };

  function list() {
    const out = [{ id: 'claude-md', name: 'CLAUDE.md', group: 'global', size: stat(path.join(claudeHome, 'CLAUDE.md'))?.size ?? 0, exists: !!stat(path.join(claudeHome, 'CLAUDE.md')) }];
    let projects = [];
    try {
      projects = fs.readdirSync(path.join(claudeHome, 'projects'));
    } catch {
      /* chưa có */
    }
    for (const p of projects.sort()) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(claudeHome, 'projects', p, 'memory')).filter((f) => f.endsWith('.md')).sort();
      } catch {
        continue;
      }
      for (const f of files) {
        const st = stat(path.join(claudeHome, 'projects', p, 'memory', f));
        if (st) out.push({ id: `mem:${p}/${f}`, name: f, group: p, size: st.size, exists: true });
      }
    }
    return out;
  }

  function read(id) {
    const f = resolveId(claudeHome, id);
    const st = stat(f);
    if (!st) return { id, text: '', exists: false };
    if (st.size > MAX_FILE) throw new HttpError(413, 'too_large', 'Tệp quá lớn để sửa ở đây.');
    return { id, text: fs.readFileSync(f, 'utf8'), exists: true };
  }

  function write(id, text) {
    if (typeof text !== 'string') throw new HttpError(400, 'invalid_body', 'Thiếu nội dung.');
    if (Buffer.byteLength(text) > MAX_FILE) throw new HttpError(413, 'too_large', 'Nội dung quá lớn.');
    const f = resolveId(claudeHome, id);
    if (id !== 'claude-md' && !stat(f)) throw new HttpError(404, 'not_found', 'Không tìm thấy tệp memory.');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
    return { id, size: Buffer.byteLength(text) };
  }

  // MCP: chỉ trả tên, loại, lệnh/URL; giá trị env và headers (có thể là khóa) không bao giờ rời server.
  function mcpList() {
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    } catch {
      /* chưa có */
    }
    const rows = [];
    const add = (scope, servers) => {
      for (const [name, c] of Object.entries(servers && typeof servers === 'object' ? servers : {})) {
        const type = c?.type || (c?.url ? 'http' : 'stdio');
        const where = c?.url ? String(c.url).replace(/[?#].*$/, '').replace(/\/\/[^/@]*@/, '//') : [c?.command, ...(Array.isArray(c?.args) ? c.args : [])].filter(Boolean).join(' ').slice(0, 200);
        rows.push({ name, scope, type, target: where, env: Object.keys(c?.env || {}).length, headers: Object.keys(c?.headers || {}).length });
      }
    };
    add('user', d.mcpServers);
    for (const [proj, v] of Object.entries(d.projects || {})) add(`project:${path.basename(proj)}`, v?.mcpServers);
    return rows;
  }

  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile(claudeBin, args, { env, timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) reject(new HttpError(400, 'mcp_failed', `claude mcp lỗi: ${String(stderr || err.message).trim().split('\n').pop().slice(0, 200)}`));
        else resolve(stdout);
      });
    });

  async function mcpAdd({ name, type = 'stdio', target, args = [] } = {}) {
    if (!NAME_RE.test(String(name || ''))) throw new HttpError(400, 'invalid_body', 'Tên MCP không hợp lệ.');
    if (!['stdio', 'http', 'sse'].includes(type)) throw new HttpError(400, 'invalid_body', 'Loại MCP không hợp lệ.');
    const t = String(target || '').trim();
    if (!t || t.length > 500 || t.startsWith('-')) throw new HttpError(400, 'invalid_body', 'Thiếu lệnh hoặc URL.');
    if (type !== 'stdio' && !/^https?:\/\//i.test(t)) throw new HttpError(400, 'invalid_body', 'URL phải bắt đầu bằng http(s)://');
    const extra = (Array.isArray(args) ? args : []).map(String).slice(0, 20);
    await run(type === 'stdio' ? ['mcp', 'add', '--scope', 'user', name, '--', t, ...extra] : ['mcp', 'add', '--scope', 'user', '--transport', type, name, t]);
    return mcpList();
  }

  async function mcpRemove(name, scope = 'user') {
    if (!NAME_RE.test(String(name || ''))) throw new HttpError(400, 'invalid_body', 'Tên MCP không hợp lệ.');
    await run(['mcp', 'remove', '--scope', scope === 'local' ? 'local' : 'user', name]);
    return mcpList();
  }

  return { list, read, write, mcpList, mcpAdd, mcpRemove };
}
