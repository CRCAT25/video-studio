// Cấu hình Vite cho giao diện Video Studio (React 19). Build ra web/dist; dev proxy /api, /media sang server.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { proxiedOrigin } from './dev-proxy.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const target = `http://127.0.0.1:${process.env.VS_PORT || 4317}`;
const devToken = process.env.VS_TOKEN || '';

// Server chỉ nhận Origin trùng Host → chỉ đổi Origin của chính trang Vite về địa chỉ server (Origin lạ giữ nguyên → 403);
// giữ SSE chảy thẳng (không gom bộ đệm).
function configure(proxy) {
  proxy.on('proxyReq', (proxyReq, req) => {
    const origin = proxiedOrigin(req.headers, target);
    if (origin) proxyReq.setHeader('origin', origin);
  });
  proxy.on('proxyRes', (proxyRes, req, res) => {
    const type = String(proxyRes.headers['content-type'] || '');
    if (type.startsWith('text/event-stream')) {
      proxyRes.headers['cache-control'] = 'no-cache, no-transform';
      proxyRes.headers['x-accel-buffering'] = 'no';
      req.socket?.setTimeout?.(0);
      req.socket?.setNoDelay?.(true);
      res.socket?.setNoDelay?.(true);
    }
  });
}

const proxyEntry = {
  target,
  changeOrigin: true,
  ws: false,
  configure,
  ...(devToken ? { headers: { 'x-studio-token': devToken } } : {}),
};

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    cors: false, // hợp đồng: --dev không mở CORS
    proxy: {
      '/api': proxyEntry,
      '/media': proxyEntry,
    },
  },
  preview: { host: '127.0.0.1' },
});
