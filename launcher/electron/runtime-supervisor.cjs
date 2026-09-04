'use strict';

const { randomUUID } = require('node:crypto');
const { spawn: spawnChild } = require('node:child_process');
const path = require('node:path');
const { redactAndBound } = require('./runtime-client.cjs');

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORWARDED_TOOLS = new Set(['codex_cancel', 'codex_status', 'codex_output']);
const READY_URL = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}\/mcp$/;

/**
 * Owns the one local core process. The renderer never receives its URL or
 * bearer token, and only the RuntimeClient's fixed activity tools can cross
 * this boundary.
 */
function createRuntimeSupervisor(options) {
  if (!options || typeof options.appDataPath !== 'string' || typeof options.runtimeEntry !== 'string') {
    throw new TypeError('Runtime supervisor requires private app data and a fixed runtime entrypoint');
  }
  const spawn = options.spawn ?? spawnChild;
  const request = options.request ?? requestRuntimeTool;
  const tokenFactory = options.tokenFactory ?? randomUUID;
  const readyTimeoutMs = positiveInteger(options.readyTimeoutMs, 15_000, 1_000, 60_000, 'readyTimeoutMs');
  const stopGraceMs = positiveInteger(options.stopGraceMs, 5_000, 10, 30_000, 'stopGraceMs');
  const forceStopTimeoutMs = positiveInteger(options.forceStopTimeoutMs, 5_000, 10, 30_000, 'forceStopTimeoutMs');
  const maxLogBytes = positiveInteger(options.maxLogBytes, 4_096, 128, 16_384, 'maxLogBytes');
  const maxLogs = positiveInteger(options.maxLogs, 64, 1, 128, 'maxLogs');
  let child;
  let active;
  let currentToken;
  let state = 'stopped';
  let stopping;
  let startQueue = Promise.resolve();
  const logs = [];
  const logListeners = new Set();

  function status() {
    return Object.freeze({ state, workspace: active?.profile.workspaceRoot ?? null });
  }

  function appendLog(entry) {
    const source = typeof entry === 'string' ? entry : 'Invalid runtime activity entry';
    const safe = redactAndBound(redactRuntimeToken(source, currentToken), maxLogBytes);
    logs.unshift(safe);
    if (logs.length > maxLogs) logs.length = maxLogs;
    for (const listener of logListeners) listener(safe);
  }

  function start(profile, mcpRegistryPath) {
    // Serialize starts, so two renderer requests cannot briefly own two
    // runtime processes. stop remains immediate so it can cancel a startup.
    const next = startQueue.then(
      () => startRuntime(profile, mcpRegistryPath),
      () => startRuntime(profile, mcpRegistryPath),
    );
    startQueue = next.catch(() => undefined);
    return next;
  }

  async function startRuntime(profile, mcpRegistryPath) {
    validateStart(profile, mcpRegistryPath);
    if (state === 'running' && active?.profile.id === profile.id) return status();
    if (state !== 'stopped') await stop();

    state = 'starting';
    const token = tokenFactory();
    if (typeof token !== 'string' || token.length < 16) throw new Error('Runtime token factory returned an invalid token');
    currentToken = token;
    const stateDir = path.join(options.appDataPath, 'runtime-state', profile.id);
    const nextChild = spawn(process.execPath, [options.runtimeEntry], {
      cwd: path.dirname(options.runtimeEntry),
      shell: false,
      windowsHide: true,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CODEX_HOST: '127.0.0.1',
        CODEX_PORT: '0',
        CODEX_WORKSPACE_ROOT: profile.workspaceRoot,
        CODEX_SKILLS_ROOT: profile.skillsRoot,
        CODEX_STATE_DIR: stateDir,
        CODEX_MCP_REGISTRY: mcpRegistryPath,
        CODEX_CONNECTOR_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = nextChild;
    try {
      const url = await waitForReady(nextChild, readyTimeoutMs, appendLog);
      active = { profile: { ...profile }, token, url };
      state = 'running';
      // Read child activity only in the main process. appendLog redacts and
      // byte-bounds it before subscribers (and therefore IPC) can see it.
      nextChild.stdout.on('data', (chunk) => appendLog(chunk.toString('utf8')));
      nextChild.stderr.on('data', (chunk) => appendLog(chunk.toString('utf8')));
      nextChild.once('exit', (code) => {
        if (child !== nextChild) return;
        child = undefined;
        active = undefined;
        currentToken = undefined;
        state = 'stopped';
        if (code !== 0 && code !== null) appendLog(`Runtime process exited with code ${code}`);
      });
      return status();
    } catch (error) {
      state = 'error';
      appendLog(error instanceof Error ? error.message : 'Runtime startup failed');
      await terminate(nextChild, stopGraceMs, forceStopTimeoutMs, appendLog);
      if (child === nextChild) child = undefined;
      active = undefined;
      currentToken = undefined;
      state = 'stopped';
      throw error;
    }
  }

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!child) {
        active = undefined;
        state = 'stopped';
        return status();
      }
      state = 'stopping';
      const owned = child;
      await terminate(owned, stopGraceMs, forceStopTimeoutMs, appendLog);
      if (child === owned) child = undefined;
      active = undefined;
      currentToken = undefined;
      state = 'stopped';
      return status();
    })();
    try {
      return await stopping;
    } finally {
      stopping = undefined;
    }
  }

  function restart(profile, mcpRegistryPath) {
    const next = startQueue.then(
      () => restartRuntime(profile, mcpRegistryPath),
      () => restartRuntime(profile, mcpRegistryPath),
    );
    startQueue = next.catch(() => undefined);
    return next;
  }

  async function restartRuntime(profile, mcpRegistryPath) {
    if (state !== 'running') return status();
    await stop();
    return startRuntime(profile, mcpRegistryPath);
  }

  async function call(tool, input) {
    if (tool === 'runtime_snapshot') return status();
    if (tool === 'runtime_logs') return { entries: [...logs] };
    if (!FORWARDED_TOOLS.has(tool)) throw new Error('Only fixed runtime tool calls are allowed');
    if (state !== 'running' || !active) throw new Error('Runtime is not running');
    return request(active.url, active.token, tool, input);
  }

  function subscribeLogs(listener) {
    if (typeof listener !== 'function') throw new TypeError('Runtime log listener must be a function');
    logListeners.add(listener);
    return () => logListeners.delete(listener);
  }

  return Object.freeze({ call, restart, start, status, stop, subscribeLogs });
}

