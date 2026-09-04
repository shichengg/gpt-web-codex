'use strict';

const { createJsonStateStore } = require('./state.cjs');

const DEFAULT_CONNECTOR_NAME = 'GPT Web Codex';
const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/;
const MAX_CONNECTOR_NAME_LENGTH = 80;
const MAX_RUNTIME_KEY_LENGTH = 2_048;
const SETUP_FIELDS = new Set(['runtimeKey', 'tunnelId']);

/**
 * This store is main-process-only. Its public snapshot intentionally contains
 * pairing metadata only; callers must not pass credentials to the renderer.
 */
async function createConnectorIdentity(filePath) {
  const state = createJsonStateStore(filePath);
  let current = validateStoredIdentity(await state.read(emptyIdentity(), validateStoredIdentity));

  function snapshot() {
    return Object.freeze({
      connectorName: current.connectorName,
      configured: current.tunnelId !== null,
    });
  }

  return Object.freeze({
    credentials: () => current.tunnelId === null
      ? null
      : Object.freeze({ tunnelId: current.tunnelId, runtimeKey: current.runtimeKey }),
    configure: async (setup) => {
      const next = validateTunnelSetup(setup, current.connectorName);
      await state.write(next);
      current = next;
      return snapshot();
    },
    name: () => current.connectorName,
    snapshot,
  });
}

function emptyIdentity() {
  return {
    version: 1,
    connectorName: DEFAULT_CONNECTOR_NAME,
    tunnelId: null,
    runtimeKey: null,
  };
}

function validateStoredIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== 1 ||
      Object.keys(value).some((key) => !['version', 'connectorName', 'tunnelId', 'runtimeKey'].includes(key))) {
    throw new TypeError('Connector identity is invalid');
  }
  const connectorName = validateConnectorName(value.connectorName);
  if (connectorName !== DEFAULT_CONNECTOR_NAME) {
    throw new TypeError('Connector identity is invalid');
  }
  if (value.tunnelId === null && value.runtimeKey === null) {
    return Object.freeze({ version: 1, connectorName, tunnelId: null, runtimeKey: null });
  }
  return Object.freeze({
    version: 1,
    connectorName,
    tunnelId: validateTunnelId(value.tunnelId),
    runtimeKey: validateRuntimeKey(value.runtimeKey),
  });
}

function validateTunnelSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !SETUP_FIELDS.has(key))) {
    throw new TypeError('Tunnel setup must contain only connector and credential fields');
  }
  return Object.freeze({
    version: 1,
    connectorName: DEFAULT_CONNECTOR_NAME,
    tunnelId: validateTunnelId(value.tunnelId),
    runtimeKey: validateRuntimeKey(value.runtimeKey),
  });
}

function validateConnectorName(value) {
  if (typeof value !== 'string') throw new TypeError('Connector name is invalid');
  const name = value.trim();
  if (!name || name.length > MAX_CONNECTOR_NAME_LENGTH || /[\0\r\n]/.test(name)) {
    throw new TypeError('Connector name is invalid');
  }
  return name;
}

function validateTunnelId(value) {
  if (typeof value !== 'string' || !TUNNEL_ID.test(value)) {
    throw new TypeError('Tunnel ID is invalid');
  }
  return value;
}

function validateRuntimeKey(value) {
  if (typeof value !== 'string' || value.trim().length < 20 ||
      value.length > MAX_RUNTIME_KEY_LENGTH || /[\0\r\n]/.test(value)) {
    throw new TypeError('Tunnel runtime key is invalid');
  }
  return value.trim();
}

module.exports = {
  DEFAULT_CONNECTOR_NAME,
  createConnectorIdentity,
  validateConnectorName,
  validateTunnelSetup,
};
