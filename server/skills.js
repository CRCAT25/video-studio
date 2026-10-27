// Thư viện skill của app: <home>/skills/<tên>/SKILL.md. Xem, sửa, xóa, nhập từ ~/.claude/skills, dán nội dung hoặc GitHub.
// Quy trình (preset) gắn skill bằng đường dẫn thư mục trong trường `skills`; runner đã biết nạp các thư mục đó.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, slugify, isValidSlug } from './paths.js';

export const MAX_SKILL_MD = 200 * 1024;
export const MAX_FILES = 200;
export const MAX_BYTES = 5 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.studio.json']);
const SCOPE_FILE = '.studio.json'; // phạm vi của skill: {channels: [id kênh]}; không có file = dùng chung (đọc được cả dạng cũ {channel})
const RESERVED = new Set(['local']); // trùng đường dẫn tĩnh /api/skills/local
export const GITHUB_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.\-/]+?))?\/?$/;

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Đọc frontmatter YAML đơn giản (name, description một dòng hoặc khối > | ); không có thì rỗng.
export function parseSkillMd(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = { title: '', description: '' };
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  const unq = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2];
    if (/^[>|][+-]?$/.test(v.trim())) {
      const buf = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim());
      v = buf.join(' ');
    }
    if (kv[1] === 'name') out.title = unq(v);
    else out.description = unq(v);
  }
  return out;
}

// Phạm vi skill: {shared:true} (mặc định, khi chưa có file) hoặc {shared:false, channels:[id…]}.
export function skillScope(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, SCOPE_FILE), 'utf8'));
    if (Array.isArray(o.channels)) return { shared: false, channels: [...new Set(o.channels.filter((c) => typeof c === 'string' && c))] };
    if (typeof o.channel === 'string' && o.channel) return { shared: false, channels: [o.channel] };
  } catch {
    /* chưa có / hỏng → dùng chung */
  }
  return { shared: true, channels: [] };
}

// Chỉ giữ skill dùng chung hoặc có tick đúng kênh của dự án (skill chỉ của kênh khác bị loại).
export function skillsForChannel(dirs, channelId) {
  return dirs.filter((d) => {
    const sc = skillScope(d);
    return sc.shared || (channelId != null && sc.channels.includes(channelId));
  });
}

const nameOf = (s) => slugify(String(s || '')).slice(0, 64);

// Danh sách thư mục con có SKILL.md trong root (không đệ quy sâu hơn 1 cấp).
export function scanSkillDirs(root) {
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of names) {
    if (!d.isDirectory() || SKIP.has(d.name)) continue;
    const dir = path.join(root, d.name);
    let text;
    try {
      text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const meta = parseSkillMd(text);
    out.push({ name: nameOf(d.name) || nameOf(meta.title), dir, title: meta.title, description: meta.description });
  }
  return out.filter((s) => s.name).sort((a, b) => a.name.localeCompare(b.name));
}

// Chép thư mục skill (chỉ file thường; bỏ symlink, .git, node_modules); vượt giới hạn → lỗi.
function copyTree(src, dest) {
  let files = 0;
  let bytes = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) {
        const size = fs.statSync(a).size;
        files++;
        bytes += size;
        if (files > MAX_FILES || bytes > MAX_BYTES) throw fail(400, 'skill_too_big', `Skill quá lớn (tối đa ${MAX_FILES} file, ${Math.round(MAX_BYTES / 1048576)} MB).`);
        fs.copyFileSync(a, b);
      }
    }
  };
  walk(src, dest);
}

