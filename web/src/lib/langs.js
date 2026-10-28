// Ngôn ngữ giọng đọc: mã → cờ nước + tên (tiếng Việt). Mã lạ → 🌐 + mã in hoa.
const L = {
  vi: ['🇻🇳', 'Tiếng Việt'], en: ['🇺🇸', 'Tiếng Anh'], fr: ['🇫🇷', 'Tiếng Pháp'], de: ['🇩🇪', 'Tiếng Đức'], es: ['🇪🇸', 'Tiếng Tây Ban Nha'],
  it: ['🇮🇹', 'Tiếng Ý'], pt: ['🇵🇹', 'Tiếng Bồ Đào Nha'], ja: ['🇯🇵', 'Tiếng Nhật'], ko: ['🇰🇷', 'Tiếng Hàn'], zh: ['🇨🇳', 'Tiếng Trung'],
  ru: ['🇷🇺', 'Tiếng Nga'], hi: ['🇮🇳', 'Tiếng Hindi'], ar: ['🇸🇦', 'Tiếng Ả Rập'], id: ['🇮🇩', 'Tiếng Indonesia'], th: ['🇹🇭', 'Tiếng Thái'],
  tr: ['🇹🇷', 'Tiếng Thổ Nhĩ Kỳ'], pl: ['🇵🇱', 'Tiếng Ba Lan'], nl: ['🇳🇱', 'Tiếng Hà Lan'], sv: ['🇸🇪', 'Tiếng Thụy Điển'],
};
export const langOf = (code) => {
  const c = String(code || '').toLowerCase();
  const [flag, name] = L[c] || ['🌐', c ? c.toUpperCase() : 'Khác'];
  return { code: c, flag, name, known: !!L[c] };
};
