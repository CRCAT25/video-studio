// Đọc % gói Claude như lệnh /usage của Claude Code: GET api.anthropic.com/api/oauth/usage bằng token đăng nhập
// của Claude Code (Keychain macOS / ~/.claude/.credentials.json) — không gọi model, không tốn token.
// API nội bộ, chưa có tài liệu → mọi lỗi/khác dạng đều ném PlanError để usage.js quay về `claude -p`.
// Token chỉ ở trong server: không trả về UI, không ghi log, không lưu ra file, chỉ gửi tới api.anthropic.com.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLAN_API_BASE = 'https://api.anthropic.com';
export const KEYCHAIN_ITEM = 'Claude Code-credentials';
export const FETCH_TIMEOUT_MS = 10_000;
export const KEYCHAIN_TIMEOUT_MS = 60_000; // lần đầu macOS hỏi quyền — chờ người dùng bấm

export class PlanError extends Error {
  // reason: 'no_token' | 'denied' | 'expired' | 'auth' | 'http' | 'shape' | 'network'
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Chạy `security find-generic-password -w`; trả chuỗi JSON hoặc null nếu không có mục. Không đọc stderr.
function keychainRead(bin, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ['find-generic-password', '-s', KEYCHAIN_ITEM, '-w'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      reject(new PlanError('no_token', 'Không đọc được Keychain.'));
      return;
    }
    const out = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new PlanError('denied', 'Chưa được phép đọc Keychain.'));
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', () => {
      clearTimeout(timer);
      reject(new PlanError('no_token', 'Không đọc được Keychain.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else if (code === 44) resolve(null); // không có mục
      else reject(new PlanError('denied', 'Chưa được phép đọc Keychain.'));
    });
  });
}

// Lấy {token, expiresAt} của Claude Code. VS_CLAUDE_CREDENTIALS (test) / CLAUDE_CONFIG_DIR → file; macOS → Keychain.
export async function readClaudeToken({ env = process.env, platform = process.platform, securityBin = 'security', timeoutMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  let raw = null;
  const file = env.VS_CLAUDE_CREDENTIALS || (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json') : null);
  if (file || platform !== 'darwin') {
    try {
      raw = fs.readFileSync(file || path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    } catch {
      raw = null;
    }
  } else {
    raw = await keychainRead(securityBin, timeoutMs);
  }
  let o;
  try {
    o = raw ? JSON.parse(raw) : null;
  } catch {
    o = null;
  }
  const c = o?.claudeAiOauth;
  if (!isObj(c) || typeof c.accessToken !== 'string' || !c.accessToken) {
    throw new PlanError('no_token', 'Không thấy thông tin đăng nhập gói Claude.');
  }
  return { token: c.accessToken, expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : null };
}

// "2026-10-26T18:00:00Z" | số giây | số ms → giây epoch; không hợp lệ → null.
function toSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.round(t / 1000) : null;
  }
  return null;
}

// Body của /api/oauth/usage → rate_limit_info cùng dạng rate_limit_event (utilization 0..1) để usage.observe dùng chung.
export function planToRateLimit(body) {
  if (!isObj(body)) return null;
  const unifiedWindows = {};
  for (const k of ['five_hour', 'seven_day']) {
    const w = body[k];
    const u = w?.utilization;
    if (typeof u !== 'number' || !Number.isFinite(u)) continue;
    unifiedWindows[k] = { utilization: u / 100, resetsAt: toSec(w.resets_at) };
  }
  const ws = Object.entries(unifiedWindows);
  if (!ws.length) return null;
  const [type, top] = ws.reduce((a, b) => (b[1].utilization > a[1].utilization ? b : a));
  const status = top.utilization >= 1 ? 'rejected' : top.utilization >= 0.8 ? 'allowed_warning' : 'allowed';
  return { status, rateLimitType: type, resetsAt: top.resetsAt, unifiedWindows };
}

// Tạo nguồn số trực tiếp: {fetch() → rate_limit_info}. Token nhớ trong RAM tới khi hết hạn / bị 401.
export function createPlanApi({ env = process.env, platform = process.platform, base = env.VS_CLAUDE_API_BASE || PLAN_API_BASE, timeoutMs = FETCH_TIMEOUT_MS, now = () => Date.now(), readToken = () => readClaudeToken({ env, platform }) } = {}) {
  let cached = null;

  async function token(fresh) {
    if (!fresh && cached && !(cached.expiresAt && cached.expiresAt <= now())) return cached;
    cached = null;
    const t = await readToken();
    if (t.expiresAt && t.expiresAt <= now()) throw new PlanError('expired', 'Phiên đăng nhập Claude đã hết hạn — chạy một bước để Claude Code làm mới.');
    cached = t;
    return t;
  }

  async function call(tok) {
    let res;
    try {
      res = await fetch(`${base.replace(/\/$/, '')}/api/oauth/usage`, {
        headers: { authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PlanError('network', 'Không kết nối được api.anthropic.com.');
    }
    if (res.status === 401 || res.status === 403) throw new PlanError('auth', 'Token đăng nhập Claude không còn dùng được.');
    if (!res.ok) throw new PlanError('http', `api.anthropic.com trả lỗi ${res.status}.`);
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const info = planToRateLimit(body);
    if (!info) throw new PlanError('shape', 'API mức dùng trả dữ liệu lạ.');
    return info;
  }

  // Lấy số mới; 401 → đọc lại token một lần (Claude Code có thể vừa làm mới).
  async function get() {
    try {
      return await call((await token(false)).token);
    } catch (e) {
      if (e.reason !== 'auth') throw e;
      return call((await token(true)).token);
    }
  }

  return { fetch: get };
}
