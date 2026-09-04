import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SkillCatalog } from '../src/skills/catalog.js';
import { CodexRunner } from '../src/codex/runner.js';
import { TaskStore } from '../src/codex/tasks.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('{"type":"message","text":"done"}\n'));
    child.emit('close', 0);
  });
  return child;
}

describe('CodexRunner', () => {
  test('spawns the fixed executable with the configured cwd and without a shell', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    await mkdir(path.join(skillsRoot, 'review'));
    await writeFile(path.join(skillsRoot, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review safely.\n---\nUse review checks.\n');
    const catalog = await SkillCatalog.create(skillsRoot);
    const store = new TaskStore(stateDir);
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string; shell: false }> = [];
    const runner = new CodexRunner({
      workspaceRoot,
      catalog,
      store,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, ...options });
        return fakeChild();
      },
    });

    await runner.submit({ prompt: 'Summarize src.', skillIds: ['review'] });

    expect(spawnCalls[0]).toMatchObject({ command: 'codex', cwd: workspaceRoot, shell: false });
    expect(spawnCalls[0].args.slice(0, 3)).toEqual(['exec', '--json', expect.any(String)]);
    expect(spawnCalls[0].args.join(' ')).toContain('Use review checks.');
  });

  test('rejects skills that are not in the catalog before spawning', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    const catalog = await SkillCatalog.create(skillsRoot);
    const store = new TaskStore(stateDir);
    let spawned = false;
    const runner = new CodexRunner({
      workspaceRoot,
      catalog,
      store,
      spawn: () => { spawned = true; return fakeChild(); },
    });

    await expect(runner.submit({ prompt: 'run', skillIds: ['missing'] })).rejects.toThrow('Unknown skill');
    expect(spawned).toBe(false);
  });

  test('bounds the materialized selected-skill context', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    await mkdir(path.join(skillsRoot, 'large'));
    await writeFile(path.join(skillsRoot, 'large', 'SKILL.md'), `---\nname: large\ndescription: Large.\n---\n${'x'.repeat(200)}\n`);
    const runner = new CodexRunner({
      workspaceRoot,
      catalog: await SkillCatalog.create(skillsRoot),
      store: new TaskStore(stateDir),
      timeoutMs: 1000,
      maxSkillContextBytes: 64,
      spawn: (command, args) => {
        const child = fakeChild();
        expect(command).toBe('codex');
        expect(Buffer.byteLength(args[2], 'utf8')).toBeLessThanOrEqual(120);
        return child;
      },
    });

    await runner.submit({ prompt: 'run', skillIds: ['large'] });
  });

  test('rejects oversized prompt and Skill selections before persistence or spawn', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    const store = new TaskStore(stateDir);
    let spawned = false;
    const runner = new CodexRunner({
      workspaceRoot,
      catalog: await SkillCatalog.create(skillsRoot),
      store,
      maxPromptBytes: 4,
      maxSkillIds: 1,
      spawn: () => { spawned = true; return fakeChild(); },
    });

    await expect(runner.submit({ prompt: '12345', skillIds: [] })).rejects.toThrow('prompt exceeds');
    await expect(runner.submit({ prompt: 'ok', skillIds: ['a', 'b'] })).rejects.toThrow('skillIds exceeds');
    expect(spawned).toBe(false);
  });

  test('persists a failed task when process spawning throws synchronously', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    const store = new TaskStore(stateDir);
    const runner = new CodexRunner({
      workspaceRoot,
      catalog: await SkillCatalog.create(skillsRoot),
      store,
      spawn: () => { throw new Error('codex unavailable'); },
    });

    await expect(runner.submit({ prompt: 'run', skillIds: [] })).rejects.toThrow('codex unavailable');
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(stateDir));
    expect(files).toHaveLength(1);
    const task = await store.get(files[0].replace('.json', ''));
    expect(task).toMatchObject({ state: 'failed', error: 'codex unavailable' });
  });

  test('rejects non-finite or out-of-range execution limits', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    const base = {
      workspaceRoot,
      catalog: await SkillCatalog.create(skillsRoot),
      store: new TaskStore(stateDir),
      spawn: () => fakeChild(),
    };

    expect(() => new CodexRunner({ ...base, timeoutMs: Number.NaN })).toThrow('timeoutMs');
    expect(() => new CodexRunner({ ...base, maxSkillContextBytes: 0 })).toThrow('maxSkillContextBytes');
    expect(() => new CodexRunner({ ...base, maxPromptBytes: Infinity })).toThrow('maxPromptBytes');
    expect(() => new CodexRunner({ ...base, maxSkillIds: 257 })).toThrow('maxSkillIds');
  });

  test('rejects malformed or oversized Skill IDs before catalog reads', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    const runner = new CodexRunner({
      workspaceRoot,
      catalog: await SkillCatalog.create(skillsRoot),
      store: new TaskStore(stateDir),
      spawn: () => fakeChild(),
    });

    await expect(runner.submit({ prompt: 'run', skillIds: ['a'.repeat(65)] })).rejects.toThrow('skill ID');
    await expect(runner.submit({ prompt: 'run', skillIds: ['bad/id'] })).rejects.toThrow('skill ID');
  });

  test('rejects aggregate request metadata before reading Skills', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-state-'));
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-skills-'));
    roots.push(workspaceRoot, stateDir, skillsRoot);
    const runner = new CodexRunner({
      workspaceRoot,
      catalog: await SkillCatalog.create(skillsRoot),
      store: new TaskStore(stateDir),
      maxMetadataBytes: 40,
      spawn: () => fakeChild(),
    });

    await expect(runner.submit({ prompt: 'ok', skillIds: ['abcdefgh', 'abcdefgh'] })).rejects.toThrow('metadata exceeds');
  });
});
