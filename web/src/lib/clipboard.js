// Chép chữ vào clipboard: thử navigator.clipboard, không được thì dùng textarea + execCommand.

// Trả true nếu chép được.
export async function copyText(text) {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    /* rơi xuống cách dự phòng */
  }
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, s.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
