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
  const maxReadyBytes = positiveInteger(options.maxReadyBytes, 8_192, 64, 65_536, 'maxReadyBytes');
  const stopGraceMs = positiveInteger(options.stopGraceMs, 5_000, 10, 30_000, 'stopGraceMs');
  const forceStopTimeoutMs = positiveInteger(options.forceStopTimeoutMs, 5_000, 10, 30_000, 'forceStopTimeoutMs');
  const maxLogBytes = positiveInteger(options.maxLogBytes, 4_096, 128, 16_384, 'maxLogBytes');
  const maxLogs = positiveInteger(options.maxLogs, 64, 1, 128, 'maxLogs');
  const platform = options.platform ?? process.platform;
  const spawnTaskkill = options.spawnTaskkill ?? spawnChild;
  const forceTerminate = options.forceTerminate ?? ((owned) => terminateProcessTree(owned, platform, spawnTaskkill));
  let child;
  let active;
  let currentToken;
  let failureMessage;
  let childOutput;
  let streamListeners;
  let state = 'stopped';
  let operationQueue = Promise.resolve();
  const logs = [];
  const logListeners = new Set();

  function status() {
    return Object.freeze({
      state,
      workspace: active?.profile.workspaceRoot ?? null,
      ...(failureMessage ? { message: failureMessage } : {}),
    });
  }

  function appendLog(entry, token = currentToken) {
    const source = typeof entry === 'string' ? entry : 'Invalid runtime activity entry';
    const safe = redactAndBound(redactRuntimeToken(source, token), maxLogBytes);
    logs.unshift(safe);
    if (logs.length > maxLogs) logs.length = maxLogs;
    for (const listener of logListeners) listener(safe);
  }

  function enqueue(operation) {
    const next = operationQueue.then(operation, operation);
    operationQueue = next.catch(() => undefined);
    return next;
  }

  function start(profile, mcpRegistryPath) {
    return enqueue(() => startRuntime(profile, mcpRegistryPath));
  }

  async function startRuntime(profile, mcpRegistryPath) {
    validateStart(profile, mcpRegistryPath);
    if (state === 'running' && active?.profile.id === profile.id) return status();
    if (state !== 'stopped') await stopRuntime();

    state = 'starting';
    failureMessage = undefined;
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
    childOutput = createChildOutput(token, appendLog);
    // A starting child already owns this profile. This makes snapshots reflect
    // the process that exists, not whichever profile was selected most recently.
    active = { profile: { ...profile }, token, url: undefined };
    try {
      const url = await waitForReady(nextChild, readyTimeoutMs, maxReadyBytes, childOutput);
      active.url = url;
      state = 'running';
      attachRuntimeListeners(nextChild, token);
      return status();
    } catch (error) {
      const cause = error instanceof Error ? error.message : 'Runtime startup failed';
      recordFailure(cause, token);
      try {
        await terminate(nextChild, stopGraceMs, forceStopTimeoutMs, appendLog, forceTerminate);
      } catch (stopError) {
        recordFailure(stopError instanceof Error ? stopError.message : 'Runtime startup cleanup failed', token);
        // The child may still be live after a failed forced shutdown. Retain
        // its token, profile, and output ownership so a later stop can retry
        // termination and Electron cannot quit while it is orphaned.
        if (hasExited(nextChild)) {
          disposeRuntimeStreams(nextChild);
          if (child === nextChild) child = undefined;
          active = undefined;
          currentToken = undefined;
        } else {
          attachRuntimeListeners(nextChild, token);
        }
        state = 'error';
        throw error;
      }
      disposeRuntimeStreams(nextChild);
      if (child === nextChild) child = undefined;
      active = undefined;
      currentToken = undefined;
      state = 'error';
      throw error;
    }
  }

  function stop() {
    return enqueue(stopRuntime);
  }

  async function stopRuntime() {
    if (!child) {
      active = undefined;
      currentToken = undefined;
      failureMessage = undefined;
      state = 'stopped';
      return status();
    }
    state = 'stopping';
    const owned = child;
    try {
      await terminate(owned, stopGraceMs, forceStopTimeoutMs, appendLog, forceTerminate);
    } catch (error) {
      recordFailure(error instanceof Error ? error.message : 'Runtime stop failed', currentToken);
      state = 'error';
      throw error;
    }
    disposeRuntimeStreams(owned);
    if (child === owned) child = undefined;
    active = undefined;
    currentToken = undefined;
    failureMessage = undefined;
    state = 'stopped';
    return status();
  }

  function restart(profile, mcpRegistryPath) {
    return enqueue(() => restartRuntime(profile, mcpRegistryPath));
  }

  async function restartRuntime(profile, mcpRegistryPath) {
    if (state !== 'running') return status();
    await stopRuntime();
    return startRuntime(profile, mcpRegistryPath);
  }

  function attachRuntimeListeners(nextChild, token) {
    const onStdout = (chunk) => childOutput?.write(chunk);
    const onStderr = (chunk) => childOutput?.write(chunk);
    const onExit = (code, signal) => {
      if (child !== nextChild) return;
      disposeRuntimeStreams(nextChild);
      if (state === 'stopping') return;
      child = undefined;
      active = undefined;
      if (state === 'error') {
        currentToken = undefined;
        return;
      }
      if ((code !== 0 && code !== null) || signal) {
        recordFailure(`Runtime process exited unexpectedly (${signal ?? `code ${code}`})`, token);
        state = 'error';
      } else {
        state = 'stopped';
      }
      currentToken = undefined;
    };
    const onError = (error) => {
      if (child !== nextChild || state === 'stopping') return;
      recordFailure(error instanceof Error ? error.message : 'Runtime child emitted an error', token);
      state = 'error';
    };
    streamListeners = { nextChild, onStdout, onStderr, onExit, onError };
    nextChild.stdout.on('data', onStdout);
    nextChild.stderr.on('data', onStderr);
    nextChild.once('exit', onExit);
    nextChild.once('error', onError);
  }

  function disposeRuntimeStreams(nextChild) {
    if (streamListeners?.nextChild === nextChild) {
      nextChild.stdout.removeListener('data', streamListeners.onStdout);
      nextChild.stderr.removeListener('data', streamListeners.onStderr);
      nextChild.removeListener('exit', streamListeners.onExit);
      nextChild.removeListener('error', streamListeners.onError);
      streamListeners = undefined;
    }
    if (child === nextChild && childOutput) {
      childOutput.close();
      childOutput = undefined;
    }
  }

  function recordFailure(cause, token) {
    failureMessage = redactAndBound(redactRuntimeToken(String(cause), token), maxLogBytes);
    appendLog(failureMessage, token);
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

async function waitForReady(child, timeoutMs, maxReadyBytes, logSink) {
  if (!child.stdout || !child.stderr) throw new Error('Runtime child does not expose stdio');
  return new Promise((resolve, reject) => {
    let pendingReady = '';
    const timer = setTimeout(() => finish(new Error('Runtime did not report readiness in time')), timeoutMs);
    const onData = (chunk) => {
      if (Buffer.isBuffer(chunk) && chunk.length > maxReadyBytes) {
        return finish(new Error('Runtime readiness output exceeded its bound'));
      }
      const text = chunk.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > maxReadyBytes) {
        return finish(new Error('Runtime readiness output exceeded its bound'));
      }
      pendingReady += text;
      if (Buffer.byteLength(pendingReady, 'utf8') > maxReadyBytes) {
        return finish(new Error('Runtime readiness output exceeded its bound'));
      }
      const lines = pendingReady.split(/\r?\n/);
      pendingReady = lines.pop() ?? '';
      for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') > maxReadyBytes) {
          return finish(new Error('Runtime readiness output exceeded its bound'));
        }
        const ready = parseReady(line);
        if (ready) return finish(undefined, ready);
        if (line) logSink.write(`${line}\n`);
      }
    };
    const onError = (error) => finish(error instanceof Error ? error : new Error('Runtime child failed'));
    const onExit = (code) => finish(new Error(`Runtime exited before readiness (${code ?? 'unknown'})`));
    const onStderr = (chunk) => logSink.write(chunk);
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

async function terminate(child, graceMs, forceStopTimeoutMs, appendLog, forceTerminate) {
  if (hasExited(child)) return;
  const exit = observeExit(child);
  try {
    sendSignal(child, 'SIGTERM');
    if (await exit.wait(graceMs)) return;

    appendLog('Runtime process did not exit after cancellation; forcing termination');
    await forceTerminate(child);
    if (await exit.wait(forceStopTimeoutMs)) return;
    throw new Error('Runtime process did not exit after forced termination');
  } finally {
    exit.dispose();
  }
}

function createChildOutput(token, appendLog) {
  let pending = '';
  let closed = false;
  const secret = token;

  function write(chunk) {
    if (closed) return;
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const keep = trailingSecretPrefixLength(pending, secret);
    const complete = pending.slice(0, pending.length - keep);
    pending = pending.slice(pending.length - keep);
    if (complete) appendLog(complete, secret);
  }

  function close() {
    if (closed) return;
    closed = true;
    // `pending` is always a suffix that could become a token on the next
    // chunk. At EOF there is no next chunk to disambiguate it, so never emit
    // this raw prefix to logs or IPC subscribers.
    if (pending) appendLog('[REDACTED]', secret);
    pending = '';
  }

  return Object.freeze({ close, write });
}

function trailingSecretPrefixLength(value, secret) {
  const maximum = Math.min(value.length, secret.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(secret.slice(0, length))) return length;
  }
  return 0;
}

async function terminateProcessTree(child, platform, spawnTaskkill) {
  if (platform !== 'win32' || !Number.isInteger(child.pid) || child.pid <= 0) {
    sendSignal(child, 'SIGKILL');
    return;
  }
  await new Promise((resolve, reject) => {
    let taskkill;
    try {
      taskkill = spawnTaskkill('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    taskkill.once('error', reject);
    taskkill.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Windows process-tree termination failed'));
    });
  });
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
