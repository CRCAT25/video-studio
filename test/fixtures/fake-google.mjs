// Server Google giả cho test YouTube (OAuth + Data API v3 + Analytics v2) — không mạng thật.
// startFakeGoogle({port?}) → {base, state, calls, close()}. Chỉnh hành vi qua state (vd. state.fail['channels'] = {status, reason}).
// Dùng trực tiếp: `node test/fixtures/fake-google.mjs <port>` (e2e).
import crypto from 'node:crypto';
import http from 'node:http';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const UPLOADS = 'UUfake-uploads';

// Dữ liệu mặc định: 1 kênh, 3 video; analytics trả mọi ngày yêu cầu.
export function defaultState() {
  return {
    channel: { id: 'UCfake000000000000000001', title: 'Kênh Giả', customUrl: '@kenhgia', publishedAt: '2024-01-15T00:00:00Z', subscribers: '1234', views: '56789', videos: '3', hidden: false },
    noChannel: false,
    videos: [
      { id: 'vid1', title: 'Video một', publishedAt: '2026-10-01T04:30:00Z', duration: 'PT11M30S', privacy: 'public', views: '1000', likes: '50', comments: '7' },
      { id: 'vid2', title: 'Video hai', publishedAt: '2026-10-10T04:30:00Z', duration: 'PT58S', privacy: 'public', views: '300', likes: '20', comments: '1' },
      { id: 'vid3', title: 'Video ba (riêng tư)', publishedAt: '2026-10-20T04:30:00Z', duration: 'PT1H2M3S', privacy: 'private', views: '0', likes: '0', comments: '0' },
    ],
    autoApprove: true, // /o/oauth2/v2/auth chuyển thẳng về redirect_uri kèm code
    denyConsent: false, // chuyển về kèm error=access_denied
    noRefresh: false, // /token không trả refresh_token
    grantScopes: null, // null → trả đúng scope được xin
    sub: 'fake-sub-owner', // id Google (sub) trả trong id_token khi xin scope openid
    fail: {}, // tên endpoint (token, refresh, revoke, channels, playlistItems, videos, reports) → {status, reason}
    revoked: new Set(),
    codes: new Map(), // code → {challenge, scope, redirectUri, clientId}
    refresh: new Map(), // refresh_token → scope
    access: new Set(),
    // Google Cloud (Thiết lập tự động): token gcloud giả, dự án, API đã bật.
    cloud: {
      token: 'fake-cloud-token',
      tosRequired: false, // tạo dự án → lỗi chưa đồng ý Điều khoản
      projectQuota: false, // tạo dự án → operation lỗi RESOURCE_EXHAUSTED
      enableFailTimes: 0, // batchEnable trả 403 bao nhiêu lần đầu (dự án mới chưa sẵn sàng)
      projects: new Map(), // projectId → {projectId, displayName, state}
      enabled: new Map(), // projectId → Set(serviceId)
      ops: new Map(), // tên operation → {polls, result}
    },
  };
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function apiError(res, f) {
  send(res, f.status, { error: { code: f.status, message: `fake ${f.reason || 'error'}`, errors: [{ reason: f.reason || 'error' }] } });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Tạo ngày YYYY-MM-DD liên tiếp từ start tới end.
function daysBetween(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

export function startFakeGoogle({ port = 0, state = defaultState() } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const body = req.method === 'POST' ? await readBody(req) : '';
    calls.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization || null, body });

    // Màn hình đồng ý của Google: tự duyệt rồi chuyển về app.
    if (p === '/o/oauth2/v2/auth') {
      const q = u.searchParams;
      const redirect = new URL(q.get('redirect_uri'));
      redirect.searchParams.set('state', q.get('state') || '');
      if (state.denyConsent) redirect.searchParams.set('error', 'access_denied');
      else {
        const code = b64url(crypto.randomBytes(12));
        state.codes.set(code, { challenge: q.get('code_challenge'), scope: q.get('scope'), redirectUri: q.get('redirect_uri'), clientId: q.get('client_id') });
        redirect.searchParams.set('code', code);
      }
      if (!state.autoApprove) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>Fake Google</title><a id="approve" href="${redirect.href.replace(/"/g, '&quot;')}">Cho phép</a>`);
        return;
      }
      res.writeHead(302, { location: redirect.href });
      res.end();
      return;
    }

    if (p === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') {
        if (state.fail.token) return send(res, state.fail.token.status, { error: state.fail.token.reason, error_description: 'fake' });
        const c = state.codes.get(f.get('code'));
        state.codes.delete(f.get('code'));
        const challenge = b64url(crypto.createHash('sha256').update(f.get('code_verifier') || '').digest());
        if (!c || c.challenge !== challenge || c.redirectUri !== f.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant', error_description: 'Bad code or verifier' });
        const scope = state.grantScopes ?? c.scope;
        const access = `at-${b64url(crypto.randomBytes(9))}`;
        state.access.add(access);
        const out = { access_token: access, expires_in: 3599, scope, token_type: 'Bearer' };
        // openid → id_token (JWT không ký, đủ cho app đọc sub/aud/iss/exp).
        if (String(c.scope).split(' ').includes('openid')) {
          const claims = { iss: 'https://accounts.google.com', aud: c.clientId, sub: state.sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
          out.id_token = ['{"alg":"none"}', JSON.stringify(claims), ''].map((x) => b64url(Buffer.from(x))).join('.');
        }
        if (!state.noRefresh && c.scope !== 'openid') {
          const rt = `rt-${b64url(crypto.randomBytes(9))}`;
          state.refresh.set(rt, scope);
          out.refresh_token = rt;
        }
        return send(res, 200, out);
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (state.fail.refresh) return send(res, state.fail.refresh.status, { error: state.fail.refresh.reason, error_description: 'fake' });
        const rt = f.get('refresh_token');
        if (!state.refresh.has(rt) || state.revoked.has(rt)) return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const access = `at-${b64url(crypto.randomBytes(9))}`;
        state.access.add(access);
        return send(res, 200, { access_token: access, expires_in: 3599, scope: state.refresh.get(rt), token_type: 'Bearer' });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (p === '/revoke' && req.method === 'POST') {
      if (state.fail.revoke) return send(res, state.fail.revoke.status, { error: state.fail.revoke.reason });
      const t = new URLSearchParams(body).get('token');
      state.revoked.add(t);
      return send(res, 200, {});
    }

    // Trang Google Cloud Console giả (người dùng làm tay).
    if (p.startsWith('/console')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Fake Cloud Console</title><h1>Fake Cloud Console</h1><p id="path">${p.replace(/[<>&"]/g, '')}</p>`);
      return;
    }

    // Google Cloud REST (CRM v3 + Service Usage v1) — Bearer là token gcloud giả.
    if (p.startsWith('/crm/v3/') || p.startsWith('/su/v1/')) {
      const cl = state.cloud;
      if ((req.headers.authorization || '') !== `Bearer ${cl.token}`) return apiError(res, { status: 401, reason: 'UNAUTHENTICATED' });
      const opName = (prefix) => `operations/${prefix}.${crypto.randomBytes(4).toString('hex')}`;
      // Operation chạy 1 nhịp: lần GET đầu chưa xong, lần sau xong.
      const newOp = (name, result) => {
        cl.ops.set(name, { polls: 0, result });
        return send(res, 200, { name, done: false });
      };
      const opMatch = p.match(/^\/(crm\/v3|su\/v1)\/(operations\/.+)$/);
      if (opMatch && req.method === 'GET') {
        const op = cl.ops.get(opMatch[2]);
        if (!op) return apiError(res, { status: 404, reason: 'NOT_FOUND' });
        op.polls += 1;
        if (op.polls < 2) return send(res, 200, { name: opMatch[2], done: false });
        const r = op.result();
        return send(res, 200, { name: opMatch[2], done: true, ...r });
      }
      if (p === '/crm/v3/projects' && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        if (cl.tosRequired) return send(res, 400, { error: { code: 400, message: 'Callers must accept Terms of Service', status: 'FAILED_PRECONDITION' } });
        if (cl.projects.has(b.projectId)) return send(res, 409, { error: { code: 409, message: 'Requested entity already exists', status: 'ALREADY_EXISTS' } });
        return newOp(opName('cp'), () => {
          if (cl.projectQuota) return { error: { code: 8, message: 'Project creation failed: quota exceeded.' } };
          const proj = { projectId: b.projectId, displayName: b.displayName, state: 'ACTIVE' };
          cl.projects.set(b.projectId, proj);
          return { response: proj };
        });
      }
      if (p === '/crm/v3/projects:search') return send(res, 200, { projects: [...cl.projects.values()].filter((x) => x.state === 'ACTIVE') });
      const pm = p.match(/^\/crm\/v3\/projects\/([^/]+)$/);
      if (pm && req.method === 'GET') {
        const proj = cl.projects.get(decodeURIComponent(pm[1]));
        return proj ? send(res, 200, proj) : send(res, 403, { error: { code: 403, message: 'Permission denied or not found', status: 'PERMISSION_DENIED' } });
      }
      const em = p.match(/^\/su\/v1\/projects\/([^/]+)\/services:batchEnable$/);
      if (em && req.method === 'POST') {
        const id = decodeURIComponent(em[1]);
        if (!cl.projects.has(id)) return send(res, 403, { error: { code: 403, message: 'Project not found', status: 'PERMISSION_DENIED' } });
        if (cl.enableFailTimes > 0) {
          cl.enableFailTimes -= 1;
          return send(res, 403, { error: { code: 403, message: 'Project not ready', status: 'PERMISSION_DENIED' } });
        }
        const ids = JSON.parse(body || '{}').serviceIds || [];
        return newOp(opName('acf'), () => {
          const set = cl.enabled.get(id) || new Set();
          for (const s of ids) set.add(s);
          cl.enabled.set(id, set);
          return { response: { services: ids.map((s) => ({ name: `projects/${id}/services/${s}`, state: 'ENABLED' })) } };
        });
      }
      return apiError(res, { status: 404, reason: 'NOT_FOUND' });
    }

    // API cần Bearer hợp lệ.
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const name = p.split('/').pop();
    if (p.startsWith('/youtube/v3/') || p.startsWith('/v2/')) {
      if (!state.access.has(bearer)) return apiError(res, { status: 401, reason: 'authError' });
      if (state.fail[name]) return apiError(res, state.fail[name]);
    }

    if (p === '/youtube/v3/channels') {
      if (state.noChannel) return send(res, 200, { items: [] });
      const c = state.channel;
      return send(res, 200, {
        items: [
          {
            id: c.id,
            snippet: { title: c.title, customUrl: c.customUrl, publishedAt: c.publishedAt },
            statistics: { subscriberCount: c.subscribers, viewCount: c.views, videoCount: c.videos, hiddenSubscriberCount: c.hidden },
            contentDetails: { relatedPlaylists: { uploads: UPLOADS } },
          },
        ],
      });
    }
    if (p === '/youtube/v3/playlistItems') {
      const page = Number(u.searchParams.get('pageToken') || 0);
      const per = Number(u.searchParams.get('maxResults') || 50);
      const slice = state.videos.slice(page * per, page * per + per);
      const more = (page + 1) * per < state.videos.length;
      return send(res, 200, { items: slice.map((v) => ({ contentDetails: { videoId: v.id } })), ...(more ? { nextPageToken: String(page + 1) } : {}) });
    }
    if (p === '/youtube/v3/videos') {
      const ids = new Set((u.searchParams.get('id') || '').split(','));
      return send(res, 200, {
        items: state.videos
          .filter((v) => ids.has(v.id))
          .map((v) => ({
            id: v.id,
            snippet: { title: v.title, publishedAt: v.publishedAt },
            contentDetails: { duration: v.duration },
            status: { privacyStatus: v.privacy },
            statistics: { viewCount: v.views, likeCount: v.likes, commentCount: v.comments },
          })),
      });
    }
    if (p === '/v2/reports') {
      const q = u.searchParams;
      if (q.get('dimensions') === 'day') {
        const rows = daysBetween(q.get('startDate'), q.get('endDate')).map((d, i) => [d, 10 + i, 20 + i, 60, i % 3, i % 5 === 0 ? 1 : 0]);
        return send(res, 200, {
          columnHeaders: ['day', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost'].map((n) => ({ name: n })),
          rows,
        });
      }
      if (q.get('dimensions') === 'video') {
        return send(res, 200, {
          columnHeaders: ['video', 'views', 'averageViewDuration', 'subscribersGained'].map((n) => ({ name: n })),
          rows: state.videos.filter((v) => v.privacy === 'public').map((v, i) => [v.id, Number(v.views), 120 + i, 3 + i]),
        });
      }
      return send(res, 400, { error: { code: 400, message: 'bad dims', errors: [{ reason: 'badRequest' }] } });
    }
    send(res, 404, { error: { code: 404, message: 'not found', errors: [{ reason: 'notFound' }] } });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        base: `http://127.0.0.1:${actual}`,
        state,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Mã client_secret.json giả loại Desktop app.
export const FAKE_CLIENT_SECRET = JSON.stringify({
  installed: { client_id: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', client_secret: 'GOCSPX-fake-secret', redirect_uris: ['http://localhost'] },
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const g = await startFakeGoogle({ port: Number(process.argv[2] || 0) });
  console.log(g.base);
}

// client_secret.json giả gắn với 1 dự án (giống file Google cho tải về); web=true → loại Web (sai loại).
export function fakeClientSecretFor(projectId, { web = false } = {}) {
  const c = { client_id: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', project_id: projectId, client_secret: 'GOCSPX-fake-secret', redirect_uris: ['http://localhost'] };
  return JSON.stringify(web ? { web: c } : { installed: c });
}
