import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RESTART_CODE, restartArgs, shouldSupervise, supervise } from '../server/supervisor.js';

// Tiến trình con giả: ghi lại tham số, tín hiệu nhận được; exit(code) giả lập thoát.
function fakeChild(args, calls) {
  const c = new EventEmitter();
  c.args = args;
  c.exitCode = null;
  c.signalCode = null;
  c.signals = [];
  c.kill = (sig) => c.signals.push(sig);
  c.exit = (code) => {
    c.exitCode = code;
    c.emit('exit', code, null);
  };
  calls.push(c);
  return c;
}

test('restartArgs: bỏ --open, giữ cổng đang dùng', () => {
  assert.deepEqual(restartArgs(['--open', '--model', 'haiku'], 4318), ['--model', 'haiku', '--port', '4318']);
  assert.deepEqual(restartArgs(['--port', '4317', '--no-open'], 4320), ['--port', '4320']);
  assert.deepEqual(restartArgs(['--port=4317', '--dev'], null), ['--dev']);
});

test('shouldSupervise: chỉ lệnh chạy server thường', () => {
  assert.equal(shouldSupervise([], {}), true);
  assert.equal(shouldSupervise(['--open', '--port', '5000'], {}), true);
  for (const a of [['--update'], ['service', 'install'], ['reset-password'], ['--help'], ['-h'], ['--service', '--port', '4318']]) {
    assert.equal(shouldSupervise(a, {}), false, a.join(' '));
  }
  assert.equal(shouldSupervise([], { VS_SUPERVISED: '1' }), false);
  assert.equal(shouldSupervise([], { VS_SUPERVISE: '0' }), false);
});

test('supervise: con thoát 75 → mở lại cùng cổng, không --open; thoát mã khác → trả mã đó', async () => {
  const calls = [];
  const logs = [];
  const signals = new EventEmitter();
  const done = supervise({ argv: ['--open'], spawnChild: (a) => fakeChild(a, calls), log: (s) => logs.push(s), signals });
  assert.deepEqual(calls[0].args, ['--open']);
  calls[0].emit('message', { type: 'listening', port: 4319 });
  calls[0].exit(RESTART_CODE);
  assert.deepEqual(calls[1].args, ['--port', '4319']);
  assert.match(logs[0], /khởi động lại/);
  calls[1].exit(1);
  assert.equal(await done, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('supervise: Ctrl+C chuyển cho con (mỗi lần một tín hiệu), con thoát 75 lúc đang tắt → không mở lại', async () => {
  const calls = [];
  const signals = new EventEmitter();
  const done = supervise({ argv: [], spawnChild: (a) => fakeChild(a, calls), log: () => {}, signals });
  signals.emit('SIGINT', 'SIGINT');
  signals.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(calls[0].signals, ['SIGINT', 'SIGTERM']);
  calls[0].exit(RESTART_CODE);
  await done;
  assert.equal(calls.length, 1);
});
