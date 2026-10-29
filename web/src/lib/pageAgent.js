// Tay chân của Trợ lý AI trên trang: đọc phần tử thao tác được (gắn số ref), bấm, gõ, chuyển trang.
// Kiểm an toàn ở đây: data-ai="block" (cấm hẳn), data-ai="confirm" hoặc chữ nhạy cảm → hỏi người dùng trước.

import { tr } from './i18n.jsx';
import { HINTS, hint } from './aiHints.js';

const PANEL = '.ai-panel';
const INTERACTIVE = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'textarea',
  'summary',
  '[role=button]',
  '[role=option]',
  '[role=radio]',
  '[role=checkbox]',
  '[role=switch]',
  '[role=tab]',
  '[role=combobox]',
  '[role=menuitem]',
].join(',');
const CONFIRM_RE = /(^|[\s"'(])(xóa|xoá|đăng xuất|cập nhật|khởi động lại|dừng|ngắt kết nối|thu hồi|chạy|hủy kết nối|delete|remove|sign out|log out|update|restart|stop|disconnect|revoke|run)/i;
const TEXT_MAX = 3000;
const NAME_MAX = 80;
export const PAGES = { overview: '#/', pipelines: '#/quy-trinh', channels: '#/channels' };

let refs = new Map(); // ref → phần tử của lần đọc gần nhất

const squash = (s, max = NAME_MAX) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Phần tử đang thấy được và không bị inert/ẩn.
function visible(el) {
  if (!el.getClientRects().length || el.closest('[inert],[aria-hidden="true"]')) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

// Tên dễ đọc của phần tử: aria-label → nhãn → chữ bên trong → placeholder/title.
function nameOf(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return squash(aria);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    if (t.trim()) return squash(t);
  }
  if (el.labels?.length) {
    const lab = el.labels[0];
    const own = lab.querySelector('.fld-l');
    return squash((own || lab).textContent);
  }
  const lab = el.closest('label');
  if (lab && lab !== el) {
    const own = lab.querySelector('.fld-l');
    if (own) return squash(own.textContent);
  }
  const txt = squash(el.innerText || el.textContent);
  return txt || squash(el.getAttribute('placeholder') || el.getAttribute('title') || '');
}

function roleOf(el) {
  const r = el.getAttribute('role');
  if (r) return r;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'input') return `input ${el.type || 'text'}`;
  return tag;
}

// Một dòng mô tả phần tử cho AI.
function describe(el, ref) {
  const role = roleOf(el);
  let line = `[${ref}] ${role} "${nameOf(el)}"`;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' checked' : ' unchecked';
    else if (el.type !== 'password') line += ` value=${JSON.stringify(squash(el.value, 200))}`;
    if (el.min !== '' && el.max !== '' && el.min != null) line += ` (${el.min}–${el.max})`;
    if (el.getAttribute('aria-invalid') === 'true') line += ' invalid';
  }
  const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
  if (checked === 'true') line += ' selected';
  if (el.getAttribute('aria-expanded') === 'true') line += ' expanded';
  if (role === 'link') {
    const h = el.getAttribute('href') || '';
    if (h.startsWith('#')) line += ` → ${h}`;
  }
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
  if (el.closest('[data-ai="block"]')) line += ' (bị chặn — người dùng tự bấm)';
  return line;
}

// Vùng đọc: hộp thoại trên cùng (kèm danh sách chọn đang mở) nếu có, không thì cả trang; luôn bỏ sidebar trợ lý.
function scopes() {
  const dialogs = [...document.querySelectorAll('[role=dialog][aria-modal=true]')].filter((d) => !d.closest(PANEL) && visible(d));
  const lists = [...document.querySelectorAll('[role=listbox]')].filter((l) => !l.closest(PANEL) && visible(l));
  if (dialogs.length) return { roots: [dialogs[dialogs.length - 1], ...lists], dialog: dialogs[dialogs.length - 1] };
  return { roots: [document.body], dialog: null };
}

// Chỉ dẫn của các vùng đang thấy (data-ai-help) trong phạm vi đọc → dòng "- tiêu đề: nội dung".
function hintsIn(roots) {
  const ids = [];
  for (const root of roots) {
    const els = [...(root.matches?.('[data-ai-help]') ? [root] : []), ...root.querySelectorAll('[data-ai-help]')];
    for (const el of els) {
      const id = el.getAttribute('data-ai-help');
      if (!HINTS[id] || ids.includes(id) || el.closest(PANEL) || !visible(el)) continue;
      ids.push(id);
    }
  }
  return ids.map((id) => `- ${hint(id).title}: ${hint(id).text}`);
}

