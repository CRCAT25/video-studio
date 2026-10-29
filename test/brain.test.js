import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_BRAIN, PROMPT_BUDGET, brainPath, cleanText, createBrain, normBranch, parseBrain, serializeBrain, styleToItems } from '../server/brain.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-brain-'));
const clock = (iso = '2026-10-29T08:00:00Z') => () => new Date(iso);

test('normBranch: chuẩn hóa tên nhánh, chặn nhánh lạ / slug sai', () => {
  assert.equal(normBranch('chung'), 'Chung');
  assert.equal(normBranch(' kênh / Goc-Kham-Pha '), 'Kênh/goc-kham-pha');
  assert.equal(normBranch('Bước làm video/giong-doc'), 'Bước làm video/giong-doc');
  assert.equal(normBranch('Kênh'), null);
  assert.equal(normBranch('Chung/x'), null);
  assert.equal(normBranch('Bí mật'), null);
  assert.equal(normBranch('Kênh/../etc'), null);
});

test('parse/serialize: giữ id/src/at, dòng nối tiếp, nhánh lạ vào Chưa phân loại, bỏ chú thích lồng', () => {
  const md = [
    '# Bộ não',
    '## Phong cách',
    '- Giọng ấm <!-- id:aa11 src:style at:2026-10-01 -->',
    '- Câu ngắn',
    '  không quá 15 chữ',
    '## Kênh/goc-kham-pha',
    '- Khán giả nam 35–60 <!-- id:bb22 src:step at:2026-10-02 from:p-12 -->',
    '## Linh tinh',
    '- Mục lạ có <!-- chèn --> chú thích',
  ].join('\n');
  const br = parseBrain(md);
  assert.deepEqual(br.map((b) => b.path), ['Phong cách', 'Kênh/goc-kham-pha', 'Chưa phân loại']);
  assert.deepEqual(br[0].items[0], { id: 'aa11', text: 'Giọng ấm', src: 'style', at: '2026-10-01' });
  assert.equal(br[0].items[1].text, 'Câu ngắn\nkhông quá 15 chữ');
  assert.equal(br[1].items[0].from, 'p-12');
  assert.ok(!br[2].items[0].text.includes('<!--'));
  // Đọc lại bản đã ghi ra phải y hệt (id không có meta vẫn ổn định).
  assert.deepEqual(parseBrain(serializeBrain(br)), br);
  assert.deepEqual(parseBrain(md)[0].items[1].id, br[0].items[1].id);
});

test('cleanText / styleToItems: bỏ dòng trống, cắt dài; bỏ dòng mẫu còn trống', () => {
  assert.equal(cleanText('a\n\n\nb  '), 'a\nb');
  assert.equal(cleanText('x'.repeat(900)).length, 600);
  const items = styleToItems('# Phong cách của tôi\n\n- Chủ đề / đối tượng xem:\n- Giọng văn: ấm, gần gũi\n## Tránh\n- chửi thề\nviết thường\n');
  assert.deepEqual(items, ['Giọng văn: ấm, gần gũi', 'Tránh: chửi thề', 'Tránh: viết thường']);
});

test('createBrain: chuyển style.md cũ sang nhánh Phong cách và đổi tên file', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'style.md'), '# Phong cách của tôi\n- Giọng văn: ấm\n- Nhịp độ:\n');
  const brain = createBrain({ home, now: clock() });
  const t = brain.tree();
  assert.equal(t.branches[0].path, 'Phong cách');
  assert.equal(t.branches[0].items[0].src, 'style');
  assert.equal(t.items, 1);
  assert.ok(fs.existsSync(path.join(home, 'style.md.migrated')));
  assert.ok(!fs.existsSync(path.join(home, 'style.md')));
  assert.equal(brain.styleText(), '- Giọng văn: ấm');
});

