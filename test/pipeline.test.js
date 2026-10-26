import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  deletePipeline,
  durationLabel,
  formatCatalog,
  normalizeFormat,
  preparePipeline,
  savePipeline,
  suggestPipeline,
} from '../server/pipeline.js';
import { loadPresets } from '../server/presets.js';

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-pl-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ids = (p) => p.steps.map((s) => s.id);

test('durationLabel: giây, phút, phút + giây', () => {
  assert.equal(durationLabel(45), '45 giây');
  assert.equal(durationLabel(600), '10 phút');
  assert.equal(durationLabel(90), '1 phút 30 giây');
});

test('normalizeFormat: mặc định dọc 9:16 ngắn 45 s; 4K chỉ ở 16:9', () => {
  assert.deepEqual(normalizeFormat(), { orientation: 'vertical', aspect: '9:16', length: 'short', duration: 45, hd4k: false, width: 1080, height: 1920 });
  assert.deepEqual(normalizeFormat({ orientation: 'horizontal', length: 'long' }), {
    orientation: 'horizontal', aspect: '16:9', length: 'long', duration: 600, hd4k: false, width: 1920, height: 1080,
  });
  const k = normalizeFormat({ orientation: 'horizontal', aspect: '16:9', length: 'long', hd4k: true });
  assert.deepEqual([k.hd4k, k.width, k.height], [true, 3840, 2160]);
  const noK = normalizeFormat({ orientation: 'horizontal', aspect: '21:9', hd4k: true });
  assert.deepEqual([noK.hd4k, noK.width], [false, 2560]);
});

test('normalizeFormat: sai hướng/tỷ lệ/độ dài/thời lượng → 400 invalid_format', () => {
  const bad = (f, re) =>
    assert.throws(() => normalizeFormat(f), (e) => e.status === 400 && e.code === 'invalid_format' && re.test(e.message));
  bad({ orientation: 'cheo' }, /dọc, ngang hoặc vuông/);
  bad({ orientation: 'vertical', aspect: '16:9' }, /16:9 không dùng cho khung dọc/);
  bad({ length: 'vua' }, /ngắn hoặc video dài/);
  bad({ length: 'short', duration: 61 }, /15 giây đến 1 phút/);
  bad({ length: 'long', duration: 120 }, /3 phút đến 30 phút/);
  bad({ duration: 30.5 }, /thời lượng/);
});

test('suggestPipeline: video ngắn 7 bước, video dài 10 bước (Cắt Shorts tắt), đều hợp lệ', () => {
  const s = suggestPipeline({ orientation: 'vertical', aspect: '9:16', length: 'short', duration: 30 });
  assert.equal(s.id, 'ngan-doc-9x16');
  assert.equal(s.name, 'Video ngắn dọc 9:16');
  assert.equal(s.format, 'short');
  assert.deepEqual(ids(s), ['kich-ban', 'phan-canh', 'hinh-anh', 'giong-doc', 'phu-de', 'dung-video', 'goi-dang']);
  assert.deepEqual(s.vars, { orientation_label: 'dọc', aspect: '9:16', resolution: '1080x1920', duration: 30, duration_label: '30 giây' });
  assert.equal(s.channel, undefined, 'gợi ý không gắn kênh');

  const l = suggestPipeline({ orientation: 'horizontal', aspect: '16:9', length: 'long', duration: 900, hd4k: true });
  assert.equal(l.id, 'dai-ngang-16x9-4k');
  assert.equal(l.vars.resolution, '3840x2160');
  assert.equal(l.vars.duration_label, '15 phút');
  assert.equal(l.steps.length, 10);
  assert.equal(l.steps.find((x) => x.id === 'cat-shorts').enabled, false);
  assert.equal(l.steps.at(-1).id, 'goi-dang');

  // bước tốn tiền luôn hỏi trước
  for (const p of [s, l]) {
    for (const st of p.steps.filter((x) => x.cost)) assert.equal(st.cost.always_ask, true, st.id);
    const { preset } = preparePipeline(p);
    assert.equal(preset.channel, null);
  }
  // không dùng chung object giữa 2 lần gợi ý
  s.steps[0].name = 'đổi';
  assert.notEqual(suggestPipeline({}).steps[0].name, 'đổi');
});

test('formatCatalog: hướng, tỷ lệ, độ dài, thư viện bước không trùng id', () => {
  const c = formatCatalog();
  assert.deepEqual(c.orientations.map((o) => o.id), ['vertical', 'horizontal', 'square']);
  assert.deepEqual(c.aspects.filter((a) => a.hd4k).map((a) => a.id), ['16:9']);
  assert.deepEqual(c.lengths.map((l) => [l.id, l.min, l.max, l.default]), [['short', 15, 60, 45], ['long', 180, 1800, 600]]);
  const sids = c.steps.map((s) => s.id);
  assert.equal(new Set(sids).size, sids.length);
  assert.ok(c.steps.every((s) => s.enabled === true));
});

