// "Kho skill của tôi": một repo git riêng của người dùng chứa skill. Tạo repo, đẩy skill từ thư viện lên (có quét thông tin riêng tư),
// kéo bản mới về và sinh sync.sh / sync.ps1 để cài skill vào ~/.claude/skills ở máy khác.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { copyTree, parseSkillMd, scanSkillDirs } from './skills.js';
import { isValidSlug } from './paths.js';

const REPO_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;
const MARK_A = '<!-- skills:start -->';
const MARK_B = '<!-- skills:end -->';
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.studio.json']);
const MAX_SCAN_BYTES = 512 * 1024;

function fail(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

// Chạy một lệnh (không shell, không hỏi mật khẩu); trả {code, out, err}; không có lệnh → code -1.
export function run(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e.message) });
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err || String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim(), err: err.trim() });
    });
  });
}

// Các mẫu thông tin riêng tư hay lọt vào skill.
const PATTERNS = [
  ['home_path', /\/Users\/[\w.-]+\//],
  ['home_path', /\/home\/[\w.-]+\//],
  ['home_path', /[A-Za-z]:\\Users\\[\w.-]+/],
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]*[A-Za-z]/],
  ['token', /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
  ['token', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['token', /\bAKIA[0-9A-Z]{16}\b/],
  ['token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['secret', /(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
  ['secret', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function* walkFiles(dir, base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(f, base);
    else if (e.isFile()) yield [f, path.relative(base, f).split(path.sep).join('/')];
  }
}

// Quét thư mục skill tìm thông tin riêng tư → [{skill, file, line, kind, excerpt}]; bỏ qua file nhị phân / quá lớn.
export function scanDir(dir, skill = '') {
  const out = [];
  for (const [f, rel] of walkFiles(dir)) {
    let buf;
    try {
      if (fs.statSync(f).size > MAX_SCAN_BYTES) continue;
      buf = fs.readFileSync(f);
    } catch {
      continue;
    }
    if (buf.subarray(0, 4096).includes(0)) continue;
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      for (const [kind, re] of PATTERNS) {
        const m = re.exec(line);
        if (m) {
          out.push({ skill, file: rel, line: i + 1, kind, excerpt: m[0].slice(0, 60) });
          break;
        }
      }
    });
  }
  return out;
}

// Băm nội dung cả thư mục để so sánh thư viện ↔ repo.
function hashDir(dir) {
  const h = crypto.createHash('sha1');
  const files = [...walkFiles(dir)].sort((a, b) => (a[1] < b[1] ? -1 : 1));
  for (const [f, rel] of files) {
    h.update(`${rel}\0`);
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

const README_HEAD = (name) => `# ${name}

My Claude Code skills, managed with [Video Studio](https://github.com/CRCAT25/video-studio).

## Install on a new machine

\`\`\`sh
git clone <this repo's URL> ~/${name}
cd ~/${name} && ./sync.sh        # macOS / Linux
# Windows (PowerShell): .\\sync.ps1
\`\`\`

Run the same script again any time to pull the latest skills.

## Skills

${MARK_A}
${MARK_B}
`;

const GITIGNORE = '.DS_Store\nnode_modules/\n.studio.json\n*.log\n';

const SYNC_SH = `#!/usr/bin/env sh
# Pull the latest skills and link each one into your Claude Code skills folder.
set -e
cd "$(dirname "$0")"
git pull --ff-only
DEST="\${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$DEST"
for f in */SKILL.md; do
  [ -f "$f" ] || continue
  name="$(dirname "$f")"
  target="$DEST/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip $name (a real folder already exists at $target)"
    continue
  fi
  ln -sfn "$PWD/$name" "$target"
  echo "linked $name"
done
`;

const SYNC_PS1 = `# Pull the latest skills and copy each one into your Claude Code skills folder.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
git pull --ff-only
$dest = if ($env:CLAUDE_SKILLS_DIR) { $env:CLAUDE_SKILLS_DIR } else { Join-Path $HOME '.claude\\skills' }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') } | ForEach-Object {
  $target = Join-Path $dest $_.Name
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse $_.FullName $target
  Write-Host "copied $($_.Name)"
}
`;

const LICENSE = (year) => `MIT License

Copyright (c) ${year}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// home: thư mục dữ liệu app; libRoot: <home>/skills; exec/gh thay được khi test.
export function createSkillRepo({ home, libRoot = path.join(home, 'skills'), exec = run, gh = (args, o) => run('gh', args, o), defaultDir = path.join(home, 'skill-repo') } = {}) {
  const cfgFile = path.join(home, 'skill-repo.json');
  const readCfg = () => {
    try {
      const o = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      return o && typeof o.dir === 'string' ? o : null;
    } catch {
      return null;
    }
  };
  const writeCfg = (c) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(c));
  };
  const git = (dir, args, o) => exec('git', args, { cwd: dir, ...o });
  const need = () => {
    const c = readCfg();
    if (!c || !fs.existsSync(path.join(c.dir, '.git'))) throw fail(409, 'repo_not_ready', 'Chưa tạo kho skill.');
    return c;
  };
  const validNames = (names) => {
    if (!Array.isArray(names) || !names.length || names.some((n) => !isValidSlug(n))) throw fail(400, 'invalid_skills', 'Chọn ít nhất một skill hợp lệ.');
    return [...new Set(names)];
  };
  const libDir = (n) => path.join(libRoot, n);
  const repoDir = (c, n) => path.join(c.dir, n);
  const hasSkill = (d) => fs.existsSync(path.join(d, 'SKILL.md'));

  // So thư viện với repo: new (chỉ có ở thư viện), changed, same, repo_only (chỉ có ở repo).
  function diff(c) {
    const names = new Set([...scanSkillDirs(libRoot).map((s) => s.name), ...scanSkillDirs(c.dir).map((s) => s.name)]);
    return [...names].sort().map((name) => {
      const a = hasSkill(libDir(name));
      const b = hasSkill(repoDir(c, name));
      const state = a && b ? (hashDir(libDir(name)) === hashDir(repoDir(c, name)) ? 'same' : 'changed') : a ? 'new' : 'repo_only';
      return { name, state };
    });
  }

  function writeReadmeTable(c) {
    const f = path.join(c.dir, 'README.md');
    let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : README_HEAD(path.basename(c.dir));
    if (!text.includes(MARK_A) || !text.includes(MARK_B)) text += `\n## Skills\n\n${MARK_A}\n${MARK_B}\n`;
    const cell = (s) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 200);
    const rows = scanSkillDirs(c.dir).map((s) => `| [${s.name}](${s.name}/) | ${cell(parseSkillMd(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')).description)} |`);
    const table = rows.length ? `| Skill | Description |\n| --- | --- |\n${rows.join('\n')}` : '_No skills yet._';
    const a = text.indexOf(MARK_A);
    const b = text.indexOf(MARK_B, a);
    fs.writeFileSync(f, `${text.slice(0, a)}${MARK_A}\n${table}\n${text.slice(b)}`);
  }

  // Máy chưa cấu hình git user thì dùng danh tính mặc định để commit không lỗi.
  async function ident(dir) {
    const n = await git(dir, ['config', 'user.name']);
    const e = await git(dir, ['config', 'user.email']);
    return n.out && e.out ? [] : ['-c', 'user.name=Video Studio', '-c', 'user.email=video-studio@localhost'];
  }
  async function commit(c, message) {
    await git(c.dir, ['add', '-A']);
    const st = await git(c.dir, ['status', '--porcelain']);
    if (!st.out) return false;
    const r = await git(c.dir, [...(await ident(c.dir)), 'commit', '-m', message]);
    if (r.code !== 0) throw fail(500, 'commit_failed', r.err || 'Không commit được.');
    return true;
  }

  async function status() {
    const c = readCfg();
    const g = await exec('git', ['--version']);
    const ghv = await gh(['auth', 'status']);
    const base = { configured: false, dir: c?.dir || defaultDir, url: c?.url || '', hasGit: g.code === 0, hasGh: ghv.code !== -1, ghLoggedIn: ghv.code === 0, skills: [], dirty: false, ahead: 0 };
    if (!c || !fs.existsSync(path.join(c.dir, '.git'))) return base;
    const st = await git(c.dir, ['status', '--porcelain']);
    const ah = await git(c.dir, ['rev-list', '--count', '@{u}..HEAD']);
    return { ...base, configured: true, skills: diff(c), dirty: !!st.out, ahead: ah.code === 0 ? Number(ah.out) || 0 : 0 };
  }

  // Tạo thư mục repo cục bộ (README, LICENSE, .gitignore, sync.sh, sync.ps1) và nối remote; có url thì nối url, hoặc để gh tạo repo.
  async function init({ url = '', dir, createWithGh = false, name = 'my-skills' } = {}) {
    const target = path.resolve(dir || defaultDir);
    url = String(url || '').trim();
    if (url && !REPO_URL_RE.test(url)) throw fail(400, 'invalid_url', 'Dán địa chỉ repo GitHub dạng https://github.com/tên/repo.');
    if (createWithGh && !/^[\w.-]{1,100}$/.test(String(name))) throw fail(400, 'invalid_name', 'Tên repo không hợp lệ.');
    if (fs.existsSync(target) && fs.readdirSync(target).length && !fs.existsSync(path.join(target, '.git'))) throw fail(409, 'dir_not_empty', 'Thư mục đã có nội dung nhưng chưa phải repo git.');
    if ((await exec('git', ['--version'])).code !== 0) throw fail(400, 'git_missing', 'Máy chưa có git.');
    fs.mkdirSync(target, { recursive: true });
    const c = { dir: target, url };
    if (!fs.existsSync(path.join(target, '.git'))) {
      const r = await git(target, ['init', '-b', 'main']);
      if (r.code !== 0) throw fail(500, 'git_init_failed', r.err || 'Không khởi tạo được repo.');
    }
    const put = (f, text, mode) => {
      const p = path.join(target, f);
      if (!fs.existsSync(p)) fs.writeFileSync(p, text, mode ? { mode } : undefined);
    };
    put('README.md', README_HEAD(path.basename(target)));
    put('LICENSE', LICENSE(new Date().getFullYear()));
    put('.gitignore', GITIGNORE);
    put('sync.sh', SYNC_SH, 0o755);
    put('sync.ps1', SYNC_PS1);
    writeReadmeTable(c);
    await commit(c, 'Initial commit');
    if (createWithGh) {
      const r = await gh(['repo', 'create', String(name), '--public', '--source=.', '--remote=origin'], { cwd: target, timeoutMs: 90_000 });
      if (r.code !== 0) throw fail(502, 'gh_failed', r.err || 'gh không tạo được repo. Chạy "gh auth login" rồi thử lại.');
      c.url = (await git(target, ['remote', 'get-url', 'origin'])).out.replace(/\.git$/, '');
    } else if (url) {
      const has = await git(target, ['remote', 'get-url', 'origin']);
      const r = await git(target, ['remote', has.code === 0 ? 'set-url' : 'add', 'origin', url]);
      if (r.code !== 0) throw fail(500, 'remote_failed', r.err || 'Không nối được remote.');
    }
    writeCfg(c);
    return status();
  }

  // Quét các skill sẽ đẩy; không đổi gì.
  function scan(names) {
    return validNames(names).flatMap((n) => {
      if (!hasSkill(libDir(n))) throw fail(404, 'skill_not_found', `Không tìm thấy skill ${n}.`);
      return scanDir(libDir(n), n);
    });
  }

  // Đẩy skill: bắt buộc confirm; có thông tin riêng tư mà chưa force → 409 kèm danh sách, chưa đổi gì.
  async function publish({ names, message, confirm, force = false } = {}) {
    const c = need();
    if (confirm !== true) throw fail(400, 'confirm_required', 'Cần bạn xác nhận trước khi đẩy lên kho.');
    names = validNames(names);
    const findings = scan(names);
    if (findings.length && !force) throw fail(409, 'private_info', 'Skill có thể chứa thông tin riêng tư.', { findings });
    for (const n of names) {
      fs.rmSync(repoDir(c, n), { recursive: true, force: true });
      copyTree(libDir(n), repoDir(c, n));
    }
    writeReadmeTable(c);
    const committed = await commit(c, String(message || '').trim().slice(0, 200) || `Update ${names.join(', ')}`);
    let pushed = false;
    let hint = '';
    if (!c.url) hint = 'no_remote';
    else {
      const r = await git(c.dir, ['push', '-u', 'origin', 'main'], { timeoutMs: 120_000 });
      pushed = r.code === 0;
      if (!pushed) hint = r.err.slice(0, 300) || 'push_failed';
    }
    return { committed, pushed, hint, names };
  }

  // Kéo bản mới của repo (chỉ fast-forward).
  async function pull() {
    const c = need();
    if (!c.url) throw fail(409, 'no_remote', 'Kho chưa có địa chỉ GitHub.');
    const r = await git(c.dir, ['pull', '--ff-only'], { timeoutMs: 120_000 });
    if (r.code !== 0) throw fail(502, 'pull_failed', r.err.slice(0, 300) || 'Không kéo được bản mới.');
    return status();
  }

  // Áp bản trong repo vào thư viện (ghi đè, giữ .studio.json).
  function apply({ names } = {}) {
    const c = need();
    names = validNames(names);
    for (const n of names) if (!hasSkill(repoDir(c, n))) throw fail(404, 'skill_not_found', `Kho không có skill ${n}.`);
    for (const n of names) {
      const keep = path.join(libDir(n), '.studio.json');
      const scope = fs.existsSync(keep) ? fs.readFileSync(keep) : null;
      fs.rmSync(libDir(n), { recursive: true, force: true });
      copyTree(repoDir(c, n), libDir(n));
      if (scope) fs.writeFileSync(keep, scope);
    }
    return { applied: names };
  }

  return { status, init, scan, publish, pull, apply };
}
