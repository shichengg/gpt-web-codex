'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createConnectorIdentity } = require('../electron/connector-identity.cjs');
const { createProfileController } = require('../electron/main.cjs');
const { createRuntimeSupervisor } = require('../electron/runtime-supervisor.cjs');
const { createTunnelSupervisor } = require('../electron/tunnel-supervisor.cjs');

function readyChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };
  return child;
}

test('runs a profile lifecycle with default Skills, fixed activity calls, and clean ownership release', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-e2e-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  await fs.mkdir(path.join(skillsRoot, 'review'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, '.codex', 'mcp'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review safely.\n---\nInspect the change.\n');

  const spawned = [];
  const activityCalls = [];
  const tunnelCalls = [];
  const child = readyChild();
  const runtime = createRuntimeSupervisor({
    appDataPath: path.join(root, 'private'),
    runtimeEntry: path.join(root, 'core', 'index.js'),
    tokenFactory: () => 'private-runtime-token-123456',
    spawn(command, args, options) {
      spawned.push({ command, args, options });
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"runtime-ready","url":"http://127.0.0.1:48999/mcp"}\n')));
      return child;
    },
    request: async (_url, _token, tool, input) => {
      activityCalls.push([tool, input]);
      if (tool === 'codex_status') return { id: input.taskId, state: 'running' };
      if (tool === 'codex_output') return { id: input.taskId, output: 'working', outputTruncated: false };
      return { id: input.taskId, state: 'cancelled' };
    },
  });
  const credentials = {
    tunnelId: `tunnel_${'a'.repeat(32)}`,
    runtimeKey: 'runtime-key-that-must-remain-private',
  };
  const tunnel = createTunnelSupervisor({
    getActiveRuntimeUrl: () => runtime.getActiveRuntimeUrl(),
    runTunnel: async (configuration) => {
      tunnelCalls.push(['run', configuration]);
      return { alias: 'test-tunnel' };
    },
    checkHealth: async () => true,
    stopTunnel: async (owned) => { tunnelCalls.push(['stop', owned]); },
  });
  const identity = await createConnectorIdentity(path.join(root, 'private', 'connector.json'));
  await identity.configure(credentials);
  const controller = await createProfileController({
    userDataPath: path.join(root, 'private'),
    shell: { openPath: async () => '' },
    runtimeSupervisor: runtime,
    tunnelSupervisor: tunnel,
    connectorIdentity: identity,
  });

  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot, enabledSkillIds: ['review'] });
  await controller.setActiveProfile('one');
  await controller.start();

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.env.CODEX_DEFAULT_SKILL_IDS, '["review"]');
  const taskId = '00000000-0000-0000-0000-000000000001';
  assert.deepEqual(await runtime.call('codex_status', { taskId }), { id: taskId, state: 'running' });
  assert.deepEqual(await runtime.call('codex_output', { taskId }), { id: taskId, output: 'working', outputTruncated: false });
  await controller.cancelTask(taskId);
  assert.deepEqual(activityCalls, [
    ['codex_status', { taskId }],
    ['codex_output', { taskId }],
    ['codex_cancel', { taskId }],
  ]);
  assert.deepEqual(tunnelCalls[0], ['run', {
    target: 'http://127.0.0.1:48999/mcp',
    connectorName: 'GPT Web Codex',
    credentials,
    healthPort: 18081,
    mcpToken: 'private-runtime-token-123456',
  }]);

  await controller.stop();
  assert.equal(runtime.status().state, 'stopped');
  assert.deepEqual(tunnelCalls, [
    tunnelCalls[0],
    ['stop', { alias: 'test-tunnel' }],
  ]);
});