test('add/update/remove: trùng thì không thêm, sửa giữ vị trí, xóa có sao lưu, báo thay đổi', () => {
  const home = tmp();
  const brain = createBrain({ home, now: clock() });
  let changes = 0;
  const off = brain.on(() => changes++);
  const a = brain.add('Chung', 'Luôn trả lời tiếng Việt');
  const b = brain.add('Chung', 'Ưu tiên chủ đề xe cộ');
  assert.equal(brain.add('chung', 'luôn trả lời tiếng việt.').duplicate, true);
  assert.equal(brain.tree().items, 2);
  brain.update(a.item.id, { text: 'Luôn trả lời bằng tiếng Việt' });
  assert.deepEqual(brain.read()[0].items.map((i) => i.text), ['Luôn trả lời bằng tiếng Việt', 'Ưu tiên chủ đề xe cộ']);
  brain.update(b.item.id, { branch: 'Kênh/goc-kham-pha' });
  assert.equal(brain.read().find((x) => x.path === 'Kênh/goc-kham-pha').items[0].id, b.item.id);
  brain.remove(a.item.id);
  assert.equal(brain.tree().items, 1);
  assert.equal(brain.backups()[0].reason, 'delete');
  assert.throws(() => brain.remove('khong-co'), { code: 'not_found' });
  assert.throws(() => brain.add('Bí mật', 'x'), { code: 'invalid_body' });
  assert.throws(() => brain.add('Chung', '   '), { code: 'invalid_body' });
  assert.equal(changes, 5);
  off();
  brain.add('Chung', 'mục mới');
  assert.equal(changes, 5);
  assert.deepEqual(brain.tree().history.map((h) => h.kind), ['add', 'add', 'edit', 'edit', 'delete', 'add']);
});

test('đầy 48 KB: chặn thêm (409 brain_full) nhưng vẫn cho xóa', () => {
  const home = tmp();
  const brain = createBrain({ home, now: clock() });
  let n = 0;
  assert.throws(() => {
    for (;;) brain.add('Bài học', `Bài học số ${n++} ${'y'.repeat(500)}`);
  }, { code: 'brain_full' });
  const t = brain.tree();
  assert.ok(t.bytes <= MAX_BRAIN && t.bytes > MAX_BRAIN * 0.95);
  assert.equal(t.level, 'warn');
  brain.remove(t.branches[0].items[0].id);
  assert.ok(brain.tree().items < t.items);
});

test('đề xuất: bỏ trùng với mục/đề xuất có sẵn, nhận (có sửa) thành mục, bỏ thì mất', () => {
  const home = tmp();
  const brain = createBrain({ home, now: clock() });
  brain.add('Chung', 'Thích video ngắn');
  assert.equal(brain.propose({ branch: 'Chung', text: 'thích video ngắn' }).reason, 'known');
  const p = brain.propose({ branch: 'Bài học', text: 'Không tự bấm Chạy trả phí', reason: 'bị từ chối', src: 'feedback' });
  assert.equal(p.ok, true);
  assert.equal(brain.propose({ branch: 'Bài học', text: 'Không tự bấm chạy trả phí!' }).reason, 'pending');
  const q = brain.propose({ branch: 'nhánh lạ', text: 'Kênh hợp tác với Honda' });
  assert.equal(q.proposal.branch, 'Chưa phân loại');
  const r = brain.accept(p.proposal.id, { text: 'Không bao giờ tự bấm "$ Chạy"' });
  assert.equal(r.item.src, 'feedback');
  assert.equal(r.branch, 'Bài học');
  brain.reject(q.proposal.id);
  assert.equal(brain.proposals().length, 0);
  assert.throws(() => brain.accept(q.proposal.id), { code: 'not_found' });
  assert.equal(brain.tree().items, 2);
});

