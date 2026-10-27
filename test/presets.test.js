import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REPO_ROOT,
  loadChannels,
  loadPresets,
  parseDuration,
  presetDirs,
  renderTemplate,
  validatePreset,
} from '../server/presets.js';

const REPO_PRESETS = path.join(REPO_ROOT, 'presets');
const FIXTURE_PRESETS = path.join(REPO_ROOT, 'test', 'fixtures', 'presets');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
}

// Preset tối thiểu hợp lệ để biến tấu trong các test lỗi.
function base(over = {}) {
  return {
    id: 'demo',
    name: 'Demo',
    channel: 'tiktok',
    vars: { duration: 45 },
    steps: [
      { id: 'hook', name: 'Hook', prompt: 'Viết hook cho {title}. {feedback}', outputs: ['script.md'] },
      {
        id: 'bible',
        name: 'Bible',
        prompt: 'Bible ~{vars.duration}s. {prev.summary}',
        outputs: ['project.json'],
        checks: [{ name: 'json', run: 'test -s project.json' }],
        gate: { mode: 'auto_if_checks' },
      },
    ],
    ...over,
  };
}

function expectInvalid(raw, re) {
  assert.throws(
    () => validatePreset(raw, '/x/demo.yaml'),
    (e) => {
      assert.match(e.message, re);
      return true;
    },
  );
}

test('repo không còn quy trình dựng sẵn: presets/ chỉ có channels.yaml', () => {
  const { presets, errors } = loadPresets([REPO_PRESETS]);
  assert.deepEqual(errors, []);
  assert.deepEqual(presets, []);
});

test('preset fixture e2e-short hợp lệ và đúng §12', () => {
  const { presets, errors } = loadPresets([FIXTURE_PRESETS]);
  assert.deepEqual(errors, []);
  const p = presets.find((x) => x.id === 'e2e-short');
  assert.ok(p);
  assert.equal(p.channel, 'tiktok');
  assert.equal(p.project_dir, 'projects/{slug}');
  assert.deepEqual(p.steps.map((s) => s.key), ['hook', 'bible', 'voice', 'deliver']);
  assert.deepEqual(p.steps[0].outputs, ['script.md']);
  assert.equal(p.steps[1].gate.mode, 'auto_if_checks');
  assert.equal(p.steps[1].checks[0].run, 'test -s project.json');
  assert.deepEqual(p.steps[2].cost, { service: 'elevenlabs', estimate: 'chars(script.md)', always_ask: true });
  assert.deepEqual(p.steps[2].outputs, ['audio/*.wav']);
  assert.equal(p.steps[3].checks[0].run, 'studio-check outputs');
  assert.deepEqual(p.steps[3].outputs, ['exports/caption.md']);
  assert.equal(p.defaults.timeout_ms, 600_000);
  assert.ok(p.steps.every((s) => s.manual === false));
});

test('validatePreset: chuẩn hóa mặc định', () => {
  const p = validatePreset(base({ foreach: 'x', skills: ['~/sk/a', 'rel/b'] }), '/x/y/demo.yaml');
  assert.equal(p.format, 'short');
  assert.equal(p.project_dir, 'projects/{slug}');
  assert.deepEqual(p.defaults.gate, { mode: 'manual' });
  assert.equal(p.defaults.timeout_ms, 2 * 3_600_000);
  assert.deepEqual(p.permissions, { allow: [], ask: [], deny: [] });
  assert.equal(p.skills[0], path.join(os.homedir(), 'sk/a'));
  assert.equal(p.skills[1], '/x/y/rel/b');
  assert.equal(p.foreach, 'x', 'trường lạ được giữ');
  const [s0, s1] = p.steps;
  assert.equal(s0.key, 'hook');
  assert.equal(s0.ord, 0);
  assert.equal(s1.ord, 1);
  assert.equal(s0.id, undefined);
  assert.deepEqual(s0.gate, { mode: 'manual' });
  assert.deepEqual(s0.checks, []);
  assert.equal(s0.cost, null);
  assert.deepEqual(s0.resources, []);
  assert.equal(s0.manual, false);
  assert.equal(s0.timeout_ms, 2 * 3_600_000);
  assert.deepEqual(s1.checks, [{ name: 'json', run: 'test -s project.json' }]);
});

