'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProfileStore } = require('../electron/profiles.cjs');
const { createProfileController, registerIpcHandlers, rendererEntryUrl } = require('../electron/main.cjs');

async function makeWorkspace(parent, name) {
  const workspaceRoot = path.join(parent, name);
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  await fs.mkdir(skillsRoot, { recursive: true });
  return { workspaceRoot, skillsRoot };
}

async function makeProfileStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-profiles-'));
  return { root, store: await createProfileStore(path.join(root, 'profiles.json')) };
}

test('stores Skills defaults per canonical workspace without retaining runtime state', async (t) => {
  const { root, store } = await makeProfileStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const one = await makeWorkspace(root, 'one');
  const two = await makeWorkspace(root, 'two');

  await store.save({ id: 'one', ...one, enabledSkillIds: [] });
  await store.save({ id: 'two', ...two, enabledSkillIds: [] });
  await store.saveDefaults('one', ['review']);
  await store.saveDefaults('two', ['sql']);

  assert.deepEqual((await store.get('one')).enabledSkillIds, ['review']);
  assert.deepEqual((await store.get('two')).enabledSkillIds, ['sql']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'profiles.json'), 'utf8')), {
    version: 1,
    activeProfileId: null,
    profiles: [
      { id: 'one', workspaceRoot: await fs.realpath(one.workspaceRoot), skillsRoot: await fs.realpath(one.skillsRoot), enabledSkillIds: ['review'] },
      { id: 'two', workspaceRoot: await fs.realpath(two.workspaceRoot), skillsRoot: await fs.realpath(two.skillsRoot), enabledSkillIds: ['sql'] },
    ],
  });
});

test('persists an active profile atomically and rejects secret-shaped profile fields', async (t) => {
  const { root, store } = await makeProfileStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await makeWorkspace(root, 'one');

  await assert.rejects(
    () => store.save({ id: 'one', ...workspace, enabledSkillIds: [], connectorToken: 'not-allowed' }),
    /unknown field/i,
  );
  await store.save({ id: 'one', ...workspace, enabledSkillIds: [] });
  await store.setActive('one');

  const reloaded = await createProfileStore(path.join(root, 'profiles.json'));
  assert.equal((await reloaded.getActive()).id, 'one');
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.tmp-')), false);
});

test('rejects more than 64 default Skills before profile persistence', async (t) => {
  const { root, store } = await makeProfileStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await makeWorkspace(root, 'one');
  const defaults = Array.from({ length: 65 }, (_value, index) => `skill-${index}`);

  await assert.rejects(
    () => store.save({ id: 'one', ...workspace, enabledSkillIds: defaults }),
    /invalid bounded fields/i,
  );

  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => fs.readFile(path.join(root, 'profiles.json'), 'utf8'), { code: 'ENOENT' });
});

test('keeps enabled Skill defaults when an existing profile path is edited', async (t) => {
  const { root, store } = await makeProfileStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await makeWorkspace(root, 'one');
  const replacement = await makeWorkspace(root, 'replacement');

  await store.save({ id: 'one', ...first, enabledSkillIds: ['review'] });
  await store.save({ id: 'one', ...replacement, enabledSkillIds: [] });

  assert.deepEqual((await store.get('one')).enabledSkillIds, ['review']);
  assert.equal((await store.get('one')).workspaceRoot, await fs.realpath(replacement.workspaceRoot));
});

test('recovers from corrupt state and removes a stale atomic-write temporary file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-corrupt-profiles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const primary = path.join(root, 'profiles.json');
  await fs.writeFile(primary, '{corrupt json');
  await fs.writeFile(path.join(root, '.profiles.json.tmp-interrupted'), '{"version":1}');

  const store = await createProfileStore(primary);

  assert.deepEqual(await store.list(), []);
  const names = await fs.readdir(root);
  assert.equal(names.some((name) => name.startsWith('profiles.json.corrupt-')), true);
  assert.equal(names.some((name) => name.includes('.tmp-')), false);
});

test('profile service and IPC reject an out-of-workspace Skills root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-profile-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await makeWorkspace(root, 'workspace');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-outside-skills-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' } });

  await assert.rejects(
    () => controller.saveProfile({ id: 'one', workspaceRoot: workspace.workspaceRoot, skillsRoot: outside, enabledSkillIds: [] }),
    /Skills root/i,
  );

  const handlers = new Map();
  const sender = { getURL: () => rendererEntryUrl };
  registerIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, controller, () => sender);
  await assert.rejects(
    () => handlers.get('launcher:save-profile')({ sender }, { id: 'one', workspaceRoot: workspace.workspaceRoot, skillsRoot: outside, enabledSkillIds: [] }),
    /Skills root/i,
  );
});

test('rejects a .codex parent junction whose canonical Skills root escapes the workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-parent-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const outsideCodex = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-outside-codex-'));
  t.after(() => fs.rm(outsideCodex, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot), { recursive: true });
  await fs.mkdir(path.join(outsideCodex, 'skills'));
  await fs.symlink(outsideCodex, path.join(workspaceRoot, '.codex'), 'junction');
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' } });

  await assert.rejects(
    () => controller.saveProfile({ id: 'one', workspaceRoot, skillsRoot: path.join(outsideCodex, 'skills'), enabledSkillIds: [] }),
    /contained/i,
  );
});

test('catalog-gates defaults on first save and rejects retained defaults when a profile root changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-profile-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await makeWorkspace(root, 'first');
  const second = await makeWorkspace(root, 'second');
  for (const [skillsRoot, id] of [[first.skillsRoot, 'review'], [second.skillsRoot, 'sql']]) {
    await fs.mkdir(path.join(skillsRoot, id));
    await fs.writeFile(path.join(skillsRoot, id, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id}.\n---\nBody`);
  }
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' } });

  await assert.rejects(
    () => controller.saveProfile({ id: 'one', ...first, enabledSkillIds: ['outside'] }),
    /Unknown Skill/,
  );
  await controller.saveProfile({ id: 'one', ...first, enabledSkillIds: ['review'] });
  await assert.rejects(
    () => controller.saveProfile({ id: 'one', ...second, enabledSkillIds: [] }),
    /Unknown Skill/,
  );
  assert.equal((await controller.listProfiles())[0].workspaceRoot, await fs.realpath(first.workspaceRoot));
});

test('active profile defaults are catalog-validated before private persistence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-profile-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await makeWorkspace(root, 'workspace');
  await fs.mkdir(path.join(workspace.skillsRoot, 'review'));
  await fs.writeFile(path.join(workspace.skillsRoot, 'review', 'SKILL.md'), '---\nname: Review\ndescription: Review safely.\n---\nBody');
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' } });

  await controller.saveProfile({ id: 'one', ...workspace, enabledSkillIds: [] });
  await controller.setActiveProfile('one');
  await assert.rejects(() => controller.saveSkills(['outside']), /Unknown Skill/);
  await controller.saveSkills(['review']);

  assert.deepEqual((await controller.listProfiles())[0].enabledSkillIds, ['review']);
});
