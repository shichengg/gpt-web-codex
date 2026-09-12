'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');

const DEFAULT_HEALTH_PORT = 18081;

function buildTunnelArgs({ target, healthPort = DEFAULT_HEALTH_PORT, credentials, logFile, proxyUrl }) {
  if (typeof target !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}\/mcp$/.test(target)) {
    throw new TypeError('Tunnel target must be a managed loopback MCP URL');
  }
  if (!credentials || typeof credentials.tunnelId !== 'string' || typeof credentials.runtimeKey !== 'string') {
    throw new TypeError('Tunnel credentials are required');
  }
  if (!Number.isInteger(healthPort) || healthPort < 1024 || healthPort > 65535) {
    throw new TypeError('Tunnel health port must be bounded');
  }
  if (typeof logFile !== 'string' || !path.isAbsolute(logFile)) throw new TypeError('Tunnel log path must be absolute');
  const args = [
    'run',
    '--control-plane.tunnel-id', credentials.tunnelId,
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--health.listen-addr', `127.0.0.1:${healthPort}`,
    '--mcp.server-url', `url=${target},channel=main`,
    '--mcp.extra-headers', 'Authorization: env:MCP_RUNTIME_HEADER_VALUE',
    '--mcp.discovery-extra-headers', 'Authorization: env:MCP_RUNTIME_HEADER_VALUE',
    '--log.file', logFile,
  ];
  if (proxyUrl) args.push('--control-plane.http-proxy', String(proxyUrl));
  return args;
}

function canConnect(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function createPackagedTunnelAdapter(options = {}) {
  const executablePath = options.executablePath;
  const exists = options.exists ?? ((filePath) => fs.existsSync(filePath));
  const spawn = options.spawn ?? spawnChild;
  const checkHealth = options.checkHealth ?? ((port, timeoutMs) => canConnect(port, timeoutMs));
  const stopProcess = options.stopProcess ?? ((child) => stopOwnedProcess(child));
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 500;

  async function runTunnel({ target, healthPort = DEFAULT_HEALTH_PORT, connectorName, credentials, mcpToken, proxyUrl }) {
    if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) || !exists(executablePath)) {
      throw new Error('Packaged OpenAI Tunnel client is missing or unavailable');
    }
    const logFile = options.logFile ?? path.join(path.dirname(executablePath), 'tunnel.log');
    // The client opens --log.file itself. Ensure a fresh installation has a
    // writable private parent directory before the child process starts.
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const args = buildTunnelArgs({ target, healthPort, credentials, logFile, proxyUrl });
    const env = {
      ...process.env,
      CONTROL_PLANE_API_KEY: credentials.runtimeKey,
      MCP_RUNTIME_HEADER_VALUE: `Bearer ${mcpToken || credentials.runtimeKey}`,
    };
    const child = spawn(executablePath, args, {
      cwd: path.dirname(executablePath), shell: false, windowsHide: true,
      detached: false, stdio: 'ignore', env,
    });
    if (!child || typeof child.pid !== 'number') throw new Error('OpenAI Tunnel client failed to start');
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await checkHealth(healthPort, healthTimeoutMs)) {
        return Object.freeze({ child, pid: child.pid, connectorName, healthPort });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await stopProcess(child);
    throw new Error('OpenAI Tunnel client did not become healthy');
  }

  async function stopTunnel(owned) {
    if (owned?.child) await stopProcess(owned.child);
  }

  async function checkTunnelHealth(owned) {
    return Boolean(owned?.healthPort && await checkHealth(owned.healthPort, healthTimeoutMs));
  }

  return Object.freeze({ runTunnel, stopTunnel, checkHealth: checkTunnelHealth });
}

function stopOwnedProcess(child) {
  if (!child || typeof child.pid !== 'number') return Promise.resolve();
  if (process.platform !== 'win32') {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawnChild('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    killer.once('exit', () => resolve());
    killer.once('error', () => resolve());
  });
}

module.exports = { DEFAULT_HEALTH_PORT, buildTunnelArgs, createPackagedTunnelAdapter };
