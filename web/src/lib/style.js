// Phong cách quy trình: áp các lựa chọn (duyệt, giọng đọc, phụ đề, thumbnail, Shorts) lên quy trình gợi ý — thuần client, không gọi AI.
const OUTPUT_CHECK = { name: 'Đủ đầu ra', run: 'studio-check outputs' };
const KEEP_MANUAL = new Set(['dung-video', 'xem-lai']); // bước cuối/xem lại luôn do người duyệt

export const hasStep = (steps, id) => steps.some((s) => s.id === id && s.enabled !== false);

// Giá trị mặc định của các công tắc, suy từ quy trình gợi ý.
export function styleDefaults(base) {
  const steps = base?.steps || [];
  return { review: 'all', voice: hasStep(steps, 'giong-doc'), subtitles: hasStep(steps, 'phu-de'), thumbnail: hasStep(steps, 'thumbnail'), shorts: hasStep(steps, 'cat-shorts') };
}

// Thêm bước từ thư viện vào trước bước đầu tiên có id nằm trong `before`; không thấy thì thêm cuối.
function insert(steps, step, before) {
  const i = steps.findIndex((s) => before.includes(s.id));
  const next = { ...structuredClone(step), enabled: true };
  if (i < 0) steps.push(next);
  else steps.splice(i, 0, next);
}

// base: quy trình gợi ý; style: {review, voice, subtitles, thumbnail, shorts} (thiếu → mặc định); library: các bước có thể thêm.
export function applyStyle(base, style = {}, library = []) {
  if (!base) return base;
  const want = { ...styleDefaults(base), ...style };
  const lib = (id) => library.find((s) => s.id === id);
  const steps = structuredClone(base.steps || []);
  const toggle = (id, on, before) => {
    const i = steps.findIndex((s) => s.id === id);
    if (on) {
      if (i >= 0) steps[i].enabled = true;
      else if (lib(id)) insert(steps, lib(id), before);
    } else if (i >= 0) steps.splice(i, 1);
  };
  toggle('giong-doc', want.voice, ['phu-de', 'dung-video']);
  toggle('phu-de', want.subtitles, ['dung-video']);
  toggle('thumbnail', want.thumbnail, ['cat-shorts', 'goi-dang']);
  toggle('cat-shorts', want.shorts, ['goi-dang']);
  if (want.review === 'light') {
    for (const s of steps) {
      if (s.manual || s.cost || KEEP_MANUAL.has(s.id) || !(s.outputs || []).length) continue;
      s.gate = { mode: 'auto_if_checks' };
      s.checks = s.checks?.length ? s.checks : [{ ...OUTPUT_CHECK }];
    }
  }
  return { ...base, steps };
}
