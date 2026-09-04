'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTunnelSupervisor, redactTunnelLog } = require('../electron/tunnel-supervisor.cjs');
const { createProfileController } = require('../electron/main.cjs');

const runtimeUrl = 'http://127.0.0.1:48765/mcp';
const connectorName = 'GPT Web Codex';
const credentials = Object.freeze({
  tunnelId: `tunnel_${'a'.repeat(32)}`,
  runtimeKey: 'runtime-key-which-must-remain-private',
});

function createFixture(overrides = {}) {
  const calls = [];
  let activeRuntimeUrl = runtimeUrl;
  let healthy = false;
  const supervisor = createTunnelSupervisor({
    getActiveRuntimeUrl: () => activeRuntimeUrl,
    runTunnel: async (config) => {
      calls.push(['run', config]);
      healthy = true;
      return { alias: 'gpt-web-codex' };
    },
    checkHealth: async () => healthy,
    stopTunnel: async (owned) => {
      calls.push(['stop', owned]);
      healthy = false;
    },
    ...overrides,
  });
  return {
    calls,
    setActiveRuntimeUrl: (value) => { activeRuntimeUrl = value; },
    setHealthy: (value) => { healthy = value; },
    supervisor,
  };
}

test('forwards only to the managed active runtime', async () => {
  const fixture = createFixture();
  await fixture.supervisor.configure(credentials);

  await fixture.supervisor.restoreOrConnect({ runtimeUrl, connectorName });

  assert.deepEqual(fixture.calls, [[
    'run',
    {
      target: runtimeUrl,
      connectorName,
      credentials: { ...credentials },
    },
  ]]);
  assert.deepEqual(fixture.supervisor.status(), {
    state: 'running',
    connectorName,
    configured: true,
    paired: true,
  });
});

test('rejects a target other than the active managed loopback runtime', async () => {
  const fixture = createFixture();
  await fixture.supervisor.configure(credentials);

  await assert.rejects(
    () => fixture.supervisor.restoreOrConnect({ runtimeUrl: 'http://127.0.0.1:48766/mcp', connectorName }),
    /managed active runtime/i,
  );
  fixture.setActiveRuntimeUrl(undefined);
  await assert.rejects(
    () => fixture.supervisor.restoreOrConnect({ runtimeUrl, connectorName }),
    /managed active runtime/i,
  );
  assert.deepEqual(fixture.calls, []);
});

test('recovers an unhealthy owned tunnel before reconnecting', async () => {
  const fixture = createFixture();
  await fixture.supervisor.configure(credentials);
  await fixture.supervisor.restoreOrConnect({ runtimeUrl, connectorName });
  fixture.setHealthy(false);

  await fixture.supervisor.restoreOrConnect({ runtimeUrl, connectorName });

  assert.equal(fixture.calls.filter(([name]) => name === 'run').length, 2);
  assert.deepEqual(fixture.calls[1], ['stop', { alias: 'gpt-web-codex' }]);
  await fixture.supervisor.stop();
  assert.deepEqual(fixture.supervisor.status(), {
    state: 'stopped',
    connectorName,
    configured: true,
    paired: false,
  });
});

test('redacts tunnel IDs and runtime keys from diagnostics', () => {
  const diagnostic = redactTunnelLog(
    `key=secret runtime_key=other Authorization: Bearer third tunnel_${'a'.repeat(32)}`,
  );

  assert.equal(diagnostic.includes('secret'), false);
  assert.equal(diagnostic.includes('other'), false);
  assert.equal(diagnostic.includes('third'), false);
  assert.equal(diagnostic.includes(`tunnel_${'a'.repeat(32)}`), false);
});

test('does not retain a configured credential when a runner error repeats it verbatim', async () => {
  const fixture = createFixture({
    runTunnel: async ({ credentials: runnerCredentials }) => {
      throw new Error(`Tunnel failed with ${runnerCredentials.tunnelId} ${runnerCredentials.runtimeKey}`);
    },
  });
  await fixture.supervisor.configure(credentials);

  await assert.rejects(
    () => fixture.supervisor.restoreOrConnect({ runtimeUrl, connectorName }),
    (error) => !error.message.includes(credentials.tunnelId) && !error.message.includes(credentials.runtimeKey),
  );
  assert.equal(JSON.stringify(fixture.supervisor.status()).includes(credentials.tunnelId), false);
  assert.equal(JSON.stringify(fixture.supervisor.status()).includes(credentials.runtimeKey), false);
});

test('redacts an unhealthy tunnel stop failure before reconnecting', async () => {
  const fixture = createFixture({
    stopTunnel: async () => {
      throw new Error(`Tunnel shutdown failed for ${credentials.tunnelId} ${credentials.runtimeKey}`);
    },
  });
  await fixture.supervisor.configure(credentials);
  await fixture.supervisor.restoreOrConnect({ runtimeUrl, connectorName });
  fixture.setHealthy(false);

  await assert.rejects(
    () => fixture.supervisor.restoreOrConnect({ runtimeUrl, connectorName }),
    (error) => !error.message.includes(credentials.tunnelId) && !error.message.includes(credentials.runtimeKey),
  );
  assert.equal(JSON.stringify(fixture.supervisor.status()).includes(credentials.tunnelId), false);
  assert.equal(JSON.stringify(fixture.supervisor.status()).includes(credentials.runtimeKey), false);
});

test('starts the runtime before pairing and stops the tunnel before the runtime', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-tunnel-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  const mcpRoot = path.join(workspaceRoot, '.codex', 'mcp');
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.mkdir(mcpRoot, { recursive: true });
  const calls = [];
  const runtime = {
    state: 'stopped',
    async start() { calls.push('runtime-start'); this.state = 'running'; },
    async stop() { calls.push('runtime-stop'); this.state = 'stopped'; },
    async call() { return { state: this.state, workspace: workspaceRoot }; },
    getActiveRuntimeUrl: () => runtimeUrl,
    subscribeLogs: () => () => {},
  };
  const tunnel = {
    state: 'stopped',
    async configure(credentialsForTunnel) { calls.push(['tunnel-configure', credentialsForTunnel]); },
    async restoreOrConnect(request) { calls.push(['tunnel-connect', request]); this.state = 'running'; },
    async stop() { calls.push('tunnel-stop'); this.state = 'stopped'; },
    status() { return { state: this.state, configured: true, paired: this.state === 'running' }; },
  };
  const identity = {
    credentials: () => ({ ...credentials }),
    name: () => connectorName,
    snapshot: () => ({ connectorName, configured: true }),
    async configure() { return this.snapshot(); },
  };
  const controller = await createProfileController({
    userDataPath: root,
    shell: { openPath: async () => '' },
    runtimeSupervisor: runtime,
    tunnelSupervisor: tunnel,
    connectorIdentity: identity,
  });
  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot, enabledSkillIds: [] });
  await controller.setActiveProfile('one');

  const started = await controller.start();

  assert.deepEqual(calls.slice(-2), [
    'runtime-start',
    ['tunnel-connect', { runtimeUrl, connectorName }],
  ]);
  assert.equal(started.tunnelState, 'running');
  assert.equal(started.connectorName, connectorName);
  assert.equal(started.tunnelConfigured, true);
  assert.equal(started.paired, true);
  assert.equal(JSON.stringify(started).includes(credentials.runtimeKey), false);

  await controller.stop();
  assert.deepEqual(calls.slice(-2), ['tunnel-stop', 'runtime-stop']);
});
