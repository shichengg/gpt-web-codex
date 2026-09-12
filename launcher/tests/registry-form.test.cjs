'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRegistryStore, validateRegistryForProfile, validateRegistryDraft } = require('../electron/registry.cjs');
const { createProfileController } = require('../electron/main.cjs');

function assertDefaultUiState(snapshot, profileStatus = 'complete') {
  assert.deepEqual(snapshot.preferences, {
    language: 'zh-CN',
    theme: 'system',
    proxyMode: 'auto',
    proxyUrl: '',
    startAtLogin: false,
    autoStartServices: true,
    keepRunningOnClose: true,
    guideDismissedSteps: [],
  });
  assert.deepEqual(snapshot.guide, [
    { id: 1, status: profileStatus, messageKey: profileStatus === 'complete' ? 'guide.profile.ready' : 'guide.profile.required' },
    { id: 2, status: 'needs-action', messageKey: 'guide.skills.required' },
    { id: 3, status: 'unavailable', messageKey: 'guide.tunnel.unavailable' },
    { id: 4, status: 'needs-action', messageKey: 'guide.chatgpt.required' },
    { id: 5, status: 'needs-action', messageKey: 'guide.runtime.required' },
  ]);
}

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

test('accepts the installed Stata GUI MCP executable and Python module entry', () => {
  const tools = ['stata_run', 'stata_run_dofile', 'stata_session', 'stata_status'];
  assert.deepEqual(validateRegistryDraft({ servers: [{ id: 'stata', command: 'D:\\Python\\Scripts\\stata-gui-mcp.exe', args: [], allowedTools: tools, timeoutMs: 120000 }] }).servers[0], {
    id: 'stata', command: 'D:\\Python\\Scripts\\stata-gui-mcp.exe', args: [], allowedTools: tools, timeoutMs: 120000,
  });
  assert.deepEqual(validateRegistryDraft({ servers: [{ id: 'stata-python', command: 'D:\\Python\\python.exe', args: ['-m', 'stata_mcp'], allowedTools: tools, timeoutMs: 120000 }] }).servers[0].args, ['-m', 'stata_mcp']);
});

test('rejects arbitrary executable MCP commands outside the approved Stata and Python forms', () => {
  assert.throws(() => validateRegistryDraft({ servers: [{ id: 'bad', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'whoami'], allowedTools: ['check'], timeoutMs: 30000 }] }), /approved/i);
});

test('accepts generic absolute local executables and loopback HTTP MCP servers', () => {
  const executable = validateRegistryDraft({ servers: [{ id: 'local', command: 'C:\\Tools\\local-mcp.exe', args: ['--stdio'], allowedTools: ['status'], timeoutMs: 30000 }] });
  assert.equal(executable.servers[0].command, 'C:\\Tools\\local-mcp.exe');
  const zotero = validateRegistryDraft({ servers: [{ id: 'zotero', transport: 'streamable-http', command: '', args: [], url: 'http://127.0.0.1:23120/mcp', allowedTools: ['search_library'], timeoutMs: 30000 }] });
  assert.equal(zotero.servers[0].url, 'http://127.0.0.1:23120/mcp');
  assert.throws(() => validateRegistryDraft({ servers: [{ id: 'remote', transport: 'streamable-http', command: '', args: [], url: 'https://example.com/mcp', allowedTools: ['search'], timeoutMs: 30000 }] }), /loopback/i);
  assert.throws(() => validateRegistryDraft({ servers: [{ id: 'shell', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'whoami'], allowedTools: ['check'], timeoutMs: 30000 }] }), /approved/i);
});

test('preserves the enabled flag while excluding HTTP credentials from registry data', () => {
  const registry = validateRegistryDraft({ servers: [{ id: 'zotero', transport: 'streamable-http', url: 'http://127.0.0.1:23120/mcp', command: '', args: [], allowedTools: ['search_library'], timeoutMs: 30000, enabled: false }] });
  assert.equal(registry.servers[0].enabled, false);
  assert.equal(Object.hasOwn(registry.servers[0], 'headers'), false);
});

test('allows an empty allowlist until the first connection discovery', () => {
  const registry = validateRegistryDraft({ servers: [{ id: 'custom', command: 'C:\\Tools\\custom-mcp.exe', args: [], allowedTools: [], timeoutMs: 30000 }] });
  assert.deepEqual(registry.servers[0].allowedTools, []);
});

test('records a readable MCP discovery failure in launcher activity logs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-mcp-discovery-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspaceRoot, '.codex', 'skills'), { recursive: true });
  const activity = [];
  const controller = await createProfileController({
    userDataPath: root,
    shell: { openPath: async () => '' },
    runtimeClient: { snapshot: async () => ({ state: 'stopped' }), mcpTools: async () => { throw new Error('MCP server unavailable'); } },
    publishActivity: (entry) => activity.push(entry),
  });
  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot: path.join(workspaceRoot, '.codex', 'skills'), enabledSkillIds: [] });
  await controller.setActiveProfile('one');
  await assert.rejects(() => controller.discoverMcpTools('zotero'), /MCP server unavailable/);
  assert.match(activity.join('\n'), /zotero.*MCP server unavailable/i);
});

test('waits for a runtime restart before discovering MCP tools', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-mcp-discovery-wait-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspaceRoot, '.codex', 'skills'), { recursive: true });
  let state = 'starting';
  const controller = await createProfileController({
    userDataPath: root,
    shell: { openPath: async () => '' },
    runtimeSupervisor: { status: () => ({ state: state === 'starting' ? 'starting' : 'running' }) },
    runtimeClient: { snapshot: async () => ({ state: 'stopped' }), mcpTools: async () => { assert.equal(state, 'running'); return [{ name: 'check' }]; } },
  });
  await controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot: path.join(workspaceRoot, '.codex', 'skills'), enabledSkillIds: [] });
  await controller.setActiveProfile('one');
  setTimeout(() => { state = 'running'; }, 30);
  await assert.doesNotReject(() => controller.discoverMcpTools('lint'));
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

  const { preferences, guide, ...runtimeSnapshot } = startSnapshot;
  assert.deepEqual(runtimeSnapshot, { state: 'running', workspace: await fs.realpath(oneRoot), proxy: { mode: 'auto', source: 'auto-direct', reachable: true, configured: false } });
  assertDefaultUiState({ preferences, guide });
  assert.deepEqual(calls, [['stop'], ['start', 'one'], ['stop']]);
  const { preferences: stoppedPreferences, guide: stoppedGuide, ...stoppedSnapshot } = await controller.snapshot();
  assert.deepEqual(stoppedSnapshot, { state: 'stopped', workspace: null, proxy: { mode: 'auto', source: 'auto-direct', reachable: true, configured: false } });
  assertDefaultUiState({ preferences: stoppedPreferences, guide: stoppedGuide });
});
