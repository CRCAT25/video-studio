// Mức dùng gói Claude (như /usage): % phiên 5 giờ / tuần lấy từ rate_limit_event của mỗi lượt `claude -p`,
// cộng tổng token app đã dùng (DB). Nút "Kiểm tra ngay" hỏi API như /usage (không tốn token); lỗi → chạy 1 câu claude siêu ngắn.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from './checks.js';
import { HttpError } from './projects.js';
import { createLineSplitter } from './stream.js';

export const CHECK_COOLDOWN_MS = 60_000; // sau lần hỏi bằng claude -p (tốn token)
export const API_COOLDOWN_MS = 10_000; // sau lần hỏi API (miễn phí)
export const CHECK_TIMEOUT_MS = 90_000;
export const WARN_AT = 0.8;
export const WINDOWS = ['five_hour', 'seven_day'];
export const SOURCES = ['steps', 'assistant', 'check'];
const CHECK_PROMPT = 'Trả lời đúng một chữ: ok';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// rate_limit_info → {status, type, windows:{five_hour:{utilization 0..1, resetsAt giây}, seven_day}}; không dùng được → null.
export function parseRateLimit(info) {
  if (!isObj(info)) return null;
  const src = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
  const windows = {};
  for (const k of WINDOWS) {
    const w = src[k];
    const u = num(w?.utilization);
    if (u == null) continue;
    windows[k] = { utilization: Math.min(Math.max(u, 0), 1.5), resetsAt: num(w.resetsAt) };
  }
  const status = typeof info.status === 'string' ? info.status : null;
  if (!status && !Object.keys(windows).length) return null;
  return {
    status,
    type: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    resetsAt: num(info.resetsAt),
    windows,
  };
}

// Nửa đêm hôm nay (giờ máy) và 7 ngày trước đó, dạng ISO.
export function dayStarts(at = new Date()) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  const week = new Date(d);
  week.setDate(week.getDate() - 6);
  return { today: d.toISOString(), week: week.toISOString() };
}

