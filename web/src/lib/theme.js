// Giao diện sáng/tối: mặc định theo hệ điều hành; người dùng đổi tay thì lưu localStorage "vs-theme" (bọc try/catch).

const KEY = 'vs-theme';

// Theme đã lưu ('dark' | 'light'); chưa lưu/lỗi → theo OS (prefers-color-scheme).
export function getStoredTheme() {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage bị chặn — theo OS */
  }
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// Áp theme lên <html data-theme> và màu thanh trình duyệt.
export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f7f7f8' : '#0b0c0e');
  return t;
}

// Lưu theme (bỏ qua nếu trình duyệt chặn storage).
export function storeTheme(theme) {
  try {
    window.localStorage.setItem(KEY, theme === 'light' ? 'light' : 'dark');
  } catch {
    /* chế độ riêng tư / chặn storage — vẫn đổi theme trong phiên */
  }
}
