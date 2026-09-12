'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMemoryStore, validateMemoryEntry } = require('../electron/memory-store.cjs');

test('memory store persists bounded entries and removes them by id', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createMemoryStore(path.join(root, 'memory.json'));

  const saved = await store.add({ title: '项目偏好', content: '使用 pnpm test', scope: 'workspace' });
  assert.equal(saved.title, '项目偏好');
  assert.equal((await store.list()).length, 1);
  await store.remove(saved.id);
  assert.deepEqual(await store.list(), []);
});

test('memory validation rejects credentials and oversized content', () => {
  assert.throws(() => validateMemoryEntry({ title: 'key', content: 'OPENAI_API_KEY=secret', scope: 'global' }), /sensitive|credential/i);
  assert.throws(() => validateMemoryEntry({ title: 'large', content: 'x'.repeat(10_001), scope: 'global' }), /size|length/i);
});

test('memory import/export keeps only validated entries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-memory-io-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createMemoryStore(path.join(root, 'memory.json'));
  await store.importEntries([{ title: '安全', content: '只保存本地偏好', scope: 'global' }]);
  const exported = await store.exportEntries();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].content, '只保存本地偏好');
});
