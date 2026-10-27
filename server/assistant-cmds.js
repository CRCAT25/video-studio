// Lệnh "/" của Trợ lý AI: lệnh có sẵn của app + skill (~/.claude/skills) + lệnh tự định nghĩa (~/.claude/commands).
// Skill/lệnh được mở rộng thành lời nhắc gửi cho model (trợ lý không có tool Skill nên server đọc nội dung hộ).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillMd } from './skills.js';

export const MAX_CMD_MD = 100 * 1024;
const NAME_RE = /^[A-Za-z0-9][\w:.-]{0,63}$/;

// Lệnh có sẵn: ui = chỉ giao diện làm được (server không xử lý).
export const BUILTIN = [
  { name: 'compact', desc: 'Nén cuộc trò chuyện (kèm hướng dẫn tóm tắt nếu muốn)', hint: '[hướng dẫn]' },
  { name: 'clear', desc: 'Bắt đầu cuộc trò chuyện mới' },
  { name: 'new', desc: 'Bắt đầu cuộc trò chuyện mới' },
  { name: 'resume', desc: 'Mở lịch sử để chọn cuộc trò chuyện cũ', ui: true },
  { name: 'model', desc: 'Chọn model (opus, sonnet, haiku, default)', hint: '[tên]' },
  { name: 'effort', desc: 'Chọn effort (low, medium, high, xhigh, max, default)', hint: '[mức]' },
  { name: 'mode', desc: 'Chế độ làm việc (page, plan, ask, edit)', hint: '[chế độ]' },
  { name: 'plan', desc: 'Vào chế độ lập kế hoạch (chỉ đọc, chờ bạn duyệt)', hint: '[việc cần lập kế hoạch]' },
  { name: 'cost', desc: 'Token và chi phí ước tính của cuộc này' },
  { name: 'context', desc: 'Ngữ cảnh đã dùng so với giới hạn' },
  { name: 'status', desc: 'Model, effort, chế độ, phiên hiện tại' },
  { name: 'rename', desc: 'Đổi tên cuộc trò chuyện', hint: '[tên]' },
  { name: 'pin', desc: 'Ghim / bỏ ghim cuộc trò chuyện' },
  { name: 'export', desc: 'Lưu cuộc trò chuyện ra tệp markdown', ui: true },
  { name: 'memory', desc: 'Sửa CLAUDE.md và memory', ui: true },
  { name: 'mcp', desc: 'Quản lý MCP server', ui: true },
  { name: 'help', desc: 'Liệt kê các lệnh' },
];

const read = (f) => {
  try {
    const st = fs.statSync(f);
    if (!st.isFile() || st.size > MAX_CMD_MD) return null;
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const subdirs = (d) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
};

// Bỏ frontmatter YAML đầu file.
export const stripFrontmatter = (t) => String(t).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

// Gom skill + lệnh tự định nghĩa; tên trùng lệnh có sẵn thì bỏ. claudeHome = thư mục ~/.claude.
export function scanCommands(claudeHome = path.join(os.homedir(), '.claude')) {
  const out = [];
  const seen = new Set(BUILTIN.map((b) => b.name));
  for (const name of subdirs(path.join(claudeHome, 'skills')).sort()) {
    const md = read(path.join(claudeHome, 'skills', name, 'SKILL.md'));
    if (md == null || !NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, desc: parseSkillMd(md).description.slice(0, 160), kind: 'skill' });
  }
  let files = [];
  try {
    files = fs.readdirSync(path.join(claudeHome, 'commands')).filter((f) => f.endsWith('.md')).sort();
  } catch {
    /* chưa có thư mục lệnh */
  }
  for (const f of files) {
    const name = f.slice(0, -3);
    const md = read(path.join(claudeHome, 'commands', f));
    if (md == null || !NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const m = /^description:\s*(.*)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] || '');
    out.push({ name, desc: (m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '').slice(0, 160), kind: 'command' });
  }
  return out;
}

export const listCommands = (claudeHome) => [...BUILTIN.map((b) => ({ ...b, kind: 'builtin' })), ...scanCommands(claudeHome)];

// "/tên đối số" → {name, args}; không phải dạng lệnh → null.
export function parseSlash(text) {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { name: m[1], args: (m[2] || '').trim() } : null;
}

// Skill/lệnh tự định nghĩa → lời nhắc đầy đủ; không có (hoặc là lệnh có sẵn) → null.
export function expandCommand(text, claudeHome = path.join(os.homedir(), '.claude')) {
  const p = parseSlash(text);
  if (!p || !NAME_RE.test(p.name) || BUILTIN.some((b) => b.name === p.name)) return null;
  const skill = read(path.join(claudeHome, 'skills', p.name, 'SKILL.md'));
  if (skill != null) {
    const body = stripFrontmatter(skill);
    return `Hãy làm theo skill "${p.name}" dưới đây, áp dụng cho yêu cầu của người dùng.\n\n<skill name="${p.name}">\n${body}\n</skill>\n\n${p.args ? `Yêu cầu: ${p.args}` : 'Người dùng không kèm yêu cầu cụ thể — hãy hỏi lại nếu cần.'}`;
  }
  const cmd = read(path.join(claudeHome, 'commands', `${p.name}.md`));
  if (cmd != null) {
    const body = stripFrontmatter(cmd);
    return body.includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(p.args) : p.args ? `${body}\n\n${p.args}` : body;
  }
  return null;
}
