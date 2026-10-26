// Test server/stream.js: chuẩn hóa dòng stream-json thật, lọc init, dòng hỏng, splitter UTF-8 (hợp đồng M1 §7, §13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLineSplitter,
  filterInit,
  isApiKeySource,
  isHookLine,
  logLineFor,
  normalizeLine,
  parseJsonLines,
  truncate,
  TEXT_MAX,
} from '../server/stream.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name) => parseJsonLines(fs.readFileSync(path.join(FIX, name), 'utf8'));
const eventsOf = (lines, ctx = { apiKeySource: 'none' }) => lines.flatMap((l) => normalizeLine(l, ctx));

const SENSITIVE_KEYS = ['email', 'emailAddress', 'orgId', 'org_id', 'orgName', 'organization', 'organizationId', 'account', 'tools', 'mcp_servers', 'plugins', 'memory_paths', 'slash_commands'];

function collectKeys(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) collectKeys(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      collectKeys(x, out);
    }
  }
  return out;
}

test('fixture thật (done) → đúng chuỗi kind', () => {
  const evs = eventsOf(readFixture('real-stream-done.jsonl'));
  assert.deepEqual(evs.map((e) => e.kind), ['init', 'tool', 'tool_result', 'text', 'structured', 'tool_result', 'result']);
  const result = evs.at(-1);
  assert.match(result.text, /^Hoàn tất sau [\d.]+s · \d+ lượt · in \d+ \/ out \d+ token$/);
  assert.ok(!result.text.includes('$'), 'không hiện $ khi dùng gói (apiKeySource none)');
  const structured = evs.find((e) => e.kind === 'structured');
  assert.equal(structured.payload.input.status, 'done');
});

test('fixture thật (denied) → đúng chuỗi kind, có sự kiện denied', () => {
  const evs = eventsOf(readFixture('real-stream-denied.jsonl'));
  assert.deepEqual(evs.map((e) => e.kind), ['init', 'tool', 'denied', 'tool_result', 'text', 'result']);
  const denied = evs.find((e) => e.kind === 'denied');
  assert.equal(denied.payload.tool_name, 'Bash');
  assert.ok(denied.payload.tool_use_id);
});

test('payload không còn email/orgId/tools… (kể cả khi init có thêm field nhạy cảm)', () => {
  const lines = [...readFixture('real-stream-done.jsonl'), ...readFixture('real-stream-denied.jsonl')];
  const init = lines.find((l) => l && l.type === 'system' && l.subtype === 'init');
  const poisoned = { ...init, email: 'nguoi.dung@example.com', orgId: 'org-123', orgName: 'Công ty X', account: { email: 'a@b.c' } };
  const evs = eventsOf([...lines, poisoned]);
  for (const ev of evs) {
    const keys = collectKeys(ev.payload);
    for (const k of SENSITIVE_KEYS) assert.ok(!keys.has(k), `payload của ${ev.kind} không được có "${k}"`);
    const s = JSON.stringify(ev);
    assert.ok(!s.includes('nguoi.dung@example.com') && !s.includes('org-123') && !s.includes('Công ty X'));
  }
  const initEv = evs.find((e) => e.kind === 'init');
  assert.equal(typeof initEv.payload.session_id, 'string');
  assert.equal(initEv.payload.apiKeySource, 'none');
});

test('dòng hỏng / không phải JSON → raw; dòng trống → bỏ', () => {
  const half = '{"type":"assistant","message":{"content":[{"type":"text","te';
  const evs = normalizeLine(half);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'raw');
  assert.ok(evs[0].text.startsWith('{"type":"assistant"'));
  assert.deepEqual(normalizeLine('   '), []);
  assert.equal(normalizeLine('Lỗi gì đó từ CLI')[0].kind, 'raw');
  assert.equal(normalizeLine(42)[0].kind, 'raw');
  // parseJsonLines giữ chuỗi gốc cho dòng không phải JSON
  const parsed = parseJsonLines('{"a":1}\nkhông phải json\n\n');
  assert.deepEqual(parsed, [{ a: 1 }, 'không phải json']);
});

test('hook_* và system khác bị bỏ; rate_limit allowed bị bỏ', () => {
  assert.deepEqual(normalizeLine({ type: 'system', subtype: 'hook_started', hook_name: 'x' }), []);
  assert.deepEqual(normalizeLine({ type: 'system', subtype: 'hook_response', output: 'bí mật' }), []);
  assert.deepEqual(normalizeLine({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), []);
  const rl = normalizeLine({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1761400000 } });
  assert.equal(rl[0].kind, 'rate_limit');
});

