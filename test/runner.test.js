// Test server/runner.js với fake-claude (hợp đồng M1 §8, §12, §13) — store thật trong thư mục tạm, không gọi claude thật.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/db.js';
import { loadChannels, loadPresets, REPO_ROOT } from '../server/presets.js';
import { createProjects, HttpError } from '../server/projects.js';
import {
  artifactKind,
  buildArgs,
  buildPrompt,
  collectArtifacts,
  createRunner,
  NETWORK_ERROR,
  STEP_RESULT_SCHEMA,
  STUDIO_PROTOCOL,
} from '../server/runner.js';

const FAKE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const FIXTURE_PRESETS = path.join(REPO_ROOT, 'test', 'fixtures', 'presets');
const REPO_PRESETS = path.join(REPO_ROOT, 'presets');

let tmp;
let home;
let extraDir;
let store;
let projects;
let runner;
let skillDir;
let missingSkill;
const runners = [];

const extraPresets = () => `
id: t-timeout
name: Hết giờ (test)
channel: tiktok
project_dir: work/{slug}
steps:
  - id: one
    name: Một
    prompt: "Làm {title}"
    outputs: [one.md]
    timeout: 600ms
---SPLIT---
id: t-checkfail
name: Check trượt (test)
channel: tiktok
project_dir: work/{slug}
steps:
  - id: one
    name: Một
    prompt: "Làm {title}"
    outputs: [one.md]
    checks:
      - name: thieu file
        run: test -f khong-co.txt
      - name: chua ho tro
        run: studio-check loudness one.md
  - id: two
    name: Hai
    prompt: "Làm tiếp"
    outputs: [two.md]
---SPLIT---
id: t-skills
name: Skill (test)
channel: tiktok
project_dir: work/{slug}
skills:
  - ${JSON.stringify(skillDir)}
  - ${JSON.stringify(missingSkill)}
steps:
  - id: one
    name: Một
    prompt: "Đọc {skill}/SKILL.md rồi làm {title}"
    outputs: ["images/*.png", "notes.txt"]
`;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-runner-')));
  home = path.join(tmp, 'home');
  extraDir = path.join(tmp, 'extra-presets');
  skillDir = path.join(tmp, "skills/kỹ năng có cách");
  missingSkill = path.join(tmp, 'skills/khong-ton-tai');
  fs.mkdirSync(home);
  fs.mkdirSync(extraDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill giả\n');
  extraPresets()
    .split('---SPLIT---')
    .forEach((y, i) => fs.writeFileSync(path.join(extraDir, `extra-${i}.yaml`), y.trim() + '\n'));
  store = openStore(path.join(home, 'studio.db'));
  const presets = () => loadPresets([FIXTURE_PRESETS, extraDir]);
  projects = createProjects({ store, presets, channels: () => loadChannels([REPO_PRESETS]), home });
  runner = mkRunner();
});

