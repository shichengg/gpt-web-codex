'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_CONNECTOR_NAME,
  createConnectorIdentity,
  validateConnectorName,
} = require('../electron/connector-identity.cjs');

test('keeps a stable connector name and rejects unsafe names', () => {
  assert.equal(validateConnectorName('  GPT Web Codex  '), 'GPT Web Codex');
  assert.throws(() => validateConnectorName(''), /connector name/i);
  assert.throws(() => validateConnectorName('name\nnext'), /connector name/i);
  assert.throws(() => validateConnectorName('x'.repeat(81)), /connector name/i);
  assert.equal(DEFAULT_CONNECTOR_NAME, 'GPT Web Codex');
});

test('persists tunnel setup privately without exposing credentials in its snapshot', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'connector.json');
  const tunnelId = `tunnel_${'a'.repeat(32)}`;
  const runtimeKey = 'runtime-key-which-must-remain-private';
  const identity = await createConnectorIdentity(filePath);

  assert.deepEqual(identity.snapshot(), {
    connectorName: DEFAULT_CONNECTOR_NAME,
    configured: false,
  });

  await identity.configure({ tunnelId, runtimeKey });
  assert.deepEqual(identity.snapshot(), {
    connectorName: DEFAULT_CONNECTOR_NAME,
    configured: true,
  });
  assert.equal(JSON.stringify(identity.snapshot()).includes(tunnelId), false);
  assert.equal(JSON.stringify(identity.snapshot()).includes(runtimeKey), false);

  const restored = await createConnectorIdentity(filePath);
  assert.deepEqual(restored.credentials(), { tunnelId, runtimeKey });
  assert.deepEqual(restored.snapshot(), {
    connectorName: DEFAULT_CONNECTOR_NAME,
    configured: true,
  });
  await assert.rejects(
    () => identity.configure({ tunnelId, runtimeKey, connectorName: 'Renamed connector' }),
    /setup|connector/i,
  );
});
