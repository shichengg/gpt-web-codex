'use strict';

const { createJsonStateStore } = require('./state.cjs');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TOKEN = 4096;

function validateCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.serverId !== 'string' || !ID.test(value.serverId) ||
      typeof value.token !== 'string' || !value.token.trim() ||
      value.token.length > MAX_TOKEN || /[\0\r\n]/.test(value.token)) {
    throw new TypeError('MCP credential is invalid');
  }
  return { serverId: value.serverId, token: value.token.trim() };
}

function createMcpCredentialStore(filePath) {
  const state = createJsonStateStore(filePath);
  const empty = Object.freeze({ credentials: Object.freeze({}) });
  const validate = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !value.credentials || typeof value.credentials !== 'object' || Array.isArray(value.credentials) ||
        Object.keys(value).some((key) => key !== 'credentials') ||
        Object.entries(value.credentials).some(([id, token]) => !ID.test(id) || typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN)) {
      throw new TypeError('MCP credential store is invalid');
    }
  };
  async function read() { return state.read(empty, validate); }
  return Object.freeze({
    async list() {
      const current = await read();
      return Object.keys(current.credentials).map((serverId) => ({ serverId, configured: true }));
    },
    async get(serverId) {
      if (typeof serverId !== 'string' || !ID.test(serverId)) return undefined;
      const current = await read();
      return current.credentials[serverId];
    },
    async save(value) {
      const credential = validateCredential(value);
      const current = await read();
      await state.write({ credentials: { ...current.credentials, [credential.serverId]: credential.token } });
      return { serverId: credential.serverId, configured: true };
    },
    async remove(serverId) {
      if (typeof serverId !== 'string' || !ID.test(serverId)) throw new TypeError('MCP server ID is invalid');
      const current = await read();
      const next = { ...current.credentials };
      delete next[serverId];
      await state.write({ credentials: next });
      return true;
    },
  });
}

module.exports = { createMcpCredentialStore, validateCredential };
