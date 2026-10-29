// Bảo mật HTTP (hợp đồng M1 §9.1): token phiên, cookie, kiểm Host/Origin, header bảo mật + CSP.
import crypto from 'node:crypto';

export const COOKIE_NAME = 'vs_token';
export const TOKEN_HEADER = 'x-studio-token';
export const UNAUTHORIZED_MESSAGE = 'Phiên đăng nhập đã hết — tải lại trang để đăng nhập.';

// media-src: data: cho câu thử giọng (VieNeu/ElevenLabs trả data URL), 2 host file mẫu giọng ElevenLabs.
export const CSP =
  "default-src 'self'; img-src 'self' data: blob: https://i.ytimg.com; media-src 'self' blob: data: https://storage.googleapis.com https://api.us.elevenlabs.io; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  // same-origin (không phải no-referrer): no-referrer làm Chrome gửi "Origin: null" khi submit form đăng nhập → 403.
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': CSP,
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Sinh token phiên ngẫu nhiên (24 byte, base64url) — chỉ giữ trong bộ nhớ.
export function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// So sánh token thời gian hằng (băm SHA-256 hai phía để cùng độ dài rồi timingSafeEqual).
export function tokenEquals(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Tách header Cookie thành object {tên: giá trị}; giá trị lỗi mã hóa giữ nguyên.
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    let val = part.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    try {
      val = decodeURIComponent(val);
    } catch {
      /* giữ nguyên */
    }
    if (name && !(name in out)) out[name] = val;
  }
  return out;
}

// Header Host hợp lệ: 127.0.0.1 | localhost | [::1], có thể kèm :cổng (chống DNS rebinding).
export function isAllowedHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const h = host.trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(h);
  if (!m) return false;
  if (m[2] !== undefined && Number(m[2]) > 65535) return false;
  return LOOPBACK_HOSTS.has(m[1]);
}

// Origin hợp lệ khi trùng đúng http://<Host> (không phân biệt hoa thường).
export function isAllowedOrigin(origin, host) {
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  return origin.trim().toLowerCase() === `http://${host.trim().toLowerCase()}`;
}

// Chuỗi Set-Cookie cho token phiên: HttpOnly, SameSite=Strict, Path=/.
export function tokenCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

// Set-Cookie xóa cookie token (Đăng xuất).
export function clearTokenCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// Tách pathname và query thô của req.url (không dùng new URL để tránh hiểu sai '//host').
export function splitUrl(rawUrl) {
  const s = typeof rawUrl === 'string' ? rawUrl : '/';
  const i = s.indexOf('?');
  return i < 0 ? { pathname: s, search: '' } : { pathname: s.slice(0, i), search: s.slice(i + 1) };
}

// URL tương đối giống req.url nhưng bỏ tham số t (dùng cho 302 sau khi đổi token sang cookie).
export function stripTokenParam(rawUrl) {
  const { pathname, search } = splitUrl(rawUrl);
  if (!search) return pathname || '/';
  const kept = search.split('&').filter((kv) => kv && kv.split('=')[0] !== 't');
  return (pathname || '/') + (kept.length ? `?${kept.join('&')}` : '');
}

