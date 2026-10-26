import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxiedOrigin } from '../web/dev-proxy.js';

const TARGET = 'http://127.0.0.1:4317';

test('proxy dev: chỉ đổi Origin của chính trang Vite, Origin lạ giữ nguyên (server trả 403)', () => {
  assert.equal(proxiedOrigin({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }, TARGET), TARGET);
  assert.equal(proxiedOrigin({ host: 'localhost:5173', origin: 'http://localhost:5173' }, TARGET), TARGET);
  for (const origin of ['http://localhost:8767', 'https://evil.example', 'http://127.0.0.1:5174', 'https://127.0.0.1:5173', 'null']) {
    assert.equal(proxiedOrigin({ host: '127.0.0.1:5173', origin }, TARGET), null, origin);
  }
  assert.equal(proxiedOrigin({ host: '127.0.0.1:5173' }, TARGET), null);
  assert.equal(proxiedOrigin({}, TARGET), null);
});

test('vite.config: dev server không mở CORS, chỉ nghe 127.0.0.1', async () => {
  const { default: cfg } = await import('../web/vite.config.js');
  assert.equal(cfg.server.cors, false);
  assert.equal(cfg.server.host, '127.0.0.1');
});
