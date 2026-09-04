'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProfileStore } = require('../electron/profiles.cjs');
const { createProfileController, registerIpcHandlers, rendererEntryUrl } = require('../electron/main.cjs');

async function makeProfileStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-profiles-'));
  return {
    root,
    store: await createProfileStore(path.join(root, 'profiles.json')),
  };
}

test('stores Skills defaults per workspace without retaining runtime state', async (t) => {
  const { root, store } = await makeProfileStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await store.save({
    id: 'one',
    workspaceRoot: 'C:/work/one',
    skillsRoot: 'C:/work/one/.codex/skills',
    enabledSkillIds: [],
  });
  await store.save({
    id: 'two',
    workspaceRoot: 'C:/work/two',
    skillsRoot: 'C:/work/two/.codex/skills',
    enabledSkillIds: [],
  });

  await store.saveDefaults('one', ['review']);
  await store.saveDefaults('two', ['sql']);

  assert.deepEqual((await store.get('one')).enabledSkillIds, ['review']);
  assert.deepEqual((await store.get('two')).enabledSkillIds, ['sql']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'profiles.json'), 'utf8')), {
    version: 1,
    activeProfileId: null,
    profiles: [
      { id: 'one', workspaceRoot: 'C:/work/one', skillsRoot: 'C:/work/one/.codex/skills', enabledSkillIds: ['review'] },
      { id: 'two', workspaceRoot: 'C:/work/two', skillsRoot: 'C:/work/two/.codex/skills', enabledSkillIds: ['sql'] },
    ],
  });
});

test('persists an active profile atomically and rejects secret-shaped profile fields', async (t) => {
  const { root, store } = await makeProfileStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => store.save({
      id: 'one',
      workspaceRoot: 'C:/work/one',
      skillsRoot: 'C:/work/one/.codex/skills',
      enabledSkillIds: [],
      connectorToken: 'not-allowed',
    }),
    /unknown field/i,
  );

  await store.save({ id: 'one', workspaceRoot: 'C:/work/one', skillsRoot: 'C:/work/one/.codex/skills', enabledSkillIds: [] });
  await store.setActive('one');

  const reloaded = await createProfileStore(path.join(root, 'profiles.json'));
  assert.equal((await reloaded.getActive()).id, 'one');
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.tmp-')), false);
});

test('profile IPC accepts only an exact path-and-choices draft', async () => {
  const handlers = new Map();
  const sender = { getURL: () => rendererEntryUrl };
  const saved = [];
  registerIpcHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { saveProfile: async (profile) => { saved.push(profile); return profile; } },
    () => sender,
  );

  const draft = { id: 'one', workspaceRoot: 'C:/work/one', skillsRoot: 'C:/work/one/.codex/skills', enabledSkillIds: ['review'] };
  await handlers.get('launcher:save-profile')({ sender }, draft);
  assert.deepEqual(saved, [draft]);
  assert.throws(
    () => handlers.get('launcher:save-profile')({ sender }, { ...draft, connectorToken: 'secret' }),
    /profile/i,
  );
});

test('active profile defaults are catalog-validated before private persistence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-profile-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills');
  await fs.mkdir(path.join(skillsRoot, 'review'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'review', 'SKILL.md'), '---\nname: Review\ndescription: Review safely.\n---\nBody');
  const controller = await createProfileController({ userDataPath: root, shell: { openPath: async () => '' } });

  await controller.saveProfile({ id: 'one', workspaceRoot: root, skillsRoot, enabledSkillIds: [] });
  await controller.setActiveProfile('one');
  await assert.rejects(() => controller.saveSkills(['outside']), /Unknown Skill/);
  await controller.saveSkills(['review']);

  assert.deepEqual((await controller.listProfiles())[0].enabledSkillIds, ['review']);
});
