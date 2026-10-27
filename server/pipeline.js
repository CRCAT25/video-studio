// Quy trình làm video: định dạng (hướng, tỷ lệ, độ dài), gợi ý quy trình đầy đủ, lưu/xóa "Quy trình của tôi" (YAML trong <home>/presets).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { slugify, isValidSlug } from './paths.js';
import { validatePreset } from './presets.js';

export const ORIENTATIONS = {
  vertical: { label: 'Dọc', aspects: ['9:16', '4:5'] },
  horizontal: { label: 'Ngang', aspects: ['16:9', '21:9'] },
  square: { label: 'Vuông', aspects: ['1:1'] },
};

// Kích thước khung hình theo tỷ lệ; hd4k chỉ có ở 16:9.
export const ASPECTS = {
  '9:16': { width: 1080, height: 1920, use: 'TikTok, Reels, Shorts' },
  '4:5': { width: 1080, height: 1350, use: 'Bảng tin Facebook, Instagram' },
  '16:9': { width: 1920, height: 1080, use: 'YouTube, màn hình ngang', hd4k: { width: 3840, height: 2160 } },
  '21:9': { width: 2560, height: 1080, use: 'Phim điện ảnh, màn rộng' },
  '1:1': { width: 1080, height: 1080, use: 'Bảng tin vuông' },
};

// Độ dài (giây): ngắn 15–60 s, dài 3–30 phút.
export const LENGTHS = {
  short: { label: 'Video ngắn', min: 15, max: 60, default: 45 },
  long: { label: 'Video dài', min: 180, max: 1800, default: 600 },
};

const DEFAULT_PERMISSIONS = {
  allow: ['Edit', 'Write', 'Read', 'Bash(ffmpeg *)', 'Bash(ffprobe *)', 'Bash(python3 *)', 'Bash(sed *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(wc *)'],
  ask: ['Bash(rm *)', 'Bash(curl *)'],
  deny: ['Bash(git push*)', 'Bash(sudo *)'],
};
const OUTPUT_CHECK = { name: 'Đủ đầu ra', run: 'studio-check outputs' };
const COST_NOTE = 'Trước khi gọi dịch vụ trả phí: gọi studio_cost_request kèm ước tính và chờ duyệt.';

