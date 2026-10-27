import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandCommand, listCommands, parseSlash } from '../server/assistant-cmds.js';
import { createClaudeFiles } from '../server/claude-files.js';
import { buildAssistantArgs, describePermission } from '../server/assistant.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cmds-'));

test('parseSlash + listCommands + expandCommand: skill, lệnh tự định nghĩa, tên trùng lệnh có sẵn bị bỏ', () => {
  const ch = tmp();
  fs.mkdirSync(path.join(ch, 'skills', 'task'), { recursive: true });
  fs.writeFileSync(path.join(ch, 'skills', 'task', 'SKILL.md'), '---\nname: task\ndescription: Làm task\n---\nBước 1');
  fs.mkdirSync(path.join(ch, 'skills', 'compact'), { recursive: true });
  fs.writeFileSync(path.join(ch, 'skills', 'compact', 'SKILL.md'), '---\nname: compact\n---\nx');
  fs.mkdirSync(path.join(ch, 'commands'));
  fs.writeFileSync(path.join(ch, 'commands', 'fix.md'), '---\ndescription: Sửa lỗi\n---\nSửa: $ARGUMENTS');
  assert.deepEqual(parseSlash('/task làm gì đó'), { name: 'task', args: 'làm gì đó' });
  assert.equal(parseSlash('xin chào'), null);
  const l = listCommands(ch);
  assert.ok(l.find((c) => c.name === 'task' && c.kind === 'skill' && c.desc === 'Làm task'));
  assert.ok(l.find((c) => c.name === 'fix' && c.kind === 'command' && c.desc === 'Sửa lỗi'));
  assert.equal(l.filter((c) => c.name === 'compact').length, 1);
  assert.match(expandCommand('/task abc', ch), /Bước 1[\s\S]*Yêu cầu: abc/);
  assert.equal(expandCommand('/fix lỗi A', ch), 'Sửa: lỗi A');
  assert.equal(expandCommand('/compact', ch), null);
  assert.equal(expandCommand('/../etc', ch), null);
});

test('buildAssistantArgs theo chế độ: page không tool; plan chỉ đọc; ask/edit có hỏi quyền và chặn thư mục bí mật', () => {
  const a = (mode) => buildAssistantArgs({ sessionId: 's', mcpConfig: 'c.json', mode, protect: ['/h/.video-studio'] });
  const v = (args, k) => args[args.indexOf(k) + 1];
  assert.equal(v(a('page'), '--tools'), '');
  assert.ok(!a('page').includes('--permission-mode'));
  assert.ok(!/Edit|Bash/.test(v(a('plan'), '--tools')));
  assert.match(v(a('plan'), '--append-system-prompt'), /kế hoạch/i);
  assert.equal(v(a('ask'), '--permission-mode'), 'default');
  assert.equal(v(a('edit'), '--permission-mode'), 'acceptEdits');
  assert.equal(v(a('ask'), '--permission-prompt-tool'), 'mcp__studio__approve');
  assert.match(v(a('ask'), '--tools'), /Bash/);
  assert.match(v(a('ask'), '--disallowedTools'), /Read\(\/\/h\/\.video-studio\/\*\*\)/);
  assert.equal(describePermission('Bash', { command: 'ls   -la' }), 'ls -la');
});

test('claude-files: chỉ id trong danh sách trắng; ghi CLAUDE.md; memory phải có sẵn; MCP ẩn env/headers', async () => {
  const ch = tmp();
  const cj = path.join(ch, 'claude.json');
  fs.mkdirSync(path.join(ch, 'projects', 'p1', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ch, 'projects', 'p1', 'memory', 'a.md'), 'A');
  fs.writeFileSync(cj, JSON.stringify({ mcpServers: { s1: { command: 'node', args: ['x.js'], env: { KEY: 'bimat' } }, h1: { type: 'http', url: 'https://u:pw@h.io/mcp?k=1', headers: { Authorization: 'bimat' } } } }));
  const f = createClaudeFiles({ claudeHome: ch, claudeJson: cj, claudeBin: '/khong/co' });
  assert.deepEqual(f.list().map((x) => x.id), ['claude-md', 'mem:p1/a.md']);
  assert.throws(() => f.read('../../etc/passwd'), { status: 400 });
  assert.throws(() => f.read('mem:p1/../../x.md'), { status: 400 });
  f.write('claude-md', 'xin chào');
  assert.equal(f.read('claude-md').text, 'xin chào');
  assert.throws(() => f.write('mem:p1/moi.md', 'x'), { status: 404 });
  f.write('mem:p1/a.md', 'B');
  assert.equal(f.read('mem:p1/a.md').text, 'B');
  assert.throws(() => f.write('claude-md', 'x'.repeat(300 * 1024)), { status: 413 });
  const m = f.mcpList();
  assert.equal(JSON.stringify(m).includes('bimat'), false);
  assert.equal(JSON.stringify(m).includes('pw'), false);
  assert.equal(m.find((x) => x.name === 's1').env, 1);
  await assert.rejects(f.mcpAdd({ name: 'x y', target: 'a' }), { status: 400 });
  await assert.rejects(f.mcpAdd({ name: 'x', type: 'http', target: 'ftp://a' }), { status: 400 });
  await assert.rejects(f.mcpRemove('..'), { status: 400 });
});
