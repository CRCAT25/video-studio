// `video-studio --update`: kéo code mới từ git (chỉ fast-forward), cài lại thư viện khi package đổi, build lại giao diện.
// Không đụng dữ liệu trong VS_HOME; repo có sửa đổi chưa commit thì từ chối để không ghi đè việc của người dùng.
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './presets.js';

const DEP_FILES = new Set(['package.json', 'package-lock.json']);

export class UpdateError extends Error {}

// Chạy lệnh trong repo; inherit = in thẳng ra terminal (npm), không thì trả stdout đã trim.
function defaultRun(cmd, args, { cwd, inherit = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', shell: process.platform === 'win32' });
  if (r.error) return { status: 1, stdout: '', stderr: r.error.message };
  return { status: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Cập nhật repo tại root. Trả {updated, from, to, commits, installed}; lỗi → throw UpdateError tiếng Việt.
export function runUpdate({ root = REPO_ROOT, run = defaultRun, log = console.log } = {}) {
  const git = (...args) => run('git', args, { cwd: root });
  if (git('rev-parse', '--is-inside-work-tree').status !== 0) {
    throw new UpdateError('Thư mục cài app không phải repo git — tải lại bằng git clone để dùng --update.');
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty.status !== 0) throw new UpdateError(`Không đọc được trạng thái git: ${dirty.stderr || 'lỗi không rõ'}`);
  if (dirty.stdout) {
    throw new UpdateError(`Repo có file đã sửa chưa commit, không cập nhật để tránh mất thay đổi:\n${dirty.stdout}\nCất đi (git stash) hoặc bỏ (git checkout -- .) rồi chạy lại.`);
  }
  const from = git('rev-parse', 'HEAD').stdout;
  log('Đang tải bản mới…');
  const pull = git('pull', '--ff-only');
  if (pull.status !== 0) {
    throw new UpdateError(`git pull không thành công:\n${pull.stderr || pull.stdout}\nKiểm tra mạng, hoặc nhánh đã lệch so với GitHub.`);
  }
  const to = git('rev-parse', 'HEAD').stdout;
  if (from === to) {
    log('Đã là bản mới nhất.');
    return { updated: false, from, to, commits: 0, installed: false };
  }
  const commits = Number(git('rev-list', '--count', `${from}..${to}`).stdout) || 0;
  const changed = git('diff', '--name-only', from, to).stdout.split('\n');
  const installed = changed.some((f) => DEP_FILES.has(f));
  if (installed) {
    log('Thư viện thay đổi → npm install…');
    if (run('npm', ['install'], { cwd: root, inherit: true }).status !== 0) throw new UpdateError('npm install lỗi — xem log ở trên rồi chạy lại video-studio --update.');
  }
  log('Đang build giao diện…');
  if (run('npm', ['run', 'build'], { cwd: root, inherit: true }).status !== 0) throw new UpdateError('npm run build lỗi — xem log ở trên rồi chạy lại video-studio --update.');
  log(`Đã cập nhật ${from.slice(0, 7)} → ${to.slice(0, 7)} (${commits} thay đổi).`);
  log('Đang mở app? Bấm Ctrl+C ở cửa sổ đó rồi gõ lại video-studio. Chạy nền thì: video-studio service restart');
  return { updated: true, from, to, commits, installed };
}