// Thư viện bước. Mỗi bước: id, name, prompt, outputs, gate, (cost, checks, manual, enabled).
const S = {
  research: {
    id: 'nghien-cuu', name: 'Nghiên cứu & dàn ý', model: 'opus',
    prompt: 'Tìm hiểu chủ đề "{title}": khán giả, góc nhìn riêng, 5–7 ý chính có nguồn. Viết dàn ý theo chương vào outline.md. {feedback}',
    outputs: ['outline.md'], gate: { mode: 'manual' },
  },
  idea: {
    id: 'kich-ban', name: 'Ý tưởng & kịch bản', model: 'opus',
    prompt: 'Từ ý tưởng "{title}": chọn 1 lời hứa cho khán giả, viết 3 hook, chọn hook mạnh nhất. ' +
      'Viết lời đọc dài khoảng {vars.duration_label} vào script.md, câu ngắn, dễ nghe. {feedback}',
    outputs: ['script.md'], gate: { mode: 'manual' },
  },
  script: {
    id: 'kich-ban', name: 'Kịch bản', model: 'opus',
    prompt: 'Viết lời đọc đầy đủ theo outline.md, dài khoảng {vars.duration_label}: mở đầu giữ chân trong 30 giây, ' +
      'mỗi chương một ý, kết có lời kêu gọi. Ghi vào script.md. {feedback}',
    outputs: ['script.md'], gate: { mode: 'manual' },
  },
  storyboard: {
    id: 'phan-canh', name: 'Phân cảnh', model: 'sonnet',
    prompt: 'Chia script.md thành các cảnh khung {vars.aspect} ({vars.orientation_label}). Mỗi cảnh: lời đọc, hình ảnh, chuyển động, thời lượng. ' +
      'Ghi storyboard.md và project.json (mảng "scenes"). {feedback}',
    outputs: ['storyboard.md', 'project.json'], checks: [OUTPUT_CHECK], gate: { mode: 'auto_if_checks' },
  },
  visuals: {
    id: 'hinh-anh', name: 'Hình ảnh & cảnh quay', model: 'sonnet',
    prompt: 'Dựng hình cho từng cảnh trong project.json bằng code chạy trên máy (canvas/SVG/three.js, biểu đồ, chữ, số, ffmpeg) và tài nguyên miễn phí CC0 nếu cần. Xuất PNG đúng khung {vars.resolution} vào images/, tên theo mã cảnh. Giữ màu và phông thống nhất, không logo hay người thật. Không gọi dịch vụ sinh ảnh trả phí. Sau khi xong ảnh, dựng luôn 3 clip xem thử dài khoảng 5–8 giây vào previews/ (preview-1.mp4…preview-3.mp4), mỗi clip ghép 2–3 ảnh liền nhau với chuyển động nhẹ (zoom/lướt) bằng ffmpeg, độ phân giải thấp (khoảng 960 ngang) để xem nhanh; chọn các cảnh tiêu biểu khác nhau (mở đầu, giữa, cao trào). {feedback}',
    outputs: ['images/*', 'previews/*.mp4'], gate: { mode: 'manual' },
  },
  voice: {
    id: 'giong-doc', name: 'Giọng đọc', model: 'haiku',
    prompt: 'Thu giọng đọc từ script.md đã duyệt, nhịp tự nhiên, xuất audio/voice.wav. ' + COST_NOTE + ' {feedback}',
    outputs: ['audio/*'], cost: { service: 'Giọng đọc AI', estimate: 'chars(script.md)', always_ask: true }, gate: { mode: 'manual' },
  },
  subtitles: {
    id: 'phu-de', name: 'Phụ đề', model: 'haiku',
    prompt: 'Tạo phụ đề subtitles.srt khớp giọng đọc, mỗi dòng ngắn, đặt trong vùng an toàn của khung {vars.aspect}. {feedback}',
    outputs: ['subtitles.srt'], checks: [OUTPUT_CHECK], gate: { mode: 'auto_if_checks' },
  },
  edit: {
    id: 'dung-video', name: 'Dựng & nhạc', model: 'haiku',
    prompt: 'Ghép hình, giọng, phụ đề và nhạc nền thành exports/video.mp4, {vars.resolution}, dài khoảng {vars.duration_label}. ' +
      'Kiểm 2 giây đầu, nhịp cắt, cân âm lượng giọng/nhạc. {feedback}',
    outputs: ['exports/*.mp4'], resources: ['render'], gate: { mode: 'manual' },
  },
  review: { id: 'xem-lai', name: 'Xem lại toàn bộ', manual: true, outputs: [], gate: { mode: 'manual' } },
  thumbnail: {
    id: 'thumbnail', name: 'Thumbnail', model: 'haiku',
    prompt: 'Thiết kế 2 phương án thumbnail 1280x720: chữ ít, tương phản cao, khớp hook. Lưu thumbnails/. {feedback}',
    outputs: ['thumbnails/*'], gate: { mode: 'manual' },
  },
  shorts: {
    id: 'cat-shorts', name: 'Cắt Shorts', model: 'haiku', enabled: false,
    prompt: 'Chọn 2–3 đoạn hay nhất (dưới 60 giây) từ exports/video.mp4, cắt sang khung dọc 1080x1920 kèm phụ đề, lưu shorts/. {feedback}',
    outputs: ['shorts/*.mp4'], resources: ['render'], gate: { mode: 'manual' },
  },
  deliver: {
    id: 'goi-dang', name: 'Gói đăng', model: 'haiku',
    prompt: 'Chuẩn bị publish.md: 3 tiêu đề (đánh dấu 1 đề xuất), mô tả có chương (nếu có), hashtag, bình luận ghim, ghi chú nội dung AI. Không thêm mục ghi công. ' +
      'Tên thư mục giao hàng lấy từ tiêu đề đề xuất (tiếng Việt có dấu, không ngày, không slug; thay ":" bằng " - ", bỏ / ? * " < > |). ' +
      'Chép (không di chuyển) mp4, phụ đề .srt, thumbnail và publish.md vào videos/<Tiêu đề>/ rồi kiểm từng file bằng cmp; hỏi trước khi ghi đè bản đã giao. Liệt kê file cần đăng. {feedback}',
    outputs: ['publish.md'], checks: [OUTPUT_CHECK], gate: { mode: 'auto_if_checks' },
  },
};

