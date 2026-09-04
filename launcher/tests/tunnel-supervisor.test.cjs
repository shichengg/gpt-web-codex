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

test('stops the paired tunnel and publishes a safe snapshot when the owned runtime crashes', async (t) => {
  const { EventEmitter } = require('node:events');
  const { createRuntimeSupervisor } = require('../electron/runtime-supervisor.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-runtime-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  const mcpRoot = path.join(workspaceRoot, '.codex', 'mcp');
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.mkdir(mcpRoot, { recursive: true });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('exit', 0);
  const runtime = createRuntimeSupervisor({
    appDataPath: root,
    runtimeEntry: path.join(root, 'runtime.cjs'),
    tokenFactory: () => 'private-runtime-token-123456',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(`{"type":"runtime-ready","url":"${runtimeUrl}"}\n`)));
      return child;
    },
  });
  let resolveTunnelStop;
  const tunnelStopped = new Promise((resolve) => { resolveTunnelStop = resolve; });
  const tunnel = {
    state: 'stopped',
    async configure() {},
    async restoreOrConnect() { this.state = 'running'; },
    async stop() { this.state = 'stopped'; resolveTunnelStop(); },
    status() { return { state: this.state, configured: true, paired: this.state === 'running' }; },
  };
  const identity = {
    credentials: () => ({ ...credentials }),
    name: () => connectorName,
    snapshot: () => ({ connectorName, configured: true }),
  };
  const published = [];
  let resolveUnavailableSnapshot;
  const unavailableSnapshot = new Promise((resolve) => { resolveUnavailableSnapshot = resolve; });
  const controller = await createProfileController({
    userDataPath: root,
    shell: { openPath: async () => '' },
    runtimeSupervisor: runtime,
    tunnelSupervisor: tunnel,
    connectorIdentity: identity,
    publishSnapshot: (snapshot) => {
      published.push(snapshot);
      if (snapshot.state === 'error' && snapshot.tunnelState === 'stopped') resolveUnavailableSnapshot();
    },
  });
  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot, enabledSkillIds: [] });
  await controller.setActiveProfile('one');
  await controller.start();

  child.emit('exit', 7);
  await Promise.race([
    Promise.all([tunnelStopped, unavailableSnapshot]),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Tunnel did not stop after runtime crash')), 250)),
  ]);

  const snapshot = published.at(-1);
  assert.deepEqual(snapshot, {
    state: 'error',
    workspace: null,
    message: 'Runtime process exited unexpectedly (code 7)',
    tunnelState: 'stopped',
    tunnelConfigured: true,
    paired: false,
    connectorName,
  });
  assert.equal(JSON.stringify(published).includes(credentials.runtimeKey), false);
  assert.equal(JSON.stringify(published).includes('private-runtime-token-123456'), false);
});

test('does not persist or retain a newly entered setup when pairing fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-setup-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { createConnectorIdentity } = require('../electron/connector-identity.cjs');
  const identity = await createConnectorIdentity(path.join(root, 'connector.json'));
  const calls = [];
  const tunnel = {
    configured: false,
    async configure(value) { this.configured = true; calls.push(['configure', value]); },
    async restoreOrConnect() { calls.push(['connect']); throw new Error('Tunnel pairing failed'); },
    async discardConfiguration() { this.configured = false; calls.push(['discard']); },
    status() { return { state: this.configured ? 'error' : 'stopped', configured: this.configured, paired: false }; },
  };
  const runtime = {
    getActiveRuntimeUrl: () => runtimeUrl,
    call: async () => ({ state: 'running', workspace: null }),
    subscribeLogs: () => () => {},
  };
  const published = [];
  const controller = await createProfileController({
    userDataPath: root,
    shell: { openPath: async () => '' },
    runtimeSupervisor: runtime,
    tunnelSupervisor: tunnel,
    connectorIdentity: identity,
    publishSnapshot: (snapshot) => published.push(snapshot),
  });

  await assert.rejects(() => controller.setupTunnel(credentials), /pairing failed/i);

  assert.equal(identity.credentials(), null);
  assert.deepEqual(identity.snapshot(), { connectorName, configured: false });
  assert.deepEqual(calls, [
    ['configure', credentials],
    ['connect'],
    ['discard'],
  ]);
  assert.equal(tunnel.configured, false);
  assert.deepEqual(published.at(-1), {
    state: 'running',
    workspace: null,
    tunnelState: 'stopped',
    tunnelConfigured: false,
    paired: false,
    connectorName,
  });
  const saved = await fs.readFile(path.join(root, 'connector.json'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  assert.equal(saved.includes(credentials.runtimeKey), false);
  assert.equal(saved.includes(credentials.tunnelId), false);
});

test('redacts a transient runtime key when identity persistence fails and Tunnel cleanup also fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-identity-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transientCredentials = {
    tunnelId: `tunnel_${'b'.repeat(32)}`,
    runtimeKey: 'transient-runtime-key-that-must-be-redacted',
  };
  const tunnel = createTunnelSupervisor({
    getActiveRuntimeUrl: () => runtimeUrl,
    runTunnel: async () => ({ alias: 'transient-pairing' }),
    checkHealth: async () => true,
    stopTunnel: async () => {
      throw new Error(`Tunnel cleanup failed: ${transientCredentials.runtimeKey}`);
    },
  });
  const identity = {
    credentials: () => null,
    name: () => connectorName,
    snapshot: () => ({ connectorName, configured: false }),
    configure: async () => { throw new Error('Connector identity persistence failed'); },
  };
  const runtime = {
    getActiveRuntimeUrl: () => runtimeUrl,
    call: async () => ({ state: 'running', workspace: null }),
    subscribeLogs: () => () => {},
  };
  const published = [];
  const controller = await createProfileController({
    userDataPath: root,
    shell: { openPath: async () => '' },
    runtimeSupervisor: runtime,
    tunnelSupervisor: tunnel,
    connectorIdentity: identity,
    publishSnapshot: (snapshot) => published.push(snapshot),
  });

  await assert.rejects(() => controller.setupTunnel(transientCredentials), /identity persistence failed/i);

  const finalSnapshot = published.at(-1);
  assert.equal(JSON.stringify(tunnel.status()).includes(transientCredentials.runtimeKey), false);
  assert.equal(JSON.stringify(finalSnapshot).includes(transientCredentials.runtimeKey), false);
  assert.equal(finalSnapshot.tunnelState, 'error');
  assert.equal(finalSnapshot.tunnelMessage?.includes('[REDACTED]'), true);
});