afterEach(async () => {
  for (const r of runners.splice(0)) await r.shutdown();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkRunner(over = {}) {
  const r = createRunner({
    store,
    projects,
    presets: () => loadPresets([FIXTURE_PRESETS, extraDir]),
    claudeBin: FAKE,
    home,
    lockHost: os.hostname(),
    killGraceMs: 2000,
    ...over,
  });
  runners.push(r);
  return r;
}

// ---- helpers
const mk = (presetId = 'e2e-short', slug = 'du-an') => {
  projects.create({ presetId, title: 'Đà Lạt — mùa mưa!', slug });
  return store.getProject(slug);
};
const states = (id) => Object.fromEntries(store.listSteps(id).map((s) => [s.key, s.state]));
const scenario = (p, name) => fs.writeFileSync(path.join(p.dir, '.fake-scenario'), name + '\n');
const calls = (p) =>
  fs
    .readFileSync(path.join(p.dir, '.fake-calls.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const lastCall = (p) => calls(p).at(-1);
const runDirOf = (p, key, n) => path.join(p.dir, '.studio', 'runs', key, String(n));
const kinds = (runId) => store.listEvents(runId).map((e) => e.kind);
const texts = (runId) => store.listEvents(runId).map((e) => e.text);

// Giá trị theo sau một cờ (tới cờ "--" kế tiếp).
function flagValues(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

async function runToEnd(p, key, opts = {}, scen = 'done', r = runner) {
  scenario(p, scen);
  const run = r.start(p.id, key, opts);
  assert.equal(run.state, 'running');
  assert.equal(r.isRunning(run.id), true);
  const report = await r.wait(run.id);
  assert.ok(report, 'wait() trả báo cáo');
  assert.equal(r.isRunning(run.id), false);
  return store.getRun(run.id);
}

async function waitForEvent(runId, pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ev = store.listEvents(runId).find(pred);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Hết giờ chờ sự kiện');
}

const isDead = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
};

function expectHttp(fn, status, code) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HttpError, `phải throw HttpError, nhận: ${err}`);
  assert.equal(err.status, status, err.message);
  assert.equal(err.code, code);
  assert.ok(err.message.length > 0);
  return err;
}

// ======================= unit: buildArgs / buildPrompt =======================

test('buildArgs: đúng thứ tự §8.1, session-id → resume, allow/deny theo allowPaid, không có prompt', () => {
  const preset = {
    id: 'p',
    name: 'P',
    skills: [],
    permissions: { allow: ['Edit', 'Write'], ask: ['Bash(*elevenlabs*)'], deny: ['Bash(sudo *)'] },
  };
  const step = { key: 'voice', cost: { service: 'elevenlabs', always_ask: true } };
  const fresh = { claude_session_id: 'sid-1', session_started: 0 };
  const a = buildArgs({ project: fresh, preset, step, allowPaid: false });
  assert.deepEqual(a, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--session-id', 'sid-1',
    '--append-system-prompt', STUDIO_PROTOCOL,
    '--json-schema', JSON.stringify(STEP_RESULT_SCHEMA),
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--allowedTools', 'Edit', 'Write',
    '--disallowedTools', 'Bash(sudo *)', 'Bash(*elevenlabs*)',
  ]);
  const resumed = buildArgs({ project: { ...fresh, session_started: 1 }, preset, step, allowPaid: true, model: 'opus' });
  assert.deepEqual(resumed.slice(4, 6), ['--resume', 'sid-1']);
  assert.ok(!resumed.includes('--session-id'));
  assert.deepEqual(flagValues(resumed, '--allowedTools'), ['Edit', 'Write', 'Bash(*elevenlabs*)']);
  assert.deepEqual(flagValues(resumed, '--disallowedTools'), ['Bash(sudo *)']);
  assert.deepEqual(resumed.slice(-2), ['--model', 'opus']);
  // allowPaid nhưng bước không có cost → ask vẫn bị chặn
  const noCost = buildArgs({ project: fresh, preset, step: { key: 'x', cost: null }, allowPaid: true });
  assert.deepEqual(flagValues(noCost, '--disallowedTools'), ['Bash(sudo *)', 'Bash(*elevenlabs*)']);
  // quyền cho phép lần này → nối thêm vào allow, không đụng deny
  const once = buildArgs({ project: fresh, preset, step, allowPaid: false, allowOnce: ['Bash(mkdir *)', 'Edit'] });
  assert.deepEqual(flagValues(once, '--allowedTools'), ['Edit', 'Write', 'Bash(mkdir *)']);
  assert.deepEqual(flagValues(once, '--disallowedTools'), ['Bash(sudo *)', 'Bash(*elevenlabs*)']);
  // quyền rỗng → bỏ hẳn cờ
  const empty = buildArgs({ project: fresh, preset: { id: 'e', permissions: { allow: [], ask: [], deny: [] } }, step: { key: 'x' } });
  assert.ok(!empty.includes('--allowedTools'));
  assert.ok(!empty.includes('--disallowedTools'));
  assert.ok(!empty.includes('--add-dir'));
  assert.ok(!empty.includes('--model'));
  assert.equal(empty.at(-1), 'none');
});

test('buildArgs/buildPrompt: --add-dir và dòng Skill chỉ cho skill có thật', () => {
  const preset = { id: 'p', name: 'P', skills: [skillDir, missingSkill], permissions: {}, steps: [{ key: 'one' }] };
  const step = { key: 'one', name: 'Một', ord: 0, prompt: 'Đọc {skill}/SKILL.md', outputs: ['a.md'] };
  const a = buildArgs({ project: { claude_session_id: 's', session_started: 0 }, preset, step });
  assert.deepEqual(flagValues(a, '--add-dir'), [skillDir]);
  const prompt = buildPrompt({ project: { id: 'x', title: 'T', dir: '/d' }, preset, step });
  assert.ok(prompt.includes(`Skill: đọc ${skillDir}/SKILL.md trước khi làm.`));
  assert.ok(!prompt.includes(`Skill: đọc ${missingSkill}`));
});

test('buildArgs/buildPrompt: skill của kênh khác bị loại, skill chung và của kênh mình được nạp', () => {
  const chA = path.join(tmp, 'skills/kenh-a');
  const chB = path.join(tmp, 'skills/kenh-b');
  for (const [d, ch] of [[chA, 'a'], [chB, 'b']]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.studio.json'), JSON.stringify({ channel: ch }));
  }
  const preset = { id: 'p', name: 'P', skills: [skillDir, chA, chB], permissions: {}, steps: [{ key: 'one' }] };
  const step = { key: 'one', name: 'Một', ord: 0, prompt: 'Đọc {skill}/SKILL.md', outputs: ['a.md'] };
  const base = { claude_session_id: 's', session_started: 0 };
  assert.deepEqual(flagValues(buildArgs({ project: { ...base, channel_id: 'a' }, preset, step }), '--add-dir'), [skillDir, chA]);
  assert.deepEqual(flagValues(buildArgs({ project: { ...base, channel_id: null }, preset, step }), '--add-dir'), [skillDir]);
  const prompt = buildPrompt({ project: { id: 'x', title: 'T', dir: '/d', channel_id: 'b' }, preset, step });
  assert.ok(prompt.includes(`Skill: đọc ${chB}/SKILL.md`));
  assert.ok(!prompt.includes(`${chA}/SKILL.md`));
  // Định dạng mới: nhiều kênh.
  const chAB = path.join(tmp, 'skills/kenh-ab');
  fs.mkdirSync(chAB, { recursive: true });
  fs.writeFileSync(path.join(chAB, '.studio.json'), JSON.stringify({ channels: ['a', 'b'] }));
  const preset2 = { ...preset, skills: [chAB] };
  for (const [ch, want] of [['a', [chAB]], ['b', [chAB]], ['c', []], [null, []]]) {
    assert.deepEqual(flagValues(buildArgs({ project: { ...base, channel_id: ch }, preset: preset2, step }), '--add-dir'), want.length ? want : null);
  }
});

test('buildPrompt: tiêu đề, đầu ra, góp ý (nội tuyến hoặc mục riêng), bước trước, ĐÃ DUYỆT CHI PHÍ', () => {
  const preset = {
    id: 'e2e-short',
    name: 'E2E',
    skills: [],
    vars: { duration: 30 },
    steps: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
  };
  const project = { id: 'du-an', title: 'Đà Lạt', dir: '/tmp/du-an' };
  const step = { key: 'b', name: 'Bước B', ord: 1, prompt: 'Viết ~{vars.duration}s cho "{title}" ({slug}). {feedback}', outputs: ['audio/{slug}.wav'], cost: { service: 'elevenlabs' } };
  const prev = { name: 'Bước A', summary: 'Đã viết kịch bản.', notes_for_next_step: 'Giọng trầm.' };
  const p = buildPrompt({ project, preset, step, feedback: 'Ngắn hơn', prev, allowPaid: true });
  const lines = p.split('\n');
  assert.equal(lines[0], '# Bước 2/3: Bước B (id: b)');
  assert.equal(lines[1], 'Dự án: Đà Lạt — slug: du-an');
  assert.equal(lines[2], 'Thư mục dự án (cwd): /tmp/du-an');
  assert.equal(lines[3], 'Quy trình: E2E (e2e-short)');
  assert.equal(lines[4], 'Đầu ra bắt buộc: ["audio/du-an.wav"]');
  assert.equal(lines[5], '');
  assert.equal(lines[6], '## Việc cần làm');
  assert.ok(lines[7].startsWith('Viết ~30s cho "Đà Lạt" (du-an).'));
  assert.ok(p.includes('Góp ý của người dùng cho lượt này:\nNgắn hơn'));
  assert.ok(!p.includes('## Góp ý của người dùng cho lượt này'), 'template có {feedback} → không thêm mục riêng');
  assert.ok(p.includes('## Kết quả bước trước (Bước A)\nĐã viết kịch bản.\nGhi chú cho bước sau: Giọng trầm.'));
  assert.ok(p.includes('ĐÃ DUYỆT CHI PHÍ: người dùng đã đồng ý chi phí dịch vụ elevenlabs cho lượt này.'));
  // template không có {feedback} → mục riêng; không allowPaid → không có dòng duyệt chi phí; không prev → không có mục
  const q = buildPrompt({ project, preset, step: { ...step, prompt: 'Làm đi.' }, feedback: 'Ngắn hơn', allowPaid: false });
  assert.ok(q.includes('\n## Góp ý của người dùng cho lượt này\nNgắn hơn'));
  assert.ok(!q.includes('ĐÃ DUYỆT CHI PHÍ'));
  assert.ok(!q.includes('## Kết quả bước trước'));
  const r = buildPrompt({ project, preset, step: { ...step, prompt: 'Làm đi. {feedback}' } });
  assert.ok(!r.includes('Góp ý'));
});

test('artifactKind + collectArtifacts: gộp structured + glob, bỏ file ngoài/không có/.studio, giữ file cũ khớp outputs', async () => {
  assert.equal(artifactKind('a/b.MP4'), 'video');
  assert.equal(artifactKind('x.wav'), 'audio');
  assert.equal(artifactKind('x.webp'), 'image');
  assert.equal(artifactKind('x.md'), 'markdown');
  assert.equal(artifactKind('x.json'), 'json');
  assert.equal(artifactKind('x.srt'), 'text');
  assert.equal(artifactKind('x.blend'), 'other');
  const dir = path.join(tmp, 'col');
  const w = (rel, s = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), s);
  };
  w('script.md');
  w('audio/a.wav');
  w('audio/old.wav');
  w('.studio/runs/x/prompt.md');
  w('ngoai.txt');
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(dir, 'audio/old.wav'), old, old);
  fs.symlinkSync(path.join(tmp, 'extra-presets'), path.join(dir, 'link-ra-ngoai'));
  const list = await collectArtifacts({
    dir,
    outputs: ['audio/*.wav', 'script.md', '~/Documents/x/**', '../x'],
    structured: {
      artifacts: [
        { path: 'script.md', label: 'Kịch bản' },
        { path: '../ngoai.txt' },
        { path: '/etc/hosts' },
        { path: 'khong-co.md' },
        { path: '.studio/runs/x/prompt.md' },
        { path: 'link-ra-ngoai/extra-0.yaml' },
        { path: path.join(dir, 'ngoai.txt') },
      ],
    },
    since: new Date().toISOString(),
  });
  assert.deepEqual(list.map((a) => a.path).sort(), ['audio/a.wav', 'audio/old.wav', 'ngoai.txt', 'script.md']);
  const s = list.find((a) => a.path === 'script.md');
  assert.equal(s.kind, 'markdown');
  assert.equal(s.label, 'Kịch bản');
  assert.equal(s.bytes, 1);
  assert.ok(!Number.isNaN(Date.parse(s.mtime)));
  assert.equal(list.find((a) => a.path === 'audio/a.wav').kind, 'audio');
});

