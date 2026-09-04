'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const { createRuntimeSupervisor } = require('../electron/runtime-supervisor.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('exit', 0);
  return child;
}

function delayedChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal === 'SIGKILL') {
      child.exitCode = 0;
      child.emit('exit', 0);
    }
  };
  return child;
}

test('supervisor starts one controlled local runtime and permits only fixed activity tools', async () => {
  const calls = [];
  const spawned = [];
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private',
    runtimeEntry: 'C:\\app\\dist\\index.js',
    spawn(command, args, options) {
      spawned.push({ command, args, options });
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
    request: async (url, token, tool, input) => {
      calls.push({ url, token, tool, input });
      return { id: input.taskId, state: 'cancelled' };
    },
    tokenFactory: () => 'private-token-123456',
  });
  const profile = { id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' };

  await supervisor.start(profile, 'C:\\private\\mcp-registries\\one.json');
  await supervisor.call('codex_cancel', { taskId: 'task-1' });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.deepEqual(spawned[0].args, ['C:\\app\\dist\\index.js']);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.env.CODEX_WORKSPACE_ROOT, profile.workspaceRoot);
  assert.equal(spawned[0].options.env.CODEX_MCP_REGISTRY, 'C:\\private\\mcp-registries\\one.json');
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:48999/mcp', token: 'private-token-123456', tool: 'codex_cancel', input: { taskId: 'task-1' },
  }]);
  await assert.rejects(() => supervisor.call('call_mcp_tool', {}), /fixed runtime tool/i);
  await supervisor.stop();
});

test('uses Electron-as-Node with a fixed entrypoint, shell disabled, and an environment allowlist', async () => {
  const child = fakeChild();
  let spawned;
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private',
    runtimeEntry: 'C:\\app\\dist\\index.js',
    tokenFactory: () => 'private-token-123456',
    spawn(command, args, options) {
      spawned = { command, args, options };
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });
  const previous = process.env.UNRELATED_LAUNCHER_SECRET;
  process.env.UNRELATED_LAUNCHER_SECRET = 'must-not-reach-runtime';
  try {
    await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  } finally {
    if (previous === undefined) delete process.env.UNRELATED_LAUNCHER_SECRET;
    else process.env.UNRELATED_LAUNCHER_SECRET = previous;
  }

  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.args, ['C:\\app\\dist\\index.js']);
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawned.options.env.CODEX_WORKSPACE_ROOT, 'C:\\workspace');
  assert.equal(spawned.options.env.UNRELATED_LAUNCHER_SECRET, undefined);
  await supervisor.stop();
});

test('redacts the generated connector token from child activity and snapshots', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });
  const received = [];
  supervisor.subscribeLogs((entry) => received.push(entry));

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  child.stderr.emit('data', Buffer.from('runtime echoed private-token-123456'));

  assert.equal(received.join('\n').includes('private-token-123456'), false);
  assert.equal(JSON.stringify(supervisor.status()).includes('private-token-123456'), false);
  await supervisor.stop();
});

test('reports stopped only after the child exits and escalates a delayed stop', async () => {
  const child = delayedChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private',
    runtimeEntry: 'C:\\app\\dist\\index.js',
    tokenFactory: () => 'private-token-123456',
    stopGraceMs: 10,
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  const stopping = supervisor.stop();
  assert.equal(supervisor.status().state, 'stopping');
  const result = await Promise.race([
    stopping.then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
  ]);

  assert.equal(result, 'stopped');
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(supervisor.status().state, 'stopped');
});

test('serializes concurrent profile starts so only one child owns the runtime', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const spawned = [];
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    spawn() {
      const child = spawned.length === 0 ? firstChild : secondChild;
      spawned.push(child);
      if (child === secondChild) {
        queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:49000/mcp"}\n')));
      }
      return child;
    },
  });
  const first = supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace-one', skillsRoot: 'C:\\workspace-one\\.codex\\skills' }, 'C:\\private\\one.json');
  const second = supervisor.start({ id: 'two', workspaceRoot: 'C:\\workspace-two', skillsRoot: 'C:\\workspace-two\\.codex\\skills' }, 'C:\\private\\two.json');

  await Promise.resolve();
  assert.equal(spawned.length, 1);
  firstChild.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n'));
  await first;
  await second;

  assert.equal(spawned.length, 2);
  assert.deepEqual(supervisor.status(), { state: 'running', workspace: 'C:\\workspace-two' });
  await supervisor.stop();
});

test('supervisor redacts and byte-bounds child activity before subscribers receive it', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
    request: async () => ({}),
    maxLogBytes: 128,
  });
  const logs = [];
  supervisor.subscribeLogs((entry) => logs.push(entry));

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  child.stderr.emit('data', Buffer.from(`{"access_token":"private","client_secret":"hidden"} ${'界'.repeat(1_000)}`));

  assert.equal(logs.length, 1);
  assert.equal(Buffer.byteLength(logs[0], 'utf8') <= 128, true);
  assert.match(logs[0], /\[REDACTED\]/);
  assert.equal(logs[0].includes('private') || logs[0].includes('hidden'), false);
  await supervisor.stop();
});
