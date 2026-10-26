// API /api/oauth/usage giả cho test: không bao giờ gọi api.anthropic.com thật.
// set({five_hour, seven_day} theo %, status?) đổi số trả về; calls ghi lại header Authorization đã nhận.
import http from 'node:http';

export const FAKE_PLAN_TOKEN = 'fake-oauth-token';

// Ghi file credentials giả cùng dạng Claude Code (dùng với VS_CLAUDE_CREDENTIALS).
export function fakeCredentials({ token = FAKE_PLAN_TOKEN, expiresAt = Date.now() + 3600_000 } = {}) {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'fake-refresh', expiresAt, scopes: ['user:inference'] } });
}

export async function startFakeClaudeApi({ five_hour = 47, seven_day = 18 } = {}) {
  let cur = { five_hour, seven_day, status: 200 };
  const calls = [];
  const srv = http.createServer((req, res) => {
    if (req.method !== 'GET' || !req.url.startsWith('/api/oauth/usage')) {
      res.writeHead(404).end();
      return;
    }
    calls.push({ auth: req.headers.authorization, beta: req.headers['anthropic-beta'] });
    if (cur.status !== 200 || req.headers.authorization !== `Bearer ${FAKE_PLAN_TOKEN}`) {
      res.writeHead(cur.status !== 200 ? cur.status : 401, { 'content-type': 'application/json' }).end('{"error":"x"}');
      return;
    }
    const w = (u, h) => (u == null ? null : { utilization: u, resets_at: new Date(Date.UTC(2030, 0, 1, h)).toISOString() });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ five_hour: w(cur.five_hour, 5), seven_day: w(cur.seven_day, 0), seven_day_opus: null, extra_usage: { is_enabled: false } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    calls,
    set: (o) => (cur = { ...cur, ...o }),
    close: () => new Promise((r) => srv.close(r)),
  };
}