// Tạo bộ theo dõi: {summary, observe, record, check, on, dispose}. store? dùng để cộng token; không có → tokens null.
// planApi? ({fetch} từ claude-plan.js) — có thì Kiểm tra hỏi API trước.
export function createUsage({
  home,
  store = null,
  claudeBin = 'claude',
  env = {},
  planApi = null,
  cooldownMs = CHECK_COOLDOWN_MS,
  apiCooldownMs = API_COOLDOWN_MS,
  timeoutMs = CHECK_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (!home) throw new Error('createUsage cần home.');
  const bin = /[\\/]/.test(String(claudeBin)) ? path.resolve(String(claudeBin)) : String(claudeBin || 'claude');
  const file = path.join(home, 'usage.json');
  const listeners = new Set();
  let limits = load(); // {status, type, resetsAt, windows, at}
  let checking = null; // Promise của lần kiểm tra đang chạy
  let lastCheck = 0;
  let via = null; // 'api' | 'claude' — cách của lần kiểm tra gần nhất
  let apiOff = false; // bị từ chối Keychain / không có token → lần tự kiểm tra sau bỏ qua API (khỏi hỏi lại)
  let child = null;

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      const p = parseRateLimit({ status: d.status, rateLimitType: d.type, resetsAt: d.resetsAt, unifiedWindows: d.windows });
      return p ? { ...p, at: typeof d.at === 'string' ? d.at : null } : null;
    } catch {
      return null;
    }
  }

  function save() {
    try {
      fs.mkdirSync(home, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(limits), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* ghi lỗi chỉ làm mất số khi khởi động lại */
    }
  }

  // Tổng token theo nguồn hôm nay / 7 ngày; DB lỗi → null.
  function tokens() {
    if (!store?.tokenTotals) return null;
    try {
      const { today, week } = dayStarts(now());
      return { today: store.tokenTotals(today), week: store.tokenTotals(week) };
    } catch {
      return null;
    }
  }

  // Ảnh chụp gửi UI.
  function summary() {
    return { limits, checking: !!checking, tokens: tokens(), via, nextCheckAt: nextCheckAt() };
  }

  // Mốc (ms) được kiểm tra lại; null = được ngay.
  function nextCheckAt() {
    if (!lastCheck) return null;
    const t = lastCheck + (via === 'claude' ? cooldownMs : apiCooldownMs);
    return t > now() ? t : null;
  }

  function emit() {
    const s = summary();
    for (const fn of listeners) {
      try {
        fn(s);
      } catch {
        /* bỏ qua */
      }
    }
  }

  // Nhận rate_limit_info từ một lượt claude bất kỳ; trả true nếu cập nhật được.
  function observe(info) {
    const p = parseRateLimit(info);
    if (!p) return false;
    // Sự kiện thiếu cửa sổ (chỉ có status) → giữ số % cũ.
    const windows = Object.keys(p.windows).length ? p.windows : limits?.windows || {};
    limits = { ...p, windows, at: new Date(now()).toISOString() };
    save();
    emit();
    return true;
  }

  // Ghi token của một lượt không thuộc bước video (trợ lý / kiểm tra).
  function record(source, usage) {
    if (!store?.addTokenUsage || !isObj(usage)) return;
    try {
      store.addTokenUsage(source, usage);
    } catch {
      /* store đã đóng */
    }
    emit();
  }

  // Lấy số mới: API trước, lỗi → claude -p (trừ khi auto: mở bảng tự kiểm, không được tốn token).
  // Đang chạy → dùng chung; vừa kiểm → 429 (auto thì trả summary). Trả summary sau khi tắt cờ checking,
  // kèm apiError khi đã phải quay về claude -p.
  function check({ auto = false } = {}) {
    if (checking) return checking.then((x) => ({ ...summary(), ...x }));
    const next = nextCheckAt();
    if (next) {
      if (auto) return Promise.resolve(summary());
      throw new HttpError(429, 'usage_cooldown', `Vừa kiểm tra — thử lại sau ${Math.ceil((next - now()) / 1000)} giây.`);
    }
    if (auto && (!planApi || apiOff)) return Promise.resolve(summary());
    lastCheck = now();
    checking = runAll(auto).finally(() => {
      checking = null;
      emit();
    });
    emit();
    return checking.then((x) => ({ ...summary(), ...x }));
  }

  async function runAll(auto) {
    let apiError = null;
    if (planApi && !(auto && apiOff)) {
      try {
        const info = await planApi.fetch();
        via = 'api';
        apiOff = false;
        observe(info);
        return {};
      } catch (e) {
        apiError = e?.message || 'Không lấy được số trực tiếp.';
        if (e?.reason === 'denied' || e?.reason === 'no_token') apiOff = true;
        if (auto) {
          lastCheck = 0; // lần tự kiểm hỏng không khóa nút Kiểm tra
          return {};
        }
      }
    }
    via = 'claude'; // tốn token dù thành công hay không → giãn cách dài
    await runCheck();
    return apiError ? { apiError } : {};
  }

  function runCheck() {
    return new Promise((resolve, reject) => {
      const dir = path.join(home, 'usage-check');
      fs.mkdirSync(dir, { recursive: true });
      const isScript = /\.(mjs|cjs|js)$/i.test(bin);
      const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--no-session-persistence', '--strict-mcp-config'];
      let got = false;
      let stderr = '';
      let done = false;
      const end = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child = null;
        if (err) reject(err);
        else resolve();
      };
      try {
        child = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...argv] : argv, { cwd: dir, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      } catch (e) {
        return end(new HttpError(503, 'claude_unavailable', `Không chạy được claude: ${e.message}`));
      }
      const timer = setTimeout(() => {
        try {
          child?.kill('SIGKILL');
        } catch {
          /* đã thoát */
        }
        end(new HttpError(504, 'usage_timeout', 'Trợ lý không trả lời kịp — thử lại sau.'));
      }, timeoutMs);
      const out = createLineSplitter((line) => {
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        if (o?.type === 'rate_limit_event') got = observe(o.rate_limit_info) || got;
        else if (o?.type === 'result' && isObj(o.usage)) record('check', o.usage);
      });
      child.stdout.on('data', (b) => out.push(b));
      child.stderr.on('data', (b) => {
        stderr = (stderr + b.toString('utf8')).slice(-1000);
      });
      child.stdin.on('error', () => {});
      child.on('error', (e) => {
        end(new HttpError(503, 'claude_unavailable', e.code === 'ENOENT' ? 'Không tìm thấy lệnh claude — cài Claude Code trước.' : `Không chạy được claude: ${e.message}`));
      });
      child.on('close', () => {
        out.end();
        if (got) return end(null);
        const loggedOut = /not logged in|login/i.test(stderr);
        end(new HttpError(502, 'usage_unavailable', loggedOut ? 'Claude chưa đăng nhập.' : 'Claude không gửi số liệu mức dùng (cần đăng nhập gói Claude, không phải API key).'));
      });
      child.stdin.end(CHECK_PROMPT);
    });
  }

  // Đăng ký nghe thay đổi; trả hàm hủy.
  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function dispose() {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* đã thoát */
    }
    listeners.clear();
  }

  return { summary, observe, record, check, on, dispose };
}