test('preparePipeline: bỏ bước tắt, tự gắn kiểm đầu ra cho bước tự duyệt, bỏ file/yaml', () => {
  const raw = suggestPipeline({ orientation: 'horizontal', length: 'long' });
  raw.file = '/x/y.yaml';
  raw.yaml = 'id: x';
  raw.steps.find((s) => s.id === 'thumbnail').enabled = false;
  const voice = raw.steps.find((s) => s.id === 'giong-doc');
  voice.gate = { mode: 'auto_if_checks' };
  const { raw: out, preset } = preparePipeline(raw);
  assert.equal(out.file, undefined);
  assert.equal(out.yaml, undefined);
  assert.ok(!ids(out).includes('thumbnail'));
  assert.ok(!ids(out).includes('cat-shorts'), 'Cắt Shorts mặc định tắt');
  assert.ok(out.steps.every((s) => !('enabled' in s)));
  assert.deepEqual(out.steps.find((s) => s.id === 'giong-doc').checks, [{ name: 'Đủ đầu ra', run: 'studio-check outputs' }]);
  assert.equal(preset.steps.length, 8);
  assert.equal(raw.steps.length, 10, 'không sửa object gốc');
});

test('preparePipeline: lỗi → EPRESET kèm danh sách problems', () => {
  const raw = suggestPipeline({});
  raw.steps[0].prompt = '';
  raw.steps[1].id = raw.steps[2].id;
  assert.throws(() => preparePipeline(raw), (e) => e.code === 'EPRESET' && e.problems.length >= 2);
  assert.throws(() => preparePipeline(null), (e) => e.code === 'EPRESET');
  assert.throws(() => preparePipeline({ ...suggestPipeline({}), steps: [] }), (e) => e.code === 'EPRESET');
});

test('savePipeline: ghi YAML vào <home>/presets, id từ tên, trùng thì -2; nạp lại được', () => {
  const raw = suggestPipeline({});
  const a = savePipeline(home, raw, 'Kênh nấu ăn');
  const b = savePipeline(home, raw, 'Kênh nấu ăn');
  assert.equal(a.id, 'kenh-nau-an');
  assert.equal(b.id, 'kenh-nau-an-2');
  assert.equal(a.file, path.join(home, 'presets', 'kenh-nau-an.yaml'));
  const y = YAML.parse(fs.readFileSync(a.file, 'utf8'));
  assert.equal(y.name, 'Kênh nấu ăn');
  assert.ok(!('file' in y) && !('yaml' in y));
  const { presets, errors } = loadPresets([path.join(home, 'presets')]);
  assert.deepEqual(errors, []);
  assert.deepEqual(presets.map((p) => p.id).sort(), ['kenh-nau-an', 'kenh-nau-an-2']);

  // tên trùng file kênh không ghi đè channels.yaml
  assert.equal(savePipeline(home, raw, 'channels').id, 'quy-trinh-channels');
  assert.equal(fs.existsSync(path.join(home, 'presets', 'channels.yaml')), false);
});

test('savePipeline: tên rỗng/quá dài → invalid_format; quy trình lỗi → EPRESET, không để file', () => {
  const raw = suggestPipeline({});
  assert.throws(() => savePipeline(home, raw, '   '), (e) => e.code === 'invalid_format');
  assert.throws(() => savePipeline(home, raw, 'x'.repeat(81)), (e) => e.code === 'invalid_format');
  const broken = { ...raw, steps: [{ ...raw.steps[0], prompt: '' }] };
  assert.throws(() => savePipeline(home, broken, 'Hỏng'), (e) => e.code === 'EPRESET');
  assert.deepEqual(fs.readdirSync(path.join(home, 'presets')), []);
});

test('deletePipeline: xóa theo id trong YAML; id lạ/không phải slug → 404; không đụng channels.yaml', () => {
  const dir = path.join(home, 'presets');
  assert.throws(() => deletePipeline(home, 'khong-co'), (e) => e.status === 404 && e.code === 'pipeline_not_found');
  const saved = savePipeline(home, suggestPipeline({}), 'Của tôi');
  // file đổi tên tay vẫn tìm được theo id
  fs.renameSync(saved.file, path.join(dir, 'doi-ten.yml'));
  fs.writeFileSync(path.join(dir, 'channels.yaml'), 'channels: []\nid: channels\n');
  fs.writeFileSync(path.join(dir, 'hong.yaml'), '{: hỏng');
  assert.throws(() => deletePipeline(home, '../x'), (e) => e.status === 404);
  assert.throws(() => deletePipeline(home, 'channels'), (e) => e.status === 404);
  assert.deepEqual(deletePipeline(home, saved.id), { ok: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['channels.yaml', 'hong.yaml']);
});
