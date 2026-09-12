'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPackagedTunnelAdapter, buildTunnelArgs } = require('../electron/tunnel-client.cjs');

const credentials = { tunnelId: `tunnel_${'a'.repeat(32)}`, runtimeKey: 'runtime-key-that-is-long-enough' };

test('builds a fixed tunnel-client command with credential environment indirection', () => {
  assert.deepEqual(buildTunnelArgs({
    target: 'http://127.0.0.1:18765/mcp',
    healthPort: 18081,
    credentials,
    logFile: 'C:\\logs\\tunnel.log',
    proxyUrl: 'http://127.0.0.1:7890',
  }), [
    'run',
    '--control-plane.tunnel-id', credentials.tunnelId,
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--health.listen-addr', '127.0.0.1:18081',
    '--mcp.server-url', 'url=http://127.0.0.1:18765/mcp,channel=main',
    '--mcp.extra-headers', 'Authorization: env:MCP_RUNTIME_HEADER_VALUE',
    '--mcp.discovery-extra-headers', 'Authorization: env:MCP_RUNTIME_HEADER_VALUE',
    '--log.file', 'C:\\logs\\tunnel.log',
    '--control-plane.http-proxy', 'http://127.0.0.1:7890',
  ]);
});

test('rejects startup when the packaged client is missing', async () => {
  const adapter = createPackagedTunnelAdapter({ executablePath: 'C:\\missing\\tunnel-client.exe' });
  await assert.rejects(
    () => adapter.runTunnel({ target: 'http://127.0.0.1:18765/mcp', healthPort: 18081, credentials }),
    /missing|unavailable/i,
  );
});

test('creates the private Tunnel log directory before spawning the client', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-web-codex-tunnel-log-'));
  const logFile = path.join(directory, 'private', 'logs', 'tunnel.log');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 4242;
  const adapter = createPackagedTunnelAdapter({
    executablePath: process.execPath,
    exists: () => true,
    logFile,
    spawn: () => child,
    checkHealth: async () => true,
  });

  await adapter.runTunnel({
    target: 'http://127.0.0.1:18765/mcp',
    healthPort: 18081,
    credentials,
  });

  assert.equal(fs.existsSync(path.dirname(logFile)), true);
});

test('stops an unhealthy owned process and never exposes the runtime key', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  let killed = false;
  const adapter = createPackagedTunnelAdapter({
    executablePath: process.execPath,
    exists: () => true,
    spawn: () => child,
    checkHealth: async () => false,
    stopProcess: async () => { killed = true; },
    healthTimeoutMs: 1,
    startupTimeoutMs: 2,
  });
  await assert.rejects(
    () => adapter.runTunnel({ target: 'http://127.0.0.1:18765/mcp', healthPort: 18081, credentials }),
    /healthy|ready/i,
  );
  assert.equal(killed, true);
  assert.equal(JSON.stringify(child).includes(credentials.runtimeKey), false);
});