test('validatePreset: gate/timeout/cost/manual', () => {
  const p = validatePreset(
    base({
      defaults: { gate: { mode: 'auto_after', after: '30m' }, timeout: '1h30m' },
      steps: [
        { id: 'a', prompt: 'x', outputs: ['a.md'], checks: [{ run: 'true' }], timeout: '90s' },
        { id: 'b', prompt: 'x', outputs: ['b.md'], gate: 'manual', cost: { service: 'elevenlabs', estimate: 1200 } },
        { id: 'c', manual: true, name: 'Tự làm' },
      ],
    }),
  );
  assert.deepEqual(p.steps[0].gate, { mode: 'auto_after', after_ms: 1_800_000 });
  assert.equal(p.steps[0].checks[0].name, 'Kiểm tra 1');
  assert.equal(p.steps[0].timeout_ms, 90_000);
  assert.equal(p.steps[1].timeout_ms, 5_400_000);
  assert.deepEqual(p.steps[1].gate, { mode: 'manual' });
  assert.deepEqual(p.steps[1].cost, { service: 'elevenlabs', estimate: '1200', always_ask: true });
  assert.equal(p.steps[2].manual, true);
  assert.deepEqual(p.steps[2].gate, { mode: 'manual' }, 'bước manual mặc định cổng manual');
  assert.deepEqual(p.steps[2].outputs, []);
  assert.equal(p.steps[1].name, 'b', 'thiếu name → dùng id');
});

test('validatePreset: thiếu steps / steps rỗng', () => {
  const raw = base();
  delete raw.steps;
  expectInvalid(raw, /steps/);
  expectInvalid(base({ steps: [] }), /steps/);
});

test('validatePreset: thiếu id/name, channel rỗng, id không phải slug', () => {
  expectInvalid(base({ id: 'Demo Preset' }), /"id"/);
  expectInvalid(base({ name: '' }), /name/);
  assert.equal(validatePreset(base({ channel: undefined }), '/x/demo.yaml').channel, null); // kênh không bắt buộc
  expectInvalid(base({ channel: '' }), /channel/);
  expectInvalid(base({ format: 'square' }), /format/);
  expectInvalid('không phải object', /object/);
});

test('validatePreset: cổng tự động mà không có checks', () => {
  for (const gate of [{ mode: 'auto_if_checks' }, { mode: 'auto_after', after: '20m' }]) {
    expectInvalid(base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], gate }] }), new RegExp(gate.mode));
  }
  // defaults.gate tự động áp vào bước không có checks → cũng lỗi
  expectInvalid(
    base({ defaults: { gate: { mode: 'auto_after', after: '20m' } }, steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'] }] }),
    /auto_after/,
  );
  // cổng 'auto' (không kiểm gì) được phép theo §3.1
  validatePreset(base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], gate: { mode: 'auto' } }] }));
});

test('validatePreset: gate mode lạ, auto_after thiếu after, timeout sai', () => {
  expectInvalid(base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], gate: { mode: 'sometimes' } }] }), /gate\.mode/);
  expectInvalid(
    base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], checks: [{ run: 'true' }], gate: { mode: 'auto_after' } }] }),
    /after/,
  );
  expectInvalid(base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], timeout: 'mãi mãi' }] }), /timeout/);
});

test('validatePreset: placeholder lạ trong prompt / checks.run / project_dir / outputs', () => {
  expectInvalid(base({ steps: [{ id: 'a', prompt: 'Xin chào {name}', outputs: ['a.md'] }] }), /\{name\}/);
  expectInvalid(base({ steps: [{ id: 'a', prompt: 'x {vars.missing}', outputs: ['a.md'] }] }), /\{vars\.missing\}/);
  expectInvalid(
    base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], checks: [{ run: 'python3 {skil}/v.py' }] }] }),
    /\{skil\}/,
  );
  expectInvalid(base({ project_dir: '~/Videos/{project}' }), /project_dir/);
  expectInvalid(base({ steps: [{ id: 'a', prompt: 'x', outputs: ['{foo}/a.md'] }] }), /\{foo\}/);
  // các placeholder hợp lệ + ${VAR} của shell + JSON không bị bắt nhầm
  validatePreset(
    base({
      project_dir: '~/Videos/{slug}',
      steps: [
        {
          id: 'a',
          prompt: '{slug} {title} {feedback} {skill} {prev.summary} {vars.duration} — JSON: {"k": 1}',
          outputs: ['{slug}.md'],
          checks: [{ run: 'test -n "${HOME}" && python3 {skill}/x.py {vars.duration}' }],
        },
      ],
    }),
  );
});

