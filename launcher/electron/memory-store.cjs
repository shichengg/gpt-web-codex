'use strict';

const { randomUUID } = require('node:crypto');
const { createJsonStateStore } = require('./state.cjs');

const MAX_ENTRIES = 100;
const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 10_000;
const SCOPES = new Set(['global', 'workspace']);
const SENSITIVE_VALUE = /(?:openai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|runtime[_-]?key|client[_-]?secret|password|cookie)\s*(?:=|:)/i;
const BEARER_VALUE = /authorization\s*:\s*bearer\s+\S+|\bbearer\s+[a-z0-9._-]{16,}/i;

function validateMemoryEntry(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Memory entry must be an object');
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  const scope = value.scope;
  if (!title || !content || !SCOPES.has(scope)) throw new TypeError('Memory entry has an invalid title, content, or scope');
  if (title.length > MAX_TITLE_LENGTH || content.length > MAX_CONTENT_LENGTH) throw new RangeError('Memory entry exceeds its size limit');
  if (SENSITIVE_VALUE.test(content) || BEARER_VALUE.test(content)) {
    throw new TypeError('Memory entries cannot contain sensitive credentials');
  }
  const id = typeof value.id === 'string' && /^[a-f0-9-]{36}$/i.test(value.id) ? value.id : options.id ?? randomUUID();
  const createdAt = typeof value.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value.createdAt)
    ? value.createdAt
    : options.createdAt ?? new Date().toISOString();
  return Object.freeze({ id, title, content, scope, createdAt });
}

function validateEntries(value) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new TypeError('Invalid memory collection');
  const entries = value.map((entry) => validateMemoryEntry(entry));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new TypeError('Memory IDs must be unique');
  return entries;
}

function createMemoryStore(filePath) {
  const state = createJsonStateStore(filePath);
  const load = async () => validateEntries(await state.read([], validateEntries));
  async function save(entries) {
    const validated = validateEntries(entries);
    await state.write(validated);
    return validated;
  }
  return Object.freeze({
    list: load,
    add: async (draft) => {
      const entries = await load();
      if (entries.length >= MAX_ENTRIES) throw new RangeError('Memory entry limit reached');
      const entry = validateMemoryEntry(draft);
      await save([entry, ...entries]);
      return entry;
    },
    remove: async (id) => {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new TypeError('Invalid memory ID');
      const entries = await load();
      const next = entries.filter((entry) => entry.id !== id);
      await save(next);
      return next.length !== entries.length;
    },
    exportEntries: load,
    importEntries: async (entries) => {
      const validated = validateEntries(entries);
      await save(validated);
      return validated;
    },
  });
}

module.exports = { MAX_CONTENT_LENGTH, MAX_ENTRIES, createMemoryStore, validateMemoryEntry };