// ======================= runner + fake-claude =======================

test('luồng đầy đủ 4 bước: args, prompt qua stdin, session → resume, artifacts, checks, cost, log, không lộ VS_*', async () => {
  const p0 = mk();
  const preset = projects.presetOf(p0.id);
  const events = [];
  const changes = [];
  runner.on('event', (e) => events.push(e));
  runner.on('change', (c) => changes.push(c));
  const limits = [];
  runner.on('rate_limit', (d) => limits.push(d));
  process.env.VS_TOKEN = 'tok-bi-mat-khong-duoc-lo';
  process.env.VS_PORT = '4999';
  let hook;
  try {
    hook = await runToEnd(p0, 'hook');
  } finally {
    delete process.env.VS_TOKEN;
    delete process.env.VS_PORT;
  }

  // --- bước 1: hook
  assert.equal(hook.state, 'done', hook.error);
  assert.ok(limits.length >= 1, 'runner phát rate_limit');
  assert.equal(limits[0].unifiedWindows.five_hour.utilization, 0.42);
  assert.equal(hook.n, 1);
  assert.equal(hook.exit_code, 0);
  assert.equal(hook.summary, 'Đã tạo 1 file đầu ra cho bước.');
  assert.equal(hook.result.status, 'done');
  assert.equal(hook.session_id, p0.claude_session_id);
  assert.ok(hook.pid > 0 && isDead(hook.pid));
  assert.deepEqual(states(p0.id), { hook: 'done', bible: 'ready', voice: 'pending', deliver: 'pending' });
  const c1 = lastCall(p0);
  assert.deepEqual(c1.env_vs, [], 'process con không nhận biến VS_*');
  assert.equal(c1.prompt, hook.prompt, 'prompt đi qua stdin, đúng prompt đã lưu');
  assert.deepEqual(c1.argv, buildArgs({ project: p0, preset, step: preset.steps[0], allowPaid: false }));
  assert.ok(!c1.argv.includes(hook.prompt), 'không có prompt positional');
  assert.deepEqual(flagValues(c1.argv, '--session-id'), [p0.claude_session_id]);
  assert.ok(!c1.argv.includes('--resume'));
  assert.deepEqual(flagValues(c1.argv, '--permission-mode'), ['acceptEdits']);
  assert.deepEqual(flagValues(c1.argv, '--permission-prompts'), ['none']);
  assert.deepEqual(flagValues(c1.argv, '--allowedTools'), ['Edit', 'Write', 'Read', 'Bash(test *)', 'Bash(ls *)']);
  assert.deepEqual(flagValues(c1.argv, '--disallowedTools'), ['Bash(sudo *)', 'Bash(git push*)', 'Bash(*elevenlabs*)']);
  assert.ok(!c1.argv.includes('--add-dir'));
  assert.ok(hook.prompt.startsWith('# Bước 1/4: Lời hứa & hook (id: hook)\n'));
  assert.ok(hook.prompt.includes('Đầu ra bắt buộc: ["script.md"]'));
  assert.equal(store.getProject(p0.id).session_started, 1);

  const arts = store.listArtifacts(hook.id);
  assert.deepEqual(arts.map((a) => [a.path, a.kind]), [['script.md', 'markdown']]);
  assert.ok(arts[0].bytes > 0);
  assert.deepEqual(store.listCostsByRun(hook.id).map(({ kind, units, unit_name, usd, note }) => ({ kind, units, unit_name, usd, note })), [
    { kind: 'claude_tokens', units: 1160, unit_name: 'token', usd: null, note: 'claude-fake-1' },
  ]);
  assert.deepEqual(hook.usage, {
    input_tokens: 10,
    output_tokens: 50,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    total_cost_usd: 0.0123,
    api_key: false,
  });
  assert.deepEqual(hook.denials, []);

  // events: store + emit, đúng thứ tự, không có hook/secret
  const k = kinds(hook.id);
  assert.equal(k[0], 'status');
  assert.equal(texts(hook.id)[0], 'Bắt đầu lượt 1');
  assert.deepEqual(k.slice(1), ['init', 'text', 'tool', 'tool_result', 'text', 'structured', 'tool_result', 'result']);
  const seqs = store.listEvents(hook.id).map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const emitted = events.filter((e) => e.runId === hook.id);
  assert.equal(emitted.length, k.length);
  assert.ok(emitted.every((e) => e.projectId === p0.id && typeof e.event.seq === 'number' && e.event.kind));
  assert.ok(changes.some((c) => c.projectId === p0.id));
  assert.ok(!JSON.stringify(store.listEvents(hook.id)).includes('secret hook output'));
  const toolEv = store.listEvents(hook.id).find((e) => e.kind === 'tool');
  assert.ok(toolEv.text.includes('script.md') && !toolEv.text.includes(p0.dir), 'đường dẫn tool hiển thị tương đối');

  // thư mục lượt
  const rd = runDirOf(p0, 'hook', 1);
  assert.equal(fs.readFileSync(path.join(rd, 'prompt.md'), 'utf8'), hook.prompt);
  assert.equal(fs.readFileSync(path.join(rd, 'system.md'), 'utf8').trim(), STUDIO_PROTOCOL);
  const argsJson = JSON.parse(fs.readFileSync(path.join(rd, 'args.json'), 'utf8'));
  assert.ok(!JSON.stringify(argsJson).includes('Bạn đang chạy trong Video Studio'), 'args.json không chứa system prompt dài');
  assert.equal(argsJson.args.length, c1.argv.length);
  const logLines = fs.readFileSync(path.join(rd, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(logLines.every((l) => !(l.type === 'system' && String(l.subtype).startsWith('hook_'))), 'stream.jsonl bỏ hook');
  const initLog = logLines.find((l) => l.subtype === 'init');
  assert.equal(initLog.session_id, p0.claude_session_id);
  for (const key of ['tools', 'mcp_servers', 'plugins', 'memory_paths', 'slash_commands']) assert.ok(!(key in initLog), key);
  assert.equal(logLines.at(-1).type, 'result');
  const resultJson = JSON.parse(fs.readFileSync(path.join(rd, 'result.json'), 'utf8'));
  assert.equal(resultJson.state, 'done');
  assert.equal(resultJson.artifacts.length, 1);
  assert.ok(!fs.existsSync(path.join(p0.dir, '.studio', 'lock')), 'lock được xóa sau lượt');

  // --- bước 2: bible (resume, prev, check ĐẠT)
  const bible = await runToEnd(p0, 'bible');
  assert.equal(bible.state, 'done', bible.error);
  const c2 = lastCall(p0);
  assert.deepEqual(flagValues(c2.argv, '--resume'), [p0.claude_session_id]);
  assert.ok(!c2.argv.includes('--session-id'));
  assert.ok(bible.prompt.includes('## Kết quả bước trước (Lời hứa & hook)\nĐã tạo 1 file đầu ra cho bước.\nGhi chú cho bước sau: Ghi chú giả cho bước sau.'));
  assert.deepEqual(store.listArtifacts(bible.id).map((a) => a.path).sort(), ['bible.md', 'project.json']);
  assert.equal(store.listArtifacts(bible.id).find((a) => a.path === 'project.json').kind, 'json');
  const ch = store.listChecks(bible.id);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].name, 'project_json');
  assert.equal(ch[0].passed, 1);
  assert.equal(ch[0].cmd, 'test -s project.json');
  assert.ok(fs.existsSync(path.join(runDirOf(p0, 'bible', 1), 'checks', '1-project-json.log')));
  assert.ok(texts(bible.id).includes('Đang chạy kiểm tra…'));
  const checkEv = store.listEvents(bible.id).find((e) => e.kind === 'check');
  assert.equal(checkEv.text, 'Kiểm tra project_json: ĐẠT');
  assert.deepEqual(checkEv.payload, { name: 'project_json', passed: true });
  assert.deepEqual(states(p0.id), { hook: 'done', bible: 'done', voice: 'ready', deliver: 'pending' });

  // --- bước 3: voice (cost 412 → allowPaid)
  const err = expectHttp(() => runner.start(p0.id, 'voice', {}), 412, 'cost_confirm_required');
  assert.equal(err.cost.service, 'elevenlabs');
  assert.equal(store.runningRunOf(p0.id), null);
  assert.equal(states(p0.id).voice, 'ready');
  const voice = await runToEnd(p0, 'voice', { allowPaid: true });
  assert.equal(voice.state, 'done', voice.error);
  assert.equal(voice.allow_paid, 1);
  const c3 = lastCall(p0);
  assert.ok(flagValues(c3.argv, '--allowedTools').includes('Bash(*elevenlabs*)'));
  assert.ok(!flagValues(c3.argv, '--disallowedTools').includes('Bash(*elevenlabs*)'));
  assert.ok(voice.prompt.includes('ĐÃ DUYỆT CHI PHÍ: người dùng đã đồng ý chi phí dịch vụ elevenlabs cho lượt này.'));
  assert.deepEqual(store.listArtifacts(voice.id).map((a) => [a.path, a.kind]), [['audio/fake-1.wav', 'audio']]);

  // --- bước 4: deliver (studio-check outputs)
  const deliver = await runToEnd(p0, 'deliver');
  assert.equal(deliver.state, 'done', deliver.error);
  const dc = store.listChecks(deliver.id);
  assert.equal(dc[0].name, 'outputs');
  assert.equal(dc[0].passed, 1, dc[0].output);
  assert.match(dc[0].output, /✓ exports\/caption\.md/);
  assert.deepEqual(states(p0.id), { hook: 'done', bible: 'done', voice: 'done', deliver: 'done' });
  assert.equal(store.getProject(p0.id).status, 'done');
  assert.equal(calls(p0).length, 4);
});

