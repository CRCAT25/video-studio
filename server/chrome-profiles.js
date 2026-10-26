// Danh sách hồ sơ Chrome trên máy (đọc file "Local State" của Chrome) để mở trang đăng nhập Claude đúng hồ sơ.
// Chỉ lấy thư mục + tên hiển thị + màu hồ sơ + đang mở — không bao giờ đọc/trả email, gaia_name hay ảnh tài khoản Google.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_PROFILES = 50;
const DIR_RE = /^(Default|Profile \d{1,4}|Guest Profile)$/;

// Đường dẫn "Local State" của Chrome theo hệ điều hành; nền tảng chưa hỗ trợ → null.
export function localStatePath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Local State');
  if (platform === 'linux') return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'google-chrome', 'Local State');
  return null;
}

// Màu ARGB (số nguyên có dấu của Chrome) → "#rrggbb"; không hợp lệ → null.
export function argbToHex(v) {
  if (!Number.isInteger(v)) return null;
  return `#${((v >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

// Parse nội dung Local State → [{dir, name, color, lastUsed, open}] (gần nhất, rồi đang mở lên đầu); lỗi → [].
// running = Chrome đang chạy; khi đó hồ sơ trong last_active_profiles (đang có cửa sổ) được đánh dấu open.
export function parseLocalState(text, { running = false } = {}) {
  let profile;
  try {
    profile = JSON.parse(String(text || ''))?.profile;
  } catch {
    return [];
  }
  const cache = profile?.info_cache;
  if (!cache || typeof cache !== 'object') return [];
  const last = typeof profile.last_used === 'string' ? profile.last_used : null;
  const active = new Set(running && Array.isArray(profile.last_active_profiles) ? profile.last_active_profiles.filter((d) => typeof d === 'string') : []);
  const out = [];
  for (const [dir, info] of Object.entries(cache)) {
    if (!DIR_RE.test(dir) || !info || typeof info !== 'object' || info.is_ephemeral === true) continue;
    const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 60) : dir;
    out.push({
      dir,
      name,
      color: argbToHex(info.profile_highlight_color ?? info.default_avatar_fill_color),
      lastUsed: dir === last,
      open: active.has(dir),
      at: Number(info.active_time) || 0,
    });
  }
  out.sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed) || Number(b.open) - Number(a.open) || b.at - a.at || a.dir.localeCompare(b.dir));
  return out.slice(0, MAX_PROFILES).map(({ at, ...p }) => p);
}

// Chrome có đang chạy không (pgrep tên tiến trình chính); lỗi / không có → false.
export function isChromeRunning({ platform = process.platform } = {}) {
  const name = platform === 'darwin' ? 'Google Chrome' : platform === 'linux' ? 'chrome' : null;
  if (!name) return false;
  try {
    execFileSync('pgrep', ['-x', name], { stdio: 'ignore', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

// Bundle id → tên trình duyệt quen thuộc.
const BROWSERS = {
  'com.google.chrome': 'Chrome',
  'com.apple.safari': 'Safari',
  'company.thebrowser.browser': 'Arc',
  'org.mozilla.firefox': 'Firefox',
  'com.microsoft.edgemac': 'Edge',
  'com.brave.browser': 'Brave',
  'com.operasoftware.opera': 'Opera',
  'com.vivaldi.vivaldi': 'Vivaldi',
};

// Tên trình duyệt mặc định từ JSON của plist LaunchServices (handler https); không khai báo → Safari (mặc định macOS).
export function parseDefaultBrowser(text) {
  let handlers;
  try {
    handlers = JSON.parse(String(text || ''))?.LSHandlers;
  } catch {
    return null;
  }
  if (!Array.isArray(handlers)) return 'Safari';
  const h = handlers.find((x) => x?.LSHandlerURLScheme === 'https') || handlers.find((x) => x?.LSHandlerURLScheme === 'http');
  const id = typeof h?.LSHandlerRoleAll === 'string' ? h.LSHandlerRoleAll.toLowerCase() : null;
  if (!id) return 'Safari';
  return BROWSERS[id] ?? null;
}

// Trình duyệt mặc định của macOS (đọc plist qua plutil); nền tảng khác / lỗi → null.
export function defaultBrowser({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'darwin') return null;
  const plist = path.join(home, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
  try {
    return parseDefaultBrowser(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return fs.existsSync(plist) ? null : 'Safari';
  }
}

// Đọc hồ sơ Chrome của máy này → {supported, profiles, defaultBrowser}; chưa cài Chrome / nền tảng khác → profiles rỗng.
// opts.running / opts.defaultBrowser để test tiêm sẵn (không gọi pgrep / plutil).
export function listChromeProfiles(opts = {}) {
  const browser = opts.defaultBrowser !== undefined ? opts.defaultBrowser : defaultBrowser(opts);
  const file = opts.file ?? localStatePath(opts);
  if (!file) return { supported: false, profiles: [], defaultBrowser: browser };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const running = opts.running ?? isChromeRunning(opts);
    return { supported: true, profiles: parseLocalState(text, { running }), defaultBrowser: browser };
  } catch {
    return { supported: true, profiles: [], defaultBrowser: browser };
  }
}
