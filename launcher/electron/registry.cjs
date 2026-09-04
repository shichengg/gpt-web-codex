'use strict';

const { createJsonStateStore } = require('./state.cjs');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVER_FIELDS = new Set(['id', 'command', 'args', 'allowedTools', 'timeoutMs']);
const MAX_SERVERS = 32;
const MAX_ARGS = 64;
const MAX_TOOLS = 128;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * Validate the only MCP configuration the launcher accepts: named local stdio
 * processes with an explicit allowlist. This intentionally has no URL or
 * transport option, so a renderer draft cannot opt into a remote endpoint.
 */
function validateRegistryDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
      Object.keys(draft).length !== 1 || !Object.hasOwn(draft, 'servers') ||
      !Array.isArray(draft.servers) || draft.servers.length > MAX_SERVERS) {
    throw new TypeError('MCP registry draft must contain a bounded servers list');
  }

  const ids = new Set();
  const servers = draft.servers.map((server) => validateServer(server, ids));
  return Object.freeze({ servers: Object.freeze(servers) });
}

function validateServer(server, ids) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw new TypeError('MCP registry server must be an object');
  }
  if (Object.keys(server).some((key) => !SERVER_FIELDS.has(key))) {
    throw new TypeError('MCP registry accepts local stdio fields only');
  }
  if (typeof server.id !== 'string' || !IDENTIFIER.test(server.id)) {
    throw new TypeError('MCP registry server ID must be a bounded identifier');
  }
  if (typeof server.command !== 'string' || !isBoundedText(server.command, 512)) {
    throw new TypeError('MCP registry server command must be a bounded local stdio command');
  }
  if (!Array.isArray(server.args) || server.args.length > MAX_ARGS ||
      !server.args.every((arg) => typeof arg === 'string' && isBoundedText(arg, 1_024))) {
    throw new TypeError('MCP registry server arguments must be a bounded string list');
  }
  if (!Array.isArray(server.allowedTools) || server.allowedTools.length === 0 || server.allowedTools.length > MAX_TOOLS ||
      new Set(server.allowedTools).size !== server.allowedTools.length) {
    throw new TypeError('MCP registry server allowed tools must be a unique bounded list');
  }
  if (server.allowedTools.some((tool) => typeof tool === 'string' && tool.includes('*'))) {
    throw new TypeError('MCP allowedTools must not contain wildcards');
  }
  if (!server.allowedTools.every((tool) => typeof tool === 'string' && IDENTIFIER.test(tool))) {
    throw new TypeError('MCP registry server allowed tools must be valid identifiers');
  }
  if (!Number.isInteger(server.timeoutMs) || server.timeoutMs < MIN_TIMEOUT_MS || server.timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`MCP registry server timeout must be ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} ms`);
  }
  if (ids.has(server.id)) {
    throw new TypeError(`Duplicate MCP server id: ${server.id}`);
  }
  ids.add(server.id);
  return Object.freeze({
    id: server.id,
    command: server.command,
    args: Object.freeze([...server.args]),
    allowedTools: Object.freeze([...server.allowedTools]),
    timeoutMs: server.timeoutMs,
  });
}

function isBoundedText(value, maximumLength) {
  return value.trim().length > 0 && value.length <= maximumLength && !value.includes('\0');
}

/** A private, atomic registry file for exactly one already-selected profile. */
function createRegistryStore(filePath) {
  const state = createJsonStateStore(filePath);
  const empty = Object.freeze({ servers: Object.freeze([]) });
  return Object.freeze({
    async load() {
      const registry = await state.read(empty, validateRegistryDraft);
      return copyRegistry(registry);
    },
    async save(draft) {
      const registry = validateRegistryDraft(draft);
      await state.write(registry);
      return copyRegistry(registry);
    },
  });
}

function copyRegistry(registry) {
  return {
    servers: registry.servers.map((server) => ({
      id: server.id,
      command: server.command,
      args: [...server.args],
      allowedTools: [...server.allowedTools],
      timeoutMs: server.timeoutMs,
    })),
  };
}

module.exports = {
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  createRegistryStore,
  validateRegistryDraft,
};
