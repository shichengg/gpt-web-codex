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
    'listMcpRegistry',
    'listMcpCredentials',
    'saveMcpCredential',
    'removeMcpCredential',
    'discoverMcpTools',
    'listMemory',
    'saveMemory',
    'removeMemory',
    'setupTunnel',
    'task',
    'cancelTask',
    'doctor',
    'openLogs',
    'preferences',
    'savePreferences',
    'onSnapshot',
    'onLog',
  ]);
});

test('preload forwards preferences only through dedicated IPC channels', async () => {
  const calls = [];
  const api = createPreloadApi({
    invoke: (...args) => { calls.push(args); return Promise.resolve(args[1]); },
    on() {},
    removeListener() {},
  });
  const preferences = {
    language: 'zh-CN', theme: 'system', proxyMode: 'auto', proxyUrl: '',
    startAtLogin: false, autoStartServices: true, keepRunningOnClose: true,
    guideDismissedSteps: [],
  };

  await api.preferences();
  await api.savePreferences(preferences);

  assert.deepEqual(calls, [
    ['launcher:preferences'],
    ['launcher:save-preferences', preferences],
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

test('preload forwards tunnel setup only through its dedicated IPC channel', async () => {
  const calls = [];
  const api = createPreloadApi({
    invoke: (...args) => { calls.push(args); return Promise.resolve({ tunnelConfigured: true }); },
    on() {},
    removeListener() {},
  });
  const credentials = {
    tunnelId: `tunnel_${'a'.repeat(32)}`,
    runtimeKey: 'runtime-key-which-must-remain-private',
  };

  const result = await api.setupTunnel(credentials);

  assert.deepEqual(calls, [['launcher:setup-tunnel', credentials]]);
  assert.deepEqual(result, { tunnelConfigured: true });
});

test('preload forwards task queries only through the fixed task IPC channel', async () => {
  const calls = [];
  const api = createPreloadApi({
    invoke: (...args) => { calls.push(args); return Promise.resolve({ id: 'task-1', state: 'running' }); },
    on() {},
    removeListener() {},
  });

  await api.task('task-1');

  assert.deepEqual(calls, [['launcher:task', 'task-1']]);
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
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'gptWebCodex');
  assert.deepEqual(Object.keys(calls[0][1]), [
    'snapshot', 'start', 'stop', 'selectWorkspace', 'listProfiles', 'saveProfile',
    'setActiveProfile', 'listSkills', 'saveSkills', 'openSkillFolder', 'saveMcpRegistry',
    'listMcpRegistry', 'listMcpCredentials', 'saveMcpCredential', 'removeMcpCredential', 'discoverMcpTools', 'listMemory', 'saveMemory', 'removeMemory',
    'setupTunnel', 'task', 'cancelTask', 'doctor', 'openLogs',
    'preferences', 'savePreferences', 'onSnapshot', 'onLog',
  ]);
  assert.equal(calls[1][0], 'mcpAssistant');
  assert.equal(typeof calls[1][1].snapshot, 'function');
  assert.equal(typeof calls[1][1].listSkills, 'function');
  assert.equal(typeof calls[1][1].listMcpRegistry, 'function');
});

test('preload exposes the reference mcpAssistant bridge with additive Skills and MCP methods', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  assert.match(source, /mcpAssistant/);
  assert.match(source, /workspaceContext/);
  assert.match(source, /inspectBuild/);
  assert.match(source, /listSkills/);
  assert.match(source, /listMcpRegistry/);
});
