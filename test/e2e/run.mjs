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
function startServer(port, home, googleBase) {
  const env = {
    ...process.env,
    VS_SECRETS: 'file',
    VS_GOOGLE_BASE: googleBase,
    VS_HOME: home,
    VS_TOKEN: TOKEN,
    VS_CLAUDE_BIN: FAKE_BIN,
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
  try {
    google = await startFakeGoogle();
    const port = await freePort();
    server = startServer(port, home, google.base);
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

    const shot = async (name, p = page) => {
      shotN += 1;
      const file = path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`);
      await p.screenshot({ path: file, fullPage: true });
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

    await check('Tạo dự án qua modal với preset e2e-short', async () => {
      await page.getByRole('button', { name: /Dự án mới/ }).first().click();
      const modal = page.locator('.modal[role="dialog"]');
      await modal.waitFor();
      await choose(modal, 'e2e-short');
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

    await check('Màn Preset có tiktok-short và e2e-short; nhãn cổng trong ô không bị cắt', async () => {
      await page.locator('header.top a', { hasText: 'Preset' }).click();
      await page.locator('.page-h h1', { hasText: 'Preset' }).waitFor();
      await page.locator('section.bp', { hasText: 'e2e-short' }).waitFor();
      await page.locator('section.bp', { hasText: 'tiktok-short' }).waitFor();
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('.flow.static .box .st')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
      );
      assert(!clipped.length, `nhãn bị cắt: ${clipped.join(', ')}`);
      const autoLab = await page.locator('section.bp', { hasText: 'e2e-manual' }).locator('.box .st', { hasText: 'Tự · 30 phút' }).first().innerText();
      await shot('presets');
      return `${await page.locator('section.bp').count()} preset · ${autoLab}`;
    });

    await check('Đổi theme sáng/tối (nhớ sau khi tải lại)', async () => {
      const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
      const t0 = await theme();
      await page.locator('header.top .theme-btn').click();
      const t1 = await theme();
      assert(t0 !== t1 && ['light', 'dark'].includes(t1), `${t0} → ${t1}`);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.waitForTimeout(300); // chờ transition màu xong rồi mới chụp
      await shot(`presets-${t1}`);
      await page.reload();
      await page.locator('.page-h h1', { hasText: 'Preset' }).waitFor();
      assert((await theme()) === t1, 'theme không được nhớ sau reload');
      await page.locator('header.top .theme-btn').click();
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
        ['presets', '#/presets', 'section.bp'],
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

    // ---- tài khoản Claude (fake-claude: auth login/logout chỉ ghi file giả, không mở trình duyệt)
    const accModal = () => page.locator('.modal', { hasText: 'Tài khoản Claude' });
    await check('Tài khoản: bấm ô CLAUDE CODE → bảng tài khoản; Đăng xuất cần xác nhận', async () => {
      await page.goto(`${base}/#/`);
      await page.locator('header.top .acc-btn', { hasText: 'ĐÃ ĐĂNG NHẬP' }).click();
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
      await modal.locator('.modal-acts').getByRole('button', { name: 'Xóa kênh' }).click();
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
