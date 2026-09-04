'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRegistryStore, validateRegistryForProfile, validateRegistryDraft } = require('../electron/registry.cjs');
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

test('permits an empty registry when the optional workspace MCP directory is absent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-empty-registry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });

  await assert.doesNotReject(() => validateRegistryForProfile({ servers: [] }, { workspaceRoot }));
  await assert.rejects(() => fs.access(path.join(workspaceRoot, '.codex', 'mcp')));
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
  await controller.task('task-1');
  await controller.cancelTask('task-1');

  assert.equal(calls[0][0], 'stop');
  assert.equal(calls.some((call) => call[0] === 'restart'), true);
  assert.equal(calls.some((call) => call[0] === 'start'), true);
  assert.deepEqual(calls.filter((call) => call[1] === 'codex_status' || call[1] === 'codex_output'), [
    ['call', 'codex_status', { taskId: 'task-1' }],
    ['call', 'codex_output', { taskId: 'task-1' }],
  ]);
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

test('serializes start and profile selection so a stale profile cannot own the runtime', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-runtime-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oneRoot = path.join(root, 'one');
  const twoRoot = path.join(root, 'two');
  const oneSkills = path.join(oneRoot, '.codex', 'skills');
  const twoSkills = path.join(twoRoot, '.codex', 'skills');
  await Promise.all([
    fs.mkdir(oneSkills, { recursive: true }),
    fs.mkdir(twoSkills, { recursive: true }),
    fs.mkdir(path.join(oneRoot, '.codex', 'mcp'), { recursive: true }),
    fs.mkdir(path.join(twoRoot, '.codex', 'mcp'), { recursive: true }),
  ]);
  const calls = [];
  let resolveStarted;
  let releaseStart;
  const enteredStart = new Promise((resolve) => { resolveStarted = resolve; });
  const heldStart = new Promise((resolve) => { releaseStart = resolve; });
  const supervisor = {
    state: 'stopped', workspace: null,
    async start(profile) {
      calls.push(['start', profile.id]);
      resolveStarted();
      await heldStart;
      this.state = 'running';
      this.workspace = profile.workspaceRoot;
    },
    async stop() { calls.push(['stop']); this.state = 'stopped'; this.workspace = null; },
    async call(tool) {
      if (tool === 'runtime_snapshot') return { state: this.state, workspace: this.workspace };
      return {};
    },
    subscribeLogs() { return () => {}; },
  };
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' }, runtimeSupervisor: supervisor });
  await controller.saveProfile({ id: 'one', workspaceRoot: oneRoot, skillsRoot: oneSkills, enabledSkillIds: [] });
  await controller.saveProfile({ id: 'two', workspaceRoot: twoRoot, skillsRoot: twoSkills, enabledSkillIds: [] });
  await controller.setActiveProfile('one');

  const starting = controller.start();
  await enteredStart;
  const switching = controller.setActiveProfile('two');
  const switchState = await Promise.race([
    switching.then(() => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 10)),
  ]);
  assert.equal(switchState, 'pending');
  releaseStart();
  const startSnapshot = await starting;
  await switching;

  assert.deepEqual(startSnapshot, { state: 'running', workspace: await fs.realpath(oneRoot) });
  assert.deepEqual(calls, [['stop'], ['start', 'one'], ['stop']]);
  assert.deepEqual(await controller.snapshot(), { state: 'stopped', workspace: null });
});