test('needs_input → câu hỏi; chạy lại kèm góp ý → done, feedback lưu và nằm trong prompt', async () => {
  const p = mk();
  const r1 = await runToEnd(p, 'hook', {}, 'needs_input');
  assert.equal(r1.state, 'needs_input');
  assert.deepEqual(r1.result.questions, ['Bạn muốn giọng nam hay nữ?']);
  assert.equal(r1.summary, 'Cần người dùng chọn giọng đọc trước khi làm tiếp.');
  assert.equal(states(p.id).hook, 'needs_input');
  assert.equal(states(p.id).bible, 'pending');
  assert.deepEqual(store.listArtifacts(r1.id), []);
  const r2 = await runToEnd(p, 'hook', { feedback: 'Giọng nữ nhé' }, 'done');
  assert.equal(r2.state, 'done', r2.error);
  assert.equal(r2.n, 2);
  assert.equal(r2.feedback, 'Giọng nữ nhé');
  assert.ok(r2.prompt.includes('Góp ý của người dùng cho lượt này:\nGiọng nữ nhé'));
  assert.equal(lastCall(p).prompt, r2.prompt);
  assert.deepEqual(flagValues(lastCall(p).argv, '--resume'), [p.claude_session_id]);
  assert.ok(fs.existsSync(path.join(runDirOf(p, 'hook', 2), 'prompt.md')));
  assert.equal(states(p.id).bible, 'ready');
});