const SHORT_FLOW = ['idea', 'storyboard', 'visuals', 'voice', 'subtitles', 'edit', 'deliver'];
const LONG_FLOW = ['research', 'script', 'storyboard', 'visuals', 'voice', 'edit', 'review', 'thumbnail', 'shorts', 'deliver'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// "45 giây" / "10 phút" / "1 phút 30 giây".
export function durationLabel(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (!m) return `${s} giây`;
  return s ? `${m} phút ${s} giây` : `${m} phút`;
}

function formatError(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'invalid_format';
  return e;
}

// Chuẩn hóa lựa chọn định dạng; sai → throw (status 400). Thiếu → mặc định dọc 9:16, ngắn.
export function normalizeFormat({ orientation = 'vertical', aspect, length = 'short', duration, hd4k = false } = {}) {
  const o = ORIENTATIONS[orientation];
  if (!o) throw formatError('Hướng khung hình phải là dọc, ngang hoặc vuông.');
  const a = aspect ?? o.aspects[0];
  if (!o.aspects.includes(a)) throw formatError(`Tỷ lệ ${a} không dùng cho khung ${o.label.toLowerCase()}.`);
  const len = LENGTHS[length];
  if (!len) throw formatError('Độ dài phải là video ngắn hoặc video dài.');
  const d = duration == null || duration === '' ? len.default : Number(duration);
  if (!Number.isInteger(d) || d < len.min || d > len.max) {
    throw formatError(`${len.label}: thời lượng từ ${durationLabel(len.min)} đến ${durationLabel(len.max)}.`);
  }
  const size = hd4k === true && ASPECTS[a].hd4k ? ASPECTS[a].hd4k : ASPECTS[a];
  return { orientation, aspect: a, length, duration: d, hd4k: size !== ASPECTS[a], width: size.width, height: size.height };
}

// Tên gợi ý: "Video ngắn dọc 9:16".
export function formatName(f) {
  return `${LENGTHS[f.length].label} ${ORIENTATIONS[f.orientation].label.toLowerCase()} ${f.aspect}${f.hd4k ? ' 4K' : ''}`;
}

// Gợi ý quy trình đầy đủ (object thô, dạng YAML preset) cho một định dạng.
export function suggestPipeline(input = {}) {
  const f = normalizeFormat(input);
  const flow = f.length === 'long' ? LONG_FLOW : SHORT_FLOW;
  return {
    id: slugify(`${f.length === 'long' ? 'dai' : 'ngan'}-${ORIENTATIONS[f.orientation].label}-${f.aspect.replace(':', 'x')}${f.hd4k ? '-4k' : ''}`),
    name: formatName(f),
    format: f.length,
    orientation: f.orientation,
    aspect: f.aspect,
    project_dir: 'projects/{slug}',
    vars: {
      orientation_label: ORIENTATIONS[f.orientation].label.toLowerCase(),
      aspect: f.aspect,
      resolution: `${f.width}x${f.height}`,
      duration: f.duration,
      duration_label: durationLabel(f.duration),
    },
    permissions: clone(DEFAULT_PERMISSIONS),
    defaults: { gate: { mode: 'manual' }, timeout: '1h', session: 'step' },
    steps: flow.map((k) => ({ enabled: true, ...clone(S[k]) })),
  };
}

// Danh mục cho giao diện: hướng, tỷ lệ, độ dài, và bước có thể thêm.
export function formatCatalog() {
  return {
    orientations: Object.entries(ORIENTATIONS).map(([id, o]) => ({ id, label: o.label, aspects: o.aspects })),
    aspects: Object.entries(ASPECTS).map(([id, a]) => ({ id, width: a.width, height: a.height, use: a.use, hd4k: !!a.hd4k })),
    lengths: Object.entries(LENGTHS).map(([id, l]) => ({ id, ...l })),
    steps: Object.values(S).filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i).map((s) => ({ ...clone(s), enabled: true })),
  };
}

// Làm sạch quy trình người dùng gửi lên: bỏ bước tắt, gắn kiểm đầu ra khi tự duyệt, rồi kiểm hợp lệ. Sai → throw EPRESET.
export function preparePipeline(raw) {
  if (!isObj(raw)) validatePreset(raw); // throw lỗi chuẩn
  const out = clone(raw);
  delete out.file;
  delete out.yaml;
  if (Array.isArray(out.steps)) {
    out.steps = out.steps
      .filter((s) => !(isObj(s) && s.enabled === false))
      .map((s) => {
        if (!isObj(s)) return s;
        const { enabled, ...step } = s;
        const auto = step.gate?.mode === 'auto_if_checks' || step.gate === 'auto_if_checks';
        if (auto && !(Array.isArray(step.checks) && step.checks.length)) step.checks = [{ ...OUTPUT_CHECK }];
        return step;
      });
  }
  return { raw: out, preset: validatePreset(out) };
}

