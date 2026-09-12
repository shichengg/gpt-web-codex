'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMcpCredentialStore } = require('../electron/mcp-credentials.cjs');

test('stores HTTP MCP credentials separately and exposes only configured metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-mcp-credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'credentials.json');
  const store = createMcpCredentialStore(filePath);
  await store.save({ serverId: 'zotero', token: 'private-token' });

  assert.deepEqual(await store.list(), [{ serverId: 'zotero', configured: true }]);
  assert.equal(await store.get('zotero'), 'private-token');
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { credentials: { zotero: 'private-token' } });
});

test('rejects malformed MCP credentials', async () => {
  const store = createMcpCredentialStore(path.join(os.tmpdir(), `gpt-web-codex-mcp-${Date.now()}.json`));
  await assert.rejects(() => store.save({ serverId: 'zotero', token: 'line\nfeed' }), /invalid/i);
});