test('forPrompt: bước đọc Chung/Phong cách/Kênh/Bước, trợ lý đọc Cách dùng app/Bài học; vượt ngân sách bỏ mục cũ', () => {
  const home = tmp();
  let day = 1;
  const brain = createBrain({ home, now: () => new Date(`2026-10-${String(day).padStart(2, '0')}T08:00:00Z`) });
  assert.equal(brain.forPrompt('step', { channel: 'gkp', step: 'kich-ban' }), '');
  brain.add('Chung', 'Xưng mình gọi bạn');
  brain.add('Kênh/gkp', 'Khán giả nam 35–60');
  brain.add('Kênh/khac', 'Kênh khác');
  brain.add('Bước làm video/kich-ban', 'Mở đầu bằng câu hỏi');
  brain.add('Bài học', 'Đừng bấm Đọc thử');
  brain.add('Cách dùng app', 'Duyệt ở nút Duyệt');
  const step = brain.forPrompt('step', { channel: 'gkp', step: 'kich-ban' });
  assert.match(step, /^## Bộ não/);
  assert.match(step, /Xưng mình[\s\S]*Khán giả nam[\s\S]*Mở đầu bằng câu hỏi/);
  assert.doesNotMatch(step, /Kênh khác|Đọc thử|nút Duyệt/);
  const asst = brain.forPrompt('assistant');
  assert.match(asst, /Đọc thử/);
  assert.match(asst, /nút Duyệt/);
  assert.doesNotMatch(asst, /Khán giả|Mở đầu/);
  // Nhiều mục → cắt theo ngân sách, bỏ mục cũ nhất trước.
  for (day = 2; day < 28; day++) brain.add('Phong cách', `Mục phong cách ngày ${day} ${'z'.repeat(500)}`);
  const cut = brain.forPrompt('step', { channel: 'gkp', step: 'kich-ban', budget: 4000 });
  assert.ok(Buffer.byteLength(cut) < 4300);
  assert.match(cut, /mục cũ hơn không gửi kèm/);
  assert.match(cut, /ngày 27/);
  assert.doesNotMatch(cut, /Xưng mình/);
  assert.ok(Buffer.byteLength(brain.forPrompt('step', {})) <= PROMPT_BUDGET + 400);
});

test('setStyleText: thay nhánh Phong cách, giữ id mục không đổi, để nguyên nhánh khác', () => {
  const home = tmp();
  const brain = createBrain({ home, now: clock() });
  brain.add('Chung', 'Giữ nguyên');
  brain.setStyleText('- Giọng ấm\n- Câu ngắn');
  const id = brain.read().find((b) => b.path === 'Phong cách').items[0].id;
  brain.setStyleText('- Giọng ấm\n- Không dùng tiếng lóng');
  const style = brain.read().find((b) => b.path === 'Phong cách').items;
  assert.equal(style[0].id, id);
  assert.deepEqual(style.map((i) => i.text), ['Giọng ấm', 'Không dùng tiếng lóng']);
  assert.equal(brain.read()[0].items[0].text, 'Giữ nguyên');
  brain.setStyleText('');
  assert.equal(brain.styleText(), '');
});

test('nén: kiểm bản nháp, áp dụng có sao lưu, khôi phục; bộ não đổi giữa chừng thì từ chối', () => {
  const home = tmp();
  const brain = createBrain({ home, now: clock() });
  brain.add('Chung', 'Trả lời tiếng Việt');
  brain.add('Chung', 'Trả lời bằng tiếng Việt có dấu');
  brain.add('Bài học', 'Không tự bấm Chạy');
  const before = brain.rawText();
  // Làm mất cả nhánh / không nhỏ đi → lỗi.
  assert.throws(() => brain.stagePreview({ branches: [{ path: 'Chung', items: ['Trả lời tiếng Việt có dấu'] }] }), /mất cả nhánh/);
  assert.throws(() => brain.stagePreview({ branches: [{ path: 'Chung', items: ['Trả lời tiếng Việt', 'Trả lời bằng tiếng Việt có dấu thật dài dài'] }, { path: 'Bài học', items: ['Không tự bấm Chạy'] }] }), /không nhỏ hơn/);
  const good = { branches: [{ path: 'Chung', items: ['Trả lời bằng tiếng Việt có dấu'] }, { path: 'Bài học', items: ['Không tự bấm Chạy'] }, { path: 'Kênh/moi', items: ['nhánh mới bị bỏ'] }], summary: 'Gộp 2 mục trùng' };
  const pv = brain.stagePreview(good);
  assert.ok(pv.after < pv.before);
  assert.equal(pv.branches.length, 2);
  // Giữ nguyên id của mục không đổi chữ.
  assert.equal(pv.branches[0].items[0].id, brain.read()[0].items[1].id);
  const t = brain.applyPreview(pv.id);
  assert.equal(t.items, 2);
  assert.match(t.backup, /-compact-/);
  assert.throws(() => brain.applyPreview(pv.id), { code: 'not_found' });
  // Đổi giữa chừng
  const pv2 = brain.stagePreview({ branches: [{ path: 'Chung', items: ['Tiếng Việt'] }, { path: 'Bài học', items: ['Không tự bấm Chạy'] }] });
  brain.add('Chung', 'mục chen ngang');
  assert.throws(() => brain.applyPreview(pv2.id), { code: 'brain_changed' }); // ghi mới → bản nháp lệch nội dung
  const pv3 = brain.stagePreview({ branches: [{ path: 'Chung', items: ['Tiếng Việt'] }, { path: 'Bài học', items: ['Không tự bấm Chạy'] }] });
  fs.appendFileSync(brainPath(home), '- sửa tay\n');
  assert.throws(() => brain.applyPreview(pv3.id), { code: 'brain_changed' });
  // Khôi phục về trước khi nén
  brain.restore(t.backup);
  assert.equal(brain.rawText(), before);
  assert.throws(() => brain.restore('../brain.md'), { code: 'invalid_body' });
});

test('sao lưu: giữ tối đa 10 bản mới nhất', () => {
  const home = tmp();
  let s = 0;
  const brain = createBrain({ home, now: () => new Date(Date.UTC(2026, 9, 29, 8, 0, s++)) });
  brain.add('Chung', 'a');
  for (let i = 0; i < 14; i++) brain.backup('manual');
  assert.equal(brain.backups().length, 10);
});