// Trang HTML (không phải /api/*, /media/*) — lỗi 401 trả HTML thay vì JSON.
export function isPagePath(pathname) {
  return !(pathname === '/api' || pathname.startsWith('/api/') || pathname === '/media' || pathname.startsWith('/media/'));
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Trang HTML ngắn (tiếng Việt) cho lỗi/hướng dẫn; không có script để hợp CSP. refresh → tự chuyển tới đường dẫn đó.
export function htmlPage(title, bodyHtml, { refresh = null } = {}) {
  const meta = refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refresh)}">` : '';
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${meta}
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111317;color:#e9e6df;
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:560px;border:1px solid #3a3f47;border-radius:10px;padding:24px 28px;background:#1a1d22}
h1{font-size:20px;margin:0 0 10px;letter-spacing:.04em;text-transform:uppercase}
code{font-family:ui-monospace,Menlo,monospace;background:#0b0c0e;padding:2px 6px;border-radius:4px;overflow-wrap:anywhere}
p{margin:8px 0}
@media (prefers-color-scheme:light){body{background:#f2efe8;color:#1d1f23}main{background:#fff;border-color:#d6d1c6}code{background:#ece8df}}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`;
}

// Trang 401 mặc định (server không có bộ đăng nhập).
export function unauthorizedPage() {
  return loginPage();
}

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

// Trang đăng nhập (không script, hợp CSP). mode 'setup' → form tạo mật khẩu (mã thiết lập + 2 ô mật khẩu);
// 'password' → ô mật khẩu; null → chỉ hướng dẫn mở app từ terminal. google=true → thêm nút Google; error → dòng lỗi.
export function loginPage({ mode = null, google = false, error = null } = {}) {
  const err = error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : '';
  const gbtn = google ? `<a class="btn" href="/auth/google">${GOOGLE_G}<span>Đăng nhập bằng Google</span></a>` : '';
  const or = google ? '<p class="or">hoặc</p>' : '';
  let sub = 'Đăng nhập để tiếp tục';
  let body;
  if (mode === 'setup') {
    sub = 'Tạo mật khẩu cho lần đầu';
    body = `${err}<form method="post" action="/auth/setup">
<label>Mã thiết lập <span class="hint">(6 số in ở terminal)</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></label>
<label>Mật khẩu<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
<label>Nhập lại mật khẩu<input type="password" name="confirm" autocomplete="new-password" minlength="8" required></label>
<button class="btn primary" type="submit">Tạo mật khẩu</button></form>${or}${gbtn}`;
  } else if (mode === 'password') {
    body = `${err}<form method="post" action="/auth/password">
<input type="text" name="username" value="video-studio" autocomplete="username" hidden>
<label>Mật khẩu<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button class="btn primary" type="submit">Đăng nhập</button></form>${or}${gbtn}
<p class="alt">Quên mật khẩu? Chạy <code>video-studio reset-password</code></p>`;
  } else {
    body = google ? `${err}${gbtn}` : `${err}<p>Chạy lệnh <code>video-studio</code> trong terminal rồi mở link nó in ra.</p>`;
  }
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Đăng nhập — Video Studio</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--line:#e3e5e9;--fg:#16181d;--dim:#646a75;--err:#c4321f;--btnbg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--line:#2a2e36;--fg:#eceef2;--dim:#9aa1ad;--err:#ff7b6b;--btnbg:#1f232a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);padding:16px;
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px 24px;text-align:center}
.logo{width:36px;height:36px;border-radius:9px;background:#2f6feb;margin:0 auto 14px;display:grid;place-items:center}
h1{font-size:20px;font-weight:500;margin:0 0 4px}
.sub{color:var(--dim);margin:0 0 20px}
p{margin:8px 0}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;height:40px;border:1px solid var(--line);border-radius:8px;
background:var(--btnbg);color:var(--fg);text-decoration:none;font-weight:500}
.btn:hover{border-color:var(--dim)}
.btn.primary{width:100%;background:#2f6feb;border-color:#2f6feb;color:#fff;font:inherit;font-weight:500;cursor:pointer;margin-top:4px}
.btn.primary:hover{background:#2a63d4}
form{text-align:left}
label{display:block;margin:0 0 12px;font-weight:500}
.hint{color:var(--dim);font-weight:400}
input:not([hidden]){display:block;width:100%;height:38px;margin-top:6px;padding:0 10px;border:1px solid var(--line);border-radius:8px;
background:var(--btnbg);color:var(--fg);font:inherit}
input:focus-visible{outline:2px solid #2f6feb;outline-offset:1px;border-color:#2f6feb}
.or{color:var(--dim);font-size:13px;margin:14px 0}
.btn:focus-visible{outline:2px solid #2f6feb;outline-offset:2px}
.alt{color:var(--dim);font-size:13px;margin-top:14px}
.err{color:var(--err);margin:0 0 14px}
code{font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:nowrap}
</style></head><body><main>
<div class="logo" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 16 16" fill="#fff"><path d="M5 3.5v9l7-4.5z"/></svg></div>
<h1>Video Studio</h1><p class="sub">${sub}</p>
${body}
</main></body></html>`;
}

// Lấy giá trị chuỗi duy nhất từ query (mảng hoặc kiểu khác → null).
function single(v) {
  return typeof v === 'string' ? v : null;
}

// Gắn hook bảo mật vào Fastify: Host 421 → Origin 403 → xác thực 401; ?t= → cookie (+302 cho trang HTML); header bảo mật.
// isPublic(req, pathname) → true cho route không cần token (health, asset tĩnh).
// session(req) → true khi có phiên đăng nhập (mật khẩu/Google) hợp lệ; page(req) → HTML trang đăng nhập.
export function registerAuth(app, { token, isPublic = () => false, session = () => false, page = () => unauthorizedPage() }) {
  if (typeof token !== 'string' || token.length < 8) throw new Error('Token phiên không hợp lệ (cần ≥ 8 ký tự).');

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (!isAllowedHost(host)) {
      reply.code(421).send({ error: 'bad_host', message: 'Địa chỉ truy cập không hợp lệ — hãy mở bằng 127.0.0.1 hoặc localhost.' });
      return reply;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, host)) {
      reply.code(403).send({ error: 'forbidden_origin', message: 'Yêu cầu bị chặn vì đến từ trang lạ (Origin không khớp).' });
      return reply;
    }

    const { pathname } = splitUrl(req.url);
    if (isPublic(req, pathname)) return;

    const qToken = single(req.query?.t);
    const qValid = qToken !== null && tokenEquals(qToken, token);
    const cValid = tokenEquals(parseCookies(req.headers.cookie)[COOKIE_NAME], token);
    const hValid = tokenEquals(single(req.headers[TOKEN_HEADER]), token);

    if (!(qValid || cValid || hValid) && !session(req)) {
      if (isPagePath(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
        reply.code(401).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await page(req));
      } else {
        reply.code(401).send({ error: 'unauthorized', message: UNAUTHORIZED_MESSAGE });
      }
      return reply;
    }
    if (qValid) reply.header('set-cookie', tokenCookie(token));
    if (qToken !== null && isPagePath(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      reply.code(302).header('location', stripTokenParam(req.url)).header('cache-control', 'no-store').send();
      return reply;
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
}