// Đọc trang → văn bản gọn (đường dẫn, tiêu đề, hộp thoại, nội dung, phần tử có ref).
export function snapshot() {
  refs = new Map();
  for (const el of document.querySelectorAll('[data-ai-ref]')) el.removeAttribute('data-ai-ref');
  const { roots, dialog } = scopes();
  const lines = [`Trang: ${location.hash || '#/'} · ${document.title}`];
  if (dialog) lines.push(`Hộp thoại đang mở: "${squash(dialog.querySelector('h2')?.textContent || '')}" (chỉ thao tác được trong hộp này)`);
  const seen = new Set();
  const items = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll(INTERACTIVE)) {
      if (seen.has(el) || el.closest(PANEL) || !visible(el)) continue;
      // nút/ô nằm trong phần tử tương tác khác (vd. option chứa svg) → chỉ giữ ngoài cùng
      if (el.parentElement?.closest(INTERACTIVE) && el.parentElement.closest(INTERACTIVE) !== el && !el.matches('input,textarea')) {
        const outer = el.parentElement.closest(INTERACTIVE);
        if (outer.closest(PANEL) == null && !outer.matches('label')) continue;
      }
      seen.add(el);
      items.push(el);
    }
  }
  const hints = hintsIn(roots);
  if (hints.length) lines.push('Cách dùng màn này:', ...hints);
  const text = squash(roots.map((r) => (r === document.body ? textOutsidePanel() : r.innerText)).join('\n'), TEXT_MAX);
  lines.push(`Nội dung: ${text}`);
  const toasts = squash(document.querySelector('.toasts')?.innerText || '', 300);
  if (toasts) lines.push(`Thông báo: ${toasts}`);
  lines.push('Phần tử:');
  items.forEach((el, i) => {
    const ref = i + 1;
    refs.set(ref, el);
    el.setAttribute('data-ai-ref', String(ref));
    lines.push(describe(el, ref));
  });
  if (!items.length) lines.push('(không có)');
  return lines.join('\n');
}

function textOutsidePanel() {
  const parts = [];
  for (const el of document.body.children) {
    if (el.matches(`${PANEL},script,style,.toasts`)) continue;
    parts.push(el.innerText || '');
  }
  return parts.join('\n');
}

// Mức nhạy cảm của thao tác: 'block' | 'confirm' | null.
export function sensitivity(el, action = 'click') {
  if (el.closest('[data-ai="block"]')) return 'block';
  if (action === 'fill' && el.type === 'password') return 'block';
  if (el.closest('[data-ai="confirm"]')) return 'confirm';
  if (action === 'click' && CONFIRM_RE.test(nameOf(el))) return 'confirm';
  return null;
}

function flash(el) {
  el.classList.add('ai-hl');
  setTimeout(() => el.classList.remove('ai-hl'), 1200);
}

// Gán giá trị kiểu React: dùng setter gốc của prototype rồi phát sự kiện input/change.
function setValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Chờ React vẽ lại rồi đọc trang.
async function settle(prefix) {
  await frame();
  await sleep(350);
  return `${prefix}\n\n${snapshot()}`;
}

const fail = (text, label = null) => ({ text, isError: true, label });

// Chạy 1 lệnh tool {tool, args}; confirm(desc) → Promise<boolean> khi cần người dùng cho phép.
// Trả {text, isError, label} (label = dòng ngắn hiện trong chat).
export async function runTool({ tool, args = {} }, { confirm }) {
  if (tool === 'read_page') return { text: snapshot(), isError: false, label: null };
  if (tool === 'navigate') {
    const hash = PAGES[args.page];
    if (!hash) return fail('Trang không hợp lệ (overview, pipelines, channels).');
    if (document.querySelector('[role=dialog][aria-modal=true]')) return fail('Đang có hộp thoại mở — đóng hộp thoại trước (nút Đóng/Hủy).');
    location.hash = hash;
    const label = { overview: tr('Tổng quan'), pipelines: tr('Quy trình'), channels: tr('Kênh') }[args.page];
    return { text: await settle(`Đã chuyển tới ${label}.`), isError: false, label: tr('Mở trang {p}', { p: label }) };
  }
  if (tool !== 'click' && tool !== 'fill') return fail(`Không có tool ${tool}.`);
  const el = refs.get(Number(args.ref));
  if (!el || !el.isConnected || !visible(el)) return fail(`Không còn phần tử [${args.ref}] — gọi read_page để lấy ref mới.`);
  const name = nameOf(el) || roleOf(el);
  const level = sensitivity(el, tool);
  if (level === 'block') {
    return fail(`"${name}" bị chặn với trợ lý (tốn tiền hoặc bí mật). Nhờ người dùng tự làm.`, tr('Bị chặn: "{n}"', { n: name }));
  }
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return fail(`"${name}" đang bị khóa (disabled).`);
  const desc = tool === 'click' ? tr('Bấm "{n}"', { n: name }) : tr('Gõ "{v}" vào "{n}"', { v: squash(args.value, 60), n: name });
  if (level === 'confirm') {
    const ok = await confirm(desc);
    if (!ok) return fail(`Người dùng không cho phép: ${desc}. Dừng lại và hỏi người dùng muốn làm gì.`, tr('Không cho phép: {d}', { d: desc }));
    if (!el.isConnected) return fail('Trang đã đổi trong lúc chờ — gọi read_page lại.');
  }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  flash(el);
  if (tool === 'click') {
    el.click();
    return { text: await settle(`Đã bấm "${name}".`), isError: false, label: tr('Đã bấm "{n}"', { n: name }) };
  }
  if (!(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') || el.type === 'checkbox' || el.type === 'radio') {
    return fail(`"${name}" không phải ô nhập — dùng click.`);
  }
  if (el.readOnly) return fail(`"${name}" chỉ đọc.`);
  el.focus();
  setValue(el, String(args.value ?? ''));
  return { text: await settle(`Đã gõ vào "${name}".`), isError: false, label: tr('Đã nhập "{v}" vào "{n}"', { v: squash(args.value, 40), n: name }) };
}