// Clone nông một repo GitHub vào dir (không shell, không hỏi mật khẩu, tối đa 60 s).
export function gitClone({ url, branch, dir, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1', '--single-branch', ...(branch ? ['--branch', branch] : []), '--', url, dir];
    let child;
    try {
      child = spawn('git', args, { shell: false, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch {
      reject(fail(500, 'git_missing', 'Không chạy được git.'));
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      reject(fail(500, 'git_missing', 'Máy chưa cài git hoặc không chạy được git.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(fail(400, 'github_failed', 'Không tải được repo GitHub (kiểm tra link, repo phải công khai).'));
    });
  });
}

// home: thư mục dữ liệu app; localRoot: nơi chứa skill trên máy; presets(): {presets:[{id,name,skills}]}; clone: thay được khi test.
export function createSkills({ home, localRoot = path.join(os.homedir(), '.claude', 'skills'), presets = () => ({ presets: [] }), channels = null, clone = gitClone } = {}) {
  const lib = path.join(home, 'skills');

  const need = (name) => {
    if (!isValidSlug(name) || RESERVED.has(name)) throw fail(404, 'skill_not_found', 'Không tìm thấy skill.');
    const dir = path.join(lib, name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw fail(404, 'skill_not_found', 'Không tìm thấy skill.');
    return dir;
  };

  // scope: {all:true} = dùng chung; {channels:[id…]} = chỉ các kênh đó (id phải có thật khi biết danh sách kênh).
  const normScope = (sc) => {
    if (sc && sc.all === true) return null;
    if (!sc || !Array.isArray(sc.channels) || sc.channels.some((c) => typeof c !== 'string' || !c)) throw fail(400, 'invalid_channel', 'Kênh không hợp lệ.');
    const list = [...new Set(sc.channels)];
    const have = channels ? new Set((channels() || []).map((x) => x && x.id)) : null;
    if (have && list.some((c) => !have.has(c))) throw fail(400, 'channel_not_found', 'Không tìm thấy kênh đã chọn.');
    return list;
  };
  const putScope = (dir, list) => {
    const f = path.join(dir, SCOPE_FILE);
    if (list == null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, JSON.stringify({ channels: list }));
  };

  const usage = () => {
    const res = presets();
    const list = Array.isArray(res) ? res : res?.presets || [];
    return list
      .map((p) => ({ id: p.id, name: p.name, skills: (p.skills || []).map((s) => path.resolve(String(s))) }))
      .filter((p) => p.skills.length);
  };
  const usedBy = (dir, all = usage()) => all.filter((p) => p.skills.includes(path.resolve(dir))).map((p) => ({ id: p.id, name: p.name }));

  function list() {
    const all = usage();
    return scanSkillDirs(lib).map((s) => {
      let st = null;
      try {
        st = fs.statSync(path.join(s.dir, 'SKILL.md'));
      } catch {
        /* vừa bị xóa */
      }
      return { name: s.name, title: s.title || s.name, description: s.description, path: s.dir, ...skillScope(s.dir), size: st?.size ?? 0, updatedAt: st ? st.mtime.toISOString() : null, usedBy: usedBy(s.dir, all) };
    });
  }

  function read(name) {
    const dir = need(name);
    const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const files = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
        else if (e.isFile() && `${rel}${e.name}` !== 'SKILL.md') files.push(`${rel}${e.name}`);
      }
    };
    walk(dir, '');
    return { name, path: dir, ...skillScope(dir), content, files: files.slice(0, 200), usedBy: usedBy(dir) };
  }

  function checkContent(content) {
    if (typeof content !== 'string' || !content.trim()) throw fail(400, 'invalid_body', 'Nội dung SKILL.md không được để trống.');
    if (Buffer.byteLength(content) > MAX_SKILL_MD) throw fail(400, 'skill_too_big', `SKILL.md tối đa ${MAX_SKILL_MD / 1024} KB.`);
  }

  function write(name, content) {
    const dir = need(name);
    checkContent(content);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
    return read(name);
  }

  // Đổi phạm vi: {all:true} hoặc {channels:[…]}.
  function setScope(name, scope) {
    const dir = need(name);
    putScope(dir, normScope(scope));
    return read(name);
  }

  function remove(name) {
    const dir = need(name);
    const used = usedBy(dir);
    if (!isInside(lib, dir)) throw fail(400, 'invalid_body', 'Đường dẫn không hợp lệ.');
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, usedBy: used };
  }

  // Tên rảnh: tên gốc nếu chưa có; nếu đã có và rename=false → lỗi 409.
  const freeName = (want, rename) => {
    const base = nameOf(want);
    if (!base || RESERVED.has(base)) throw fail(400, 'invalid_name', 'Tên skill không hợp lệ (chữ thường, số, dấu gạch ngang).');
    if (!fs.existsSync(path.join(lib, base))) return base;
    if (!rename) throw fail(409, 'skill_exists', `Đã có skill "${base}" trong thư viện.`);
    for (let i = 2; ; i++) if (!fs.existsSync(path.join(lib, `${base}-${i}`))) return `${base}-${i}`;
  };

  function importDirs(found, names, rename) {
    const pick = found.filter((s) => names.includes(s.name));
    if (!pick.length) throw fail(400, 'invalid_body', 'Chưa chọn skill nào hợp lệ để nhập.');
    const done = [];
    for (const s of pick) {
      const name = freeName(s.name, rename);
      try {
        copyTree(s.dir, path.join(lib, name));
      } catch (e) {
        fs.rmSync(path.join(lib, name), { recursive: true, force: true });
        throw e;
      }
      done.push(name);
    }
    return done;
  }

  function importText({ name, content, rename = false }) {
    checkContent(content);
    const n = freeName(name || parseSkillMd(content).title, rename);
    fs.mkdirSync(path.join(lib, n), { recursive: true });
    fs.writeFileSync(path.join(lib, n, 'SKILL.md'), content);
    return [n];
  }

  // Skill có trên máy (~/.claude/skills) + đã có trong thư viện hay chưa.
  function local() {
    const have = new Set(scanSkillDirs(lib).map((s) => s.name));
    return scanSkillDirs(localRoot).map((s) => ({ name: s.name, title: s.title || s.name, description: s.description, imported: have.has(s.name) }));
  }

  const importLocal = ({ names, rename = false }) => importDirs(scanSkillDirs(localRoot), Array.isArray(names) ? names : [], rename);

  // Không có names → chỉ quét và trả các skill tìm được; có names → nhập các skill đó.
  async function importGithub({ url, names, rename = false }) {
    const m = GITHUB_RE.exec(String(url || '').trim());
    if (!m || m[3]?.includes('..')) throw fail(400, 'invalid_url', 'Chỉ nhận link dạng https://github.com/chủ/repo (có thể kèm /tree/nhánh/thư-mục).');
    const [, owner, repo, tree] = m;
    const parts = tree ? tree.split('/') : [];
    const branch = parts[0];
    const sub = parts.slice(1).join('/');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-skill-'));
    try {
      const dir = path.join(tmp, 'repo');
      await clone({ url: `https://github.com/${owner}/${repo}.git`, branch, dir });
      const base = sub ? path.join(dir, sub) : dir;
      if (!isInside(dir, base) && base !== dir) throw fail(400, 'invalid_url', 'Đường dẫn thư mục không hợp lệ.');
      // Thư mục trỏ thẳng vào một skill, hoặc thư mục chứa nhiều skill (thường là skills/)
      let found = fs.existsSync(path.join(base, 'SKILL.md')) ? [{ name: nameOf(path.basename(base)) || nameOf(repo), dir: base, ...parseSkillMd(fs.readFileSync(path.join(base, 'SKILL.md'), 'utf8')) }] : [];
      if (!found.length) found = scanSkillDirs(base);
      if (!found.length) found = scanSkillDirs(path.join(base, 'skills'));
      if (!found.length) throw fail(400, 'no_skill', 'Không tìm thấy SKILL.md nào trong link này.');
      if (!Array.isArray(names)) return { candidates: found.map((s) => ({ name: s.name, title: s.title || s.name, description: s.description })) };
      return { imported: importDirs(found, names, rename) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return { lib, list, read, write, setScope, remove, local, importLocal, importText, importGithub };
}
