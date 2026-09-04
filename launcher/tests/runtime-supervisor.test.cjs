'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const { createRuntimeSupervisor } = require('../electron/runtime-supervisor.cjs');
const { stopRuntimeBeforeQuit } = require('../electron/main.cjs');

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

test('keeps the managed runtime URL out of status while allowing main-process tunnel ownership', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');

  assert.equal(supervisor.getActiveRuntimeUrl(), 'http://127.0.0.1:48999/mcp');
  assert.equal(JSON.stringify(supervisor.status()).includes('48999'), false);
  await supervisor.stop();
});

test('never emits token fragments split across chunks and ignores stream data after exit', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });
  const logs = [];
  supervisor.subscribeLogs((entry) => logs.push(entry));

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  child.stderr.emit('data', Buffer.from('prefix private-token-'));
  child.stderr.emit('data', Buffer.from('123456 suffix'));
  child.emit('exit', 0);
  child.stderr.emit('data', Buffer.from('private-token-123456 after exit'));

  assert.equal(logs.some((entry) => /private-token-|123456/.test(entry)), false);
  assert.equal(logs.join('\n').includes('private-token-123456'), false);
});

test('drops a trailing partial token when an output stream closes', async () => {
  const child = fakeChild();
  const token = 'private-token-123456';
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => token,
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });
  const logs = [];
  supervisor.subscribeLogs((entry) => logs.push(entry));

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  child.stderr.emit('data', Buffer.from(token.slice(0, -1)));
  child.emit('exit', 0);

  assert.equal(logs.some((entry) => entry.includes(token.slice(0, -1))), false);
});

test('owns Windows descendants with a fixed taskkill process-tree command', async () => {
  const child = delayedChild();
  child.pid = 4242;
  const taskkillCalls = [];
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    platform: 'win32', stopGraceMs: 10,
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
    spawnTaskkill(command, args, options) {
      taskkillCalls.push({ command, args, options });
      const taskkill = new EventEmitter();
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0);
        taskkill.emit('exit', 0);
      });
      return taskkill;
    },
  });

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  await supervisor.stop();

  assert.deepEqual(taskkillCalls, [{
    command: 'taskkill', args: ['/pid', '4242', '/t', '/f'], options: { shell: false, stdio: 'ignore', windowsHide: true },
  }]);
});

test('keeps an unexpected child exit as an error with a secret-free cause', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  child.emit('exit', 7);

  assert.equal(supervisor.status().state, 'error');
  assert.match(supervisor.status().message, /exited unexpectedly/i);
  assert.equal(JSON.stringify(supervisor.status()).includes('private-token-123456'), false);
});

test('emits a safe runtime-unavailable lifecycle event when the child crashes', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });
  const lifecycle = [];
  supervisor.subscribeLifecycle((event) => lifecycle.push(event));

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  child.emit('exit', 7);

  assert.deepEqual(lifecycle, [{
    type: 'runtime-unavailable',
    snapshot: {
      state: 'error',
      workspace: null,
      message: 'Runtime process exited unexpectedly (code 7)',
    },
  }]);
  assert.equal(JSON.stringify(lifecycle).includes('48999'), false);
  assert.equal(JSON.stringify(lifecycle).includes('private-token-123456'), false);
});

test('keeps an unexpected child error as a bounded secret-free runtime failure', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456', maxLogBytes: 128,
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
  });

  await supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json');
  child.emit('error', new Error(`runtime private-token-123456 ${'界'.repeat(1_000)}`));

  assert.equal(supervisor.status().state, 'error');
  assert.equal(Buffer.byteLength(supervisor.status().message, 'utf8') <= 128, true);
  assert.equal(supervisor.status().message.includes('private-token-123456'), false);
  await supervisor.stop();
});

test('rejects oversized readiness output without retaining an unbounded buffer', async () => {
  const child = fakeChild();
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456', maxReadyBytes: 64,
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('x'.repeat(65))));
      return child;
    },
  });

  await assert.rejects(
    () => supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json'),
    /readiness output exceeded/i,
  );
  assert.equal(supervisor.status().state, 'error');
});

test('retains a failed startup child so stop failure blocks launcher quit', async () => {
  const child = delayedChild();
  child.pid = 4242;
  const supervisor = createRuntimeSupervisor({
    appDataPath: 'C:\\private', runtimeEntry: 'C:\\app\\dist\\index.js', tokenFactory: () => 'private-token-123456',
    platform: 'win32', maxReadyBytes: 64, stopGraceMs: 10, forceStopTimeoutMs: 10,
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('x'.repeat(65))));
      return child;
    },
    spawnTaskkill() {
      const taskkill = new EventEmitter();
      queueMicrotask(() => taskkill.emit('exit', 1));
      return taskkill;
    },
  });

  await assert.rejects(
    () => supervisor.start({ id: 'one', workspaceRoot: 'C:\\workspace', skillsRoot: 'C:\\workspace\\.codex\\skills' }, 'C:\\private\\one.json'),
    /readiness output exceeded/i,
  );
  assert.deepEqual(supervisor.status().workspace, 'C:\\workspace');
  await assert.rejects(() => supervisor.stop(), /process-tree termination failed/i);

  let quitCalls = 0;
  assert.equal(await stopRuntimeBeforeQuit(supervisor, () => { quitCalls += 1; }), false);
  assert.equal(quitCalls, 0);
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
  await Promise.resolve();
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
