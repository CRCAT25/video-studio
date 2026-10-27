#!/usr/bin/env node
// E2E M1 (§13): server thật + fake-claude + Chrome for Testing qua playwright-core.
// Chạy: npm run e2e  ·  E2E_SHOTS=<thư mục ảnh> · E2E_HEADED=1 để xem trình duyệt · E2E_SKIP_BUILD=1 bỏ bước build web.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Ảnh thu nhỏ i.ytimg.com của Google giả → trả ảnh SVG tại chỗ, không ra mạng thật.
const THUMB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#3a6"/></svg>';
const fakeThumbs = (ctx) => ctx.route('https://i.ytimg.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: THUMB_SVG }));
import { FAKE_CLIENT_SECRET, fakeClientSecretFor, startFakeGoogle } from '../fixtures/fake-google.mjs';
import { fakeCredentials, startFakeClaudeApi } from '../fixtures/fake-claude-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_BIN = path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const FAKE_GCLOUD = path.join(ROOT, 'test', 'fixtures', 'fake-gcloud.mjs');
const PRESET_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'presets', 'e2e-short.yaml');
const MANUAL_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'presets', 'e2e-manual.yaml');
const CHROME =
  process.env.E2E_CHROME ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'vs-e2e-shots');
const TOKEN = 'e2e-fixed-token-0123456789abcdef';
const TITLE = 'Vàng nhẫn hay gửi tiết kiệm';
const SLUG = 'vang-nhan-hay-gui-tiet-kiem';
const WAIT = 15_000;

const results = [];
let shotN = 0;

// Ghi một mục kiểm ✅/❌ (không ném lỗi — để chạy tiếp các mục khác khi có thể).
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}

// Chạy một mục kiểm; lỗi ném ra = ❌ kèm thông điệp, rồi đi tiếp.
// Menu Tài khoản ở header: đổi theme / mở bảng Claude (qua DOM để dùng được cả khi panel phủ header).
async function toggleTheme(p) {
  await p.evaluate(() => document.querySelector('header.top .acc-btn').click());
  await p.waitForSelector('header.top .menu');
  await p.evaluate(() => [...document.querySelectorAll('.menu [role=menuitemradio][aria-checked=false]')].find((b) => /^(Sáng|Tối)$/.test(b.textContent.trim())).click());
  await p.waitForSelector('header.top .menu', { state: 'detached' });
}
async function openAccount(p) {
  await p.locator('header.top .acc-btn').click();
  await p.getByRole('menuitem', { name: 'Tài khoản Claude' }).click();
}

async function check(name, fn) {
  try {
    const detail = await fn();
    return record(name, true, typeof detail === 'string' ? detail : '');
  } catch (e) {
    return record(name, false, String(e && e.message ? e.message : e).split('\n')[0]);
  }
}

