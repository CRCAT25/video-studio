// ProjectService: tạo dự án, dựng view cho UI, chuyển trạng thái bước/lượt (hợp đồng M1 §5, §6, §6.1).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, isValidSlug, safeJoin, shellQuote, slugify, studioHome } from './paths.js';
import { DEFAULT_TIMEOUT_MS, renderTemplate } from './presets.js';

// Lỗi có mã HTTP + code máy đọc (§10); extra (vd {cost}) được gộp vào body JSON.
export class HttpError extends Error {
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
    if (extra && typeof extra === 'object') {
      this.extra = extra;
      for (const [k, v] of Object.entries(extra)) if (!(k in this)) this[k] = v;
    }
  }

  // Body JSON trả cho client: {error, message, ...extra}.
  toJSON() {
    return { error: this.code, message: this.message, ...(this.extra || {}) };
  }
}

export const STEP_STATES = ['pending', 'ready', 'running', 'done', 'failed', 'needs_input', 'stale', 'manual'];
export const RUNNABLE_STATES = new Set(['ready', 'done', 'failed', 'needs_input', 'stale']);
export const COMPLETABLE_STATES = new Set(['ready', 'failed', 'needs_input', 'stale', 'manual']);
const EARLIER_OK = new Set(['done', 'stale']);
const RESTORE_ON_STOP = new Set(['done', 'stale', 'failed', 'needs_input']);
const FINISH_STATES = new Set(['done', 'failed', 'needs_input', 'stopped']);
const MAX_ESTIMATE_BYTES = 20 * 1024 * 1024;

const now = () => new Date().toISOString();

// Mặc định kiểm pid còn sống: process.kill(pid, 0); EPERM = còn sống (process của user khác).
export function defaultIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Mặc định xem process qua ps: {ppid, command} hoặc null (không có / ps lỗi). Dùng để nhận diện claude mồ côi.
export function defaultInspect(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /^\s*(\d+)\s+(.*)$/s.exec(out.trim());
    return m ? { ppid: Number(m[1]), command: m[2].trim() } : null;
  } catch {
    return null;
  }
}

// Mặc định gửi tín hiệu dừng cho process mồ côi.
function defaultKill(pid) {
  process.kill(Number(pid), 'SIGTERM');
}

function asPresetList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.presets)) return v.presets;
  return [];
}

function runSummary(r) {
  if (!r) return null;
  return {
    id: r.id,
    n: r.n,
    state: r.state,
    started_at: r.started_at,
    ended_at: r.ended_at,
    summary: r.summary,
    error: r.error,
    progress_pct: r.progress_pct,
    progress_msg: r.progress_msg,
    exit_code: r.exit_code,
  };
}

function runDetail(r) {
  return {
    ...runSummary(r),
    feedback: r.feedback,
    allow_paid: r.allow_paid,
    prompt: r.prompt,
    result: r.result ?? null,
    denials: r.denials ?? null,
    usage: r.usage ?? null,
  };
}

