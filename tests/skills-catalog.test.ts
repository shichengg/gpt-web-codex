import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { sameFileIdentity, SkillCatalog } from '../src/skills/catalog.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeSkillsRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
  temporaryRoots.push(root);
  return root;
}

describe('SkillCatalog', () => {
  test('lists only directories containing valid SKILL.md packages', async () => {
    const skillsRoot = await makeSkillsRoot();
    await mkdir(path.join(skillsRoot, 'review'));
    await writeFile(path.join(skillsRoot, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code safely.\n---\n\nReview instructions.\n');
    await mkdir(path.join(skillsRoot, 'missing-metadata'));
    await writeFile(path.join(skillsRoot, 'missing-metadata', 'SKILL.md'), '# no frontmatter');
    await mkdir(path.join(skillsRoot, 'file-only'));
    await writeFile(path.join(skillsRoot, 'README.md'), 'not a skill');

    const catalog = await SkillCatalog.create(skillsRoot);

    await expect(catalog.list()).resolves.toEqual([
      { id: 'review', name: 'review', description: 'Review code safely.' },
    ]);
  });

  test('reads an explicit skill and rejects an unregistered identifier', async () => {
    const skillsRoot = await makeSkillsRoot();
    await mkdir(path.join(skillsRoot, 'review'));
    await writeFile(path.join(skillsRoot, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code safely.\n---\n\nReview instructions.\n');
    const catalog = await SkillCatalog.create(skillsRoot);

    await expect(catalog.read('review')).resolves.toEqual({
      id: 'review',
      name: 'review',
      description: 'Review code safely.',
      content: 'Review instructions.\n',
    });
    await expect(catalog.read('../outside')).rejects.toThrow('Unknown skill');
  });

  test('lists and reads a skill from a trusted bundled skills directory', async () => {
    const skillsRoot = await makeSkillsRoot();
    const bundledSkill = path.join(skillsRoot, 'superpowers', 'skills', 'brainstorming');
    await mkdir(bundledSkill, { recursive: true });
    await writeFile(path.join(bundledSkill, 'SKILL.md'), '---\nname: brainstorming\ndescription: Explore the design.\n---\n\nPlan first.\n');
    const catalog = await SkillCatalog.create(skillsRoot);

    await expect(catalog.list()).resolves.toEqual([
      { id: 'superpowers-brainstorming', name: 'brainstorming', description: 'Explore the design.' },
    ]);
    await expect(catalog.read('superpowers-brainstorming')).resolves.toMatchObject({ content: 'Plan first.\n' });
  });

  test('rejects malformed frontmatter and does not expose an outside symlink', async () => {
    const skillsRoot = await makeSkillsRoot();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-outside-'));
    temporaryRoots.push(outside);
    await mkdir(path.join(outside, 'external'));
    await writeFile(path.join(outside, 'external', 'SKILL.md'), '---\nname: external\ndescription: Outside.\n---\nsecret');
    await symlink(path.join(outside, 'external'), path.join(skillsRoot, 'linked'), 'junction');
    await mkdir(path.join(skillsRoot, 'malformed'));
    await writeFile(path.join(skillsRoot, 'malformed', 'SKILL.md'), '---\nname: malformed\n---\nbody');
    await expect(SkillCatalog.create(skillsRoot)).resolves.toBeDefined();
    await expect((await SkillCatalog.create(skillsRoot)).list()).resolves.toEqual([]);
  });

  test.skipIf(process.platform === 'win32')('does not read a SKILL.md file symlinked outside the root', async () => {
    const skillsRoot = await makeSkillsRoot();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skill-file-outside-'));
    temporaryRoots.push(outside);
    await mkdir(path.join(skillsRoot, 'linked-file'));
    const outsideFile = path.join(outside, 'SKILL.md');
    await writeFile(outsideFile, '---\nname: leaked\ndescription: Leaked.\n---\nsecret');
    await symlink(outsideFile, path.join(skillsRoot, 'linked-file', 'SKILL.md'), 'file');

    const catalog = await SkillCatalog.create(skillsRoot);

    await expect(catalog.list()).resolves.toEqual([]);
    await expect(catalog.read('linked-file')).rejects.toThrow('Unknown skill');
  });

  test('rejects changed file identities', () => {
    const file = {
      isFile: () => true,
      dev: 1,
      ino: 2,
      size: 10,
      mtimeMs: 20,
      ctimeMs: 30,
    } as import('node:fs').Stats;
    const replacement = { ...file, ino: 3 } as import('node:fs').Stats;

    expect(sameFileIdentity(file, file)).toBe(true);
    expect(sameFileIdentity(file, replacement)).toBe(false);
  });
});
