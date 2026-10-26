// Test server/checks.js: lệnh shell exit 0/1, quoting, studio-check outputs (mới/cũ/rỗng/thiếu), chưa hỗ trợ → null (§8.5, §13).
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkLogName,
  checkOutputs,
  childEnv,
  isOutsidePattern,
  runChecks,
  runShell,
  tail,
  UNSUPPORTED_MSG,
  writeCheckLog,
} from '../server/checks.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-checks-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel, content = 'x') => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};
const ageFile = (rel, secondsAgo) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(path.join(dir, rel), t, t);
};
const stepWith = (checks, outputs = []) => ({ key: 's', name: 'S', outputs, checks });

test('lệnh shell exit 0 → ĐẠT, exit 1 → TRƯỢT, output được giữ', async () => {
  write('project.json', '{"scenes":[]}');
  const res = await runChecks({
    dir,
    step: stepWith([
      { name: 'co_file', run: 'test -s project.json && echo co' },
      { name: 'khong_file', run: 'echo thieu >&2; test -s khong-co.json' },
    ]),
    run: { started_at: new Date().toISOString() },
  });
  assert.equal(res.length, 2);
  assert.equal(res[0].passed, true);
  assert.equal(res[0].output.trim(), 'co');
  assert.equal(res[0].cmd, 'test -s project.json && echo co');
  assert.equal(res[1].passed, false);
  assert.match(res[1].output, /thieu/);
  assert.ok(res[1].duration_ms >= 0);
});

test('quoting: vars/skill có dấu cách và nháy đơn được bọc an toàn', async () => {
  const skill = path.join(dir, "skill có 'nháy' & cách");
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill');
  const preset = { id: 'p', name: 'P', skills: [skill], vars: { ten: "it's a \"test\"; rm -rf /" } };
  const step = stepWith([
    { name: 'vars', run: "printf '%s' {vars.ten} > ten.txt" },
    { name: 'skill', run: 'test -f {skill}/SKILL.md' },
    { name: 'slug', run: 'printf "%s" {slug} > slug.txt' },
  ]);
  const res = await runChecks({ dir, step, preset, project: { id: 'du-an-1', title: 'T' }, run: { started_at: new Date().toISOString() } });
  assert.deepEqual(res.map((r) => r.passed), [true, true, true]);
  assert.equal(fs.readFileSync(path.join(dir, 'ten.txt'), 'utf8'), "it's a \"test\"; rm -rf /");
  assert.equal(fs.readFileSync(path.join(dir, 'slug.txt'), 'utf8'), 'du-an-1');
  assert.ok(res[1].cmd.includes("'\\''"), 'nháy đơn trong đường dẫn được escape kiểu POSIX');
});

test('studio-check outputs: file mới → ĐẠT', async () => {
  const since = new Date().toISOString();
  write('exports/caption.md', 'caption');
  write('audio/a.wav', 'RIFF');
  const r = await checkOutputs({ dir, outputs: ['exports/caption.md', 'audio/*.wav'], since });
  assert.equal(r.passed, true, r.output);
  assert.match(r.output, /✓ exports\/caption\.md \(1 file\)/);
  assert.match(r.output, /✓ audio\/\*\.wav \(1 file\)/);
});

test('studio-check outputs: file cũ hơn lượt chạy → TRƯỢT', async () => {
  write('exports/caption.md', 'caption');
  ageFile('exports/caption.md', 3600);
  const r = await checkOutputs({ dir, outputs: ['exports/caption.md'], since: new Date().toISOString() });
  assert.equal(r.passed, false);
  assert.match(r.output, /1 file cũ hơn lượt chạy/);
});

test('studio-check outputs: file trong 2 s trước started_at vẫn tính là mới', async () => {
  write('a.md', 'a');
  ageFile('a.md', 1);
  const r = await checkOutputs({ dir, outputs: ['a.md'], since: new Date().toISOString() });
  assert.equal(r.passed, true, r.output);
});

test('studio-check outputs: file rỗng → TRƯỢT', async () => {
  write('exports/caption.md', '');
  const r = await checkOutputs({ dir, outputs: ['exports/caption.md'], since: new Date(Date.now() - 1000).toISOString() });
  assert.equal(r.passed, false);
  assert.match(r.output, /1 file rỗng/);
});

test('studio-check outputs: thiếu file → TRƯỢT; một mẫu thiếu là đủ trượt', async () => {
  write('script.md', 'ok');
  const r = await checkOutputs({ dir, outputs: ['script.md', 'audio/*.wav'], since: new Date(Date.now() - 1000).toISOString() });
  assert.equal(r.passed, false);
  assert.match(r.output, /✓ script\.md/);
  assert.match(r.output, /✗ audio\/\*\.wav: không có file mới \(không tìm thấy file nào\)/);
});

