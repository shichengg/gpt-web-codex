const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
    'listProfiles',
    'saveProfile',
    'setActiveProfile',
    'listSkills',
    'saveSkills',
    'openSkillFolder',
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

test('sandboxed preload exposes the bridge while require.main is unavailable', () => {
  const calls = [];
  const fakeIpc = createFakeIpc();
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  const module = { exports: {} };
  const sandboxedRequire = (id) => {
    assert.equal(id, 'electron');
    return {
      contextBridge: {
        exposeInMainWorld: (...args) => calls.push(args),
      },
      ipcRenderer: fakeIpc,
    };
  };

  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: sandboxedRequire,
  }, { filename: 'sandboxed-preload.cjs' });

  assert.equal(sandboxedRequire.main, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'gptWebCodex');
  assert.deepEqual(Object.keys(calls[0][1]), [
    'snapshot', 'start', 'stop', 'selectWorkspace', 'listProfiles', 'saveProfile',
    'setActiveProfile', 'listSkills', 'saveSkills', 'openSkillFolder', 'saveMcpRegistry',
    'cancelTask', 'doctor', 'openLogs', 'onSnapshot', 'onLog',
  ]);
});
