// Biểu tượng SVG: logo, tải về, nhánh Bộ não, mũi tên xu hướng.

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

// Nét vẽ của từng nhánh Bộ não (viewBox 24, nét 1.8).
const BRANCH_PATHS = {
  pin: 'M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1.1.2-2.2 1.4-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10zM7.5 11.5h.01M10.5 7.5h.01M15 7.5h.01',
  app: 'M7 2.5h10a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5zM11 18h2',
  video: 'M3.5 6.5h11a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 2 16V8a1.5 1.5 0 0 1 1.5-1.5zM16 10.5l6-3.5v10l-6-3.5',
  film: 'M4.5 3h15A1.5 1.5 0 0 1 21 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3zM7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4',
  book: 'M2 4.5h6a4 4 0 0 1 4 4V21a3 3 0 0 0-3-3H2zM22 4.5h-6a4 4 0 0 0-4 4V21a3 3 0 0 1 3-3h7z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  bulb: 'M9 18h6M10 21.5h4M12 2.5a6.5 6.5 0 0 0-4 11.6c.6.5 1 1.3 1 2.1v.8h6v-.8c0-.8.4-1.6 1-2.1a6.5 6.5 0 0 0-4-11.6z',
};

// Biểu tượng nhánh Bộ não theo tên (pin, palette, app, video, film, book, inbox, bulb).
export function BranchIcon({ name }) {
  return (
    <svg className="ic-br" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={BRANCH_PATHS[name] || BRANCH_PATHS.inbox} />
    </svg>
  );
}

// Mũi tên xu hướng: up (tăng) / down (giảm); màu do lớp cha quyết định.
export function TrendIcon({ dir }) {
  return (
    <svg className="ic-tr" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === 'down' ? 'M8 3v10M4 9l4 4 4-4' : 'M8 13V3M4 7l4-4 4 4'} />
    </svg>
  );
}
