// Chạy kiểm tra sau mỗi lượt (hợp đồng M1 §8.5): lệnh shell của preset + kiểm nội bộ `studio-check outputs`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { isInside, slugify } from './paths.js';
import { renderTemplate } from './presets.js';

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const CHECK_OUTPUT_MAX = 20_000;
export const UNSUPPORTED_MSG = 'Chưa hỗ trợ ở M1 (sẽ có ở M2)';
const KILL_GRACE_MS = 5000;
const MTIME_SLACK_MS = 2000;

// Env cho process con (claude, lệnh kiểm tra): kế thừa process.env nhưng bỏ mọi biến VS_* (token studio, cổng…).
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VS_')) env[k] = v;
  return { ...env, ...extra };
}

// Tên file log của check thứ i (đếm từ 1): "<i>-<slug(name)>.log".
export function checkLogName(i, name) {
  return `${i}-${slugify(name)}.log`;
}

// Giữ tối đa max ký tự CUỐI của chuỗi (log dài chỉ cần phần đuôi).
export function tail(s, max = CHECK_OUTPUT_MAX) {
  const str = String(s ?? '');
  return str.length <= max ? str : '…' + str.slice(str.length - max + 1);
}

// Mẫu đầu ra nằm ngoài thư mục dự án (tuyệt đối, ~, hoặc có '..') → không glob trong cwd được.
export function isOutsidePattern(p) {
  if (typeof p !== 'string' || !p.trim()) return true;
  const t = p.trim();
  return path.isAbsolute(t) || t.startsWith('~') || t.split(/[\\/]/).includes('..');
}

// Chạy `/bin/sh -c cmd` trong cwd (nhóm process riêng để dừng được cả cháu chắt); trả {code, signal, output, timedOut, aborted, error}.
export function runShell(cmd, { cwd, timeoutMs = CHECK_TIMEOUT_MS, signal, maxOutput = CHECK_OUTPUT_MAX } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer = null;
    let cut = false;
    const append = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > maxOutput * 2) {
        output = output.slice(output.length - maxOutput);
        cut = true;
      }
    };
    let child;
    try {
      child = spawn('/bin/sh', ['-c', cmd], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
    } catch (e) {
      resolve({ code: null, signal: null, output: `Không chạy được lệnh: ${e.message}`, timedOut, aborted, error: e });
      return;
    }
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* đã thoát */
        }
      }
    };
    const terminate = () => {
      killGroup('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const out = cut && output.length <= maxOutput ? '…' + output.slice(output.length - maxOutput + 1) : tail(output, maxOutput);
      resolve({ ...res, output: out, timedOut, aborted });
    };
    child.on('error', (e) => {
      output += `${output && !output.endsWith('\n') ? '\n' : ''}Không chạy được lệnh: ${e.message}`;
      finish({ code: null, signal: null, error: e });
    });
    child.on('close', (code, sig) => finish({ code, signal: sig, error: null }));
  });
}

// Kiểm `studio-check outputs`: mỗi glob phải khớp ≥1 file không rỗng có mtime ≥ since − 2 s; trả {passed, output}.
export async function checkOutputs({ dir, outputs, since } = {}) {
  const list = Array.isArray(outputs) ? outputs.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!list.length) return { passed: true, output: 'Bước không khai báo đầu ra — không có gì để kiểm.' };
  const t = since == null ? NaN : typeof since === 'number' ? since : Date.parse(since);
  const minMtime = Number.isFinite(t) ? t - MTIME_SLACK_MS : -Infinity;
  const lines = [];
  let passed = true;
  for (const pattern of list) {
    if (isOutsidePattern(pattern)) {
      passed = false;
      lines.push(`✗ ${pattern}: nằm ngoài thư mục dự án (M1 chưa kiểm được)`);
      continue;
    }
    let files = [];
    try {
      files = await glob(pattern, { cwd: dir, dot: false, onlyFiles: true, ignore: ['.studio/**'] });
    } catch (e) {
      passed = false;
      lines.push(`✗ ${pattern}: mẫu không hợp lệ (${e.message})`);
      continue;
    }
    let fresh = 0;
    let empty = 0;
    let old = 0;
    for (const rel of files) {
      let st;
      try {
        st = fs.statSync(path.join(dir, rel));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size === 0) empty++;
      else if (st.mtimeMs < minMtime) old++;
      else fresh++;
    }
    if (fresh > 0) {
      lines.push(`✓ ${pattern} (${fresh} file)`);
    } else {
      passed = false;
      const why = [];
      if (!files.length) why.push('không tìm thấy file nào');
      if (empty) why.push(`${empty} file rỗng`);
      if (old) why.push(`${old} file cũ hơn lượt chạy`);
      lines.push(`✗ ${pattern}: không có file mới${why.length ? ` (${why.join(', ')})` : ''}`);
    }
  }
  return { passed, output: lines.join('\n') };
}

