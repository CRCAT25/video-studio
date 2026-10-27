// Tra bản dịch không cần React (test dùng được): khớp khóa thẳng, rồi khớp khóa mẫu có {biến}.
const PATTERNS = {};
// Khóa chứa {biến} → [regex, mẫu Anh, tên biến]; dựng một lần cho mỗi ngôn ngữ.
function matchPattern(dict, lang, text) {
  let list = PATTERNS[lang];
  if (!list) {
    list = PATTERNS[lang] = [];
    for (const [k, v] of Object.entries(dict[lang])) {
      if (!/\{\w+\}/.test(k)) continue;
      const names = [];
      const src = k
        .split(/(\{\w+\})/)
        .map((part) => {
          if (/^\{\w+\}$/.test(part)) {
            names.push(part.slice(1, -1));
            return '([\\s\\S]+?)';
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      list.push([new RegExp(`^${src}$`), v, names]);
    }
  }
  for (const [re, v, names] of list) {
    const m = re.exec(text);
    if (m) return v.replace(/\{(\w+)\}/g, (x, n) => (names.includes(n) ? m[names.indexOf(n) + 1] : x));
  }
  return null;
}


// Chuỗi server đã nội suy sẵn ("Bước "x" không còn…") → khớp khóa mẫu, lấy giá trị thay vào bản Anh; không có thì giữ khóa.
export function lookup(dict, lang, key) {
  const d = dict[lang];
  if (!d) return key;
  return d[key] || matchPattern(dict, lang, key) || key;
}
