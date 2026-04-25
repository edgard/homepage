import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadSupervisorHelpers() {
  const source = fs.readFileSync(new URL('./stream-supervisor.js', import.meta.url), 'utf8');
  const context = {
    console,
    setTimeout,
    clearTimeout,
    window: {},
  };
  context.self = context.window;
  vm.runInNewContext(source, context, { filename: 'stream-supervisor.js' });
  return context.window.KrakowStreamSupervisor;
}

test('retry queue keeps every retry and staggers attach callbacks', () => {
  const { createRetryQueue } = loadSupervisorHelpers();
  const calls = [];
  const timers = [];
  const queue = createRetryQueue({
    intervalMs: 100,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
    attach(video) {
      calls.push(video.id);
    },
  });

  queue.enqueue({ id: 'a' });
  queue.enqueue({ id: 'b' });
  queue.enqueue({ id: 'c' });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 0);

  timers.shift().callback();
  assert.deepEqual(calls, ['a']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 100);

  timers.shift().callback();
  timers.shift().callback();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(timers.length, 0);
});

test('getRetryDelay uses bounded exponential backoff', () => {
  const { getRetryDelay } = loadSupervisorHelpers();

  assert.equal(getRetryDelay(1, { baseMs: 1500, maxMs: 20000 }), 1500);
  assert.equal(getRetryDelay(2, { baseMs: 1500, maxMs: 20000 }), 3000);
  assert.equal(getRetryDelay(99, { baseMs: 1500, maxMs: 20000 }), 20000);
});
