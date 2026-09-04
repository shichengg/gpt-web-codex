const assert = require('node:assert/strict');
const test = require('node:test');

const { createPreloadApi } = require('../electron/preload.cjs');

function createFakeIpc() {
  return {
    invoke() {},
    on() {},
    removeListener() {},
  };
}

test('preload exposes only declared launcher methods', () => {
  const api = createPreloadApi(createFakeIpc());

  assert.deepEqual(Object.keys(api), [
    'snapshot',
    'start',
    'stop',
    'selectWorkspace',
    'saveSkills',
    'saveMcpRegistry',
    'cancelTask',
    'doctor',
    'openLogs',
    'onSnapshot',
    'onLog',
  ]);
});

test('preload subscriptions remove their own listener', () => {
  const listeners = new Map();
  const ipc = {
    invoke() {},
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    removeListener(channel, listener) {
      assert.equal(listeners.get(channel), listener);
      listeners.delete(channel);
    },
  };

  const unsubscribe = createPreloadApi(ipc).onSnapshot(() => {});
  unsubscribe();

  assert.equal(listeners.size, 0);
});
