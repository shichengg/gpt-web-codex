'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { doctor } = require('../electron/doctor.cjs');
const { createTunnelSupervisor } = require('../electron/tunnel-supervisor.cjs');

const runtimeUrl = 'http://127.0.0.1:48765/mcp';
const credentials = {
  tunnelId: `tunnel_${'a'.repeat(32)}`,
  runtimeKey: 'runtime-key-that-must-stay-private',
};

test('unavailable Tunnel adapter leaves no owned route and diagnostics stay explicit', async () => {
  let stops = 0;
  const tunnel = createTunnelSupervisor({
    getActiveRuntimeUrl: () => runtimeUrl,
    runTunnel: async () => { throw new Error(`No compatible client for ${credentials.runtimeKey}`); },
    checkHealth: async () => false,
    stopTunnel: async () => { stops += 1; },
  });

  await tunnel.configure(credentials);
  await assert.rejects(
    () => tunnel.restoreOrConnect({ runtimeUrl, connectorName: 'GPT Web Codex' }),
    /compatible client/i,
  );
  await tunnel.stop();

  const report = await doctor({
    which: async () => 'codex',
    tunnelAvailable: false,
    tunnelStatus: () => tunnel.status(),
  });
  assert.equal(stops, 0);
  assert.deepEqual(tunnel.status(), {
    state: 'stopped', connectorName: 'GPT Web Codex', configured: true, paired: false,
  });
  assert.match(report.checks.find((check) => check.id === 'tunnel').message, /unavailable/i);
  assert.equal(JSON.stringify({ report, status: tunnel.status() }).includes(credentials.runtimeKey), false);
});