test('validatePreset: outputs tuyệt đối / .. / ~ / rỗng / sai kiểu', () => {
  const step = (outputs) => base({ steps: [{ id: 'a', prompt: 'x', outputs }] });
  expectInvalid(step(['/etc/passwd']), /tuyệt đối/);
  expectInvalid(step(['~/x.md']), /tuyệt đối/);
  expectInvalid(step(['../x.md']), /\.\./);
  expectInvalid(step(['a/../../x.md']), /\.\./);
  expectInvalid(step(['']), /rỗng/);
  expectInvalid(step([]), /ít nhất 1/);
  expectInvalid(step('a.md'), /danh sách/);
  expectInvalid(base({ steps: [{ id: 'a', prompt: 'x' }] }), /outputs/);
  // vars làm output trỏ ra ngoài → lỗi
  expectInvalid(base({ vars: { out: '~/Videos' }, steps: [{ id: 'a', prompt: 'x', outputs: ['{vars.out}/**'] }] }), /ngoài thư mục dự án/);
  // a..b không phải '..'
  validatePreset(step(['a..b.md', 'dir/*.png', '{slug}/x.md']));
});

test('validatePreset: key bước sai slug, trùng; thiếu prompt; báo tất cả lỗi một lần', () => {
  expectInvalid(base({ steps: [{ id: 'publish_pkg', prompt: 'x', outputs: ['a.md'] }] }), /publish_pkg/);
  expectInvalid(
    base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'] }, { id: 'a', prompt: 'y', outputs: ['b.md'] }] }),
    /trùng/,
  );
  expectInvalid(base({ steps: [{ id: 'a', outputs: ['a.md'] }] }), /prompt/);
  try {
    validatePreset(base({ id: 'X', steps: [{ id: 'B', outputs: ['/a'] }] }), '/x/demo.yaml');
    assert.fail('phải throw');
  } catch (e) {
    assert.equal(e.code, 'EPRESET');
    assert.ok(e.problems.length >= 4, e.message);
    assert.match(e.message, /^Quy trình có \d+ lỗi:/);
    assert.equal(e.file, '/x/demo.yaml');
  }
});

test('validatePreset: cost sai', () => {
  expectInvalid(base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], cost: { estimate: 'chars(a.md)' } }] }), /service/);
  expectInvalid(
    base({ steps: [{ id: 'a', prompt: 'x', outputs: ['a.md'], cost: { service: 's', always_ask: 'có' } }] }),
    /always_ask/,
  );
});

test('renderTemplate: feedback, prev.summary, vars, skill, title/slug', () => {
  const ctx = {
    slug: 'da-lat',
    title: 'Đà Lạt',
    feedback: 'Ngắn hơn',
    skill: ['/sk/one', '/sk/two'],
    prev: { summary: 'Đã viết hook.' },
    vars: { duration: 45, size: '1080x1920' },
  };
  assert.equal(renderTemplate('{title} ({slug})', ctx), 'Đà Lạt (da-lat)');
  assert.equal(renderTemplate('Làm đi.{feedback}', ctx), 'Làm đi.\n\nGóp ý của người dùng cho lượt này:\nNgắn hơn');
  assert.equal(renderTemplate('Làm đi.{feedback}', { ...ctx, feedback: '' }), 'Làm đi.');
  assert.equal(renderTemplate('Làm đi.{feedback}', { ...ctx, feedback: null }), 'Làm đi.');
  assert.equal(renderTemplate('Trước: {prev.summary}', ctx), 'Trước: Đã viết hook.');
  assert.equal(renderTemplate('Trước: {prev.summary}', { ...ctx, prev: null }), 'Trước: ');
  assert.equal(renderTemplate('{vars.duration}s {vars.size}', ctx), '45s 1080x1920');
  assert.equal(renderTemplate('{skill}/SKILL.md', ctx), '/sk/one/SKILL.md');
  assert.equal(renderTemplate('{skill}', { skill: '/a' }), '/a');
  assert.equal(renderTemplate('[{skill}]', {}), '[]');
  assert.equal(renderTemplate(null, ctx), '');
});

test('renderTemplate: placeholder lạ giữ nguyên', () => {
  const ctx = { slug: 's', vars: { a: 1 } };
  assert.equal(renderTemplate('{unknown} {vars.b} {vars.a} {} { slug } ${HOME} {"k":1}', ctx), '{unknown} {vars.b} 1 {} { slug } ${HOME} {"k":1}');
});

