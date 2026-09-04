'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openSkillFolder, saveSkillDefaults, scanSkills } = require('../electron/skills.cjs');

async function makeSkillsRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
  await fs.mkdir(path.join(root, 'review'));
  await fs.writeFile(path.join(root, 'review', 'SKILL.md'), '---\nname: Review\ndescription: Review code safely.\n---\n' + 'x'.repeat(5000));
  await fs.mkdir(path.join(root, 'invalid'));
  await fs.writeFile(path.join(root, 'invalid', 'SKILL.md'), 'missing frontmatter');
  return root;
}

test('scans direct Skills into bounded renderer-safe summaries and previews', async (t) => {
  const root = await makeSkillsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const skills = await scanSkills(root);

  assert.deepEqual(skills.map(({ id, name, description }) => ({ id, name, description })), [
    { id: 'review', name: 'Review', description: 'Review code safely.' },
  ]);
  assert.equal(skills[0].preview.length, 4096);
  assert.equal('content' in skills[0], false);
  assert.equal('path' in skills[0], false);
});

test('treats an absent optional Skills root as an empty catalog', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-missing-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.deepEqual(await scanSkills(path.join(root, 'does-not-exist')), []);
});

test('rejects defaults outside the scanned catalog', async (t) => {
  const root = await makeSkillsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = { id: 'one', workspaceRoot: 'C:/work/one', skillsRoot: root, enabledSkillIds: [] };

  await assert.rejects(() => saveSkillDefaults(profile, ['outside']), /Unknown Skill/);
  assert.deepEqual(await saveSkillDefaults(profile, ['review']), ['review']);
});

test('opens only a folder selected from the current Skills catalog', async (t) => {
  const root = await makeSkillsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const opened = [];

  await openSkillFolder(root, 'review', { openPath: async (value) => { opened.push(value); return ''; } });
  await assert.rejects(() => openSkillFolder(root, 'outside', { openPath: async () => '' }), /Unknown Skill/);

  assert.deepEqual(opened, [path.join(root, 'review')]);
});