// Chọn giá trị trong ô chọn tự vẽ (components/Select.jsx) nằm trong scope.
async function choose(scope, value) {
  await scope.locator('.sel-btn').click();
  await scope.locator(`.sel-list [role="option"][data-value="${value}"]`).click();
  await scope.locator('.sel-list').waitFor({ state: 'detached' });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Tìm cổng TCP trống trên 127.0.0.1.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Khởi server thật; chờ dòng "Video Studio đang chạy: <url>".
function startServer(port, home, googleBase, claudeApiBase) {
  const env = {
    ...process.env,
    VS_SECRETS: 'file',
    VS_GOOGLE_BASE: googleBase,
    VS_UPDATE_API: googleBase,
    VS_UPDATE_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-update.mjs'),
    VS_HOME: home,
    VS_TOKEN: TOKEN,
    VS_CLAUDE_BIN: FAKE_BIN,
    // Mức dùng: token giả + API giả — không đọc Keychain thật, không gọi api.anthropic.com.
    VS_CLAUDE_CREDENTIALS: path.join(home, 'fake-claude-credentials.json'),
    VS_CLAUDE_API_BASE: claudeApiBase,
    FAKE_AUTH_FILE: path.join(home, 'fake-auth.json'),
    FAKE_LOGIN_MS: '1500',
    FAKE_BROWSER_LOG: path.join(home, 'fake-browser.jsonl'),
    VS_GCLOUD: FAKE_GCLOUD,
    VS_DOWNLOADS: path.join(home, 'Downloads'),
    FAKE_GCLOUD_LOG: path.join(home, 'fake-gcloud.jsonl'),
  };
  delete env.FAKE_GCLOUD_LOGIN;
  delete env.FAKE_GCLOUD_LOGIN_MS;
  delete env.FAKE_LOGIN_EXIT;
  delete env.FAKE_SCENARIO;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'cli.js'), '--port', String(port), '--no-open'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server không khởi động sau ${WAIT} ms:\n${logs.join('')}`)), WAIT);
    const onData = (buf) => {
      const s = buf.toString('utf8');
      logs.push(s);
      const m = logs.join('').match(/Video Studio đang chạy: (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(new URL(m[1]).origin);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => logs.push(b.toString('utf8')));
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      reject(new Error(`server thoát sớm (code ${code}, signal ${sig}):\n${logs.join('')}`));
    });
  });
  return { child, ready, logs };
}

// Dừng server: SIGTERM, quá 5 s thì SIGKILL.
async function stopServer(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* đã thoát */
    }
  }, 5000);
  await gone;
  clearTimeout(t);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (/^\d\d-.*\.png$/.test(f)) fs.rmSync(path.join(SHOTS, f), { force: true });

  if (process.env.E2E_SKIP_BUILD !== '1') {
    const b = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'web/vite.config.js', '--logLevel', 'error'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (!record('Build web (vite build)', b.status === 0, b.status === 0 ? '' : (b.stderr || b.stdout || '').trim().split('\n').pop())) return;
  }
  if (!record('Có Chrome for Testing', fs.existsSync(CHROME), fs.existsSync(CHROME) ? '' : CHROME)) return;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-e2e-home-'));
  fs.mkdirSync(path.join(home, 'presets'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.copyFileSync(PRESET_FIXTURE, path.join(home, 'presets', 'e2e-short.yaml'));
  fs.copyFileSync(MANUAL_FIXTURE, path.join(home, 'presets', 'e2e-manual.yaml'));
  const projDir = path.join(home, 'projects', SLUG);
  const setScenario = (s) => {
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '.fake-scenario'), `${s}\n`);
  };

  // Kênh YouTube giả: không đụng Keychain thật (VS_SECRETS=file) và Google thật (fake-google).
  fs.writeFileSync(
    path.join(home, 'presets', 'channels.yaml'),
    '- id: tiktok\n  name: TikTok\n  platform: tiktok\n',
  );
  let server;
  let browser;
  let google;
  let claudeApi;
  try {
    google = await startFakeGoogle();
    claudeApi = await startFakeClaudeApi({ five_hour: 47, seven_day: 18 });
    fs.writeFileSync(path.join(home, 'fake-claude-credentials.json'), fakeCredentials());
    google.state.release = { tag_name: 'v9.9.9', name: 'v9.9.9', html_url: 'https://github.com/CRCAT25/video-studio/releases/tag/v9.9.9' };
    const port = await freePort();
    server = startServer(port, home, google.base, claudeApi.base);
    const base = await server.ready;
    record('Server thật khởi động', true, base);

    const apiGet = async (p) => {
      const r = await fetch(base + p, { headers: { 'x-studio-token': TOKEN } });
      const body = await r.json();
      if (!r.ok) throw new Error(`${p} → ${r.status} ${body?.message || ''}`);
      return body;
    };
    const stepApi = (key) => apiGet(`/api/projects/${SLUG}/steps/${key}`);

    // ---- HTTP thô: 401 / 302 + cookie
    await check('/api/projects không token → 401', async () => {
      const r = await fetch(`${base}/api/projects`);
      const body = await r.json().catch(() => ({}));
      assert(r.status === 401, `status ${r.status}`);
      assert(body.error === 'unauthorized', `error=${body.error}`);
      return body.message;
    });
    await check('Mở /?t=token → 302 bỏ token + set cookie', async () => {
      const r = await fetch(`${base}/?t=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' });
      assert(r.status === 302, `status ${r.status}`);
      const loc = r.headers.get('location') || '';
      assert(!loc.includes('t='), `location còn token: ${loc}`);
      const sc = r.headers.get('set-cookie') || '';
      assert(sc.includes(`vs_token=${TOKEN}`), 'thiếu cookie vs_token');
      assert(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Path=\//.test(sc), `cookie thiếu cờ: ${sc}`);
      return `Location: ${loc}`;
    });

    // ---- trình duyệt
    browser = await chromium.launch({ executablePath: CHROME, headless: process.env.E2E_HEADED !== '1' });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: 'dark', locale: 'vi-VN' });
    await fakeThumbs(context);
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT);
    const consoleIssues = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleIssues.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleIssues.push(`pageerror: ${e.message}`));
    const runPosts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/projects\/[^/]+\/steps\/[^/]+\/run$/.test(new URL(req.url()).pathname)) runPosts.push(req.url());
    });

    const shot = async (name, p = page, fullPage = true) => {
      shotN += 1;
      const file = path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`);
      await p.screenshot({ path: file, fullPage }); // menu nổi (position:fixed) cần fullPage=false
      return file;
    };
    const stateTag = () => page.locator('.step-head h1 .state-tag');
    const waitState = async (st, timeout = WAIT) => {
      await page.locator(`.step-head h1 .state-tag.s-${st}`).waitFor({ timeout });
    };
    const mainBtn = () => page.locator('.step-head .acts button').first();
    // Chờ bước có thêm lượt mới (so với `before`) và lượt đó đã kết thúc, rồi chờ UI hiện trạng thái `st`.
    const waitNewRun = async (key, before, st) => {
      const t0 = Date.now();
      for (;;) {
        const v = await stepApi(key);
        if (v.runs.length > before && v.runs[0].state !== 'running' && v.step.state !== 'running') break;
        if (Date.now() - t0 > WAIT) throw new Error(`bước ${key}: không có lượt mới kết thúc sau ${WAIT} ms`);
        await new Promise((r) => setTimeout(r, 150));
      }
      await waitState(st);
    };
    const tab = (label) => page.locator('.subtabs button', { hasText: label });
    const gotoStep = async (key, name) => {
      await page.locator(`.line-panel .flow a.box[href$="/${key}"]`).click();
      await page.locator('.step-head h1', { hasText: name }).waitFor();
    };

    // Đi Tab/Shift+Tab n lần, trả các phần tử nhận focus nằm ngoài hộp thoại.
    const tabOutside = async (key, n) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        await page.keyboard.press(key);
        const where = await page.evaluate(() => {
          const a = document.activeElement;
          return a && a.closest('.modal') ? '' : `${a?.tagName}.${a?.className || ''} "${(a?.textContent || '').trim().slice(0, 20)}"`;
        });
        if (where) out.push(where);
      }
      return out;
    };

    let created = false;
    await check('Trình duyệt mở /?t= → URL không còn token, có cookie', async () => {
      await page.goto(`${base}/?t=${encodeURIComponent(TOKEN)}`);
      await page.locator('.page-h h1', { hasText: 'Dự án' }).waitFor();
      assert(!page.url().includes('t='), `URL còn token: ${page.url()}`);
      const ck = (await context.cookies(base)).find((c) => c.name === 'vs_token');
      assert(ck && ck.httpOnly && ck.sameSite === 'Strict', 'cookie vs_token thiếu/sai cờ');
      await page.locator('header.top').waitFor();
      assert((await page.locator('.doctor[role="alert"]').count()) === 0, 'đang hiện banner doctor');
      await shot('overview-empty');
      return page.url();
    });

    await check('Bản mới: thanh báo v9.9.9 → Cập nhật → Khởi động lại → app mở lại cùng cổng, trang tự tải lại', async () => {
      const bar = page.locator('.upd');
      await bar.getByText('Có bản mới').waitFor();
      assert((await bar.textContent()).includes('v9.9.9'), 'thiếu số bản mới');
      const link = await bar.getByRole('link', { name: 'Xem thay đổi' }).getAttribute('href');
      assert(link?.startsWith('https://github.com/'), `link thay đổi sai: ${link}`);
      await shot('update-banner');
      await bar.getByRole('button', { name: 'Cập nhật' }).click();
      await bar.getByText('Đang cập nhật').waitFor();
      await bar.getByText('Đã tải bản v9.9.9').waitFor({ timeout: 10_000 });
      await shot('update-done');
      const boot0 = (await (await fetch(`${base}/api/health`)).json()).boot;
      await page.evaluate(() => (window.__beforeRestart = true));
      await bar.getByRole('button', { name: 'Khởi động lại' }).click();
      await page.waitForFunction(() => !window.__beforeRestart, null, { timeout: 30_000 });
      const boot1 = (await (await fetch(`${base}/api/health`)).json()).boot;
      assert(boot1 && boot1 !== boot0, 'server chưa khởi động lại');
      assert(server.child.exitCode == null, 'tiến trình cha đã thoát');
      await bar.getByText('Có bản mới').waitFor();
    });

    await check('Modal: Tab/Shift+Tab không thoát khỏi hộp, nền inert, Esc trả lại trang', async () => {
      await page.getByRole('button', { name: /Dự án mới/ }).first().click();
      const modal = page.locator('.modal[role="dialog"]');
      await modal.waitFor();
      const fwd = await tabOutside('Tab', 14);
      const back = await tabOutside('Shift+Tab', 14);
      assert(!fwd.length && !back.length, `focus ra ngoài: ${[...fwd, ...back].slice(0, 3).join(', ')}`);
      const inert = await page.evaluate(() => !!document.querySelector('header.top')?.closest('[inert]'));
      assert(inert, 'header không inert khi mở hộp thoại');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'detached' });
      const left = await page.evaluate(() => document.querySelectorAll('[inert]').length);
      assert(left === 0, `còn ${left} phần tử inert sau khi đóng`);
      return '28 lần Tab trong hộp';
    });

    await check('Tạo dự án qua modal: chọn quy trình đã lưu e2e-short → Tiếp tục', async () => {
      await page.getByRole('button', { name: /Dự án mới/ }).first().click();
      const modal = page.locator('.modal[role="dialog"]');
      await modal.waitFor();
      await modal.getByRole('tab', { name: /Quy trình đã lưu/ }).click();
      await modal.locator('.saved-item', { hasText: 'E2E short' }).click();
      await modal.locator('.fld.prev:not(.sk-zone)').waitFor();
      await shot('new-project-pick');
      await modal.getByRole('button', { name: 'Tiếp tục' }).click();
      await modal.locator('input[data-autofocus]').fill(TITLE);
      await modal.locator('details.adv summary').click();
      const slug = await modal.getByLabel('Slug').inputValue();
      assert(slug === SLUG, `slug tự sinh = ${slug}`);
      const dir = await modal.locator('.dirprev').innerText();
      assert(dir.includes(`projects/${SLUG}`), `xem trước thư mục = ${dir}`);
      await shot('new-project-modal');
      await modal.getByRole('button', { name: /Tạo dự án/ }).click();
      await page.waitForURL(new RegExp(`#/p/${SLUG}/hook$`));
      await page.locator('.step-head h1', { hasText: 'Lời hứa & hook' }).waitFor();
      created = true;
      return dir;
    });
    if (!created) throw new Error('Không tạo được dự án — dừng các bước sau.');

    // ---- Bước hook: slow → Dừng → chạy lại tới xong
    await check('Hook: chạy kịch bản slow, thấy log live', async () => {
      await waitState('ready');
      setScenario('slow');
      await mainBtn().click();
      await waitState('running');
      const log = page.locator('.term .log');
      await log.locator('.ev', { hasText: 'Đang làm… 2' }).waitFor();
      const n1 = await log.locator('.ev').count();
      await log.locator('.ev', { hasText: 'Đang làm… 6' }).waitFor();
      const n2 = await log.locator('.ev').count();
      assert(n2 > n1, `số dòng không tăng (${n1} → ${n2})`);
      assert((await page.locator('.term .lamp.live').count()) === 1, 'đèn live không sáng');
      await shot('hook-running-live-log');
      return `${n1} → ${n2} dòng`;
    });

    await check('Hook: bấm Dừng → lượt dừng, bước về sẵn sàng', async () => {
      await page.locator('.step-head .acts button.danger', { hasText: 'Dừng' }).click();
      await page.locator('.step-head h1 .state-tag:not(.s-running)').waitFor();
      const st = await stateTag().getAttribute('class');
      assert(/s-ready/.test(st), `trạng thái sau Dừng: ${st}`);
      await page.locator('.term .log .ev', { hasText: 'Dừng theo yêu cầu' }).waitFor();
      const v = await stepApi('hook');
      assert(v.runs[0]?.state === 'stopped', `lượt 1 = ${v.runs[0]?.state}`);
      await shot('hook-stopped');
      return `lượt ${v.runs[0].n}: ${v.runs[0].state}`;
    });

    await check('Hook: chạy lại (done) → Xong', async () => {
      setScenario('done');
      await mainBtn().click();
      await waitNewRun('hook', 1, 'done');
      const v = await stepApi('hook');
      assert(v.runs.length === 2 && v.runs[0].state === 'done', `runs = ${v.runs.map((r) => r.state).join(',')}`);
      return `${v.runs.length} lượt`;
    });

    await check('Tab Đầu ra có script.md và nội dung', async () => {
      await tab('Đầu ra').click();
      const out = page.locator('.text-out', { hasText: 'script.md' });
      await out.waitFor();
      await out.locator('pre.box-pre', { hasText: 'Nội dung giả cho script.md' }).waitFor();
      await shot('hook-outputs');
      return (await out.locator('pre.box-pre').innerText()).split('\n')[0];
    });

    // ---- Bước bible
    await check('Sang bước bible (đã sẵn sàng), chạy → check project_json ĐẠT', async () => {
      await gotoStep('bible', 'Visual bible');
      await waitState('ready');
      await mainBtn().click();
      await waitNewRun('bible', 0, 'done');
      await tab('Kiểm tra').click();
      const row = page.locator('.check', { hasText: 'project_json' });
      await row.locator('.pf.p', { hasText: 'ĐẠT' }).waitFor();
      assert((await row.locator('code').innerText()).includes('test -s project.json'), 'lệnh check sai');
      await shot('bible-checks');
      return 'test -s project.json';
    });

    // ---- Bước voice: modal chi phí
    await check('Voice: Chạy → modal chi phí; Hủy không tạo lượt', async () => {
      await gotoStep('voice', 'Lồng tiếng');
      await waitState('ready');
      const before = runPosts.length;
      await mainBtn().click();
      const modal = page.locator('.modal[role="dialog"]', { hasText: 'Xác nhận chi phí' });
      await modal.waitFor();
      const box = await modal.locator('.cost-box').innerText();
      assert(/elevenlabs/i.test(box), `cost-box: ${box}`);
      await shot('voice-cost-modal');
      await modal.getByRole('button', { name: 'Hủy' }).click();
      await modal.waitFor({ state: 'detached' });
      await page.waitForTimeout(300);
      assert(runPosts.length === before, 'Hủy vẫn gọi API run');
      const v = await stepApi('voice');
      assert(v.runs.length === 0 && v.step.state === 'ready', `runs=${v.runs.length}, state=${v.step.state}`);
      return box.replace(/\s+/g, ' ').trim();
    });

    await check('Voice: Đồng ý → chạy với allowPaid, ra audio', async () => {
      await mainBtn().click();
      const modal = page.locator('.modal[role="dialog"]', { hasText: 'Xác nhận chi phí' });
      await modal.waitFor();
      await modal.getByRole('button', { name: /Đồng ý/ }).click();
      await waitNewRun('voice', 0, 'done');
      const v = await stepApi('voice');
      assert(v.runs.length === 1, `runs=${v.runs.length}`);
      assert(v.runs[0].allow_paid === true || v.runs[0].allow_paid === 1, `allow_paid=${v.runs[0].allow_paid}`);
      await tab('Đầu ra').click();
      await page.locator('.out-row', { hasText: 'audio/fake-1.wav' }).locator('audio').waitFor();
      await shot('voice-outputs');
      return 'audio/fake-1.wav';
    });

    // ---- Bước deliver: needs_input → chạy lại kèm góp ý
    const FEEDBACK = 'Giọng nữ, ấm áp.';
    await check('Deliver: needs_input hiện câu hỏi', async () => {
      await gotoStep('deliver', 'Giao bản cuối');
      await waitState('ready');
      setScenario('needs_input');
      await mainBtn().click();
      await waitNewRun('deliver', 0, 'needs_input');
      await page.locator('.decide.ask', { hasText: 'Claude cần bạn trả lời' }).locator('li', { hasText: 'Bạn muốn giọng nam hay nữ?' }).waitFor();
      await shot('deliver-needs-input');
      return 'Bạn muốn giọng nam hay nữ?';
    });

    await check('Deliver: "Chạy lại kèm góp ý" → Xong, góp ý vào prompt', async () => {
      setScenario('done');
      await page.locator('#fb').fill(FEEDBACK);
      await page.locator('.step-head .acts button', { hasText: 'Chạy lại kèm góp ý' }).click();
      await waitNewRun('deliver', 1, 'done');
      const v = await stepApi('deliver');
      assert(v.runs.length === 2 && v.runs[0].feedback === FEEDBACK, `feedback lượt mới = ${v.runs[0]?.feedback}`);
      const calls = fs.readFileSync(path.join(projDir, '.fake-calls.jsonl'), 'utf8').trim().split('\n');
      const last = JSON.parse(calls[calls.length - 1]);
      assert(last.prompt.includes(FEEDBACK), 'prompt lượt mới không chứa góp ý');
      return `${v.runs.length} lượt`;
    });

    await check('Dự án hoàn tất; tab Kiểm tra ĐẠT', async () => {
      await tab('Kiểm tra').click();
      await page.locator('.check', { hasText: 'outputs' }).locator('.pf.p', { hasText: 'ĐẠT' }).waitFor();
      assert((await page.locator('.check .pf.f').count()) === 0, 'có check TRƯỢT');
      await shot('deliver-checks');
      const { projects, stats } = await apiGet('/api/projects');
      const p = projects.find((x) => x.id === SLUG);
      assert(p && p.status === 'done', `status dự án = ${p?.status}`);
      assert(stats.done === 1, `stats.done = ${stats.done}`);
      await page.locator('header.top a', { hasText: 'Tổng quan' }).click();
      await page.locator('.proj', { hasText: TITLE }).locator('text=Hoàn tất').first().waitFor();
      await shot('overview-done');
      return `stats.done=${stats.done}`;
    });

    await check('Chạy lại hook → các bước sau thành stale', async () => {
      await page.locator('.proj', { hasText: TITLE }).locator('.ptitle').first().click();
      await page.locator('.step-head').waitFor();
      if (!/\/hook$/.test(page.url())) await gotoStep('hook', 'Lời hứa & hook');
      await waitState('done');
      const before = (await stepApi('hook')).runs.length;
      await mainBtn().click();
      await waitNewRun('hook', before, 'done');
      const v = await apiGet(`/api/projects/${SLUG}`);
      const states = Object.fromEntries((v.project?.steps || v.steps || []).map((s) => [s.key, s.state]));
      assert(states.bible === 'stale' && states.voice === 'stale' && states.deliver === 'stale', JSON.stringify(states));
      await page.locator('.line-panel .flow a.box.s-stale').nth(2).waitFor();
      await shot('hook-rerun-stale');
      return JSON.stringify(states);
    });

    await check('Việc tay: Đánh dấu xong → không còn nút Chạy lại / cảnh báo / thẻ góp ý', async () => {
      const r = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'x-studio-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ presetId: 'e2e-manual', title: 'Đăng tay thử', slug: 'dang-tay-thu' }),
      });
      assert(r.status === 201, `tạo dự án manual → ${r.status}`);
      await page.goto(`${base}/#/p/dang-tay-thu/upload`);
      await waitState('manual');
      await page.locator('.step-head .acts button', { hasText: 'Đánh dấu xong' }).click();
      await waitState('done');
      const btns = await page.locator('.step-head .acts button').allInnerTexts();
      assert(!btns.some((t) => /Chạy/.test(t)), `nút: ${btns.join(' | ')}`);
      assert((await page.locator('.warn-note').count()) === 0, `còn cảnh báo: ${await page.locator('.warn-note').allInnerTexts()}`);
      assert((await page.locator('#fb').count()) === 0, 'còn thẻ góp ý');
      await page.locator('.note', { hasText: 'Việc tay đã đánh dấu xong' }).waitFor();
      await shot('manual-done');
      return btns.join(' | ');
    });

    await check('Màn Quy trình: quy trình của tôi e2e-short/e2e-manual; nhãn cổng trong ô không bị cắt', async () => {
      await page.locator('header.top a', { hasText: 'Quy trình' }).click();
      await page.locator('.page-h h1', { hasText: 'Quy trình' }).waitFor();
      await page.locator('section.bp', { hasText: 'e2e-short' }).waitFor();
      await page.locator('section.bp', { hasText: 'e2e-manual' }).waitFor();
      assert((await page.locator('section.bp', { hasText: 'tiktok-short' }).count()) === 0, 'còn preset dựng sẵn tiktok-short');
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('.flow.static .box .st')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
      );
      assert(!clipped.length, `nhãn bị cắt: ${clipped.join(', ')}`);
      const autoLab = await page.locator('section.bp', { hasText: 'e2e-manual' }).locator('.box .st', { hasText: 'Tự · 30 phút' }).first().innerText();
      await shot('presets');
      return `${await page.locator('section.bp').count()} quy trình · ${autoLab}`;
    });

    await check('Gợi ý: ngắn → dài → ngắn chỉ gọi API 2 lần (cache + tải sẵn), quay lại hiện ngay', async () => {
      const sg = page.locator('form.sg');
      const urls = [];
      const onReq = (r) => r.url().includes('/api/pipeline/suggest') && urls.push(r.url());
      page.on('request', onReq);
      try {
        await sg.getByRole('radio', { name: /Ngang/ }).click();
        await sg.locator('h2', { hasText: 'Video ngắn ngang 16:9' }).waitFor();
        await page.waitForResponse((r) => r.url().includes('length=long'), { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(100);
        const t0 = Date.now();
        await sg.getByRole('radio', { name: /Video dài/ }).click();
        await sg.locator('h2', { hasText: 'Video dài ngang 16:9' }).waitFor();
        const ms = Date.now() - t0;
        await sg.getByRole('radio', { name: /Video ngắn/ }).click();
        await sg.locator('h2', { hasText: 'Video ngắn ngang 16:9' }).waitFor();
        await page.waitForTimeout(400);
        assert(urls.length === 2, `${urls.length} request: ${urls.join(' , ')}`);
        assert(ms < 200, `chuyển sang dài mất ${ms} ms`);
        return `${urls.length} request · dài hiện sau ${ms} ms`;
      } finally {
        page.off('request', onReq);
      }
    });

    await check('Dropdown đồng nhất: cổng duyệt + thêm bước dùng Select chung, không còn <select> gốc', async () => {
      const sg = page.locator('form.sg');
      await sg.locator('summary', { hasText: 'Tùy chỉnh các bước' }).click();
      const row = sg.locator('.se-row').first();
      const gate = row.locator('.se-gate');
      await choose(gate, 'auto_if_checks');
      const gTxt = await gate.locator('.sel-btn').innerText();
      assert(/Tự duyệt khi kiểm đạt/.test(gTxt), `cổng = ${gTxt}`);
      const n0 = await sg.locator('.se-row').count();
      await choose(sg.locator('.se-add-sel'), '__custom');
      await sg.locator('.se-row input.se-name[value="Bước mới"]').waitFor();
      assert((await sg.locator('.se-row').count()) === n0 + 1, 'chưa thêm bước');
      const addTxt = await sg.locator('.se-add-sel .sel-btn').innerText();
      assert(addTxt.includes('Thêm bước'), `ô thêm bước không quay về chữ gợi ý: ${addTxt}`);
      await sg.locator('.se-add-sel .sel-btn').click();
      await page.waitForTimeout(250); // chờ menu hiện xong
      await shot('dropdown-add-step', page, false);
      await page.keyboard.press('Escape');
      const native = await page.locator('select').count();
      assert(native === 0, `còn ${native} <select> gốc`);
      await sg.locator('summary', { hasText: 'Tùy chỉnh các bước' }).click();
      return `cổng: ${gTxt.trim()} · ${n0} → ${n0 + 1} bước`;
    });

    await check('Gợi ý: đổi định dạng → lưu làm quy trình của tôi → xóa', async () => {
      const sg = page.locator('form.sg');
      await sg.getByRole('radio', { name: /Ngang/ }).click();
      await sg.getByRole('radio', { name: /Video dài/ }).click();
      await sg.locator('h2', { hasText: 'Video dài ngang 16:9' }).waitFor();
      const name = 'Kênh E2E dài';
      await sg.getByLabel('Tên quy trình').fill(name);
      await sg.getByRole('button', { name: /Lưu làm quy trình của tôi/ }).click();
      const card = page.locator('section.bp', { hasText: name });
      await card.waitFor();
      const id = await card.locator('.bp-h .mono').innerText();
      assert(id === 'kenh-e2e-dai', `id = ${id}`);
      assert(fs.existsSync(path.join(home, 'presets', 'kenh-e2e-dai.yaml')), 'không thấy file YAML');
      await shot('pipeline-saved');
      await card.getByRole('button', { name: 'Xóa' }).click();
      const dlg = page.locator('.modal', { hasText: 'Xóa quy trình?' });
      await dlg.getByRole('button', { name: 'Xóa' }).click();
      await card.waitFor({ state: 'detached' });
      assert(!fs.existsSync(path.join(home, 'presets', 'kenh-e2e-dai.yaml')), 'file YAML còn sau khi xóa');
      assert((await page.locator('section.bp', { hasText: 'e2e-short' }).locator('.bp-del').count()) === 1, 'thiếu nút Xóa cho quy trình của tôi');
      return id;
    });

    await check('Song ngữ: menu Tài khoản → English; các màn không còn chữ Việt; nhớ sau reload; trả lại Tiếng Việt', async () => {
      const VI = /[À-ÖØ-öø-ỹ]/;
      const pick = async (name) => {
        await page.locator('header.top .acc-btn').click();
        await page.getByRole('menuitemradio', { name }).click();
      };
      await page.goto(`${base}/#/`);
      const left = [];
      try {
        await pick('English');
        assert((await page.evaluate(() => document.documentElement.lang)) === 'en', 'lang chưa đổi');
        for (const [hash, h1] of [['#/', 'Projects'], ['#/presets', 'Workflows'], ['#/channels', 'YouTube channel']]) {
          await page.goto(`${base}/${hash}`);
          await page.locator('.page-h h1', { hasText: h1 }).waitFor();
          await page.waitForFunction(() => !document.querySelector('.sk-zone'), null, { timeout: WAIT });
          const txt = await page.locator('header.top, main').evaluateAll((els) => els.map((e) => e.innerText).join('\n'));
          for (const line of txt.split('\n')) if (VI.test(line)) left.push(`${hash}: ${line.trim()}`);
        }
        // Tên dự án/kênh và tên bước/quy trình do server trả (dịch ở Đợt 2) vẫn là tiếng Việt → bỏ qua; chỉ bắt chữ giao diện còn sót.
        const ui = left.filter((l) => !/e2e|Kênh giả|kenh-gia|Video (một|ba)|Đăng tay|Xem lại|Vàng nhẫn|Lời hứa|Lồng tiếng|Giao bản cuối/i.test(l));
        assert(ui.length === 0, `còn chữ Việt ở EN: ${ui.slice(0, 40).join(' | ')}`);
        await shot('lang-en');
        await page.goto(`${base}/#/`);
        await page.reload();
        await page.locator('.page-h h1', { hasText: 'Projects' }).waitFor();
        await pick('Tiếng Việt');
        await page.locator('.page-h h1', { hasText: 'Các dự án' }).waitFor();
        assert((await page.evaluate(() => document.documentElement.lang)) === 'vi', 'lang chưa trả về vi');
      } finally {
        await page.evaluate(() => localStorage.setItem('vs.lang', 'vi'));
        await page.goto(`${base}/#/presets`);
        await page.reload();
      }
      return `EN ok, ${left.length} dòng tên riêng có dấu`;
    });
    await check('Đổi theme sáng/tối (nhớ sau khi tải lại)', async () => {
      const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
      const t0 = await theme();
      await toggleTheme(page);
      const t1 = await theme();
      assert(t0 !== t1 && ['light', 'dark'].includes(t1), `${t0} → ${t1}`);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.waitForTimeout(300); // chờ transition màu xong rồi mới chụp
      await shot(`presets-${t1}`);
      await page.reload();
      await page.locator('.page-h h1', { hasText: 'Quy trình' }).waitFor();
      assert((await theme()) === t1, 'theme không được nhớ sau reload');
      await toggleTheme(page);
      assert((await theme()) === t0, 'không đổi lại được');
      const bg0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert(bg !== bg0, 'màu nền không đổi');
      return `${t0} → ${t1} → ${t0}`;
    });

    await check('Viewport 390 px: 3 màn không cuộn ngang', async () => {
      const m = await context.newPage();
      m.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') consoleIssues.push(`${msg.type()} (390): ${msg.text()}`);
      });
      m.on('pageerror', (e) => consoleIssues.push(`pageerror (390): ${e.message}`));
      m.setDefaultTimeout(WAIT);
      await m.setViewportSize({ width: 390, height: 844 });
      const bad = [];
      const screens = [
        ['overview', '#/', '.page-h h1'],
        ['step', `#/p/${SLUG}/deliver`, '.step-head h1'],
        ['presets', '#/quy-trinh', 'section.bp'],
      ];
      for (const [name, hash, sel] of screens) {
        await m.goto(`${base}/${hash}`);
        await m.locator(sel).first().waitFor();
        await m.waitForTimeout(250);
        const w = await m.evaluate(() => ({
          sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          cw: document.documentElement.clientWidth,
        }));
        if (w.sw > w.cw) bad.push(`${name}: ${w.sw} > ${w.cw}`);
        await shot(`m390-${name}`, m);
      }
      await m.close();
      assert(!bad.length, bad.join('; '));
      return 'overview, step, presets';
    });

    await check('Skeleton: API chậm → khung chờ (không chữ "Đang tải…"), tải xong hiện nội dung; 390 px sáng/tối', async () => {
      const m = await context.newPage();
      m.setDefaultTimeout(WAIT);
      await m.setViewportSize({ width: 390, height: 844 });
      // làm chậm mọi API dữ liệu 1,2 s để kịp thấy skeleton
      await m.route('**/api/**', async (r) => {
        await new Promise((ok) => setTimeout(ok, 1200));
        await r.continue().catch(() => {});
      });
      const theme = () => m.evaluate(() => document.documentElement.dataset.theme);
      const screens = [
        ['overview', '#/', '.proj'],
        ['step', `#/p/${SLUG}/deliver`, '.step-head h1 .state-tag'],
        ['presets', '#/quy-trinh', 'section.bp'],
      ];
      const seen = [];
      for (const pass of [0, 1]) {
        for (const [name, hash, real] of screens) {
          await m.goto(`${base}/${hash}`);
          await m.reload(); // đổi hash không tải lại trang → ép tải lần đầu
          if (pass === 1 && !seen.includes('toggled')) {
            await toggleTheme(m);
            seen.push('toggled');
          }
          const zone = m.locator('.sk-zone[aria-busy="true"]').first();
          await zone.waitFor();
          await m.waitForTimeout(400); // qua 150 ms trễ + mờ dần
          const txt = await m.locator('main, #root').first().innerText();
          assert(!/Đang tải…|Đang kiểm tra…/.test(txt), `${name}: còn chữ loading`);
          const w = await m.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
          assert(w <= 0, `${name}: cuộn ngang ${w}px khi đang skeleton`);
          await shot(`sk-${name}-${await theme()}`, m);
          await m.waitForFunction(() => !document.querySelector('.sk-zone'), null, { timeout: WAIT });
          assert(await m.locator(real).first().isVisible(), `${name}: không thấy nội dung thật sau khi tải xong`);
        }
      }
      await toggleTheme(m); // trả theme cũ
      await m.close();
      return 'overview, step, presets × sáng/tối';
    });

    // ---- tài khoản Claude (fake-claude: auth login/logout chỉ ghi file giả, không mở trình duyệt)
    const accModal = () => page.locator('.modal', { hasText: 'Tài khoản Claude' });
    await check('Tài khoản: bấm ô CLAUDE CODE → bảng tài khoản; Đăng xuất cần xác nhận', async () => {
      await page.goto(`${base}/#/`);
      await openAccount(page);
      await accModal().locator('.acc-box', { hasText: 'Đã đăng nhập' }).waitFor();
      await accModal().locator('.sel-btn').waitFor();
      // Ô chọn tự vẽ: bàn phím mở/đóng; Esc chỉ đóng danh sách, không đóng hộp thoại.
      await accModal().locator('.sel-btn').focus();
      await page.keyboard.press('ArrowDown');
      await accModal().locator('.sel-list[role="listbox"]').waitFor();
      await page.waitForTimeout(250); // hết hiệu ứng hiện
      await shot('select-open');
      await page.keyboard.press('Escape');
      await accModal().locator('.sel-list').waitFor({ state: 'detached' });
      assert((await accModal().count()) === 1, 'Esc trong ô chọn đóng luôn hộp thoại');
      await accModal().getByRole('button', { name: 'Đăng xuất' }).click();
      await accModal().locator('.acc-confirm').waitFor();
      await shot('account-logout-confirm');
      await accModal().getByRole('button', { name: 'Không' }).click();
      assert((await accModal().locator('.acc-confirm').count()) === 0, 'Không vẫn còn hộp xác nhận');
      await accModal().getByRole('button', { name: 'Đăng xuất' }).click();
      await accModal().locator('.acc-confirm .note', { hasText: 'terminal' }).waitFor();
      await accModal().locator('.modal-acts').getByRole('button', { name: 'Đăng xuất' }).click();
      await page.locator('.toast', { hasText: 'Đã đăng xuất' }).waitFor();
      await page.locator('.doctor').getByRole('button', { name: 'Đăng nhập Claude' }).waitFor();
      await page.locator('header.top .acc-btn', { hasText: 'CHƯA ĐĂNG NHẬP' }).waitFor();
      assert((await accModal().count()) === 0, 'bảng chưa tự đóng sau khi đăng xuất');
      const auth = JSON.parse(fs.readFileSync(path.join(home, 'fake-auth.json'), 'utf8'));
      assert(auth.loggedIn === false, 'fake auth chưa ghi đăng xuất');
    });
    await check('Tài khoản: Đăng nhập → đang chờ trình duyệt → Hủy', async () => {
      await page.locator('.doctor').getByRole('button', { name: 'Đăng nhập Claude' }).click();
      await choose(accModal(), '__default__');
      await accModal().locator('.modal-acts').getByRole('button', { name: 'Đăng nhập' }).click();
      await accModal().locator('.acc-wait', { hasText: 'trình duyệt mặc định' }).waitFor();
      await shot('account-waiting');
      await accModal().getByRole('button', { name: 'Hủy' }).click();
      await page.locator('.toast', { hasText: 'Đã hủy đăng nhập' }).waitFor();
      await accModal().locator('.acc-wait').waitFor({ state: 'detached' });
    });
    await check('Tài khoản: Đăng nhập (hồ sơ Chrome nếu có) → xong tự đóng, băng đỏ biến mất', async () => {
      await accModal().locator('.sel-btn').click();
      const opts = await accModal().locator('.sel-list [role="option"]').evaluateAll((os) => os.map((o) => o.dataset.value));
      await accModal().locator('.sel-btn').click();
      const prof = opts.find((v) => v !== '__default__') || '__default__';
      await choose(accModal(), prof);
      await accModal().getByRole('radio', { name: /Console/ }).click();
      await accModal().locator('.modal-acts').getByRole('button', { name: 'Đăng nhập' }).click();
      await accModal().locator('.acc-wait').waitFor();
      await page.locator('.toast', { hasText: 'Đã đăng nhập Claude Code' }).waitFor();
      await accModal().waitFor({ state: 'detached' });
      await page.locator('header.top .acc-btn', { hasText: 'ĐÃ ĐĂNG NHẬP' }).waitFor();
      await page.locator('.doctor').waitFor({ state: 'detached' });
      const auth = JSON.parse(fs.readFileSync(path.join(home, 'fake-auth.json'), 'utf8'));
      assert(auth.loggedIn === true && auth.authMethod === 'console', `fake auth: ${JSON.stringify(auth)}`);
      const saved = await page.evaluate(() => localStorage.getItem('vs.chromeProfile'));
      assert(saved === prof, `không nhớ hồ sơ: ${saved}`);
      const blog = path.join(home, 'fake-browser.jsonl');
      if (prof !== '__default__') {
        const last = JSON.parse(fs.readFileSync(blog, 'utf8').trim().split('\n').pop());
        assert(last.profile === prof && last.browser.endsWith('open-chrome-profile.sh'), `BROWSER sai: ${JSON.stringify(last)}`);
      }
      return prof === '__default__' ? 'không có hồ sơ Chrome — trình duyệt mặc định' : `hồ sơ ${prof}`;
    });

    // ---- mức dùng gói Claude (fake-claude gửi rate_limit_event 5h 42% / tuần 17%)
    const meter = () => page.locator('header.top .use-btn');
    await check('Mức dùng: ô đầu trang hiện % 5h (42% từ lượt chạy / 47% từ API khi mở bảng Tài khoản)', async () => {
      await page.goto(`${base}/#/`);
      await meter().locator('.use-v', { hasText: /^(42|47)%$/ }).waitFor();
      const cls = await meter().getAttribute('class');
      assert(!/warn|bad/.test(cls), `màu sai: ${cls}`);
      return await meter().innerText();
    });
    await check('Mức dùng: mở bảng → tự lấy % qua API (47/18, không tốn token); Kiểm tra ngay → số mới, khóa nút', async () => {
      await meter().click();
      const box = accModal().locator('.use-box');
      const bar = (name) => box.getByRole('progressbar', { name });
      await box.waitFor();
      await box.locator('[role=progressbar][aria-label="Phiên 5 giờ"][aria-valuenow="47"]').waitFor();
      assert((await bar('Tuần').getAttribute('aria-valuenow')) === '18', 'tuần ≠ 18');
      assert( claudeApi.calls.every((c) => c.auth === 'Bearer fake-oauth-token' && c.beta === 'oauth-2025-04-20'), `API giả: ${JSON.stringify(claudeApi.calls)}`);
      const btn = box.getByRole('button', { name: /Kiểm tra ngay/ });
      // Mở bảng vừa hỏi → nút khóa ~10 s; chờ mở lại rồi bấm.
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll('.use-box button')].find((x) => /Kiểm tra ngay/.test(x.textContent));
        return b && !b.disabled;
      }, null, { timeout: 15_000 });
      claudeApi.set({ five_hour: 55 });
      const n0 = claudeApi.calls.length;
      await btn.click();
      await box.locator('[role=progressbar][aria-label="Phiên 5 giờ"][aria-valuenow="55"]').waitFor();
      assert(claudeApi.calls.length === n0 + 1, `số lần gọi API: ${claudeApi.calls.length - n0}`);
      assert((await box.locator('.use-tbl tr', { hasText: 'Kiểm tra' }).count()) === 0, 'Kiểm tra qua API mà vẫn có dòng token');
      assert(await btn.isDisabled(), 'nút không khóa sau khi kiểm tra');
      await box.locator('.use-at', { hasText: 'Cập nhật' }).waitFor();
      await shot('usage-panel');
      return `API ${claudeApi.calls.length} lần, 5h 47% → 55%, không có dòng token Kiểm tra`;
    });
    await check('Mức dùng: API lỗi → Kiểm tra ngay quay về claude -p, toast báo, dòng Kiểm tra = 33 token', async () => {
      const box = accModal().locator('.use-box');
      claudeApi.set({ status: 500 });
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll('.use-box button')].find((x) => /Kiểm tra ngay/.test(x.textContent));
        return b && !b.disabled;
      }, null, { timeout: 15_000 });
      await box.getByRole('button', { name: /Kiểm tra ngay/ }).click();
      await page.locator('.toast', { hasText: 'đã hỏi Claude thay' }).waitFor();
      await box.locator('.use-tbl tr', { hasText: 'Kiểm tra' }).locator('td', { hasText: '33' }).first().waitFor();
      await box.locator('[role=progressbar][aria-label="Phiên 5 giờ"][aria-valuenow="42"]').waitFor();
      claudeApi.set({ status: 200 });
      await page.keyboard.press('Escape');
      await accModal().waitFor({ state: 'detached' });
      return 'fallback 42% từ fake-claude';
    });
    await check('Mức dùng: ≥80% → ô vàng; chạm 100% → ô đỏ + toast một lần; 390 px ẩn ô, sáng/tối', async () => {
      const fake = (u5, status) => ({
        limits: { status, type: 'five_hour', resetsAt: 1893456000, at: new Date().toISOString(), windows: { five_hour: { utilization: u5, resetsAt: 1893456000 }, seven_day: { utilization: 0.3, resetsAt: 1894060800 } } },
        checking: false,
        tokens: null,
      });
      let body = fake(0.85, 'allowed_warning');
      await page.route('**/api/claude/usage', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
      try {
        await page.reload();
        await page.locator('header.top .use-btn.warn', { hasText: '85%' }).waitFor();
        await shot('usage-warn');
        body = fake(1, 'rejected');
        await page.reload();
        await page.locator('header.top .use-btn.bad', { hasText: '100%' }).waitFor();
        await page.locator('.toast', { hasText: 'Đã chạm giới hạn gói Claude' }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
        const seen = [];
        for (let i = 0; i < 2; i++) {
          await page.waitForTimeout(300);
          const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
          assert(w <= 0, `cuộn ngang ${w}px (${await theme()})`);
          assert(!(await meter().isVisible()), 'màn 390 px vẫn hiện ô mức dùng');
          seen.push(await theme());
          await shot(`usage-390-${await theme()}`, page, false);
          await toggleTheme(page);
        }
        assert((await page.locator('.toast', { hasText: 'Đã chạm giới hạn' }).count()) <= 1, 'toast lặp');
        return seen.join(' + ');
      } finally {
        await page.unroute('**/api/claude/usage');
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.reload();
      }
    });

    // ---- Kênh YouTube (Google giả, bí mật lưu file trong VS_HOME)
    const ytCard = (name) => page.locator('section.yt-card', { hasText: name });
    const ytRow = (name) => page.locator('.yt-chlist tbody tr', { hasText: name });
    let ytHash = null; // #/channels/<id> của kênh giả
    await check('Kênh: chưa thiết lập → trang hướng dẫn, dán client_secret → đã thiết lập', async () => {
      await page.goto(`${base}/#/`);
      await page.locator('header.top a', { hasText: 'Kênh' }).click();
      await page.locator('.page-h h1', { hasText: 'Kênh YouTube' }).waitFor();
      await page.locator('.card.empty', { hasText: 'Chưa kết nối Google Cloud' }).waitFor();
      assert((await page.getByRole('button', { name: '+ Thêm kênh' }).count()) === 0, 'Thêm kênh hiện khi chưa thiết lập');
      assert((await page.locator('section.yt-card').count()) === 0, 'có sẵn kênh dù chưa thêm');
      await page.locator('.card.empty a', { hasText: 'Bắt đầu' }).click();
      await page.locator('.page-h h1', { hasText: 'Thiết lập Google' }).waitFor();
      await page.getByRole('button', { name: 'Bắt đầu' }).waitFor();
      assert((await page.locator('.gw-stages > li').count()) === 4, 'không đủ 4 bước');
      await page.locator('details.gw-manual > summary').click();
      const nIssues = consoleIssues.length;
      await page.locator('.gw-manual textarea').fill('{"web":{}}');
      await page.getByRole('button', { name: 'Lưu' }).click();
      const bad = await page.locator('.gw-manual .err-note').innerText();
      consoleIssues.splice(nIssues); // 400 có chủ đích (client loại web): trình duyệt ghi "Failed to load resource"
      await page.locator('.gw-manual textarea').fill(FAKE_CLIENT_SECRET);
      await page.getByRole('button', { name: 'Lưu' }).click();
      await page.locator('.toast', { hasText: 'Đã lưu thiết lập Google' }).waitFor();
      await page.locator('.yt-setup-ok', { hasText: 'Đã thiết lập' }).waitFor();
      const txt = await page.locator('main').innerText();
      assert(!txt.includes('GOCSPX'), 'client secret hiện trên trang');
      const sec = fs.readFileSync(path.join(home, 'secrets.json'), 'utf8');
      assert(sec.includes('GOCSPX-fake-secret'), 'secrets.json không có client');
      await shot('yt-setup');
      return `dán sai: "${bad}"`;
    });
    // Thêm kênh qua modal (trình duyệt mặc định); Google giả tự cho phép và quay về callback trong tab mới.
    const addChannel = async () => {
      await page.locator('.page-h').getByRole('button', { name: '+ Thêm kênh' }).click();
      const modal = page.locator('.modal', { hasText: 'Thêm kênh YouTube' });
      await choose(modal, '__default__');
      const popupP = context.waitForEvent('page');
      await modal.getByRole('button', { name: /Mở trang Google/ }).click();
      const popup = await popupP;
      await popup.waitForLoadState().catch(() => {});
      return popup;
    };
    await check('Kênh: trống → + Thêm kênh → Google giả cho phép → thẻ kênh mới; thêm trùng → báo lỗi', async () => {
      await page.locator('.page-h a', { hasText: 'Kênh' }).click();
      await page.locator('.card.empty', { hasText: 'Chưa có kênh nào' }).waitFor();
      await shot('yt-empty');
      let popup = await addChannel();
      await page.locator('.toast', { hasText: 'Đã thêm kênh Kênh Giả' }).waitFor();
      await ytRow('Kênh Giả').locator('.lamp.ok').waitFor();
      await popup.close().catch(() => {});
      await page.locator('.card.empty').waitFor({ state: 'detached' });
      popup = await addChannel();
      await page.locator('.toast', { hasText: 'đã được thêm rồi' }).waitFor();
      await popup.close().catch(() => {});
      assert((await page.locator('.yt-chlist tbody tr').count()) === 1, 'thêm trùng tạo hàng thứ hai');
      assert(google.calls.some((c) => c.path === '/token'), 'không đổi code lấy token');
      const auth = google.calls.find((c) => c.path === '/o/oauth2/v2/auth');
      assert(!/email|profile/.test(auth.query.scope), `scope thừa: ${auth.query.scope}`);
      assert(auth.query.code_challenge_method === 'S256', 'thiếu PKCE');
      return auth.query.scope.split(' ').map((s) => s.split('/').pop()).join(', ');
    });
    await check('Kênh: danh sách hiện thông tin chung → Chi tiết › mở trang kênh', async () => {
      const row = ytRow('Kênh Giả');
      await row.locator('td.num', { hasText: /1[.,]?234/ }).waitFor();
      assert((await page.locator('section.yt-card, .yt-tiles').count()) === 0, 'danh sách hiện số liệu chi tiết');
      await shot('yt-list');
      await row.getByRole('link', { name: /Xem chi tiết/ }).click();
      await page.locator('section.yt-card h1', { hasText: 'Kênh Giả' }).waitFor();
      ytHash = new URL(page.url()).hash;
      assert(/^#\/channels\/[^/]+$/.test(ytHash), `hash sai: ${ytHash}`);
      await page.locator('.crumb a', { hasText: 'Kênh' }).waitFor();
      return (await row.innerText().catch(() => '')).replace(/\s+/g, ' ') || ytHash;
    });
    await check('Kênh: số liệu 28 ngày, biểu đồ có tooltip, bảng video sắp xếp được', async () => {
      const card = ytCard('Kênh Giả');
      await card.locator('.yt-tiles .yt-tile').first().waitFor();
      const subs = await card.locator('.yt-tile', { hasText: 'Người đăng ký' }).locator('.yt-tile-v').innerText();
      assert(/1[.,]?234/.test(subs), `số người đăng ký: ${subs}`);
      const bars = await card.locator('.ytc-hit').count();
      assert(bars >= 27, `chỉ có ${bars} ngày`);
      await card.locator('.ytc-hit').nth(5).hover();
      await card.locator('.ytc-tip').waitFor({ timeout: 3000 }).catch(() => {
        throw new Error('hover cột không hiện tooltip');
      });
      await card.locator('.chips button', { hasText: 'Phút xem' }).click();
      await card.locator('.yt-chart-h', { hasText: 'Phút xem theo ngày' }).waitFor();
      const rows = card.locator('.yt-videos table.yt-tbl tbody tr');
      await rows.first().waitFor();
      const titles = () => card.locator('.yt-videos table.yt-tbl tbody .yt-vtext > a').allInnerTexts();
      const t0 = await titles();
      await card.locator('.yt-videos th button', { hasText: 'Lượt xem' }).click();
      const sortAttr = await card.locator('.yt-videos th', { hasText: 'Lượt xem' }).getAttribute('aria-sort');
      assert(sortAttr !== 'none', 'aria-sort không đổi');
      const t1 = await titles();
      assert(t0.length === 2, `tab Video có ${t0.length} video`);
      assert(await rows.locator('.yt-priv', { hasText: 'Riêng tư' }).count() === 1, 'video private thiếu nhãn');
      assert(await rows.locator('.yt-thumb img').count() === 2, 'thiếu ảnh thu nhỏ');
      assert(!(await card.getByText('Xem dạng bảng').count()), 'còn "Xem dạng bảng"');
      await card.getByRole('tab', { name: /Shorts/ }).click();
      const ts = await titles();
      assert(ts.length === 1 && ts[0] === 'Video hai', `tab Shorts: ${ts}`);
      await card.getByRole('tab', { name: /Video/ }).click();
      await page.waitForTimeout(300);
      await shot('yt-stats');
      return `${bars} ngày · ${t0.length} video + ${ts.length} short · sắp xếp ${sortAttr} (${t0[0]} → ${t1[0]})`;
    });
    await check('Kênh: Làm mới gọi lại Google; vào lại trang dùng cache', async () => {
      const card = ytCard('Kênh Giả');
      const n0 = google.calls.filter((c) => c.path.includes('/reports')).length;
      await card.getByRole('button', { name: /Làm mới/ }).click();
      await card.getByRole('button', { name: /Làm mới/ }).and(page.locator(':enabled')).waitFor();
      const n1 = google.calls.filter((c) => c.path.includes('/reports')).length;
      assert(n1 > n0, 'Làm mới không gọi Analytics');
      await page.goto(`${base}/#/`);
      await page.goto(`${base}/#/channels`);
      await ytRow('Kênh Giả').locator('td.num', { hasText: /1[.,]?234/ }).waitFor();
      await page.goto(`${base}/${ytHash}`);
      await card.locator('.yt-tiles .yt-tile').first().waitFor();
      await page.waitForTimeout(500);
      const n2 = google.calls.filter((c) => c.path.includes('/reports')).length;
      assert(n2 === n1, `vào lại vẫn gọi Google (${n1} → ${n2})`);
      return `reports: ${n0} → ${n1} → ${n2}`;
    });
    await check('Kênh: Làm mới tất cả ở danh sách gọi lại Google cho mọi kênh', async () => {
      await page.goto(`${base}/#/channels`);
      await ytRow('Kênh Giả').locator('td.num', { hasText: /1[.,]?234/ }).waitFor();
      const count = (p) => google.calls.filter((c) => c.path.includes(p)).length;
      const r0 = count('/reports'), v0 = count('/videos');
      const btn = page.getByRole('button', { name: /Làm mới tất cả/ });
      await btn.click();
      await page.getByText('Đã tải lại tất cả kênh.').waitFor();
      await btn.and(page.locator(':enabled')).waitFor();
      const r1 = count('/reports'), v1 = count('/videos');
      assert(r1 > r0 && v1 > v0, `không gọi lại Google (reports ${r0}→${r1}, videos ${v0}→${v1})`);
      await ytRow('Kênh Giả').locator('td.num', { hasText: /1[.,]?234/ }).waitFor();
      await page.locator('.page-h .acts', { hasText: 'Cập nhật vừa xong' }).waitFor();
      await shot('yt-reload-all');
      return `reports ${r0}→${r1} · videos ${v0}→${v1}`;
    });
    await check('Kênh: Tự làm mới 5 phút → tới hạn tự gọi lại Google, nhớ lựa chọn; tắt thì không gọi', async () => {
      await page.clock.install();
      await page.goto(`${base}/#/channels`);
      await ytRow('Kênh Giả').locator('td.num', { hasText: /1[.,]?234/ }).waitFor();
      const count = (p) => google.calls.filter((c) => c.path.includes(p)).length;
      const sel = page.locator('.page-h .acts .yt-range-sel', { has: page.getByLabel('Tự làm mới') });
      await choose(sel, '5');
      assert((await page.evaluate(() => localStorage.getItem('vs.yt.auto'))) === '5', 'không nhớ lựa chọn');
      const r0 = count('/reports');
      await page.clock.fastForward(4 * 60_000);
      await page.waitForTimeout(400);
      assert(count('/reports') === r0, 'gọi Google trước 5 phút');
      await page.clock.fastForward(61_000);
      for (let i = 0; i < 40 && count('/reports') === r0; i++) await page.waitForTimeout(100);
      const r1 = count('/reports');
      assert(r1 > r0, 'đủ 5 phút mà không tự làm mới');
      await choose(sel, 'off');
      await page.clock.fastForward(6 * 60_000);
      await page.waitForTimeout(500);
      assert(count('/reports') === r1, 'tắt rồi mà vẫn tự làm mới');
      return `reports ${r0} → ${r1}, tắt → giữ nguyên`;
    });
    await check('Kênh: chọn khoảng ngày 7 / 365 / tùy chọn → ô số, biểu đồ, bảng đổi theo; nhớ sau khi tải lại', async () => {
      await page.goto(`${base}/${ytHash}`);
      const card = ytCard('Kênh Giả');
      const bar = card.locator('.yt-bar');
      await card.locator('.yt-tiles .yt-tile').first().waitFor();
      const lastReport = (dims) => google.calls.filter((c) => c.path.includes('/reports') && c.query.dimensions === dims).at(-1)?.query;
      await choose(bar, '7');
      await card.locator('.yt-tile', { hasText: 'Lượt xem · 7 ngày' }).waitFor();
      const bars7 = await card.locator('.ytc-hit').count();
      assert(bars7 === 7, `7 ngày nhưng có ${bars7} cột`);
      const d = lastReport('day');
      assert(Math.round((Date.parse(d.endDate) - Date.parse(d.startDate)) / 864e5) === 6, `kỳ gửi Google sai: ${d.startDate}–${d.endDate}`);
      assert(lastReport('video').startDate === d.startDate, 'bảng video không theo khoảng');
      await choose(bar, '365');
      await card.locator('.yt-chart-h', { hasText: 'theo tuần' }).waitFor();
      const weeks = await card.locator('.ytc-hit').count();
      assert(weeks === 53, `365 ngày gộp tuần ra ${weeks} cột`);
      await shot('yt-range-365');
      const ymd = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
      await choose(bar, 'custom');
      await bar.getByLabel('Từ ngày').fill(ymd(40));
      await bar.getByLabel('Đến ngày').fill(ymd(11));
      await bar.getByRole('button', { name: 'Áp dụng' }).click();
      const lbl = `${ymd(40).slice(8, 10)}/${ymd(40).slice(5, 7)}/${ymd(40).slice(2, 4)}`;
      await card.locator('.yt-tile', { hasText: lbl }).first().waitFor();
      const bars = await card.locator('.ytc-hit').count();
      assert(bars === 30, `tùy chọn 30 ngày nhưng có ${bars} cột`);
      await page.reload();
      await card.locator('.yt-tile', { hasText: lbl }).first().waitFor();
      await page.goto(`${base}/#/channels`);
      await page.locator('.yt-chlist th', { hasText: `Lượt xem · ${lbl}` }).waitFor();
      await ytRow('Kênh Giả').locator('td.num', { hasText: /1[.,]?234/ }).waitFor();
      await shot('yt-range-list');
      await choose(page.locator('.page-h .yt-range'), '28');
      await page.locator('.yt-chlist th', { hasText: 'Lượt xem · 28 ngày' }).waitFor();
      return `7 ngày: ${bars7} cột · 365: ${weeks} tuần · tùy chọn: ${bars} cột · ${lbl}`;
    });
    await check('Kênh: 390 px sáng + tối không cuộn ngang', async () => {
      const bad = [];
      for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, locale: 'vi-VN' });
        await ctx.addCookies([{ name: 'vs_token', value: TOKEN, url: base }]);
        await fakeThumbs(ctx);
        const m = await ctx.newPage();
        m.on('pageerror', (e) => consoleIssues.push(`pageerror (390 ${scheme}): ${e.message}`));
        for (const [name, hash, sel] of [
          ['channels', '#/channels', '.yt-chlist tbody tr'],
          ['channel', ytHash, '.yt-tiles .yt-tile'],
          ['setup', '#/channels/setup', '.yt-limits'],
        ]) {
          await m.goto(`${base}/${hash}`);
          await m.locator(sel).first().waitFor();
          await m.waitForTimeout(300);
          const w = await m.evaluate(() => ({ sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), cw: document.documentElement.clientWidth }));
          if (w.sw > w.cw) bad.push(`${name} ${scheme}: ${w.sw} > ${w.cw}`);
          const tabOut = await m.evaluate(() => {
            const nav = document.querySelector('nav.tabs');
            const r = nav.getBoundingClientRect().right;
            return [...nav.querySelectorAll('a')].filter((x) => x.getBoundingClientRect().right > r + 1).map((x) => x.textContent);
          });
          if (tabOut.length) bad.push(`${name} ${scheme}: tab bị khuất ${tabOut.join(', ')}`);
          await shot(`m390-yt-${name}-${scheme}`, m);
        }
        await ctx.close();
      }
      assert(!bad.length, bad.join('; '));
      return 'channels, channel, setup × sáng/tối';
    });
    await check('Kênh: Xóa kênh cần xác nhận → thu hồi token, về trang trống; xóa thiết lập được', async () => {
      await page.goto(`${base}/${ytHash}`);
      const card = ytCard('Kênh Giả');
      await card.getByRole('button', { name: 'Xóa kênh' }).click();
      const modal = page.locator('.modal', { hasText: 'Xóa kênh' });
      await modal.getByRole('button', { name: 'Không' }).click();
      await card.locator('.lamp.ok').waitFor();
      await card.getByRole('button', { name: 'Xóa kênh' }).click();
      const del = modal.locator('.modal-acts').getByRole('button', { name: 'Xóa kênh' });
      const input = modal.getByLabel(/để xác nhận/);
      for (const wrong of ['', 'kênh giả', 'Kenh Gia', 'Kênh Giả ']) {
        await input.fill(wrong);
        assert(await del.isDisabled(), `gõ "${wrong}" vẫn cho xóa`);
      }
      await input.fill('Kênh Giả');
      await del.click();
      await page.locator('.toast', { hasText: 'Đã xóa kênh' }).waitFor();
      await page.locator('.card.empty', { hasText: 'Chưa có kênh nào' }).waitFor();
      assert(google.state.revoked.size >= 1, 'Google giả không nhận revoke');
      const sec = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'));
      assert(!JSON.stringify(sec).includes('refresh'), 'token còn trong secrets.json');
      await page.goto(`${base}/#/channels/setup`);
      await page.getByRole('button', { name: 'Xóa thiết lập' }).click();
      await page.locator('.toast', { hasText: 'Đã xóa thiết lập Google' }).waitFor();
      await page.locator('.yt-setup-ok').waitFor({ state: 'detached' });
    });
    await check('Thiết lập tự động (gcloud + Google giả): Bắt đầu → dự án + API → xin quyền → tự nhận file → xong', async () => {
      await page.goto(`${base}/#/channels/setup`);
      const gw = page.locator('section.gw');
      await choose(gw, '__default__');
      await gw.getByRole('button', { name: 'Bắt đầu' }).click();
      await gw.getByRole('button', { name: /Xong, tiếp tục/ }).waitFor({ timeout: WAIT });
      const pid = (await gw.locator('.gw-body .mono').first().innerText()).trim();
      assert(google.state.cloud.projects.has(pid), `Google giả không có dự án ${pid}`);
      assert((google.state.cloud.enabled.get(pid) || new Set()).size >= 2, 'chưa bật đủ 2 API');
      assert((await gw.locator('.gw-stages li.done').count()) === 2, 'thanh tiến độ sai ở bước xin quyền');
      await shot('gw-consent');
      const popupP = context.waitForEvent('page');
      await gw.getByRole('button', { name: /Xong, tiếp tục/ }).click();
      const popup = await popupP; // trình duyệt mặc định → trang tạo client mở tab mới
      assert(popup.url().includes('/console/'), `tab mới sai: ${popup.url()}`);
      await popup.close();
      await gw.locator('.yt-wait', { hasText: 'client_secret' }).waitFor();
      fs.writeFileSync(path.join(home, 'Downloads', `client_secret_e2e.apps.googleusercontent.com.json`), fakeClientSecretFor(pid));
      await page.locator('.gw-found').waitFor({ timeout: WAIT });
      await page.locator('.yt-setup-ok', { hasText: 'Đã thiết lập' }).waitFor();
      await gw.locator('.gw-done a', { hasText: 'Thêm kênh' }).waitFor();
      await shot('gw-done');
      await page.locator('.gw-found').getByRole('button', { name: 'Giữ lại' }).click(); // không đụng Thùng rác thật
      await page.locator('.toast', { hasText: 'Đã giữ file' }).waitFor();
      await page.locator('.gw-found').waitFor({ state: 'detached' });
      assert(fs.readdirSync(path.join(home, 'Downloads')).length === 1, 'file trong Tải về bị xóa dù chọn Giữ lại');
      const glog = fs.readFileSync(path.join(home, 'fake-gcloud.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.join(' '));
      assert(glog.includes('auth login --brief') && glog.includes('auth revoke --all --quiet'), `gcloud: ${glog.join(' | ')}`);
      const txt = await page.locator('main').innerText();
      assert(!txt.includes('GOCSPX') && !txt.includes('fake-cloud-token'), 'lộ bí mật trên trang');
      return `dự án ${pid}`;
    });

    // ---- Trợ lý AI (fake-claude chế độ --mcp-config: gọi MCP thật → app → tab này thao tác DOM)
    const ai = () => page.locator('aside.ai-panel');
    const aiSay = async (text) => {
      await ai().getByLabel('Tin nhắn cho trợ lý').fill(text);
      await ai().getByLabel('Tin nhắn cho trợ lý').press('Enter');
    };
    const aiIdle = () => ai().locator('.ai-form button[type=submit]').waitFor();
    await check('Trợ lý AI: mở sidebar → "60" → trợ lý mở Dự án mới và nhập Thời lượng = 60', async () => {
      await page.goto(`${base}/#/`);
      await page.locator('.page-h h1').waitFor();
      await page.locator('header.top .ai-btn').click();
      await ai().waitFor();
      assert((await page.locator('header.top .ai-btn').getAttribute('aria-pressed')) === 'true', 'nút không bật');
      await ai().locator('.ai-ex .chip').first().waitFor();
      await aiSay('Tạo dự án mới, video dài 60 giây');
      await ai().locator('.ai-bot', { hasText: 'Đã đặt thời lượng 60 giây.' }).waitFor();
      const modal = page.locator('.modal', { hasText: 'Dự án mới' });
      await modal.waitFor();
      const v = await modal.locator('.fmt-dur input').first().inputValue();
      assert(v === '60', `Thời lượng = ${v}`);
      const acts = await ai().locator('.ai-act').allInnerTexts();
      assert(acts.some((t) => t.includes('Dự án mới')) && acts.some((t) => t.includes('"60"')), acts.join(' | '));
      // gõ trong panel khi modal mở: Tab không bị modal giữ, panel không inert
      assert(!(await ai().evaluate((el) => !!el.closest('[inert]'))), 'panel bị inert khi có modal');
      await shot('ai-60');
      await modal.getByRole('button', { name: 'Hủy', exact: true }).click();
      await modal.waitFor({ state: 'detached' });
      await aiIdle();
      return acts.join(' · ');
    });

    await check('Trợ lý AI: nút nhạy cảm (Xóa) → thẻ xin phép; Không → không xóa', async () => {
      await page.goto(`${base}/#/quy-trinh`);
      await page.locator('section.bp').first().waitFor();
      const before = await page.locator('section.bp').count();
      await aiSay('xóa quy trình đầu tiên');
      const card = ai().locator('.ai-ask');
      await card.waitFor();
      assert((await card.innerText()).includes('Bấm "Xóa"'), await card.innerText());
      await shot('ai-ask');
      await card.getByRole('button', { name: 'Không' }).click();
      await ai().locator('.ai-bot', { hasText: 'Không xóa' }).waitFor();
      await ai().locator('.ai-act.bad', { hasText: 'Không cho phép' }).waitFor();
      assert(!(await page.locator('.modal', { hasText: 'Xóa quy trình?' }).count()), 'đã mở hộp xóa');
      assert((await page.locator('section.bp').count()) === before, 'số quy trình đổi');
      await aiIdle();
      return `còn ${before} quy trình`;
    });

    await check('Trợ lý AI: đang chạy → Dừng; Cuộc mới xóa lịch sử; nhớ trạng thái mở sau tải lại', async () => {
      await aiSay('làm chậm thôi');
      await ai().locator('.ai-wait').waitFor();
      await ai().getByRole('button', { name: 'Dừng' }).click();
      await ai().locator('.ai-note', { hasText: 'Đã dừng.' }).waitFor();
      await aiIdle();
      await page.reload();
      await ai().waitFor();
      await ai().locator('.ai-user', { hasText: 'làm chậm thôi' }).waitFor();
      await ai().getByRole('button', { name: 'Cuộc mới' }).click();
      await ai().locator('.ai-ex .chip').first().waitFor();
      assert(!(await ai().locator('.ai-msg').count()), 'còn tin cũ');
      return 'Dừng → Đã dừng; Cuộc mới → trống';
    });

    await check('Trợ lý AI: lịch sử giữ cuộc cũ + mở lại; đổi model/effort; Compact tắt khi chưa có phiên', async () => {
      await ai().getByRole('button', { name: 'Lịch sử trò chuyện' }).click();
      const row = ai().locator('.ai-hist-row', { hasText: 'Tạo dự án mới' });
      await row.waitFor();
      await row.locator('.ai-hist-open').click();
      await ai().locator('.ai-user', { hasText: 'làm chậm thôi' }).waitFor();
      await ai().getByRole('button', { name: 'Cuộc mới' }).click();
      await ai().locator('.ai-ex .chip').first().waitFor();
      const opts = ai().locator('.ai-opts button');
      await opts.nth(0).click();
      await page.getByRole('option', { name: 'Haiku' }).click();
      await opts.nth(1).click();
      await page.getByRole('option', { name: 'low' }).click();
      await page.waitForTimeout(300);
      assert((await opts.nth(0).innerText()).includes('Haiku'), await opts.nth(0).innerText());
      assert((await opts.nth(1).innerText()).includes('low'), await opts.nth(1).innerText());
      await ai().getByRole('button', { name: 'Thêm' }).click();
      assert(await ai().getByRole('menuitem').isDisabled(), 'Compact phải tắt khi chưa có phiên');
      await ai().getByLabel('Tin nhắn cho trợ lý').press('Escape');
      await shot('ai-hist');
      return 'lịch sử mở lại OK; Haiku + low; Compact tắt';
    });

    await check('Trợ lý AI: 390 px sáng + tối không cuộn ngang; Esc đóng sidebar', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
      const seen = [];
      for (let i = 0; i < 2; i++) {
        await page.waitForTimeout(300);
        const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
        assert(w <= 0, `cuộn ngang ${w}px (${await theme()})`);
        const box = await ai().boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= 391, `panel lệch ${JSON.stringify(box)}`);
        seen.push(await theme());
        await shot(`ai-390-${await theme()}`);
        if (i === 0) {
          // panel phủ cả header ở màn hẹp → bấm theme qua DOM
          await toggleTheme(page);
        }
      }
      await toggleTheme(page);
      await page.setViewportSize({ width: 1366, height: 900 });
      await ai().getByLabel('Tin nhắn cho trợ lý').press('Escape');
      await ai().waitFor({ state: 'detached' });
      assert(!(await page.evaluate(() => document.body.classList.contains('ai-open'))), 'body còn ai-open');
      return seen.join(' + ');
    });

    await check('Console sạch (không error/warning)', async () => {
      assert(!consoleIssues.length, consoleIssues.slice(0, 5).join(' | '));
    });

    // Mục cuối: giết server giữa lượt (không còn mục nào cần server sau đây).
    await check('Mất kết nối giữa lượt → nhật ký thôi "trực tiếp", đồng hồ đứng', async () => {
      await page.goto(`${base}/#/p/${SLUG}/hook`);
      await waitState('done');
      setScenario('slow');
      await mainBtn().click();
      await waitState('running');
      await page.locator('.term .log .ev', { hasText: 'Đang làm… 6' }).waitFor();
      const calls = fs.readFileSync(path.join(projDir, '.fake-calls.jsonl'), 'utf8').trim().split('\n');
      const argv = JSON.parse(calls[calls.length - 1]).argv;
      const sid = argv[argv.indexOf('--resume') + 1] || argv[argv.indexOf('--session-id') + 1];
      server.child.kill('SIGKILL');
      await new Promise((r) => (server.child.exitCode != null || server.child.signalCode != null ? r() : server.child.once('exit', r)));
      // dọn fake-claude mồ côi của lượt này (process do e2e khởi)
      const ps = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n');
      for (const line of ps) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m && sid && m[2].includes(FAKE_BIN) && m[2].includes(sid)) {
          try {
            process.kill(Number(m[1]), 'SIGTERM');
          } catch {
            /* đã thoát */
          }
        }
      }
      await page.locator('.term .term-h', { hasText: 'mất kết nối' }).waitFor();
      assert((await page.locator('.term .cursor').count()) === 0, 'con trỏ live vẫn nhấp nháy');
      assert((await page.locator('.term .lamp.live').count()) === 0, 'đèn live vẫn sáng');
      await page.locator('.step-head h1 .state-tag', { hasText: 'mất kết nối' }).waitFor();
      const clock = page.locator('.step-head .meta .ro', { hasText: 'Thời gian chạy' }).locator('b');
      const t1 = await clock.innerText();
      await page.waitForTimeout(2200);
      const t2 = await clock.innerText();
      assert(t1 === t2, `đồng hồ vẫn chạy: ${t1} → ${t2}`);
      await shot('offline-running');
      return `${t1} đứng yên`;
    });
  } catch (e) {
    record('Kịch bản E2E', false, String(e && e.message ? e.message : e).split('\n')[0]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server.child).catch(() => {});
    if (google) await google.close().catch(() => {});
    if (claudeApi) await claudeApi.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (e) {
  record('E2E', false, String(e && e.message ? e.message : e));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} mục đạt · ảnh: ${SHOTS}`);
process.exitCode = failed || !results.length ? 1 : 0;