test('fail: result is_error → failed, step failed, vẫn lưu usage/cost, phiên đã bắt đầu', async () => {
  const p = mk();
  const r = await runToEnd(p, 'hook', {}, 'fail');
  assert.equal(r.state, 'failed');
  assert.match(r.error, /error_during_execution/);
  assert.equal(r.exit_code, 1);
  assert.equal(states(p.id).hook, 'failed');
  assert.equal(store.getProject(p.id).session_started, 1);
  assert.equal(store.listCostsByRun(r.id).length, 1);
  assert.equal(kinds(r.id).at(-1), 'result');
  assert.ok(!fs.existsSync(path.join(p.dir, '.studio', 'lock')));
});

test('crash: nửa dòng JSON → sự kiện raw, failed, session_started vẫn 0 → lượt sau vẫn --session-id', async () => {
  const p = mk();
  const r = await runToEnd(p, 'hook', {}, 'crash');
  assert.equal(r.state, 'failed');
  assert.match(r.error, /Claude thoát với mã 2/);
  assert.equal(r.exit_code, 2);
  const raw = store.listEvents(r.id).find((e) => e.kind === 'raw');
  assert.ok(raw && raw.text.startsWith('{"type":"assistant"'));
  assert.equal(store.getProject(p.id).session_started, 0);
  assert.equal(store.listCostsByRun(r.id).length, 0);
  const r2 = await runToEnd(p, 'hook', {}, 'done');
  assert.equal(r2.state, 'done', r2.error);
  assert.deepEqual(flagValues(lastCall(p).argv, '--session-id'), [p.claude_session_id]);
});

test('bad_resume: "No conversation found" khi --resume → failed rõ ràng, không tự tạo phiên mới', async () => {
  const p = mk();
  await runToEnd(p, 'hook', {}, 'done');
  const r = await runToEnd(p, 'bible', {}, 'bad_resume');
  assert.equal(r.state, 'failed');
  assert.match(r.error, /Không tìm thấy phiên Claude/);
  assert.ok(r.error.includes(p.claude_session_id));
  const after = store.getProject(p.id);
  assert.equal(after.claude_session_id, p.claude_session_id);
  assert.equal(after.session_started, 1);
  assert.ok(store.listEvents(r.id).some((e) => e.kind === 'stderr' && /No conversation found/.test(e.text)));
  assert.equal(states(p.id).bible, 'failed');
});

