'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openSkillFolder, saveSkillDefaults, scanSkills } = require('../electron/skills.cjs');

async function makeProfile() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
  const skillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  await fs.mkdir(path.join(skillsRoot, 'review'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'review', 'SKILL.md'), '---\nname: Review\ndescription: Review code safely.\n---\n' + 'x'.repeat(5000));
  await fs.mkdir(path.join(skillsRoot, 'invalid'));
  await fs.writeFile(path.join(skillsRoot, 'invalid', 'SKILL.md'), 'missing frontmatter');
  return { id: 'one', workspaceRoot, skillsRoot, enabledSkillIds: [] };
}

test('scans direct Skills into bounded renderer-safe summaries and previews', async (t) => {
  const profile = await makeProfile();
  t.after(() => fs.rm(profile.workspaceRoot, { recursive: true, force: true }));
  const skills = await scanSkills(profile);

  assert.deepEqual(skills.map(({ id, name, description }) => ({ id, name, description })), [
    { id: 'review', name: 'Review', description: 'Review code safely.' },
  ]);
  assert.equal(skills[0].preview.length, 4096);
  assert.equal('content' in skills[0], false);
  assert.equal('path' in skills[0], false);
});

test('scans trusted Skills from a bundled skills subdirectory', async (t) => {
  const profile = await makeProfile();
  t.after(() => fs.rm(profile.workspaceRoot, { recursive: true, force: true }));
  const bundledSkill = path.join(profile.skillsRoot, 'superpowers', 'skills', 'brainstorming');
  await fs.mkdir(bundledSkill, { recursive: true });
  await fs.writeFile(path.join(bundledSkill, 'SKILL.md'), '---\nname: Brainstorming\ndescription: Shape a feature before implementation.\n---\nPlan first.');

  const skills = await scanSkills(profile);

  assert.equal(skills.some((skill) => skill.id === 'superpowers-brainstorming' && skill.name === 'Brainstorming'), true);
});

test('rejects defaults outside the scanned catalog', async (t) => {
  const profile = await makeProfile();
  t.after(() => fs.rm(profile.workspaceRoot, { recursive: true, force: true }));

  await assert.rejects(() => saveSkillDefaults(profile, ['outside']), /Unknown Skill/);
  assert.deepEqual(await saveSkillDefaults(profile, ['review']), ['review']);
});

test('opens only a folder selected from the current Skills catalog', async (t) => {
  const profile = await makeProfile();
  t.after(() => fs.rm(profile.workspaceRoot, { recursive: true, force: true }));
  const opened = [];

  await openSkillFolder(profile, 'review', { openPath: async (value) => { opened.push(value); return ''; } });
  await assert.rejects(() => openSkillFolder(profile, 'outside', { openPath: async () => '' }), /Unknown Skill/);
  assert.deepEqual(opened, [path.join(await fs.realpath(profile.skillsRoot), 'review')]);
});

test('rejects a Skill directory replaced with a link after catalog scanning', async (t) => {
  const profile = await makeProfile();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-outside-skill-'));
  t.after(() => fs.rm(profile.workspaceRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const opened = [];

  await assert.rejects(
    () => openSkillFolder(profile, 'review', { openPath: async (value) => { opened.push(value); return ''; } }, {
      beforeOpen: async () => {
        await fs.rm(path.join(profile.skillsRoot, 'review'), { recursive: true });
        await fs.symlink(outside, path.join(profile.skillsRoot, 'review'), 'junction');
      },
    }),
    /Skill folder changed/i,
  );
  assert.deepEqual(opened, []);
});
