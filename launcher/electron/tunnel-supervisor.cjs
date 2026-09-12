'use strict';

const { redactAndBound } = require('./runtime-client.cjs');
const { validateConnectorName, validateTunnelSetup } = require('./connector-identity.cjs');

const MANAGED_RUNTIME_URL = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}\/mcp$/;
const MAX_DIAGNOSTIC_BYTES = 4_096;

/**
 * Owns one OpenAI Tunnel adapter for the one managed runtime. The adapter is
 * injected so this boundary never shells out to an unverified tunnel command
 * or lets renderer input choose an executable or target.
 */
function createTunnelSupervisor(options) {
  if (!options || typeof options.getActiveRuntimeUrl !== 'function' ||
      typeof options.runTunnel !== 'function' || typeof options.stopTunnel !== 'function' ||
      typeof options.checkHealth !== 'function') {
    throw new TypeError('Tunnel supervisor requires managed runtime and tunnel adapters');
  }

  let credentials = null;
  let connectorName = null;
  let owned = null;
  let failureMessage;
  let state = 'stopped';
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const next = operationQueue.then(operation, operation);
    operationQueue = next.catch(() => undefined);
    return next;
  }

  function status() {
    return Object.freeze({
      state,
      connectorName,
      configured: credentials !== null,
      paired: state === 'running',
      ...(failureMessage ? { message: failureMessage } : {}),
    });
  }

  async function configure(value) {
    return enqueue(async () => {
      const setup = validateTunnelSetup(value, connectorName ?? undefined);
      try {
        if (owned) await stopOwnedTunnel();
        credentials = Object.freeze({ tunnelId: setup.tunnelId, runtimeKey: setup.runtimeKey });
        connectorName = setup.connectorName;
        failureMessage = undefined;
        state = 'stopped';
        return status();
      } catch (error) {
        failureMessage = redactKnownCredentials(error instanceof Error ? error.message : 'Tunnel setup failed');
        state = 'error';
        throw new Error(failureMessage);
      }
    });
  }

  async function restoreOrConnect(request) {
    return enqueue(async () => {
      const target = requireManagedActiveRuntime(request?.runtimeUrl);
      const requestedName = validateConnectorName(request?.connectorName);
      if (!credentials) throw new Error('Configure the OpenAI Tunnel before connecting');
      if (connectorName && connectorName !== requestedName) {
        throw new Error('Connector name must remain stable while the Tunnel is configured');
      }

      if (owned && await isHealthy(owned, target)) {
        state = 'running';
        failureMessage = undefined;
        return status();
      }

      state = 'starting';
      failureMessage = undefined;
      try {
        if (owned) await stopOwnedTunnel();
        const runRequest = {
          target,
          connectorName: requestedName,
          credentials: { ...credentials },
        };
        for (const field of ['healthPort', 'mcpToken', 'proxyUrl']) {
          if (request && Object.hasOwn(request, field)) runRequest[field] = request[field];
        }
        const nextOwned = await options.runTunnel(runRequest);
        if (!nextOwned || typeof nextOwned !== 'object') {
          throw new Error('Tunnel adapter did not return owned runtime state');
        }
        owned = nextOwned;
        if (!await isHealthy(owned, target)) {
          await stopOwnedTunnel();
          throw new Error('Tunnel did not become healthy for the managed runtime');
        }
        connectorName = requestedName;
        state = 'running';
        return status();
      } catch (error) {
        failureMessage = redactKnownCredentials(error instanceof Error ? error.message : 'Tunnel connection failed');
        state = 'error';
        throw new Error(failureMessage);
      }
    });
  }

  async function stop() {
    return enqueue(async () => {
      if (!owned) {
        state = 'stopped';
        failureMessage = undefined;
        return status();
      }
      state = 'stopping';
      try {
        await stopOwnedTunnel();
        failureMessage = undefined;
        state = 'stopped';
        return status();
      } catch (error) {
        failureMessage = redactKnownCredentials(error instanceof Error ? error.message : 'Tunnel stop failed');
        state = 'error';
        throw new Error(failureMessage);
      }
    });
  }

  /** Remove an unpaired setup from memory after a failed pairing attempt. */
  async function discardConfiguration() {
    return enqueue(async () => {
      const discardedCredentials = credentials;
      credentials = null;
      connectorName = null;
      failureMessage = undefined;
      if (!owned) {
        state = 'stopped';
        return status();
      }
      state = 'stopping';
      try {
        await stopOwnedTunnel();
        state = 'stopped';
        return status();
      } catch (error) {
        // The in-memory setup is discarded before cleanup, but a failed owned
        // stop can still repeat its key. Keep that private redaction context
        // until the error has been made safe for status/snapshot publication.
        failureMessage = redactKnownCredentials(
          error instanceof Error ? error.message : 'Tunnel discard failed',
          discardedCredentials,
        );
        state = 'error';
        throw new Error(failureMessage);
      }
    });
  }

  function requireManagedActiveRuntime(candidate) {
    const active = options.getActiveRuntimeUrl();
    if (typeof candidate !== 'string' || typeof active !== 'string' ||
        !MANAGED_RUNTIME_URL.test(candidate) || !MANAGED_RUNTIME_URL.test(active) || candidate !== active) {
      throw new Error('Tunnel target must be the managed active runtime');
    }
    return active;
  }

  async function isHealthy(currentOwned, target) {
    try {
      return await options.checkHealth(currentOwned, target) === true;
    } catch {
      return false;
    }
  }

  async function stopOwnedTunnel() {
    const currentOwned = owned;
    if (!currentOwned) return;
    await options.stopTunnel(currentOwned);
    if (owned === currentOwned) owned = null;
  }

  function redactKnownCredentials(value, knownCredentials = credentials) {
    let source = typeof value === 'string' ? value : 'Invalid tunnel diagnostic';
    if (knownCredentials) {
      source = source.split(knownCredentials.tunnelId).join('[REDACTED]');
      source = source.split(knownCredentials.runtimeKey).join('[REDACTED]');
    }
    return redactTunnelLog(source);
  }

  return Object.freeze({ configure, discardConfiguration, restoreOrConnect, status, stop });
}

/** Redact credentials before a tunnel diagnostic can be logged or rendered. */
function redactTunnelLog(value, maximumBytes = MAX_DIAGNOSTIC_BYTES) {
  const source = typeof value === 'string' ? value : 'Invalid tunnel diagnostic';
  const redacted = source
    .replace(/tunnel_[a-f0-9]{32}/gi, '[REDACTED]')
    .replace(/\b(runtime_?key|api_?key|key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(["'])(runtime_?key|api_?key|key|token|secret|password)\1\s*:\s*(["'])[^"']*\3/gi, '$1$2$1:[REDACTED]')
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/\bbearer\s+[A-Za-z0-9._~-]{8,}\b/gi, 'Bearer [REDACTED]');
  return redactAndBound(redacted, maximumBytes);
}

module.exports = { createTunnelSupervisor, redactTunnelLog };