test('session_in_use: --session-id bị từ chối "already in use" trước init → failed rõ ràng, lượt sau tự --resume và chạy được', async () => {
  const p = mk();
  assert.equal(p.session_started, 0);
  const r = await runToEnd(p, 'hook', {}, 'session_in_use');
  assert.equal(r.state, 'failed');
  assert.equal(r.error, 'Phiên đã tồn tại — lượt sau sẽ tiếp tục bằng --resume, bấm Chạy lại.');
  assert.deepEqual(flagValues(lastCall(p).argv, '--session-id'), [p.claude_session_id]);
  const after = store.getProject(p.id);
  assert.equal(after.session_started, 1);
  assert.equal(after.claude_session_id, p.claude_session_id);
  const r2 = await runToEnd(p, 'hook', {}, 'session_in_use');
  assert.equal(r2.state, 'done', r2.error);
  assert.deepEqual(flagValues(lastCall(p).argv, '--resume'), [p.claude_session_id]);
  assert.equal(flagValues(lastCall(p).argv, '--session-id'), null);
});

test('denied: lưu denials, có sự kiện denied, lượt vẫn done', async () => {
  const p = mk();
  const r = await runToEnd(p, 'hook', {}, 'denied');
  assert.equal(r.state, 'done', r.error);
  assert.equal(r.denials.length, 1);
  assert.equal(r.denials[0].tool_name, 'Bash');
  assert.deepEqual(r.denials[0].tool_input, { command: 'sudo rm -rf /tmp/khong-co-that' });
  const d = store.listEvents(r.id).find((e) => e.kind === 'denied');
  assert.equal(d.payload.tool_name, 'Bash');
});

test('stop: lượt slow bị dừng → stopped, step khôi phục, process chết, lock xóa', async () => {
  const p = mk();
  await runToEnd(p, 'hook', {}, 'done');
  scenario(p, 'slow');
  const run = runner.start(p.id, 'hook', {});
  await waitForEvent(run.id, (e) => e.kind === 'text' && e.text.startsWith('Đang làm…'));
  const lock = JSON.parse(fs.readFileSync(path.join(p.dir, '.studio', 'lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.run_id, run.id);
  assert.equal(lock.host, os.hostname());
  assert.ok(lock.since);
  const pid = store.getRun(run.id).pid;
  assert.ok(pid > 0);
  assert.equal(runner.stop(run.id), true);
  const t0 = Date.now();
  await runner.wait(run.id);
  assert.ok(Date.now() - t0 < 1900, 'fake chết ngay khi SIGTERM, không cần SIGKILL');
  const r = store.getRun(run.id);
  assert.equal(r.state, 'stopped');
  assert.ok(texts(run.id).includes('Dừng theo yêu cầu'));
  assert.equal(states(p.id).hook, 'done', 'bước đã done trước đó → khôi phục done');
  assert.ok(isDead(pid));
  assert.equal(runner.isRunning(run.id), false);
  assert.equal(runner.stop(run.id), false);
  assert.ok(!fs.existsSync(path.join(p.dir, '.studio', 'lock')));
  assert.equal(store.runningRunOf(p.id), null);
});

test('timeout: bước timeout 600ms + slow → failed "Hết thời gian", process chết', async () => {
  const p = mk('t-timeout', 'het-gio');
  const t0 = Date.now();
  const r = await runToEnd(p, 'one', {}, 'slow');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /^Hết thời gian \(0,01 phút\)/);
  assert.ok(isDead(r.pid));
  assert.equal(states(p.id).one, 'failed');
  assert.ok(store.listEvents(r.id).some((e) => e.kind === 'error' && /Hết thời gian/.test(e.text)));
});

test('busy: đang chạy thì lượt thứ 2 bị 409 busy', async () => {
  const p = mk();
  scenario(p, 'slow');
  const run = runner.start(p.id, 'hook', {});
  expectHttp(() => runner.start(p.id, 'hook', {}), 409, 'busy');
  runner.stop(run.id);
  await runner.wait(run.id);
  assert.equal(states(p.id).hook, 'ready');
});

test('lock: process khác còn sống giữ lock → 409 locked, không tạo lượt; pid chết / lock hỏng → ghi đè', async () => {
  const p = mk();
  const lockFile = path.join(p.dir, '.studio', 'lock');
  const foreign = { pid: process.ppid, host: os.hostname(), since: new Date().toISOString(), run_id: 'run-khac' };
  fs.writeFileSync(lockFile, JSON.stringify(foreign));
  const e = expectHttp(() => runner.start(p.id, 'hook', {}), 409, 'locked');
  assert.match(e.message, new RegExp(`pid ${process.ppid}`));
  assert.equal(store.runningRunOf(p.id), null);
  assert.equal(store.listRunsByStep(store.getStep(p.id, 'hook').id).length, 0);
  assert.equal(states(p.id).hook, 'ready');
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), foreign, 'không đụng lock của người khác');

  // máy khác → coi như đang khóa
  fs.writeFileSync(lockFile, JSON.stringify({ ...foreign, pid: process.pid, host: 'may-khac.local' }));
  expectHttp(() => runner.start(p.id, 'hook', {}), 409, 'locked');

  // pid đã chết → ghi đè
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(isDead(dead));
  fs.writeFileSync(lockFile, JSON.stringify({ ...foreign, pid: dead }));
  const r1 = await runToEnd(p, 'hook', {}, 'done');
  assert.equal(r1.state, 'done', r1.error);
  assert.ok(!fs.existsSync(lockFile));

  // lock hỏng → ghi đè; lock của chính process nhưng không có lượt chạy → ghi đè
  fs.writeFileSync(lockFile, '{hỏng');
  assert.equal((await runToEnd(p, 'hook', {}, 'done')).state, 'done');
  fs.writeFileSync(lockFile, JSON.stringify({ ...foreign, pid: process.pid }));
  assert.equal((await runToEnd(p, 'hook', {}, 'done')).state, 'done');
  assert.ok(!fs.existsSync(lockFile));
});

