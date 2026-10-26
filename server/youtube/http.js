// Gọi Google REST bằng fetch (không dùng thư viện googleapis): địa chỉ endpoint, lỗi chuẩn hóa, quy đổi lỗi sang HttpError.
import { HttpError } from '../projects.js';

export const REQUEST_TIMEOUT_MS = 30_000;

// Địa chỉ các dịch vụ Google; base (vd. server giả khi test) → mọi endpoint trỏ về base với cùng đường dẫn.
export function googleEndpoints(base = null) {
  const b = base ? String(base).replace(/\/+$/, '') : null;
  return {
    auth: b ? `${b}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    token: b ? `${b}/token` : 'https://oauth2.googleapis.com/token',
    revoke: b ? `${b}/revoke` : 'https://oauth2.googleapis.com/revoke',
    data: b ? `${b}/youtube/v3` : 'https://www.googleapis.com/youtube/v3',
    upload: b ? `${b}/upload/youtube/v3` : 'https://www.googleapis.com/upload/youtube/v3',
    analytics: b ? `${b}/v2` : 'https://youtubeanalytics.googleapis.com/v2',
    crm: b ? `${b}/crm/v3` : 'https://cloudresourcemanager.googleapis.com/v3',
    serviceusage: b ? `${b}/su/v1` : 'https://serviceusage.googleapis.com/v1',
    console: b ? `${b}/console` : 'https://console.cloud.google.com',
  };
}

// Lỗi từ Google: status HTTP + reason (quotaExceeded, invalid_grant…); message không bao giờ chứa token.
export class GoogleError extends Error {
  constructor(status, reason, message) {
    super(message || `Google trả lỗi ${status}.`);
    this.name = 'GoogleError';
    this.status = status;
    this.reason = reason || null;
  }
}

// Rút reason + message từ thân lỗi Google (dạng API {error:{errors:[{reason}],message}} hoặc OAuth {error, error_description}).
function parseError(status, data) {
  const e = data?.error;
  if (e && typeof e === 'object') {
    const reason = e.errors?.[0]?.reason || e.status || null;
    return new GoogleError(status, reason, typeof e.message === 'string' ? e.message.slice(0, 300) : null);
  }
  if (typeof e === 'string') return new GoogleError(status, e, typeof data.error_description === 'string' ? data.error_description.slice(0, 300) : null);
  return new GoogleError(status, null, null);
}

// fetch có hạn giờ; trả JSON (hoặc null nếu thân rỗng). Lỗi HTTP → GoogleError; lỗi mạng → GoogleError status 0.
export async function gfetch(fetchFn, url, { method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
  let res;
  try {
    res = await fetchFn(url, { method, headers, body, signal: signal || AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === 'AbortError' && signal?.aborted) throw e;
    throw new GoogleError(0, 'network', 'Không kết nối được tới Google.');
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw parseError(res.status, data);
  return data;
}

// Thân form x-www-form-urlencoded cho endpoint OAuth.
export function formBody(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p.toString();
}

// GoogleError → HttpError có thông báo tiếng Việt cho UI.
export function toHttpError(e) {
  if (!(e instanceof GoogleError)) return e;
  if (e.status === 0) return new HttpError(502, 'yt_network', 'Không kết nối được tới Google. Kiểm tra mạng rồi thử lại.');
  if (e.reason === 'invalid_grant' || e.status === 401) return new HttpError(401, 'yt_reauth', 'Kết nối YouTube đã hết hạn hoặc bị thu hồi — bấm Kết nối lại.');
  if (['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason)) {
    return new HttpError(429, 'yt_quota', 'Đã hết hạn mức YouTube API hôm nay (reset lúc 0h giờ Thái Bình Dương ≈ 14–15h Việt Nam).');
  }
  if (e.reason === 'accessNotConfigured' || e.reason === 'SERVICE_DISABLED') {
    return new HttpError(502, 'yt_api_disabled', 'Dự án Google Cloud chưa bật YouTube Data API v3 / YouTube Analytics API — xem lại bước 2 trong Thiết lập.');
  }
  if (e.reason === 'invalid_client' || e.reason === 'unauthorized_client') {
    return new HttpError(400, 'yt_bad_client', 'Google từ chối client OAuth — dán lại client_secret.json đúng loại "Ứng dụng máy tính".');
  }
  if (e.status === 403) return new HttpError(403, 'yt_forbidden', `Google từ chối yêu cầu${e.reason ? ` (${e.reason})` : ''}.`);
  return new HttpError(502, 'yt_error', `Google trả lỗi ${e.status}${e.reason ? ` (${e.reason})` : ''}.`);
}