test('studio-check outputs: bỏ qua .studio/** và file ẩn; mẫu ngoài dự án → TRƯỢT', async () => {
  write('.studio/runs/x/out.md', 'x');
  write('.hidden.md', 'x');
  const r = await checkOutputs({ dir, outputs: ['**/*.md'], since: null });
  assert.equal(r.passed, false);
  const out = await checkOutputs({ dir, outputs: ['~/Documents/x/**', '/tmp/x', '../x'], since: null });
  assert.equal(out.passed, false);
  assert.equal(out.output.split('\n').filter((l) => l.includes('nằm ngoài thư mục dự án')).length, 3);
  const none = await checkOutputs({ dir, outputs: [], since: null });
  assert.equal(none.passed, true);
});

test('runChecks: `studio-check outputs` dùng outputs của bước (đã render vars)', async () => {
  const run = { started_at: new Date().toISOString() };
  write('exports/du-an.md', 'ok');
  const step = stepWith([{ name: 'outputs', run: 'studio-check outputs' }], ['exports/{slug}.md']);
  const res = await runChecks({ dir, step, project: { id: 'du-an' }, run });
  assert.equal(res[0].passed, true, res[0].output);
  assert.equal(res[0].cmd, 'studio-check outputs');
});

test('check studio-check chưa hỗ trợ → passed null + thông báo', async () => {
  const step = stepWith([
    { name: 'loudness', run: 'studio-check loudness exports/final.mp4' },
    { name: 'cmp', run: 'studio-check deliver-cmp' },
  ]);
  const res = await runChecks({ dir, step, run: { started_at: new Date().toISOString() } });
  assert.deepEqual(res.map((r) => r.passed), [null, null]);
  assert.equal(res[0].output, UNSUPPORTED_MSG);
});

test('timeout: lệnh chạy quá lâu bị dừng → TRƯỢT kèm ghi chú hết giờ', async () => {
  const t0 = Date.now();
  const res = await runChecks({ dir, step: stepWith([{ name: 'lau', run: 'sleep 30' }]), run: {}, timeoutMs: 300 });
  assert.equal(res[0].passed, false);
  assert.match(res[0].output, /Hết thời gian kiểm tra \(0,3 giây\)/);
  assert.ok(Date.now() - t0 < 10_000, 'không đợi hết sleep 30');
});

test('abort: dừng giữa chừng → check đang chạy và các check sau = null', async () => {
  const ac = new AbortController();
  const seen = [];
  const p = runChecks({
    dir,
    step: stepWith([
      { name: 'dang_chay', run: 'sleep 30' },
      { name: 'sau', run: 'true' },
    ]),
    run: {},
    signal: ac.signal,
    onResult: (r, i) => seen.push([i, r.name, r.passed]),
  });
  setTimeout(() => ac.abort(), 200);
  const res = await p;
  assert.deepEqual(res.map((r) => r.passed), [null, null]);
  assert.match(res[0].output, /Dừng theo yêu cầu/);
  assert.match(res[1].output, /Bỏ qua/);
  assert.deepEqual(seen, [[0, 'dang_chay', null], [1, 'sau', null]]);
});

test('runShell: env không có biến VS_*; output dài chỉ giữ phần đuôi', async () => {
  process.env.VS_TOKEN = 'bi-mat-khong-duoc-lo';
  try {
    const r = await runShell('env', { cwd: dir });
    assert.equal(r.code, 0);
    assert.ok(!r.output.includes('VS_TOKEN'));
    assert.ok(!r.output.includes('bi-mat-khong-duoc-lo'));
    assert.ok(!Object.keys(childEnv()).some((k) => k.startsWith('VS_')));
  } finally {
    delete process.env.VS_TOKEN;
  }
  const long = await runShell("yes 'abcdefghij' | head -n 5000", { cwd: dir, maxOutput: 1000 });
  assert.ok(long.output.length <= 1000);
  assert.ok(long.output.startsWith('…'));
  assert.equal(tail('abc', 10), 'abc');
});

test('isOutsidePattern', () => {
  assert.equal(isOutsidePattern('exports/*.mp4'), false);
  assert.equal(isOutsidePattern('/abs/x'), true);
  assert.equal(isOutsidePattern('~/Documents/x'), true);
  assert.equal(isOutsidePattern('a/../../x'), true);
  assert.equal(isOutsidePattern(''), true);
});

test('writeCheckLog: ghi <runDir>/checks/<i>-<slug>.log có lệnh, output, kết luận', () => {
  const runDir = path.join(dir, '.studio', 'runs', 'bible', '1');
  const f = writeCheckLog(runDir, 1, { name: 'project_json', cmd: 'test -s project.json', passed: false, output: 'lỗi gì đó', duration_ms: 12 });
  assert.equal(f, path.join(runDir, 'checks', checkLogName(1, 'project_json')));
  assert.equal(path.basename(f), '1-project-json.log');
  const s = fs.readFileSync(f, 'utf8');
  assert.match(s, /^# project_json\n\$ test -s project\.json\n/);
  assert.match(s, /lỗi gì đó/);
  assert.match(s, /→ TRƯỢT \(12 ms\)/);
  const f2 = writeCheckLog(runDir, 2, { name: '../../thoát ra', cmd: 'x', passed: null, output: '', duration_ms: 0 });
  assert.ok(f2.startsWith(path.join(runDir, 'checks') + path.sep));
  assert.match(fs.readFileSync(f2, 'utf8'), /→ BỎ QUA/);
});
