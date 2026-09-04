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
