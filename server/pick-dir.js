// Hộp thoại chọn thư mục của macOS (osascript) — trình duyệt không lấy được đường dẫn thật nên server mở giúp.
import { execFile } from 'node:child_process';

const SCRIPT = 'POSIX path of (choose folder with prompt "Chọn thư mục dự án")';
const TIMEOUT_MS = 10 * 60 * 1000;

// Trả hàm pick() → {path} | {cancelled:true}; ném {code:'unsupported'} khi không phải macOS. Mỗi lúc chỉ mở 1 hộp thoại.
export function createDirPicker({ platform = process.platform, bin = process.env.VS_PICK_DIR_BIN || 'osascript', run = execFile } = {}) {
  let busy = null;
  return function pick() {
    if (platform !== 'darwin' && !process.env.VS_PICK_DIR_BIN) return Promise.reject(Object.assign(new Error('Chọn thư mục chỉ hỗ trợ macOS.'), { code: 'unsupported' }));
    if (busy) return busy;
    busy = new Promise((resolve, reject) => {
      run(bin, ['-e', SCRIPT], { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
        busy = null;
        if (err) {
          if (/-128|User canceled/i.test(`${stderr || ''}${err.message || ''}`)) return resolve({ cancelled: true });
          return reject(Object.assign(new Error('Không mở được hộp thoại chọn thư mục.'), { code: 'pick_failed' }));
        }
        const p = String(stdout || '').trim().replace(/(.)\/+$/, '$1');
        if (!p.startsWith('/')) return resolve({ cancelled: true });
        resolve({ path: p });
      });
    });
    return busy;
  };
}
