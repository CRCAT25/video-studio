// Biểu tượng SVG: logo, tải về.

// Logo: ô bo góc có nút play.
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="var(--accent-bg)" />
      <path d="M9.5 7.5v9l7-4.5z" fill="#fff" />
    </svg>
  );
}

// Mũi tên tải về (thay ký tự ⇩ vì font chữ không có glyph này).
export function DownloadIcon() {
  return (
    <svg className="ic-dl" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />
    </svg>
  );
}