test('lock sót lại của lượt đã kết thúc (DB này biết run_id) → ghi đè dù hostname đổi / pid còn sống; lock lạ → 409 kèm cách gỡ', async () => {
  const p = mk();
  const old = await runToEnd(p, 'hook', {}, 'done');
  const lockFile = path.join(p.dir, '.studio', 'lock');
  // server cũ chết sau khi lượt xong; macOS đổi hostname (vd '<host>-2.local'); pid bị process khác dùng lại (process.ppid còn sống)
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, host: `${os.hostname()}-2.local`, since: new Date().toISOString(), run_id: old.id }));
  const r = await runToEnd(p, 'hook', {}, 'done');
  assert.equal(r.state, 'done', r.error);
  assert.ok(!fs.existsSync(lockFile));

  // run_id DB không biết (máy khác dùng chung thư mục) → vẫn khóa, thông báo chỉ cách gỡ
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, host: 'may-khac.local', run_id: 'run-la' }));
  const e = expectHttp(() => runner.start(p.id, 'hook', {}), 409, 'locked');
  assert.ok(e.message.includes(`xóa file ${lockFile}`), e.message);
  // lượt DB biết nhưng vẫn đang 'running' → không coi là sót
  const running = projects.beginRun(p.id, 'bible', {});
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, host: 'may-khac.local', run_id: running.id }));
  projects.finishRun(running.id, { state: 'stopped' });
  assert.equal((await runToEnd(p, 'hook', {}, 'done')).state, 'done');
});

test('check trượt → lượt failed "Kiểm tra không đạt", log từng check, bước sau không mở', async () => {
  const p = mk('t-checkfail', 'check-truot');
  const r = await runToEnd(p, 'one', {}, 'done');
  assert.equal(r.state, 'failed');
  assert.equal(r.error, 'Kiểm tra không đạt: thieu file');
  const ch = store.listChecks(r.id);
  assert.deepEqual(ch.map((c) => [c.name, c.passed]), [['thieu file', 0], ['chua ho tro', null]]);
  assert.match(ch[1].output, /Chưa hỗ trợ ở M1/);
  const logs = fs.readdirSync(path.join(runDirOf(p, 'one', 1), 'checks')).sort();
  assert.deepEqual(logs, ['1-thieu-file.log', '2-chua-ho-tro.log']);
  const t = texts(r.id);
  assert.ok(t.includes('Kiểm tra thieu file: TRƯỢT'));
  assert.ok(t.includes('Kiểm tra chua ho tro: BỎ QUA (chưa hỗ trợ)'));
  assert.deepEqual(states(p.id), { one: 'failed', two: 'pending' });
  assert.deepEqual(store.listArtifacts(r.id).map((a) => a.path), ['one.md']);
});

test('skills: --add-dir chỉ skill có thật (đường dẫn có dấu cách), không có cờ quyền khi rỗng; ảnh/text artifact', async () => {
  const p = mk('t-skills', 'co-skill');
  const r = await runToEnd(p, 'one', {}, 'done');
  assert.equal(r.state, 'done', r.error);
  const argv = lastCall(p).argv;
  assert.deepEqual(flagValues(argv, '--add-dir'), [skillDir]);
  assert.ok(!argv.includes('--allowedTools'));
  assert.ok(!argv.includes('--disallowedTools'));
  assert.ok(r.prompt.includes(`Skill: đọc ${skillDir}/SKILL.md trước khi làm.`));
  assert.ok(!r.prompt.includes(missingSkill));
  assert.ok(r.prompt.includes(`Đọc ${skillDir}/SKILL.md rồi làm`));
  const arts = store.listArtifacts(r.id).map((a) => [a.path, a.kind]).sort();
  assert.deepEqual(arts, [['images/fake-1.png', 'image'], ['notes.txt', 'text']]);
  const png = fs.readFileSync(path.join(p.dir, 'images/fake-1.png'));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
});

test('model: --model được truyền khi runner có model', async () => {
  const r2 = mkRunner({ model: 'claude-opus-test' });
  const p = mk();
  const r = await runToEnd(p, 'hook', {}, 'done', r2);
  assert.equal(r.state, 'done', r.error);
  assert.deepEqual(lastCall(p).argv.slice(-2), ['--model', 'claude-opus-test']);
});

test('claude không chạy được (bin không tồn tại) → failed có thông báo, lock xóa', async () => {
  const bad = mkRunner({ claudeBin: path.join(tmp, 'khong-co-claude') });
  const p = mk();
  const run = bad.start(p.id, 'hook', {});
  await bad.wait(run.id);
  const r = store.getRun(run.id);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /Không chạy được Claude CLI/);
  assert.equal(states(p.id).hook, 'failed');
  assert.ok(!fs.existsSync(path.join(p.dir, '.studio', 'lock')));
});

test('shutdown: dừng mọi lượt đang chạy, sau đó start bị từ chối 503', async () => {
  const p = mk();
  const q = mk('t-timeout', 'du-an-2');
  scenario(p, 'slow');
  scenario(q, 'slow');
  const a = runner.start(p.id, 'hook', {});
  const b = runner.start(q.id, 'one', {});
  await waitForEvent(a.id, (e) => e.kind === 'init');
  const pids = [store.getRun(a.id).pid, store.getRun(b.id).pid];
  await runner.shutdown();
  assert.equal(store.getRun(a.id).state, 'stopped');
  assert.ok(['stopped', 'failed'].includes(store.getRun(b.id).state));
  assert.ok(pids.every((pid) => isDead(pid)));
  assert.equal(runner.isRunning(a.id), false);
  expectHttp(() => runner.start(p.id, 'hook', {}), 503, 'shutting_down');
});

