// Preset YAML: nạp, kiểm hợp lệ, chuẩn hóa, render template (hợp đồng M1 §3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expandHome, SLUG_RE, shellQuote } from './paths.js';

/** Thư mục gốc repo = thư mục cha của server/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GATE_MODES = ['manual', 'auto_if_checks', 'auto_after', 'auto'];
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DIR = 'projects/{slug}';

// Placeholder dạng {tên} hoặc {a.b}; bỏ qua ${...} của shell.
const PLACEHOLDER_RE = /(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)\}/g;
const BASE_PLACEHOLDERS = new Set(['slug', 'title', 'feedback', 'skill', 'prev.summary']);
const FEEDBACK_PREFIX = '\n\nGóp ý của người dùng cho lượt này:\n';

const STEP_KEYS = new Set(['id', 'name', 'prompt', 'outputs', 'checks', 'gate', 'cost', 'resources', 'manual', 'timeout', 'timeout_ms', 'model']);
const PRESET_KEYS = new Set(['id', 'name', 'channel', 'format', 'project_dir', 'skills', 'vars', 'permissions', 'defaults', 'steps', 'file', 'yaml']);

// Danh sách thư mục preset theo thứ tự ưu tiên tăng dần: <repo>/presets rồi <home>/presets.
export function presetDirs(home) {
  const dirs = [path.join(REPO_ROOT, 'presets')];
  if (home) dirs.push(path.join(home, 'presets'));
  return dirs;
}

// '20m' → 1200000, '1h30m' → 5400000, '90s', '500ms', '2d'; số (hoặc chuỗi số) → ms; sai → throw.
export function parseDuration(s) {
  if (typeof s === 'number') {
    if (Number.isFinite(s) && s >= 0) return s;
    throw new Error(`Thời lượng không hợp lệ: ${s}`);
  }
  if (typeof s !== 'string') throw new Error(`Thời lượng không hợp lệ: ${JSON.stringify(s)}`);
  const t = s.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(t)) return Number(t);
  if (!t || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(t)) {
    throw new Error(`Thời lượng không hợp lệ: "${s}" (ví dụ: 90s, 20m, 1h, 1h30m)`);
  }
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) total += Number(m[1]) * unit[m[2]];
  return Math.round(total);
}

function placeholderValue(name, ctx) {
  switch (name) {
    case 'slug': return ctx.slug == null ? '' : String(ctx.slug);
    case 'title': return ctx.title == null ? '' : String(ctx.title);
    case 'skill': {
      const sk = Array.isArray(ctx.skill) ? ctx.skill[0] : ctx.skill;
      return sk == null ? '' : String(sk);
    }
    case 'feedback': {
      const fb = ctx.feedback;
      return typeof fb === 'string' && fb.trim() ? FEEDBACK_PREFIX + fb : '';
    }
    case 'prev.summary': {
      const sum = ctx.prev && ctx.prev.summary;
      return sum == null ? '' : String(sum);
    }
    default:
      if (name.startsWith('vars.')) {
        const k = name.slice(5);
        const vars = ctx.vars;
        if (vars && typeof vars === 'object' && Object.hasOwn(vars, k)) return vars[k] == null ? '' : String(vars[k]);
      }
      return undefined; // placeholder lạ → giữ nguyên
  }
}

// Thay placeholder §3.2 trong str bằng giá trị từ ctx; placeholder lạ giữ nguyên.
// opts.shell === true → mỗi giá trị được bọc nháy đơn kiểu POSIX.
export function renderTemplate(str, ctx = {}, opts = {}) {
  if (str == null) return '';
  const c = ctx || {};
  return String(str).replace(PLACEHOLDER_RE, (whole, name) => {
    const v = placeholderValue(name, c);
    if (v === undefined) return whole;
    return opts.shell === true ? shellQuote(v) : v;
  });
}

// Liệt kê placeholder trong chuỗi không thuộc bộ §3.2 (vars.x phải có trong vars).
export function unknownPlaceholders(str, vars = {}) {
  const out = [];
  if (typeof str !== 'string') return out;
  for (const m of str.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (BASE_PLACEHOLDERS.has(name)) continue;
    if (name.startsWith('vars.') && vars && Object.hasOwn(vars, name.slice(5))) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const show = (v) => (v === undefined ? '(trống)' : JSON.stringify(v));
const pick = (obj, known) => Object.fromEntries(Object.entries(obj).filter(([k]) => !known.has(k)));

function isAbsLike(p) {
  return path.isAbsolute(p) || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p);
}
function hasDotDot(p) {
  return p.split(/[\\/]+/).includes('..');
}

function normalizeGate(g, where, bad) {
  if (g == null) return null;
  const gate = typeof g === 'string' ? { mode: g } : g;
  if (!isObj(gate)) {
    bad(`${where}: "gate" phải là object {mode, after?}.`);
    return null;
  }
  if (!GATE_MODES.includes(gate.mode)) {
    bad(`${where}: gate.mode ${show(gate.mode)} không hợp lệ (chọn: ${GATE_MODES.join(', ')}).`);
    return null;
  }
  const out = { mode: gate.mode };
  if (gate.mode === 'auto_after') {
    const after = gate.after ?? gate.after_ms;
    if (after == null) bad(`${where}: gate "auto_after" cần trường "after" (ví dụ 30m).`);
    else {
      try {
        out.after_ms = parseDuration(after);
      } catch {
        bad(`${where}: gate.after ${show(after)} không hợp lệ (ví dụ 30m, 1h).`);
      }
    }
  }
  return out;
}

function checkPlaceholders(str, field, vars, bad) {
  const unk = unknownPlaceholders(str, vars);
  if (unk.length) {
    bad(`${field}: placeholder không hợp lệ ${unk.map((n) => `{${n}}`).join(', ')} ` +
      '(chỉ dùng {slug} {title} {feedback} {skill} {prev.summary} {vars.<tên có trong vars>}).');
  }
}

function strList(v, field, bad) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    bad(`${field} phải là danh sách chuỗi.`);
    return [];
  }
  return [...v];
}

function presetError(problems, file) {
  const msg = problems.length === 1
    ? problems[0]
    : `Quy trình có ${problems.length} lỗi:\n` + problems.map((p, i) => `${i + 1}) ${p}`).join('\n');
  const err = new Error(msg);
  err.code = 'EPRESET';
  err.problems = problems;
  err.file = file;
  return err;
}

// Kiểm hợp lệ + chuẩn hóa preset thô (đã parse YAML) theo §3.1; sai → throw Error liệt kê mọi lỗi.
export function validatePreset(raw, file) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (!isObj(raw)) throw presetError(['Quy trình phải là một object YAML (id, name, steps…).'], file);

  if (typeof raw.id !== 'string' || !SLUG_RE.test(raw.id)) {
    bad(`Trường "id" phải dạng slug (chữ thường a-z, số, dấu "-"), hiện là ${show(raw.id)}.`);
  }
  if (!nonEmpty(raw.name)) bad('Thiếu trường "name" (tên quy trình).');
  if (raw.channel != null && !nonEmpty(raw.channel)) bad('Trường "channel" phải là id kênh (hoặc bỏ trống).');
  const format = raw.format ?? 'short';
  if (format !== 'short' && format !== 'long') bad(`Trường "format" phải là "short" hoặc "long", hiện là ${show(raw.format)}.`);

  const vars = {};
  if (raw.vars != null) {
    if (!isObj(raw.vars)) bad('Trường "vars" phải là object {tên: giá trị}.');
    else {
      for (const [k, v] of Object.entries(raw.vars)) {
        if (!/^[A-Za-z0-9_-]+$/.test(k)) bad(`vars: tên biến "${k}" không hợp lệ (chỉ chữ, số, "_", "-").`);
        if (v !== null && typeof v === 'object') bad(`vars.${k}: giá trị phải là chuỗi, số hoặc boolean.`);
        vars[k] = v;
      }
    }
  }

  const project_dir = raw.project_dir ?? DEFAULT_PROJECT_DIR;
  if (!nonEmpty(project_dir)) bad('Trường "project_dir" phải là chuỗi (ví dụ ~/Videos/{slug}).');
  else checkPlaceholders(project_dir, 'project_dir', vars, bad);

  const baseDir = file ? path.dirname(path.resolve(file)) : REPO_ROOT;
  let skills = [];
  if (raw.skills != null) {
    const list = typeof raw.skills === 'string' ? [raw.skills] : raw.skills;
    if (!Array.isArray(list) || list.some((s) => !nonEmpty(s))) bad('Trường "skills" phải là danh sách đường dẫn.');
    else skills = list.map((s) => path.resolve(baseDir, expandHome(s.trim())));
  }

  const permissions = { allow: [], ask: [], deny: [] };
  if (raw.permissions != null) {
    if (!isObj(raw.permissions)) bad('Trường "permissions" phải là object {allow, ask, deny}.');
    else for (const k of ['allow', 'ask', 'deny']) permissions[k] = strList(raw.permissions[k], `permissions.${k}`, bad);
  }

  const rawDefaults = raw.defaults ?? {};
  const defaults = { gate: { mode: 'manual' }, timeout_ms: DEFAULT_TIMEOUT_MS };
  if (!isObj(rawDefaults)) bad('Trường "defaults" phải là object {gate, timeout}.');
  else {
    Object.assign(defaults, pick(rawDefaults, new Set(['gate', 'timeout', 'timeout_ms', 'session'])));
    if (rawDefaults.session != null && !['step', 'project'].includes(rawDefaults.session)) bad('defaults.session phải là "step" hoặc "project".');
    const g = normalizeGate(rawDefaults.gate, 'defaults', bad);
    if (g) defaults.gate = g;
    const to = rawDefaults.timeout ?? rawDefaults.timeout_ms;
    if (to != null) {
      try {
        defaults.timeout_ms = parseDuration(to);
      } catch {
        bad(`defaults.timeout ${show(to)} không hợp lệ (ví dụ 20m, 2h).`);
      }
    }
  }

  const steps = [];
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    bad('Trường "steps" phải là danh sách có ít nhất 1 bước.');
  } else {
    const seen = new Set();
    raw.steps.forEach((s, i) => {
      const label = isObj(s) && typeof s.id === 'string' ? `Bước "${s.id}" (steps[${i}])` : `Bước steps[${i}]`;
      if (!isObj(s)) {
        bad(`${label}: phải là object.`);
        return;
      }
      const key = s.id;
      if (typeof key !== 'string' || !SLUG_RE.test(key)) {
        bad(`${label}: "id" phải dạng slug (chữ thường a-z, số, dấu "-"), hiện là ${show(key)}.`);
      } else if (seen.has(key)) {
        bad(`${label}: "id" bị trùng với bước khác.`);
      }
      seen.add(key);

      if (s.manual != null && typeof s.manual !== 'boolean') bad(`${label}: "manual" phải là true/false.`);
      const manual = s.manual === true;
      if (s.name != null && !nonEmpty(s.name)) bad(`${label}: "name" phải là chuỗi.`);
      const name = nonEmpty(s.name) ? s.name : String(key ?? `Bước ${i + 1}`);

      let prompt = '';
      if (s.prompt != null && typeof s.prompt !== 'string') bad(`${label}: "prompt" phải là chuỗi.`);
      else if (typeof s.prompt === 'string') prompt = s.prompt;
      if (!manual && !prompt.trim()) bad(`${label}: thiếu "prompt" (chỉ bước manual: true mới được bỏ trống).`);
      if (prompt) checkPlaceholders(prompt, `${label} prompt`, vars, bad);

      let outputs = [];
      if (s.outputs == null) {
        if (!manual) bad(`${label}: thiếu "outputs" (danh sách glob đầu ra trong thư mục dự án).`);
      } else if (!Array.isArray(s.outputs) || s.outputs.some((o) => typeof o !== 'string')) {
        bad(`${label}: "outputs" phải là danh sách chuỗi.`);
      } else {
        outputs = [...s.outputs];
        if (!manual && outputs.length === 0) bad(`${label}: "outputs" phải có ít nhất 1 mục.`);
        for (const o of outputs) {
          if (!o.trim()) { bad(`${label}: "outputs" có mục rỗng.`); continue; }
          if (o.includes('\0')) { bad(`${label}: output ${show(o)} chứa ký tự không hợp lệ.`); continue; }
          if (isAbsLike(o)) { bad(`${label}: output ${show(o)} không được là đường dẫn tuyệt đối (phải nằm trong thư mục dự án).`); continue; }
          if (hasDotDot(o)) { bad(`${label}: output ${show(o)} không được chứa "..".`); continue; }
          const unk = unknownPlaceholders(o, vars);
          if (unk.length) { checkPlaceholders(o, `${label} output ${show(o)}`, vars, bad); continue; }
          // Kiểm cả giá trị thật sau khi thay {vars.*}: không được ra ngoài thư mục dự án.
          const eff = renderTemplate(o, { slug: 'slug', title: 'title', vars });
          if (eff !== o && (isAbsLike(eff) || hasDotDot(eff))) {
            bad(`${label}: output ${show(o)} sau khi thay biến thành ${show(eff)} — nằm ngoài thư mục dự án (phải là đường dẫn tương đối, không "..").`);
          }
        }
      }

      const checks = [];
      if (s.checks != null) {
        if (!Array.isArray(s.checks)) bad(`${label}: "checks" phải là danh sách {name, run}.`);
        else {
          s.checks.forEach((c, j) => {
            if (!isObj(c) || !nonEmpty(c.run)) {
              bad(`${label}: checks[${j}] phải có "run" (lệnh shell).`);
              return;
            }
            if (c.name != null && !nonEmpty(c.name)) bad(`${label}: checks[${j}].name phải là chuỗi.`);
            checkPlaceholders(c.run, `${label} checks[${j}].run`, vars, bad);
            checks.push({ ...c, name: nonEmpty(c.name) ? c.name : `Kiểm tra ${j + 1}`, run: c.run });
          });
        }
      }

      const ownGate = normalizeGate(s.gate, label, bad);
      const gate = ownGate || (manual ? { mode: 'manual' } : { ...defaults.gate });
      if ((gate.mode === 'auto_if_checks' || gate.mode === 'auto_after') && checks.length === 0) {
        bad(`${label}: cổng "${gate.mode}" cần ít nhất 1 kiểm tra (checks) — không thì bước sẽ tự duyệt mà không kiểm gì.`);
      }

      let cost = null;
      if (s.cost != null) {
        if (!isObj(s.cost) || !nonEmpty(s.cost.service)) bad(`${label}: "cost" phải có "service" (ví dụ elevenlabs).`);
        else {
          if (s.cost.always_ask != null && typeof s.cost.always_ask !== 'boolean') bad(`${label}: cost.always_ask phải là true/false.`);
          const est = s.cost.estimate;
          if (est != null && typeof est !== 'string' && typeof est !== 'number') bad(`${label}: cost.estimate phải là chuỗi hoặc số.`);
          cost = {
            ...s.cost,
            service: s.cost.service,
            estimate: est == null ? null : String(est),
            always_ask: s.cost.always_ask !== false,
          };
          // free_fallback: tên phương án miễn phí (vd. "Giọng VieNeu miễn phí") — cho phép chạy mà không duyệt chi phí.
          if (s.cost.free_fallback != null) {
            if (typeof s.cost.free_fallback !== 'string' || !s.cost.free_fallback.trim()) bad(`${label}: cost.free_fallback phải là chuỗi (tên phương án miễn phí).`);
            else cost.free_fallback = s.cost.free_fallback.trim().slice(0, 80);
          }
        }
      }

      const resources = strList(s.resources, `${label}: "resources"`, bad);

      let timeout_ms = defaults.timeout_ms;
      const to = s.timeout ?? s.timeout_ms;
      if (to != null) {
        try {
          timeout_ms = parseDuration(to);
        } catch {
          bad(`${label}: timeout ${show(to)} không hợp lệ (ví dụ 20m, 1h).`);
        }
      }

      // model: opus | sonnet | haiku (alias) hoặc tên đầy đủ; trống = theo mặc định của máy.
      let model;
      if (s.model != null && s.model !== '') {
        if (typeof s.model === 'string' && /^[A-Za-z0-9._\[\]-]{1,64}$/.test(s.model)) model = s.model;
        else bad(`${label}: model ${show(s.model)} không hợp lệ (ví dụ opus, sonnet, haiku).`);
      }
      steps.push({
        ...pick(s, STEP_KEYS),
        key, name, ord: i, prompt, outputs, checks, gate, cost, resources, manual, timeout_ms,
        ...(model ? { model } : {}),
      });
    });
  }

  if (problems.length) throw presetError(problems, file);

  return {
    ...pick(raw, PRESET_KEYS),
    id: raw.id,
    name: raw.name,
    channel: nonEmpty(raw.channel) ? raw.channel : null,
    format,
    file: file ?? null,
    yaml: '',
    project_dir,
    skills,
    vars,
    permissions,
    defaults,
    steps,
  };
}

const asList = (dirs) => (dirs == null ? [] : Array.isArray(dirs) ? dirs : [dirs]);

// Đọc *.yaml (trừ channels.yaml) trong từng thư mục; thư mục sau ghi đè preset trùng id. Không throw vì 1 file hỏng.
export function loadPresets(dirs) {
  const byId = new Map();
  const errors = [];
  for (const dir of asList(dirs)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') errors.push({ file: dir, message: `Không đọc được thư mục quy trình: ${e.message}` });
      continue;
    }
    const names = entries
      .filter((d) => d.isFile() && /\.ya?ml$/i.test(d.name) && !d.name.startsWith('.') && !/^channels\.ya?ml$/i.test(d.name))
      .map((d) => d.name)
      .sort();
    const seenHere = new Map();
    for (const name of names) {
      const file = path.resolve(dir, name);
      try {
        const text = fs.readFileSync(file, 'utf8');
        let raw;
        try {
          raw = YAML.parse(text);
        } catch (e) {
          throw new Error(`YAML sai cú pháp: ${e.message}`);
        }
        const preset = validatePreset(raw, file);
        preset.yaml = text;
        preset.pipeline = raw; // bản thô để giao diện sửa lại
        if (seenHere.has(preset.id)) {
          errors.push({ file, message: `Trùng id "${preset.id}" với ${path.basename(seenHere.get(preset.id))} trong cùng thư mục — bỏ qua file này.` });
          continue;
        }
        seenHere.set(preset.id, file);
        byId.set(preset.id, preset);
      } catch (e) {
        errors.push({ file, message: e.message });
      }
    }
  }
  return { presets: [...byId.values()], errors };
}

// Đọc channels.yaml đầu tiên tìm thấy (theo thứ tự dirs) → [{id, name, platform, videos_dir}]; lỗi → thử thư mục kế, cuối cùng [].
export function loadChannels(dirs) {
  for (const dir of asList(dirs)) {
    for (const name of ['channels.yaml', 'channels.yml']) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      try {
        let raw = YAML.parse(text);
        if (isObj(raw) && Array.isArray(raw.channels)) raw = raw.channels;
        if (!Array.isArray(raw)) continue;
        return raw
          .filter((c) => isObj(c) && nonEmpty(c.id))
          .map((c) => ({
            id: c.id,
            name: nonEmpty(c.name) ? c.name : c.id,
            platform: c.platform ?? null,
            videos_dir: nonEmpty(c.videos_dir) ? expandHome(c.videos_dir.trim()) : null,
          }));
      } catch {
        continue;
      }
    }
  }
  return [];
}