test('text event bị cắt ≤ 500 ký tự; thinking rỗng bị bỏ', () => {
  const long = 'á'.repeat(2000);
  const evs = normalizeLine({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: long }] } });
  assert.deepEqual(evs.map((e) => e.kind), ['text']);
  assert.ok(evs[0].text.length <= TEXT_MAX);
  assert.ok(truncate('abc', 10) === 'abc');
});

test('result: có API key → hiện $; lỗi → "Kết thúc lỗi"', () => {
  const r = { type: 'result', subtype: 'success', is_error: false, duration_ms: 2500, num_turns: 2, total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 } };
  assert.match(normalizeLine(r, { apiKeySource: 'ANTHROPIC_API_KEY' })[0].text, /\$0\.0123/);
  assert.ok(!normalizeLine(r, { apiKeySource: 'none' })[0].text.includes('$'));
  const err = normalizeLine({ ...r, is_error: true, subtype: 'error_during_execution' }, { apiKeySource: 'none' })[0];
  assert.match(err.text, /^Kết thúc lỗi \(error_during_execution\)/);
  assert.equal(isApiKeySource('none'), false);
  assert.equal(isApiKeySource(null), false);
  assert.equal(isApiKeySource('ANTHROPIC_API_KEY'), true);
});

test('synthetic [structured-output-enforce] không thành event', () => {
  const evs = normalizeLine({ type: 'user', isSynthetic: true, message: { content: [{ type: 'text', text: '[structured-output-enforce] hãy gọi StructuredOutput' }] } });
  assert.deepEqual(evs, []);
});

test('logLineFor: bỏ hook, init chỉ còn field whitelist, dòng khác giữ nguyên', () => {
  assert.equal(logLineFor({ type: 'system', subtype: 'hook_started' }), null);
  assert.equal(isHookLine({ type: 'system', subtype: 'hook_response' }), true);
  assert.equal(isHookLine({ type: 'system', subtype: 'init' }), false);
  const init = readFixture('real-stream-done.jsonl')[0];
  const filtered = logLineFor({ ...init, email: 'x@y.z', orgId: 'o1' });
  assert.equal(filtered.type, 'system');
  assert.equal(filtered.subtype, 'init');
  assert.equal(filtered.session_id, init.session_id);
  for (const k of ['tools', 'mcp_servers', 'plugins', 'memory_paths', 'slash_commands', 'email', 'orgId']) assert.ok(!(k in filtered), k);
  assert.deepEqual(filterInit(init), filtered);
  const other = { type: 'assistant', message: { content: [] } };
  assert.equal(logLineFor(other), other);
});

test('splitter: ký tự UTF-8 nhiều byte bị cắt giữa 2 mẩu vẫn đúng; CRLF; phần dư khi end()', () => {
  const lines = [];
  const sp = createLineSplitter((l) => lines.push(l));
  const buf = Buffer.from('{"text":"Đang làm… ổn"}\r\nthứ hai\nphần dư', 'utf8');
  // cắt từng byte một để chắc chắn cắt giữa ký tự nhiều byte
  for (let i = 0; i < buf.length; i++) sp.push(buf.subarray(i, i + 1));
  assert.deepEqual(lines, ['{"text":"Đang làm… ổn"}', 'thứ hai']);
  sp.end();
  assert.deepEqual(lines, ['{"text":"Đang làm… ổn"}', 'thứ hai', 'phần dư']);
  assert.deepEqual(JSON.parse(lines[0]), { text: 'Đang làm… ổn' });
  sp.push(Buffer.from('sau end\n'));
  assert.equal(lines.length, 3, 'push sau end() bị bỏ qua');
});

test('splitter: cắt ngay giữa ký tự 3 byte (…) ở ranh giới 2 mẩu', () => {
  const lines = [];
  const sp = createLineSplitter((l) => lines.push(l));
  const b = Buffer.from('a…b\n', 'utf8'); // … = e2 80 a6
  sp.push(b.subarray(0, 2));
  sp.push(b.subarray(2, 3));
  sp.push(b.subarray(3));
  assert.deepEqual(lines, ['a…b']);
});