function notFound(message) {
  const e = new Error(message);
  e.status = 404;
  e.code = 'pipeline_not_found';
  return e;
}

// Lưu thành "Quy trình của tôi": <home>/presets/<id>.yaml; id lấy từ tên, trùng thì thêm -2, -3…
export function savePipeline(home, raw, name) {
  const title = String(name ?? raw?.name ?? '').trim();
  if (!title || title.length > 80) throw formatError('Tên quy trình phải có 1–80 ký tự.');
  const dir = path.join(home, 'presets');
  fs.mkdirSync(dir, { recursive: true });
  let base = slugify(title).slice(0, 56) || 'quy-trinh';
  if (base === 'channels') base = 'quy-trinh-channels'; // channels.yaml là file kênh
  let id = base;
  for (let i = 2; fs.existsSync(path.join(dir, `${id}.yaml`)) || fs.existsSync(path.join(dir, `${id}.yml`)); i++) id = `${base}-${i}`;
  const { raw: clean } = preparePipeline({ ...raw, id, name: title });
  const file = path.join(dir, `${id}.yaml`);
  const text = `# Quy trình của tôi — tạo bởi Video Studio\n${YAML.stringify(clean, { lineWidth: 0 })}`;
  fs.writeFileSync(file, text, { flag: 'wx' });
  return { id, name: title, file };
}

// Xóa quy trình đã lưu: tìm file YAML trong <home>/presets có đúng id (chỉ thư mục này, không đụng repo).
export function deletePipeline(home, id) {
  if (!isValidSlug(id)) throw notFound('Không tìm thấy quy trình.');
  const dir = path.join(home, 'presets');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n) && !/^channels\.ya?ml$/i.test(n));
  } catch {
    /* chưa có thư mục */
  }
  for (const n of names) {
    const file = path.join(dir, n);
    let fileId;
    try {
      fileId = YAML.parse(fs.readFileSync(file, 'utf8'))?.id;
    } catch {
      continue;
    }
    if (fileId !== id) continue;
    fs.unlinkSync(file);
    return { ok: true };
  }
  throw notFound('Không tìm thấy quy trình.');
}

// Quy tắc được cấp bằng nút "Cho phép": tên công cụ nguyên khối (WebSearch, mcp__…) hoặc Bash(<lệnh> *) cho lệnh không nguy hiểm.
const GRANT_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const GRANT_BASH = /^Bash\(([A-Za-z0-9._-]{1,40}) \*\)$/;
const DANGEROUS_CMDS = new Set([
  'rm', 'sudo', 'su', 'doas', 'curl', 'wget', 'git', 'chmod', 'chown', 'kill', 'killall', 'pkill', 'dd', 'ssh', 'scp', 'sh', 'bash', 'zsh', 'fish',
  'eval', 'exec', 'xargs', 'find', 'env', 'nohup', 'osascript', 'launchctl', 'open', 'npm', 'npx', 'pnpm', 'yarn', 'brew', 'pip', 'pip3', 'mkfs',
  'diskutil', 'shutdown', 'reboot', 'security',
]);

function grantError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Kiểm quy tắc có cấp được bằng nút không; trả chính chuỗi quy tắc hoặc throw 400 invalid_permission.
// Lệnh chỉ cho phép "lần này" (không lưu): find chỉ đọc có thể cấp một lần, vì quy tắc Bash(find *) lưu lại sẽ cho cả -delete/-exec.
export const ONCE_ONLY_CMDS = new Set(['find']);

export function validateGrantRule(rule, { once = false } = {}) {
  const bad = () => grantError(400, 'invalid_permission', 'Chỉ cấp được quyền theo tên công cụ (ví dụ WebSearch) hoặc lệnh Bash an toàn (ví dụ Bash(mkdir *)); lệnh nguy hiểm như rm, curl, git phải sửa tay trong quy trình.');
  if (typeof rule !== 'string') throw bad();
  if (GRANT_TOOL.test(rule) && rule !== 'Bash') return rule;
  const m = GRANT_BASH.exec(rule);
  if (m && once && ONCE_ONLY_CMDS.has(m[1].toLowerCase())) return rule;
  if (m && !DANGEROUS_CMDS.has(m[1].toLowerCase())) return rule;
  throw bad();
}