// "10 phút" / "1,5 phút" / "0,3 giây" — dùng trong thông báo hết giờ.
function fmtDuration(ms) {
  const vi = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  return ms >= 60000 ? `${vi(ms / 60000)} phút` : `${vi(ms / 1000)} giây`;
}

function defaultCtx({ project, preset, run }) {
  return {
    slug: project?.id ?? '',
    title: project?.title ?? '',
    feedback: run?.feedback ?? '',
    skill: preset?.skills ?? [],
    prev: { summary: '' },
    vars: preset?.vars ?? {},
  };
}

// Chạy lần lượt step.checks trong dir; trả [{name, cmd, passed (true|false|null), output, duration_ms}].
// opts phụ: signal (AbortSignal để dừng giữa chừng), timeoutMs, onResult(result, i) gọi ngay khi xong từng check.
export async function runChecks({ dir, step, preset, project, run, ctx, signal, timeoutMs = CHECK_TIMEOUT_MS, onResult } = {}) {
  const checks = Array.isArray(step?.checks) ? step.checks : [];
  const c = ctx || defaultCtx({ project, preset, run });
  const since = run?.started_at ?? null;
  const results = [];
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i] || {};
    const name = typeof check.name === 'string' && check.name ? check.name : `check-${i + 1}`;
    const raw = String(check.run ?? '').trim();
    const t0 = Date.now();
    let res;
    if (signal?.aborted) {
      res = { name, cmd: raw, passed: null, output: 'Bỏ qua vì lượt chạy bị dừng.', duration_ms: 0 };
    } else if (raw === 'studio-check outputs') {
      const outputs = (step?.outputs ?? []).map((o) => renderTemplate(o, c));
      const r = await checkOutputs({ dir, outputs, since });
      res = { name, cmd: raw, passed: r.passed, output: tail(r.output), duration_ms: Date.now() - t0 };
    } else if (/^studio-check(\s|$)/.test(raw)) {
      res = { name, cmd: raw, passed: null, output: UNSUPPORTED_MSG, duration_ms: 0 };
    } else {
      const cmd = renderTemplate(check.run, c, { shell: true });
      const r = await runShell(cmd, { cwd: dir, timeoutMs, signal });
      let output = r.output;
      if (r.timedOut) output += `${output && !output.endsWith('\n') ? '\n' : ''}[Hết thời gian kiểm tra (${fmtDuration(timeoutMs)})]`;
      if (r.aborted) output += `${output && !output.endsWith('\n') ? '\n' : ''}[Dừng theo yêu cầu]`;
      const passed = r.aborted ? null : r.code === 0 && !r.timedOut;
      res = { name, cmd, passed, output: tail(output), duration_ms: Date.now() - t0 };
    }
    results.push(res);
    if (onResult) await onResult(res, i);
  }
  return results;
}

// Ghi log 1 check vào <runDir>/checks/<i>-<slug>.log (i đếm từ 1); trả đường dẫn file.
export function writeCheckLog(runDir, i, res) {
  const dir = path.join(runDir, 'checks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, checkLogName(i, res.name));
  if (!isInside(dir, file)) throw new Error('Tên check không hợp lệ.');
  const verdict = res.passed === true ? 'ĐẠT' : res.passed === false ? 'TRƯỢT' : 'BỎ QUA';
  fs.writeFileSync(file, `# ${res.name}\n$ ${res.cmd}\n\n${res.output ?? ''}${res.output && !String(res.output).endsWith('\n') ? '\n' : ''}\n→ ${verdict} (${res.duration_ms ?? 0} ms)\n`);
  return file;
}
