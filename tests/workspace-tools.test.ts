import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createPathPolicy } from '../src/security/paths.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace tools', () => {
  test('reads and searches only allowed workspace files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const needle = true;');
    await writeFile(path.join(root, '.env'), 'TOKEN=secret');
    const tools = createWorkspaceTools(root, await createPathPolicy(root));

    await expect(tools.readFile('src/a.ts')).resolves.toMatchObject({ text: expect.stringContaining('export'), truncated: false });
    await expect(tools.readFile('.env')).rejects.toThrow('sensitive');
    await expect(tools.search('needle')).resolves.toMatchObject({ matches: expect.any(Array) });
  });

  test('bounds file reads and directory listings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(70_000));
    const tools = createWorkspaceTools(root, await createPathPolicy(root));

    await expect(tools.readFile('large.txt')).resolves.toMatchObject({ text: expect.any(String), truncated: true });
    await expect(tools.listDirectory('.')).resolves.toEqual(expect.arrayContaining([{ name: 'large.txt', type: 'file' }]));
  });

  test('rejects binary files and caps directory enumeration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([120, 0, 121]));
    await Promise.all(Array.from({ length: 250 }, (_, index) => writeFile(path.join(root, `entry-${index}.txt`), 'x')));
    const tools = createWorkspaceTools(root, await createPathPolicy(root));

    await expect(tools.readFile('binary.bin')).rejects.toThrow('binary');
    await expect(tools.listDirectory('.')).resolves.toHaveLength(200);
  });

  test('reports search traversal truncation when a directory exceeds its entry cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await Promise.all(Array.from({ length: 250 }, (_, index) => writeFile(path.join(root, `entry-${index}.txt`), 'x')));
    const tools = createWorkspaceTools(root, await createPathPolicy(root));

    await expect(tools.search('needle')).resolves.toMatchObject({ matches: [], truncated: true });
  });

  test('caps inspected entries even when earlier entries are rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(path.join(root, `.env-${String(index).padStart(3, '0')}`), 'secret')));
    await writeFile(path.join(root, 'zzz-allowed.txt'), 'visible');
    const tools = createWorkspaceTools(root, await createPathPolicy(root));

    await expect(tools.listDirectory('.')).resolves.not.toContainEqual({ name: 'zzz-allowed.txt', type: 'file' });
  });

  test('does not expose task state files when the state root is inside the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    const state = path.join(root, '.codex', 'state');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'task.json'), 'needle secret');
    const { createPathPolicy } = await import('../src/security/paths.js');
    const tools = createWorkspaceTools(root, await createPathPolicy(root, { deniedRoots: [state] }));

    await expect(tools.readFile('.codex/state/task.json')).rejects.toThrow('denied');
    await expect(tools.listDirectory('.codex/state')).rejects.toThrow('denied');
    await expect(tools.search('needle')).resolves.toMatchObject({ matches: [] });
  });

  test('applies global search scan budgets and reports their metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await Promise.all(Array.from({ length: 4 }, (_, index) => writeFile(path.join(root, `f-${index}.txt`), 'needle')));
    const tools = createWorkspaceTools(root, await createPathPolicy(root), { maxSearchFiles: 2, maxSearchEntries: 10, maxSearchBytes: 100, maxSearchMs: 5_000 });

    await expect(tools.search('needle')).resolves.toMatchObject({
      truncated: true,
      scan: { files: 2, entries: 2, bytes: 12 },
    });
  });

  test('never reads more than the remaining global search byte budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await writeFile(path.join(root, 'large.txt'), 'needle'.repeat(20_000));
    const tools = createWorkspaceTools(root, await createPathPolicy(root), { maxSearchFiles: 10, maxSearchEntries: 10, maxSearchBytes: 1, maxSearchMs: 5_000 });

    await expect(tools.search('needle')).resolves.toMatchObject({
      truncated: true,
      scan: { files: 1, entries: 1, bytes: 1 },
    });
  });
});