// Thêm quy tắc vào permissions.allow của bản thô quy trình (sửa tại chỗ); trả true nếu có thay đổi.
export function addAllowTool(raw, rule) {
  validateGrantRule(rule);
  const perm = (raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : (raw.permissions = {}));
  const list = (k) => (Array.isArray(perm[k]) ? perm[k] : []);
  const whole = !rule.startsWith('Bash(');
  const hit = ['deny', 'ask'].find((k) => list(k).some((x) => x === rule || (whole && String(x).startsWith(`${rule}(`))));
  if (hit) throw grantError(409, 'permission_blocked_by_rule', `Quy trình đang để "${rule}" ở mục ${hit} — sửa tay trong quy trình nếu muốn cho phép.`);
  if (list('allow').includes(rule)) return false;
  perm.allow = [...list('allow'), rule];
  return true;
}

// Cấp quyền cho cả quy trình đã lưu (<home>/presets/<id>.yaml). Trả true nếu đã ghi, false nếu không có file/không đổi.
export function grantSavedPipeline(home, id, tool) {
  if (!isValidSlug(id)) return false;
  const dir = path.join(home, 'presets');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n) && !/^channels\.ya?ml$/i.test(n));
  } catch {
    return false;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    let raw;
    try {
      raw = YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!raw || raw.id !== id) continue;
    if (!addAllowTool(raw, tool)) return false;
    fs.writeFileSync(file, `# Quy trình của tôi — tạo bởi Video Studio\n${YAML.stringify(raw, { lineWidth: 0 })}`);
    return true;
  }
  return false;
}

// Gắn thư mục skill vào quy trình đã lưu (<home>/presets/<id>.yaml) nếu có; trả true khi đã ghi.
export function attachSavedSkill(home, id, skillDir) {
  if (!isValidSlug(id)) return false;
  const dir = path.join(home, 'presets');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n) && !/^channels\.ya?ml$/i.test(n));
  } catch {
    return false;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    let raw;
    try {
      raw = YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!raw || raw.id !== id) continue;
    const list = Array.isArray(raw.skills) ? raw.skills : raw.skills ? [raw.skills] : [];
    if (list.map((s) => path.resolve(String(s))).includes(path.resolve(skillDir))) return false;
    raw.skills = [...list, skillDir];
    fs.writeFileSync(file, `# Quy trình của tôi — tạo bởi Video Studio\n${YAML.stringify(raw, { lineWidth: 0 })}`);
    return true;
  }
  return false;
}

// Quyền cấp cho mọi dự án (nút "Cho phép tất cả các dự án"): <home>/global-permissions.json {allow: [...]}.
export function readGlobalAllow(home) {
  if (!home) return [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'global-permissions.json'), 'utf8'));
    return Array.isArray(j?.allow) ? j.allow.filter((r) => { try { return validateGrantRule(r) === r; } catch { return false; } }) : [];
  } catch {
    return [];
  }
}

// Thêm quy tắc vào danh sách chung; trả true nếu có thay đổi.
export function addGlobalAllow(home, rule) {
  validateGrantRule(rule);
  const list = readGlobalAllow(home);
  if (list.includes(rule)) return false;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'global-permissions.json'), `${JSON.stringify({ allow: [...list, rule] }, null, 2)}\n`);
  return true;
}

// Model mặc định của app cho bước chưa chọn model: <home>/settings.json {default_model}.
const MODEL_RE = /^[A-Za-z0-9._[\]-]{1,64}$/;
export function readDefaultModel(home) {
  if (!home) return '';
  try {
    const m = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))?.default_model;
    return typeof m === 'string' && MODEL_RE.test(m) ? m : '';
  } catch {
    return '';
  }
}

export function writeDefaultModel(home, model) {
  const m = String(model ?? '').trim();
  if (m && !MODEL_RE.test(m)) throw formatError('Tên model không hợp lệ.');
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')) || {};
  } catch {
    /* chưa có */
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify({ ...cur, default_model: m }, null, 2)}\n`);
  return m;
}