// Tạo ProjectService từ store (db.js), presets: () => {presets, errors}, channels: () => Channel[], home ($VS_HOME).
export function createProjects({ store, presets, channels, home } = {}) {
  if (!store) throw new Error('createProjects cần store.');
  const prevStates = new Map(); // run.id → state của bước trước khi chạy (dùng khi 'stopped')

  const presetList = () => {
    try {
      return asPresetList(typeof presets === 'function' ? presets() : presets);
    } catch {
      return [];
    }
  };
  const channelList = () => {
    try {
      const c = typeof channels === 'function' ? channels() : channels;
      return Array.isArray(c) ? c : [];
    } catch {
      return [];
    }
  };
  const homeDir = () => path.resolve(home ? expandHome(home) : studioHome());
  const findPreset = (id, list = presetList()) => list.find((p) => p && p.id === id) ?? null;
  const presetStepOf = (preset, key) => preset?.steps?.find((s) => s.key === key) ?? null;
  const tplCtx = (p, preset) => ({ slug: p.id, title: p.title, vars: preset?.vars ?? {} });

  function snapshotSafe(id) {
    try {
      writeSnapshot(id);
    } catch {
      /* snapshot chỉ là bản sao tiện tra cứu — lỗi ghi không chặn luồng chính */
    }
  }

  // ---- view
  function stepSummary(s, p, preset, withOutputs) {
    const ps = presetStepOf(preset, s.key);
    const out = {
      key: s.key,
      name: s.name,
      ord: s.ord,
      state: s.state,
      gate_mode: ps?.gate?.mode ?? 'manual',
      has_cost: !!ps?.cost,
      manual: !!ps?.manual,
    };
    if (withOutputs) out.outputs = (ps?.outputs ?? []).map((o) => renderTemplate(o, tplCtx(p, preset)));
    out.run = runSummary(store.latestRunByStep(s.id));
    return out;
  }

  function projectView(p, { withOutputs = true, presetsNow = presetList(), channelsNow = channelList() } = {}) {
    const preset = findPreset(p.preset_id, presetsNow);
    const ch = p.channel_id ? channelsNow.find((c) => c && c.id === p.channel_id) : null;
    const steps = store.listSteps(p.id).map((s) => stepSummary(s, p, preset, withOutputs));
    const running = store.runningRunOf(p.id);
    const current = steps.find((s) => s.state === 'running') ?? steps.find((s) => s.state !== 'done') ?? null;
    return {
      id: p.id,
      title: p.title,
      dir: p.dir,
      preset: preset
        ? { id: preset.id, name: preset.name, format: preset.format }
        : { id: p.preset_id, name: p.preset_id, format: null },
      channel: p.channel_id
        ? ch
          ? { id: ch.id, name: ch.name ?? ch.id, platform: ch.platform ?? null }
          : { id: p.channel_id, name: p.channel_id, platform: null }
        : null,
      status: p.status,
      created_at: p.created_at,
      updated_at: p.updated_at,
      session_id: p.claude_session_id,
      session_started: p.session_started,
      steps,
      current,
      progress: { done: steps.filter((s) => s.state === 'done').length, total: steps.length },
      costs: store.costSummary(p.id),
      running_run_id: running ? running.id : null,
    };
  }

  // Trạng thái dự án sau một thay đổi: running nếu còn lượt chạy, done nếu mọi bước done, ngược lại active.
  function recomputeStatus(projectId) {
    const steps = store.listSteps(projectId);
    let status = 'active';
    if (store.runningRunOf(projectId)) status = 'running';
    else if (steps.length && steps.every((s) => s.state === 'done')) status = 'done';
    store.updateProject(projectId, { status });
    return status;
  }

  // Bước kế tiếp đang pending → ready (hoặc manual nếu preset đánh dấu manual: true).
  function advanceNext(p, step, preset) {
    const next = store.listSteps(p.id).find((s) => s.ord > step.ord);
    if (next && next.state === 'pending') {
      const ps = presetStepOf(preset, next.key);
      store.updateStep(next.id, { state: ps?.manual ? 'manual' : 'ready' });
    }
  }

  function firstBlockingEarlier(projectId, step) {
    return store.listSteps(projectId).find((s) => s.ord < step.ord && !EARLIER_OK.has(s.state)) ?? null;
  }

  // ---- API
  // Tạo dự án mới theo preset (§6 create); trả ProjectView hoặc throw HttpError 400/404/409.
  function create({ presetId, title, slug, dir } = {}) {
    const preset = findPreset(presetId);
    if (!preset) throw new HttpError(404, 'preset_not_found', `Không tìm thấy preset "${presetId ?? ''}".`);

    const t = typeof title === 'string' ? title.trim() : '';
    if (t.length < 1 || t.length > 200) {
      throw new HttpError(400, 'invalid_title', 'Tiêu đề phải có từ 1 đến 200 ký tự.');
    }

    let id;
    if (slug != null && !(typeof slug === 'string' && slug.trim() === '')) {
      id = typeof slug === 'string' ? slug.trim() : slug;
      if (!isValidSlug(id)) {
        throw new HttpError(400, 'invalid_slug', 'Slug chỉ gồm chữ thường a-z, số và dấu "-", bắt đầu bằng chữ/số, tối đa 64 ký tự.');
      }
    } else {
      id = slugify(t);
    }
    if (store.getProject(id)) throw new HttpError(409, 'slug_taken', `Slug "${id}" đã có dự án khác dùng. Hãy chọn slug khác.`);

    let abs;
    if (dir != null && !(typeof dir === 'string' && dir.trim() === '')) {
      const d = typeof dir === 'string' ? expandHome(dir.trim()) : null;
      if (!d || d.includes('\0') || !path.isAbsolute(d)) {
        throw new HttpError(400, 'invalid_dir', 'Thư mục dự án phải là đường dẫn tuyệt đối (hoặc bắt đầu bằng ~/).');
      }
      abs = path.resolve(d);
    } else {
      const rendered = expandHome(renderTemplate(preset.project_dir || 'projects/{slug}', { slug: id, vars: preset.vars ?? {} }));
      abs = path.isAbsolute(rendered) ? path.resolve(rendered) : path.resolve(homeDir(), rendered);
    }
    if (abs === path.parse(abs).root) throw new HttpError(400, 'invalid_dir', 'Không dùng thư mục gốc của ổ đĩa làm thư mục dự án.');

    const taken = store.listProjects().find((p) => path.resolve(p.dir) === abs);
    if (taken) throw new HttpError(409, 'dir_taken', `Thư mục này đã thuộc dự án "${taken.title}" (${taken.id}).`);

    try {
      const st = fs.statSync(abs, { throwIfNoEntry: false });
      if (st && !st.isDirectory()) throw new HttpError(400, 'invalid_dir', `Đường dẫn đã tồn tại nhưng không phải thư mục: ${abs}`);
      fs.mkdirSync(path.join(abs, '.studio'), { recursive: true });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'invalid_dir', `Không tạo được thư mục dự án: ${e.message}`);
    }

    try {
      store.tx(() => {
        store.insertProject({
          id,
          preset_id: preset.id,
          channel_id: preset.channel ?? null,
          title: t,
          dir: abs,
          claude_session_id: crypto.randomUUID(),
        });
        preset.steps.forEach((s, i) => {
          const state = i === 0 ? (s.manual ? 'manual' : 'ready') : 'pending';
          store.insertStep({ project_id: id, key: s.key, name: s.name, ord: i, state });
        });
      });
    } catch (e) {
      if (String(e.code || '').startsWith('SQLITE_CONSTRAINT') && store.getProject(id)) {
        throw new HttpError(409, 'slug_taken', `Slug "${id}" đã có dự án khác dùng. Hãy chọn slug khác.`);
      }
      throw e;
    }
    writeSnapshot(id);
    return view(id);
  }

  // Danh sách dự án cho màn Tổng quan (ProjectView không có steps[].outputs), mới cập nhật trước.
  function list() {
    const presetsNow = presetList();
    const channelsNow = channelList();
    return store.listProjects().map((p) => projectView(p, { withOutputs: false, presetsNow, channelsNow }));
  }

  // ProjectView của một dự án, hoặc null nếu không có.
  function view(id) {
    const p = store.getProject(id);
    return p ? projectView(p) : null;
  }

  // StepView (chi tiết bước + các lượt + lượt mới nhất + can_run + resume_cmd), hoặc null.
  function stepView(id, key) {
    const p = store.getProject(id);
    if (!p) return null;
    const s = store.getStep(id, key);
    if (!s) return null;
    const presetsNow = presetList();
    const preset = findPreset(p.preset_id, presetsNow);
    const ps = presetStepOf(preset, key);
    const project = projectView(p, { presetsNow });
    const summary = project.steps.find((x) => x.key === key) ?? stepSummary(s, p, preset, true);
    const est = ps?.cost ? estimateCost(id, key) : null;
    const step = {
      ...summary,
      prompt_template: ps?.prompt ?? '',
      checks: (ps?.checks ?? []).map((c) => ({ name: c.name, run: c.run })),
      cost: ps?.cost ? { ...ps.cost, ...(est || {}) } : null,
      timeout_ms: ps?.timeout_ms ?? preset?.defaults?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    };
    const rawRuns = store.listRunsByStep(s.id);
    const runs = rawRuns.map(runDetail);
    const latest = rawRuns.length
      ? {
          run: runs[0],
          artifacts: store.listArtifacts(rawRuns[0].id),
          checks: store.listChecks(rawRuns[0].id),
          costs: store.listCostsByRun(rawRuns[0].id),
        }
      : null;
    // Nút Chạy: bỏ qua bước xác nhận chi phí (UI tự mở modal khi has_cost) — chỉ báo các lý do chặn thật.
    const cr = canRun(id, key, { allowPaid: true });
    const can_run = cr.ok ? { ok: true } : { ok: false, code: cr.code, message: cr.message };
    if (ps?.cost?.always_ask) can_run.cost_confirm = true;
    const resume_cmd = p.session_started === 1 && p.claude_session_id
      ? `cd ${shellQuote(p.dir)} && claude --resume ${p.claude_session_id}`
      : null;
    return { project, step, runs, latest, can_run, resume_cmd };
  }

  // Kiểm bước có chạy được không (§5, §8.4.1): {ok:true} hoặc {ok:false, status, code, message[, cost]}. Lock do runner kiểm.
  function canRun(id, key, { allowPaid } = {}) {
    const p = store.getProject(id);
    if (!p) return { ok: false, status: 404, code: 'not_found', message: `Không tìm thấy dự án "${id}".` };
    const s = store.getStep(id, key);
    if (!s) return { ok: false, status: 404, code: 'not_found', message: `Không tìm thấy bước "${key}" trong dự án "${id}".` };
    const preset = findPreset(p.preset_id);
    if (!preset) {
      return { ok: false, status: 404, code: 'preset_not_found', message: `Preset "${p.preset_id}" của dự án không còn (đã xóa hoặc đang lỗi) — sửa preset rồi thử lại.` };
    }
    const ps = presetStepOf(preset, key);
    if (!ps) {
      return { ok: false, status: 409, code: 'not_runnable', message: `Bước "${key}" không còn trong preset "${preset.id}".` };
    }
    const running = store.runningRunOf(id);
    if (running) {
      const rs = store.getStepById(running.step_id);
      return { ok: false, status: 409, code: 'busy', message: `Dự án đang chạy bước "${rs ? rs.name : '?'}". Chờ lượt đó xong hoặc dừng nó trước.` };
    }
    if (ps.manual) {
      return { ok: false, status: 409, code: 'not_runnable', message: 'Đây là bước làm thủ công — tự làm rồi bấm "Đánh dấu xong".' };
    }
    if (!RUNNABLE_STATES.has(s.state)) {
      const why = {
        pending: 'Bước trước chưa xong.',
        running: 'Bước đang chạy.',
        manual: 'Đây là bước làm thủ công — tự làm rồi bấm "Đánh dấu xong".',
      }[s.state] ?? `Trạng thái "${s.state}" không cho phép chạy.`;
      return { ok: false, status: 409, code: 'not_runnable', message: why };
    }
    const blocker = firstBlockingEarlier(id, s);
    if (blocker) {
      return { ok: false, status: 409, code: 'not_runnable', message: `Bước trước chưa xong: "${blocker.name}".` };
    }
    if (ps.cost && ps.cost.always_ask && allowPaid !== true) {
      const est = estimateCost(id, key);
      return {
        ok: false,
        status: 412,
        code: 'cost_confirm_required',
        message: `Bước này dùng dịch vụ tốn tiền (${ps.cost.service}). Cần xác nhận chi phí trước khi chạy.`,
        cost: {
          service: ps.cost.service,
          estimate: ps.cost.estimate ?? null,
          always_ask: true,
          estimate_value: est ? est.estimate_value : null,
          unit: est ? est.unit : '',
        },
      };
    }
    return { ok: true };
  }

  // Bắt đầu lượt (transaction): kiểm lại canRun, tạo run 'running', đổi state bước/dự án, rerun → bước sau stale/pending.
  function beginRun(id, key, { prompt = null, feedback = null, allowPaid = false } = {}) {
    const run = store.tx(() => {
      const chk = canRun(id, key, { allowPaid });
      if (!chk.ok) throw new HttpError(chk.status, chk.code, chk.message, chk.cost ? { cost: chk.cost } : undefined);
      const s = store.getStep(id, key);
      const prev = s.state;
      const r = store.insertRun({
        step_id: s.id,
        project_id: id,
        prompt,
        feedback: typeof feedback === 'string' && feedback.trim() ? feedback : null,
        allow_paid: allowPaid === true,
      });
      store.updateStep(s.id, { state: 'running', current_run_id: r.id });
      if (prev === 'done' || prev === 'stale') {
        for (const later of store.listSteps(id)) {
          if (later.ord <= s.ord) continue;
          if (later.state === 'done') store.updateStep(later.id, { state: 'stale' });
          else if (later.state === 'ready' || later.state === 'manual') store.updateStep(later.id, { state: 'pending' });
        }
      }
      store.updateProject(id, { status: 'running' });
      prevStates.set(r.id, prev);
      return r;
    });
    snapshotSafe(id);
    return store.getRun(run.id);
  }

  // Kết thúc lượt (transaction) theo outcome {state, summary?, error?, result?, exit_code?, prevState?}; trả run.
  function finishRun(runId, outcome = {}) {
    const run0 = store.getRun(runId);
    if (!run0) return null;
    if (run0.state !== 'running') return run0; // đã kết thúc trước đó → không làm gì
    const projectId = run0.project_id;
    store.tx(() => {
      const o = outcome || {};
      let state = FINISH_STATES.has(o.state) ? o.state : 'failed';
      const patch = {};
      if (!run0.ended_at) patch.ended_at = now();
      if (o.exit_code !== undefined) patch.exit_code = o.exit_code;
      if (o.result !== undefined) patch.result = o.result;
      if (o.summary !== undefined) patch.summary = o.summary;
      else if (run0.summary == null && o.result && typeof o.result.summary === 'string') patch.summary = o.result.summary;
      if (o.error !== undefined) patch.error = o.error;
      if (!FINISH_STATES.has(o.state)) patch.error = o.error ?? `Kết quả lượt không hợp lệ: ${JSON.stringify(o.state ?? null)}`;

      if (state === 'done') {
        const failedChecks = store.listChecks(runId).filter((c) => c.passed === 0);
        if (failedChecks.length) {
          state = 'failed';
          patch.error = `Kiểm tra không đạt: ${failedChecks.map((c) => c.name).join(', ')}`;
        }
      }
      if (state === 'failed' && patch.error == null && run0.error == null) patch.error = 'Lượt chạy thất bại.';
      patch.state = state;
      store.updateRun(runId, patch);

      const step = store.getStepById(run0.step_id);
      if (step && (step.current_run_id === runId || step.current_run_id == null) && step.state === 'running') {
        let stepState = state;
        if (state === 'stopped') {
          const prev = o.prevState ?? prevStates.get(runId);
          stepState = RESTORE_ON_STOP.has(prev) ? prev : 'ready';
        }
        store.updateStep(step.id, { state: stepState });
        if (stepState === 'done') {
          const p = store.getProject(projectId);
          advanceNext(p, step, findPreset(p.preset_id));
        }
      }
      recomputeStatus(projectId);
    });
    prevStates.delete(runId);
    snapshotSafe(projectId);
    return store.getRun(runId);
  }

  // Người dùng đánh dấu bước xong (§5); trả StepView hoặc throw HttpError 404/409.
  function complete(id, key) {
    const p = store.getProject(id);
    if (!p) throw new HttpError(404, 'not_found', `Không tìm thấy dự án "${id}".`);
    store.tx(() => {
      const s = store.getStep(id, key);
      if (!s) throw new HttpError(404, 'not_found', `Không tìm thấy bước "${key}" trong dự án "${id}".`);
      if (!COMPLETABLE_STATES.has(s.state)) {
        const why = {
          done: 'Bước đã xong rồi.',
          running: 'Bước đang chạy — dừng lượt đó trước khi đánh dấu xong.',
          pending: 'Bước trước chưa xong.',
        }[s.state] ?? `Trạng thái "${s.state}" không cho phép đánh dấu xong.`;
        throw new HttpError(409, 'not_runnable', why);
      }
      const blocker = firstBlockingEarlier(id, s);
      if (blocker) throw new HttpError(409, 'not_runnable', `Bước trước chưa xong: "${blocker.name}".`);
      store.updateStep(s.id, { state: 'done' });
      advanceNext(p, s, findPreset(p.preset_id));
      recomputeStatus(id);
    });
    snapshotSafe(id);
    return stepView(id, key);
  }

  const aliveWith = (isAlive) => (pid) => {
    if (pid == null) return false;
    try {
      return !!isAlive(pid);
    } catch {
      return false;
    }
  };

  // Process pid có đúng là claude của lượt này không (dòng lệnh chứa session id của dự án/lượt)? → {ppid} hoặc null.
  function claudeOfRun(run, inspect) {
    let info = null;
    try {
      info = inspect(run.pid);
    } catch {
      info = null;
    }
    if (!info || typeof info.command !== 'string') return null;
    const p = store.getProject(run.project_id);
    const sids = [p?.claude_session_id, run.session_id].filter((x) => typeof x === 'string' && x.length >= 8);
    return sids.some((sid) => info.command.includes(sid)) ? { ppid: Number(info.ppid) || 0 } : null;
  }

  function killSafe(kill, pid) {
    try {
      kill(pid);
      return true;
    } catch {
      return false;
    }
  }

  // Sau khi server khởi động lại: lượt 'running' không còn ai trông (pid chết/NULL, pid đã bị dùng lại, hoặc claude mồ côi
  // vì server cũ chết) → failed, bước failed, dự án active; claude mồ côi bị SIGTERM. Chỉ bỏ qua lượt mà claude còn
  // cha là một server khác đang sống (Video Studio thứ hai dùng chung VS_HOME). Xóa lock chết.
  function recoverOnStartup(isAlive = defaultIsAlive, { inspect = defaultInspect, kill = defaultKill } = {}) {
    const alive = aliveWith(isAlive);
    let fixed = 0;
    const touched = new Set();
    for (const run of store.listRunsByState('running')) {
      let error = 'Server dừng giữa chừng';
      if (alive(run.pid)) {
        const own = claudeOfRun(run, inspect);
        if (own) {
          if (own.ppid > 1 && own.ppid !== process.pid && alive(own.ppid)) continue; // server khác còn trông lượt này
          if (killSafe(kill, run.pid)) error = 'Server dừng giữa chừng (đã dừng claude còn sót)';
        }
        // không nhận ra là claude của lượt (pid đã bị process khác dùng lại) → chỉ đánh dấu, không đụng process
      }
      store.tx(() => {
        store.updateRun(run.id, { state: 'failed', error, ended_at: run.ended_at ?? now() });
        const step = store.getStepById(run.step_id);
        if (step && step.state === 'running' && (step.current_run_id === run.id || step.current_run_id == null)) {
          store.updateStep(step.id, { state: 'failed' });
        }
      });
      prevStates.delete(run.id);
      touched.add(run.project_id);
      fixed++;
    }
    // Bước kẹt 'running' mà không còn lượt chạy nào → failed; dự án kẹt 'running' → tính lại.
    for (const p of store.listProjects()) {
      const hasRunning = !!store.runningRunOf(p.id);
      for (const s of store.listSteps(p.id)) {
        if (s.state !== 'running') continue;
        const cur = s.current_run_id ? store.getRun(s.current_run_id) : null;
        if (!cur || cur.state !== 'running') {
          store.updateStep(s.id, { state: 'failed' });
          touched.add(p.id);
          fixed++;
        }
      }
      if (touched.has(p.id) || (p.status === 'running' && !hasRunning)) {
        recomputeStatus(p.id);
        touched.add(p.id);
      }
    }
    for (const pid of touched) {
      const p = store.getProject(pid);
      if (!p) continue;
      removeDeadLock(p.dir, alive);
      snapshotSafe(pid);
    }
    return fixed;
  }

  // Dừng một lượt 'running' trong DB mà runner hiện tại không trông (mồ côi sau khi server khởi động lại):
  // SIGTERM claude nếu nhận ra đúng process, kết thúc lượt 'stopped', gỡ lock của lượt. Trả run hoặc null (không chạy).
  function abandonRun(runId, { isAlive = defaultIsAlive, inspect = defaultInspect, kill = defaultKill } = {}) {
    const run = store.getRun(runId);
    if (!run || run.state !== 'running') return null;
    const alive = aliveWith(isAlive);
    if (alive(run.pid) && claudeOfRun(run, inspect)) killSafe(kill, run.pid);
    const done = finishRun(runId, { state: 'stopped', error: 'Lượt mồ côi (server đã khởi động lại)' });
    const p = store.getProject(run.project_id);
    if (p) removeDeadLock(p.dir, alive);
    return done;
  }

  // Xóa <dir>/.studio/lock nếu chắc đã chết: run_id là lượt DB này biết và lượt đó không còn 'running' (bất kể máy/pid),
  // hoặc lock cùng máy mà pid đã chết. Lock của máy khác (thư mục đồng bộ) mà DB không biết run_id → giữ. Trả true nếu xóa.
  function removeDeadLock(dir, alive) {
    const lockFile = path.join(dir, '.studio', 'lock');
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (!lock || typeof lock !== 'object') return false;
      const known = lock.run_id != null ? store.getRun(lock.run_id) : null;
      const sameHost = lock.host == null || lock.host === os.hostname();
      const ended = !!known && known.state !== 'running';
      if (ended || (sameHost && Number(lock.pid) !== process.pid && !alive(lock.pid))) {
        fs.unlinkSync(lockFile);
        return true;
      }
    } catch {
      /* không có lock hoặc lock hỏng → bỏ qua (runner sẽ xử lý khi chạy) */
    }
    return false;
  }

  // Ghi <dir>/.studio/project.json {id, preset, title, steps:[{key,state}], updated_at} (ghi tạm rồi rename).
  function writeSnapshot(id) {
    const p = store.getProject(id);
    if (!p) return null;
    const steps = store.listSteps(id);
    let updated = p.updated_at;
    for (const s of steps) if (s.updated_at > updated) updated = s.updated_at;
    const data = {
      id: p.id,
      preset: p.preset_id,
      title: p.title,
      steps: steps.map((s) => ({ key: s.key, state: s.state })),
      updated_at: updated,
    };
    const dir = path.join(p.dir, '.studio');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'project.json');
    const tmp = path.join(dir, `.project.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return data;
  }

  // Preset (đã chuẩn hóa) của dự án, hoặc null nếu dự án/preset không còn.
  function presetOf(id) {
    const p = store.getProject(id);
    return p ? findPreset(p.preset_id) : null;
  }

  // Ước tính chi phí dịch vụ của bước (§6.1): chars(file) | count(key) | số nguyên; không bao giờ throw.
  function estimateCost(id, key) {
    let base = null;
    try {
      const p = store.getProject(id);
      if (!p) return null;
      const preset = findPreset(p.preset_id);
      const ps = presetStepOf(preset, key);
      if (!ps || !ps.cost) return null;
      const expr = ps.cost.estimate == null ? null : String(ps.cost.estimate);
      base = { service: ps.cost.service, estimate: expr, estimate_value: null, unit: ps.cost.unit ?? '' };
      if (expr == null) return base;
      const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
      let m;
      if ((m = /^\s*chars\((.+)\)\s*$/.exec(expr))) {
        base.unit = 'ký tự';
        const rel = renderTemplate(unquote(m[1]), tplCtx(p, preset));
        const abs = safeJoin(p.dir, rel);
        const st = fs.statSync(abs, { throwIfNoEntry: false });
        if (st && st.isFile() && st.size <= MAX_ESTIMATE_BYTES) {
          base.estimate_value = [...fs.readFileSync(abs, 'utf8').trim()].length;
        }
      } else if ((m = /^\s*count\((.+)\)\s*$/.exec(expr))) {
        base.unit = 'mục';
        const k = unquote(m[1]);
        const abs = safeJoin(p.dir, 'project.json');
        const st = fs.statSync(abs, { throwIfNoEntry: false });
        if (st && st.isFile() && st.size <= MAX_ESTIMATE_BYTES) {
          let v = JSON.parse(fs.readFileSync(abs, 'utf8'));
          for (const part of k.split('.')) v = v != null && typeof v === 'object' ? v[part] : undefined;
          if (Array.isArray(v)) base.estimate_value = v.length;
        }
      } else if (/^\s*\d+\s*$/.test(expr)) {
        base.estimate_value = Number(expr.trim());
      }
      return base;
    } catch {
      return base;
    }
  }

  return {
    create,
    list,
    view,
    stepView,
    canRun,
    beginRun,
    finishRun,
    complete,
    recoverOnStartup,
    abandonRun,
    writeSnapshot,
    presetOf,
    estimateCost,
  };
}
