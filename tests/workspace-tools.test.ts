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

    await expect(tools.readFile('src/a.ts')).resolves.toContain('export');
    await expect(tools.readFile('.env')).rejects.toThrow('sensitive');
    await expect(tools.search('needle')).resolves.toMatchObject({ matches: expect.any(Array) });
  });

  test('bounds file reads and directory listings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-workspace-'));
    roots.push(root);
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(70_000));
    const tools = createWorkspaceTools(root, await createPathPolicy(root));

    await expect(tools.readFile('large.txt')).resolves.toHaveLength(64 * 1024);
    await expect(tools.listDirectory('.')).resolves.toEqual(expect.arrayContaining([{ name: 'large.txt', type: 'file' }]));
  });
});
