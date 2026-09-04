'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { RuntimeClient } = require('../electron/runtime-client.cjs');

function createFakeRuntime() {
  return {
    calls: [],
    async call(tool, input) {
      this.calls.push([tool, input]);
      if (tool === 'codex_status') return { id: input.taskId, state: 'running', error: 'access_token=private client_secret=hidden' };
      if (tool === 'codex_output') return { id: input.taskId, output: `{"access_token":"private","client_secret":"hidden"} ${'界'.repeat(8_000)}`, outputTruncated: false };
      if (tool === 'runtime_snapshot') return { state: 'running', connectorToken: 'private' };
      if (tool === 'runtime_logs') return { entries: [`{"password":"private","access_token":"hidden"} ${'界'.repeat(8_000)}`] };
      return { id: input.taskId, state: 'cancelled' };
    },
  };
}

test('cancels activity through fixed runtime tool', async () => {
  const fake = createFakeRuntime();
  const client = new RuntimeClient(fake);

  await client.cancel('task-1');

  assert.deepEqual(fake.calls, [['codex_cancel', { taskId: 'task-1' }]]);
});

test('returns only bounded redacted runtime activity', async () => {
  const fake = createFakeRuntime();
  const client = new RuntimeClient(fake, { maxTextLength: 128, maxLogEntries: 2 });

  const [snapshot, task, logs] = await Promise.all([
    client.snapshot(), client.task('task-1'), client.logs(),
  ]);

  assert.deepEqual(snapshot, { state: 'running' });
  assert.equal(task.id, 'task-1');
  assert.equal(task.state, 'running');
  assert.match(task.error, /\[REDACTED\]/);
  assert.equal(Buffer.byteLength(task.output, 'utf8') <= 128, true);
  assert.match(task.output, /\[REDACTED\]/);
  assert.equal(logs.length, 1);
  assert.equal(Buffer.byteLength(logs[0], 'utf8') <= 128, true);
  assert.match(logs[0], /\[REDACTED\]/);
  assert.equal(JSON.stringify({ snapshot, task, logs }).includes('private'), false);
  assert.equal(JSON.stringify({ snapshot, task, logs }).includes('hidden'), false);
});