test('renderTemplate: shell quoting kiểu POSIX', () => {
  const ctx = { skill: ['/Users/a b/skill'], slug: "it's", vars: { n: 'x; rm -rf /' } };
  assert.equal(
    renderTemplate('python3 {skill}/scripts/v.py', ctx, { shell: true }),
    "python3 '/Users/a b/skill'/scripts/v.py",
  );
  assert.equal(renderTemplate('echo {slug}', ctx, { shell: true }), "echo 'it'\\''s'");
  assert.equal(renderTemplate('echo {vars.n}', ctx, { shell: true }), "echo 'x; rm -rf /'");
  assert.equal(renderTemplate('echo {nope} {vars.zz}', ctx, { shell: true }), 'echo {nope} {vars.zz}');
  // không shell → không bọc
  assert.equal(renderTemplate('echo {slug}', ctx), "echo it's");
});

test('parseDuration', () => {
  assert.equal(parseDuration('20m'), 1_200_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration(1500), 1500);
  assert.equal(parseDuration('2500'), 2500);
  assert.equal(parseDuration(' 2H '), 7_200_000);
  for (const bad of ['', 'abc', '10x', '-5m', 'm', null, undefined, {}, -1, NaN]) {
    assert.throws(() => parseDuration(bad), undefined, `phải lỗi: ${String(bad)}`);
  }
});

test('loadPresets: thư mục sau ghi đè, file hỏng không chặn file khác, thư mục thiếu bỏ qua', () => {
  const tmp = tmpdir();
  try {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const yaml = (name, extra = '') =>
      `id: demo\nname: ${name}\nchannel: tiktok\n${extra}steps:\n  - id: one\n    prompt: "x"\n    outputs: [a.md]\n`;
    fs.writeFileSync(path.join(a, 'demo.yaml'), yaml('Từ A'));
    fs.writeFileSync(path.join(a, 'other.yml'), yaml('Khác').replace('id: demo', 'id: other'));
    fs.writeFileSync(path.join(a, 'broken.yaml'), 'id: [chưa đóng\n  name: :\n');
    fs.writeFileSync(path.join(a, 'invalid.yaml'), 'id: bad\nname: Bad\nchannel: tiktok\n');
    fs.writeFileSync(path.join(a, 'channels.yaml'), '- id: x\n  name: X\n');
    fs.writeFileSync(path.join(a, 'notes.txt'), 'không phải yaml');
    fs.writeFileSync(path.join(b, 'demo.yaml'), yaml('Từ B'));

    const { presets, errors } = loadPresets([a, path.join(tmp, 'khong-co'), b]);
    const ids = presets.map((p) => p.id).sort();
    assert.deepEqual(ids, ['demo', 'other']);
    const demo = presets.find((p) => p.id === 'demo');
    assert.equal(demo.name, 'Từ B');
    assert.equal(demo.file, path.join(b, 'demo.yaml'));
    assert.match(demo.yaml, /Từ B/);
    assert.equal(errors.length, 2, JSON.stringify(errors));
    const broken = errors.find((e) => e.file.endsWith('broken.yaml'));
    assert.match(broken.message, /YAML/);
    const invalid = errors.find((e) => e.file.endsWith('invalid.yaml'));
    assert.match(invalid.message, /steps/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadPresets: trùng id trong cùng thư mục → lỗi, giữ file đầu', () => {
  const tmp = tmpdir();
  try {
    const y = (name) => `id: same\nname: ${name}\nchannel: c\nsteps:\n  - id: s\n    prompt: p\n    outputs: [a.md]\n`;
    fs.writeFileSync(path.join(tmp, 'a.yaml'), y('Đầu'));
    fs.writeFileSync(path.join(tmp, 'b.yaml'), y('Sau'));
    const { presets, errors } = loadPresets(tmp);
    assert.equal(presets.length, 1);
    assert.equal(presets[0].name, 'Đầu');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Trùng id/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadChannels: đọc channels.yaml đầu tiên tìm thấy', () => {
  const real = loadChannels([FIXTURE_PRESETS]);
  assert.deepEqual(real.map((c) => c.id), ['tiktok']);
  assert.deepEqual(real[0], { id: 'tiktok', name: 'TikTok', platform: 'tiktok', videos_dir: null });

  const tmp = tmpdir();
  try {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, 'channels.yaml'), 'channels:\n  - id: x\n  - id: y\n    name: Y\n    platform: youtube\n');
    assert.deepEqual(loadChannels([a, b]), [
      { id: 'x', name: 'x', platform: null, videos_dir: null },
      { id: 'y', name: 'Y', platform: 'youtube', videos_dir: null },
    ]);
    assert.deepEqual(loadChannels([path.join(tmp, 'none')]), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('presetDirs: repo trước, home sau', () => {
  assert.deepEqual(presetDirs('/h'), [REPO_PRESETS, '/h/presets']);
  assert.deepEqual(presetDirs(), [REPO_PRESETS]);
});
