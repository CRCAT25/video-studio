// Mục người dùng đang xem/chọn trên trang (vd ảnh trong khung xem lớn) để Trợ lý AI biết "ảnh này" là ảnh nào.
import { useSyncExternalStore } from 'react';

let cur = null; // {kind:'image', projectId, path, name}
const subs = new Set();

export function setFocus(v) {
  cur = v;
  subs.forEach((f) => f());
}
export function clearFocus(match) {
  if (cur && (!match || (cur.path === match.path && cur.projectId === match.projectId))) setFocus(null);
}
export function useFocus() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => cur,
  );
}
