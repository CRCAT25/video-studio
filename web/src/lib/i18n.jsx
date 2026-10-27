// Song ngữ Việt/Anh: khóa chính là câu tiếng Việt; locales/en.js dịch sang tiếng Anh, tiếng Việt dùng thẳng khóa.
// t('Xin chào {name}', {name}) trong component (hook useT), tr(...) ở code ngoài React, T('...') chỉ đánh dấu chuỗi
// khai báo ở mức module (dịch lúc vẽ bằng t(x)). Test quét web/src để mọi khóa đều có bản Anh.
import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from '../locales/en.js';
import { lookup } from './lookup.js';

export const LANGS = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
];
const KEY = 'vs.lang';
const DICT = { en };
let current = 'vi';

function readLang() {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'en' ? 'en' : 'vi';
  } catch {
    return 'vi';
  }
}

export const getLang = () => current;

// Dịch khóa theo ngôn ngữ; thay {tên} bằng giá trị trong vars; thiếu bản dịch thì giữ khóa.
export function translate(lang, key, vars) {
  const s = lookup(DICT, lang, key);
  if (!vars) return s;
  // biến là phần tử React (vd. <span>) → trả mảng các mảnh để chèn giữa câu
  if (Object.values(vars).some((v) => v !== null && typeof v === 'object')) {
    return s.split(/(\{\w+\})/).map((part, i) => {
      const v = vars[part.slice(1, -1)];
      return /^\{\w+\}$/.test(part) && v != null ? <Fragment key={i}>{v}</Fragment> : part;
    });
  }
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}
export const tr = (key, vars) => translate(current, key, vars);
export const T = (key) => key; // chỉ đánh dấu để test quét thấy khóa

// Mã locale cho Intl / toLocaleString.
export const intlLocale = () => (current === 'en' ? 'en-US' : 'vi-VN');

const Ctx = createContext({ lang: 'vi', setLang: () => {}, t: tr });

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    current = readLang();
    return current;
  });
  const setLang = useCallback((v) => {
    const next = v === 'en' ? 'en' : 'vi';
    current = next; // đặt trước khi vẽ lại để tr() ngoài React cũng đúng
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* trình duyệt chặn lưu */
    }
    setLangState(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang, t: (k, vars) => translate(lang, k, vars) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;
