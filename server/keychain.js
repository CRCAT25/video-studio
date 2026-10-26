// Kho bí mật cho kết nối YouTube: macOS Keychain qua lệnh `security` (bí mật đi qua stdin dạng hex, không lên argv);
// hệ điều hành khác → file JSON quyền 600 trong VS_HOME. Không bao giờ log giá trị.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const KEYCHAIN_SERVICE = 'video-studio';
const NAME_RE = /^[A-Za-z0-9:._-]{1,120}$/;
const NOT_FOUND = 44; // mã thoát của `security` khi không có mục

// Chạy `security` với argv + stdin; trả {code, stdout}. Không đọc stderr (có thể chứa tên mục, không chứa bí mật).
function run(bin, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8') }));
    child.stdin.end(input ?? '');
  });
}

function checkName(name) {
  if (!NAME_RE.test(String(name))) throw new Error('Tên mục bí mật không hợp lệ.');
  return String(name);
}

// Kho Keychain: {kind:'keychain', get, set, remove}; giá trị là chuỗi.
export function keychainStore({ bin = 'security', service = KEYCHAIN_SERVICE } = {}) {
  return {
    kind: 'keychain',
    async get(name) {
      const r = await run(bin, ['find-generic-password', '-a', checkName(name), '-s', service, '-w']);
      if (r.code === NOT_FOUND) return null;
      if (r.code !== 0) throw new Error(`Không đọc được Keychain (mã ${r.code}).`);
      return r.stdout.replace(/\n$/, '');
    },
    async set(name, value) {
      const hex = Buffer.from(String(value), 'utf8').toString('hex');
      const r = await run(bin, ['-i'], `add-generic-password -U -a "${checkName(name)}" -s "${service}" -X ${hex}\n`);
      if (r.code !== 0) throw new Error(`Không ghi được Keychain (mã ${r.code}).`);
    },
    async remove(name) {
      const r = await run(bin, ['delete-generic-password', '-a', checkName(name), '-s', service]);
      if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`Không xóa được mục trong Keychain (mã ${r.code}).`);
    },
  };
}

// Kho file (quyền 600) cho máy không có Keychain.
export function fileStore(file) {
  const read = () => {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  };
  const write = (o) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  };
  return {
    kind: 'file',
    async get(name) {
      const v = read()[checkName(name)];
      return typeof v === 'string' ? v : null;
    },
    async set(name, value) {
      const o = read();
      o[checkName(name)] = String(value);
      write(o);
    },
    async remove(name) {
      const o = read();
      if (!(checkName(name) in o)) return;
      delete o[name];
      write(o);
    },
  };
}

// Kho mặc định theo hệ điều hành: macOS → Keychain, còn lại → $home/secrets.json.
export function createSecretStore({ platform = process.platform, home, bin } = {}) {
  if (platform === 'darwin') return keychainStore({ bin });
  return fileStore(path.join(home, 'secrets.json'));
}