test('canRun lỗi được ném lại dạng HttpError (404, bước chưa tới lượt 409)', () => {
  const p = mk();
  expectHttp(() => runner.start('khong-co', 'hook', {}), 404, 'not_found');
  expectHttp(() => runner.start(p.id, 'bible', {}), 409, 'not_runnable');
  assert.ok(!fs.existsSync(path.join(p.dir, '.studio', 'lock')));
});

test('buildPrompt: có .studio/reference.md → thêm dòng Tham khảo; không có thì không', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ref-'));
  const step = { key: 'one', name: 'Một', ord: 0, prompt: 'Làm', outputs: ['a.md'] };
  const preset = { id: 'p', name: 'P', permissions: {}, steps: [{ key: 'one' }] };
  const mk = () => buildPrompt({ project: { id: 'x', title: 'T', dir }, preset, step });
  assert.ok(!mk().includes('reference.md'));
  fs.mkdirSync(path.join(dir, '.studio'));
  fs.writeFileSync(path.join(dir, '.studio', 'reference.md'), 'x');
  assert.ok(mk().includes('.studio/reference.md'));
});

test('buildArgs: model của bước ưu tiên hơn model của app', () => {
  const project = { dir: '/p' };
  const at = (a) => a[a.indexOf('--model') + 1];
  assert.equal(at(buildArgs({ project, preset: {}, step: { model: 'opus' }, model: 'haiku' })), 'opus');
  assert.equal(at(buildArgs({ project, preset: {}, step: {}, model: 'haiku' })), 'haiku');
  assert.ok(!buildArgs({ project, preset: {}, step: {} }).includes('--model'));
});

test('buildArgs: phiên riêng của bước thay cho phiên dự án', () => {
  const project = { dir: '/p', claude_session_id: 'proj-sid', session_started: 1 };
  const at = (a, f) => a[a.indexOf(f) + 1];
  const fresh = buildArgs({ project, preset: {}, step: {}, session: { id: 'step-sid', resume: false } });
  assert.equal(at(fresh, '--session-id'), 'step-sid');
  assert.ok(!fresh.includes('--resume'));
  const again = buildArgs({ project, preset: {}, step: {}, session: { id: 'step-sid', resume: true } });
  assert.equal(at(again, '--resume'), 'step-sid');
  assert.equal(at(buildArgs({ project, preset: {}, step: {} }), '--resume'), 'proj-sid');
});

test('buildPrompt reply: chỉ gửi câu trả lời ngắn, vẫn có đầu ra bắt buộc và dòng duyệt chi phí', () => {
  const step = { key: 'draft', name: 'Nháp', ord: 0, outputs: ['exports/a.mp4'], prompt: 'RẤT DÀI', cost: { service: 'ElevenLabs' } };
  const p = buildPrompt({ project: { id: 'p', title: 'T', dir: '/x' }, preset: { id: 'x', steps: [step] }, step, feedback: 'Đồng ý', reply: 'Đồng ý', allowPaid: true });
  assert.match(p, /Đồng ý/);
  assert.match(p, /exports\/a\.mp4/);
  assert.match(p, /ĐÃ DUYỆT CHI PHÍ/);
  assert.doesNotMatch(p, /RẤT DÀI/);
});

test('stop: tắt cả chương trình con mà claude gọi ra (ffmpeg…), kể cả khi nó bỏ qua SIGTERM', async () => {
  const p = mk();
  scenario(p, 'grandchild');
  const run = runner.start(p.id, 'hook', {});
  await waitForEvent(run.id, (e) => e.kind === 'text' && e.text.startsWith('Đang làm…'));
  const gc = Number(fs.readFileSync(path.join(p.dir, '.fake-grandchild'), 'utf8'));
  assert.ok(gc > 0 && !isDead(gc));
  runner.stop(run.id);
  await runner.wait(run.id);
  const t0 = Date.now();
  while (!isDead(gc) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 30));
  assert.ok(isDead(gc), 'chương trình con phải chết theo');
  assert.equal(store.getRun(run.id).state, 'stopped');
});

test('mất mạng: lỗi kết nối của claude → báo "Mất mạng", không phải lỗi chung', async () => {
  const p = mk();
  const r = await runToEnd(p, 'hook', {}, 'net_error');
  assert.equal(r.state, 'failed');
  assert.equal(r.error, NETWORK_ERROR);
});

test('Tiếp tục: chỉ thêm dặn "giữ file đã xong" khi lượt gần nhất bị dừng/lỗi', async () => {
  const p = mk();
  const prompt = (n) => fs.readFileSync(path.join(runDirOf(p, 'hook', n), 'prompt.md'), 'utf8');
  await runToEnd(p, 'hook', { cont: true }, 'done');
  assert.ok(!prompt(1).includes('Tiếp tục lượt bị gián đoạn'), 'chưa có lượt hỏng → bỏ qua cờ');
  await runToEnd(p, 'hook', {}, 'fail');
  await runToEnd(p, 'hook', { cont: true }, 'done');
  assert.match(prompt(3), /## Tiếp tục lượt bị gián đoạn[\s\S]*GIỮ NGUYÊN/);
});

test('buildPrompt: cách làm người dùng chọn + file người dùng có sẵn', () => {
  const preset = { id: 'p', name: 'P', steps: [{ key: 'kb', name: 'Kịch bản', prompt: 'Viết script.md', outputs: ['script.md'] }] };
  const step = preset.steps[0];
  const p = buildPrompt({ project: { id: 'x', title: 'T', dir: '/d' }, preset, step, method: { label: 'Viết theo dàn ý', hint: 'Bám sát outline.md' }, own: ['script.md'] });
  assert.match(p, /## Cách làm người dùng chọn: Viết theo dàn ý\nBám sát outline\.md/);
  assert.match(p, /## File người dùng có sẵn[\s\S]*- script\.md[\s\S]*\.orig/);
  const plain = buildPrompt({ project: { id: 'x', title: 'T', dir: '/d' }, preset, step });
  assert.doesNotMatch(plain, /Cách làm người dùng chọn|File người dùng có sẵn/);
});
