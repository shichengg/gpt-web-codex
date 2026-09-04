'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { doctor } = require('../electron/doctor.cjs');

test('doctor reports unavailable Codex and redacts every diagnostic secret', async () => {
  const secret = 'CODEX_CONNECTOR_TOKEN=private-connector-token-123456';
  const report = await doctor({
    which: async () => null,
    runtimeStatus: () => ({ state: 'error', message: `runtime_key=private-runtime-key ${secret}` }),
    getActiveProfile: async () => ({ id: 'workspace', apiToken: 'private-profile-token' }),
    tunnelStatus: () => ({ state: 'error', message: `password=private-tunnel-password ${secret}` }),
    connectorSnapshot: () => ({ configured: true, runtimeKey: 'private-identity-key' }),
    tunnelAvailable: false,
  });

  assert.deepEqual(report.checks.map((check) => check.id), ['codex', 'runtime', 'profile', 'tunnel', 'connector']);
  assert.deepEqual(report.checks.find((check) => check.id === 'codex'), {
    id: 'codex',
    status: 'error',
    message: 'Codex CLI was not found on PATH.',
  });
  assert.deepEqual(report.checks.find((check) => check.id === 'tunnel'), {
    id: 'tunnel',
    status: 'warning',
    message: 'OpenAI Tunnel client is unavailable in this launcher build.',
  });
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'CODEX_CONNECTOR_TOKEN',
    'private-connector-token-123456',
    'private-runtime-key',
    'private-profile-token',
    'private-tunnel-password',
    'private-identity-key',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must be redacted`);
  }
});

test('doctor reports configured local dependencies without returning their raw state', async () => {
  const report = await doctor({
    which: async () => 'C:\\Program Files\\Codex\\codex.exe',
    runtimeStatus: () => ({ state: 'running', token: 'never-returned' }),
    getActiveProfile: async () => ({ id: 'workspace', runtimeKey: 'never-returned' }),
    tunnelStatus: () => ({ state: 'running', configured: true, paired: true, runtimeKey: 'never-returned' }),
    connectorSnapshot: () => ({ configured: true, runtimeKey: 'never-returned' }),
    tunnelAvailable: true,
  });

  assert.deepEqual(report.checks, [
    { id: 'codex', status: 'ok', message: 'Codex CLI is available.' },
    { id: 'runtime', status: 'ok', message: 'Managed local runtime is running.' },
    { id: 'profile', status: 'ok', message: 'An active workspace profile is configured.' },
    { id: 'tunnel', status: 'ok', message: 'OpenAI Tunnel client is available and paired.' },
    { id: 'connector', status: 'ok', message: 'Connector identity is configured.' },
  ]);
  assert.equal(JSON.stringify(report).includes('never-returned'), false);
});