function validateStart(profile, mcpRegistryPath) {
  if (!profile || typeof profile.id !== 'string' || !PROFILE_ID.test(profile.id) ||
      typeof profile.workspaceRoot !== 'string' || typeof profile.skillsRoot !== 'string' ||
      typeof mcpRegistryPath !== 'string' || !path.isAbsolute(mcpRegistryPath)) {
    throw new TypeError('Runtime supervisor requires a validated profile and private registry path');
  }
}

function positiveInteger(value, fallback, minimum, maximum, name) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) throw new TypeError(`${name} must be bounded`);
  return selected;
}

async function waitForReady(child, timeoutMs, appendLog) {
  if (!child.stdout || !child.stderr) throw new Error('Runtime child does not expose stdio');
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Runtime did not report readiness in time')), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? '';
      for (const line of lines) {
        const ready = parseReady(line);
        if (ready) return finish(undefined, ready);
        if (line) appendLog(line);
      }
    };
    const onError = (error) => finish(error instanceof Error ? error : new Error('Runtime child failed'));
    const onExit = (code) => finish(new Error(`Runtime exited before readiness (${code ?? 'unknown'})`));
    const onStderr = (chunk) => appendLog(chunk.toString('utf8'));
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const finish = (error, url) => {
      cleanup();
      if (error) reject(error);
      else resolve(url);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function parseReady(line) {
  try {
    const record = JSON.parse(line);
    return record?.type === 'runtime-ready' && typeof record.url === 'string' && READY_URL.test(record.url) ? record.url : undefined;
  } catch {
    return undefined;
  }
}

async function terminate(child, graceMs, forceStopTimeoutMs, appendLog) {
  if (hasExited(child)) return;
  const exit = observeExit(child);
  try {
    sendSignal(child, 'SIGTERM');
    if (await exit.wait(graceMs)) return;

    appendLog('Runtime process did not exit after cancellation; forcing termination');
    sendSignal(child, 'SIGKILL');
    if (await exit.wait(forceStopTimeoutMs)) return;
    throw new Error('Runtime process did not exit after forced termination');
  } finally {
    exit.dispose();
  }
}

function hasExited(child) {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
}

function sendSignal(child, signal) {
  try {
    child.kill(signal);
  } catch (error) {
    if (!hasExited(child)) throw error;
  }
}

function observeExit(child) {
  let exited = hasExited(child);
  let resolveWait;
  const onExit = () => {
    exited = true;
    if (resolveWait) resolveWait(true);
  };
  child.once('exit', onExit);
  return Object.freeze({
    wait: (timeoutMs) => exited
      ? Promise.resolve(true)
      : new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolveWait = undefined;
          resolve(exited);
        }, timeoutMs);
        resolveWait = (value) => {
          clearTimeout(timer);
          resolveWait = undefined;
          resolve(value);
        };
      }),
    dispose: () => child.removeListener('exit', onExit),
  });
}

function redactRuntimeToken(value, token) {
  if (!token) return value;
  return value.split(token).join('[REDACTED]');
}

async function requestRuntimeTool(url, token, tool, input) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: tool, arguments: input } }),
  });
  if (!response.ok) throw new Error('Runtime tool request failed');
  const body = await response.json();
  const result = body?.result;
  if (!result || result.isError) throw new Error('Runtime tool request was rejected');
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  throw new Error('Runtime tool response was invalid');
}

module.exports = { createRuntimeSupervisor };
