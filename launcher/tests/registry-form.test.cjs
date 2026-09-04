'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRegistryStore, validateRegistryDraft } = require('../electron/registry.cjs');
const { createProfileController } = require('../electron/main.cjs');

const validDraft = Object.freeze({
  servers: [{ id: 'lint', command: 'node', args: ['C:\\trusted\\server.cjs'], allowedTools: ['check'], timeoutMs: 30_000 }],
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

test('accepts only the approved node executable with one local CJS entrypoint', () => {
  for (const server of [
    { ...validDraft.servers[0], command: 'npx' },
    { ...validDraft.servers[0], command: 'powershell.exe' },
    { ...validDraft.servers[0], command: 'cmd.exe' },
    { ...validDraft.servers[0], args: ['-e', 'process.exit()'] },
    { ...validDraft.servers[0], args: ['https://remote.example/proxy.cjs'] },
    { ...validDraft.servers[0], args: ['C:\\trusted\\server.cjs', '--remote=https://remote.example'] },
  ]) {
    assert.throws(() => validateRegistryDraft({ servers: [server] }), /approved|entrypoint|argument/i);
  }
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
  const mcpRoot = path.join(workspaceRoot, '.codex', 'mcp');
  const entrypoint = path.join(mcpRoot, 'lint.cjs');
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.mkdir(mcpRoot, { recursive: true });
  await fs.writeFile(entrypoint, 'process.stdin.resume();');
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

  const profileDraft = { servers: [{ ...validDraft.servers[0], args: [entrypoint] }] };
  await controller.saveMcpRegistry(profileDraft);

  assert.deepEqual(restarts, ['one']);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'mcp-registries', 'one.json'), 'utf8')),
    profileDraft,
  );
});

test('controller uses its RuntimeClient and owned supervisor for start, cancel, and registry reload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-runtime-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  const mcpRoot = path.join(workspaceRoot, '.codex', 'mcp');
  const entrypoint = path.join(mcpRoot, 'lint.cjs');
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.mkdir(mcpRoot, { recursive: true });
  await fs.writeFile(entrypoint, 'process.stdin.resume();');
  const calls = [];
  const supervisor = {
    state: 'stopped',
    async start(profile, registryPath) { calls.push(['start', profile.id, registryPath]); this.state = 'running'; },
    async stop() { calls.push(['stop']); this.state = 'stopped'; },
    async restart(profile, registryPath) { calls.push(['restart', profile.id, registryPath]); },
    async call(tool, input) {
      calls.push(['call', tool, input]);
      if (tool === 'runtime_snapshot') return { state: this.state };
      return { id: input.taskId, state: 'cancelled' };
    },
    subscribeLogs() { return () => {}; },
  };
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' }, runtimeSupervisor: supervisor });
  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot, enabledSkillIds: [] });
  await controller.setActiveProfile('one');
  const draft = { servers: [{ ...validDraft.servers[0], args: [entrypoint] }] };
  await controller.saveMcpRegistry(draft);
  await controller.start();
  await controller.cancelTask('task-1');

  assert.equal(calls[0][0], 'stop');
  assert.equal(calls.some((call) => call[0] === 'restart'), true);
  assert.equal(calls.some((call) => call[0] === 'start'), true);
  assert.deepEqual(calls.find((call) => call[1] === 'codex_cancel'), ['call', 'codex_cancel', { taskId: 'task-1' }]);
});

test('revalidates a pre-existing registry against the active profile before runtime spawn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-registry-start-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  const mcpRoot = path.join(workspaceRoot, '.codex', 'mcp');
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-outside-entrypoint-'));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.mkdir(mcpRoot, { recursive: true });
  const outsideEntrypoint = path.join(outsideRoot, 'outside.cjs');
  await fs.writeFile(outsideEntrypoint, 'process.stdin.resume();');
  await fs.mkdir(path.join(root, 'mcp-registries'), { recursive: true });
  await fs.writeFile(path.join(root, 'mcp-registries', 'one.json'), JSON.stringify({
    servers: [{ ...validDraft.servers[0], args: [outsideEntrypoint] }],
  }));
  let spawned = 0;
  let restarted = 0;
  const supervisor = {
    async start() { spawned += 1; },
    async restart() { restarted += 1; },
    async stop() {},
    async call() { return { state: 'stopped' }; },
    subscribeLogs() { return () => {}; },
  };
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' }, runtimeSupervisor: supervisor });
  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot, enabledSkillIds: [] });
  await controller.setActiveProfile('one');

  await assert.rejects(() => controller.start(), /contained/i);

  assert.equal(spawned, 0);
  assert.equal(restarted, 0);
});
