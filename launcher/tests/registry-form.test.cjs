'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRegistryStore, validateRegistryDraft } = require('../electron/registry.cjs');
const { createProfileController } = require('../electron/main.cjs');

const validDraft = Object.freeze({
  servers: [{ id: 'lint', command: 'node', args: ['server.cjs'], allowedTools: ['check'], timeoutMs: 30_000 }],
});

test('rejects remote MCP URL and wildcard tool', () => {
  assert.throws(() => validateRegistryDraft({
    servers: [{ id: 'x', url: 'https://x', allowedTools: ['*'] }],
  }), /local stdio|wildcard|unknown/i);
});

test('enforces the core local stdio registry limits before persistence', () => {
  assert.throws(
    () => validateRegistryDraft({ servers: [{ ...validDraft.servers[0], id: 'lint', timeoutMs: 999 }] }),
    /timeout/i,
  );
  assert.throws(
    () => validateRegistryDraft({ servers: [...validDraft.servers, { ...validDraft.servers[0] }] }),
    /duplicate/i,
  );
  assert.throws(
    () => validateRegistryDraft({ servers: [{ ...validDraft.servers[0], command: '  ' }] }),
    /command/i,
  );
});

test('atomically saves an exact validated registry without retaining rejected drafts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-registry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registryPath = path.join(root, 'mcp.json');
  const store = createRegistryStore(registryPath);

  await store.save(validDraft);
  await assert.rejects(
    () => store.save({ servers: [{ ...validDraft.servers[0], allowedTools: ['*'] }] }),
    /wildcard/i,
  );

  assert.deepEqual(await store.load(), validDraft);
  assert.deepEqual(JSON.parse(await fs.readFile(registryPath, 'utf8')), validDraft);
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.tmp-')), false);
});

test('saves registry per active canonical profile before requesting a runtime restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-registry-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  await fs.mkdir(skillsRoot, { recursive: true });
  const restarts = [];
  const controller = await createProfileController({
    userDataPath: root,
    shell: { openPath: async () => '' },
    runtimeSupervisor: { restart: async (profile) => restarts.push(profile.id) },
  });

  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot, enabledSkillIds: [] });
  await controller.setActiveProfile('one');
  await assert.rejects(
    () => controller.saveMcpRegistry({ servers: [{ ...validDraft.servers[0], allowedTools: ['*'] }] }),
    /wildcard/i,
  );
  assert.deepEqual(restarts, []);

  await controller.saveMcpRegistry(validDraft);

  assert.deepEqual(restarts, ['one']);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'mcp-registries', 'one.json'), 'utf8')),
    validDraft,
  );
});
