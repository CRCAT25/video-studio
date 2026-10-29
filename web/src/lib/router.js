// Router hash tối giản: #/ (Tổng quan), #/p/:id/:key (Chi tiết bước), #/quy-trinh (Quy trình), #/channels, #/channels/setup, #/channels/:id, #/skills, #/bo-nao.
import { useEffect, useState } from 'react';

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Phân tích location.hash → {name, params}.
export function parseHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const parts = h.split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) {
    return { name: 'step', params: { id: safeDecode(parts[1]), key: parts[2] ? safeDecode(parts[2]) : null } };
  }
  if (parts[0] === 'quy-trinh' || parts[0] === 'presets') return { name: 'presets', params: {} };
  if (parts[0] === 'tts' && parts.length === 1) return { name: 'tts', params: {} };
  if (parts[0] === 'skills' && parts.length === 1) return { name: 'skills', params: {} };
  if (parts[0] === 'bo-nao' && parts.length === 1) return { name: 'brain', params: {} };
  if (parts[0] === 'channels' && parts[1] === 'setup' && parts.length === 2) return { name: 'channelsSetup', params: {} };
  if (parts[0] === 'channels' && parts.length === 1) return { name: 'channels', params: {} };
  if (parts[0] === 'channels' && parts.length === 2) return { name: 'channel', params: { id: safeDecode(parts[1]) } };
  if (parts.length === 0) return { name: 'overview', params: {} };
  return { name: 'notfound', params: {} };
}

// Hook trả route hiện tại, cập nhật khi hash đổi.
export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// Tạo hash tới Chi tiết bước.
export function stepHref(projectId, key) {
  return `#/p/${encodeURIComponent(projectId)}/${encodeURIComponent(key || '')}`;
}

// Chuyển trang (đổi hash).
export function navigate(hash) {
  if (window.location.hash !== hash) window.location.hash = hash;
}
