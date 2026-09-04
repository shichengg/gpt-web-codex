import { mkdtemp, mkdir, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createPathPolicy } from '../src/security/paths.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-paths-'));
  temporaryRoots.push(root);
  return root;
}

describe('createPathPolicy', () => {
  test('resolves an ordinary in-root path', async () => {
    const root = await makeWorkspace();
    const policy = await createPathPolicy(root);

    await writeFile(path.join(root, 'README.md'), 'ok');

    expect(await policy.resolve('README.md')).toBe(await realpath(path.join(root, 'README.md')));
  });

  test('rejects traversal and absolute paths', async () => {
    const root = await makeWorkspace();
    const policy = await createPathPolicy(root);

    await expect(policy.resolve('../secret.txt')).rejects.toThrow('outside the allowed root');
    await expect(policy.resolve('C:/secret.txt')).rejects.toThrow('relative path');
  });

  test('rejects a symlink that resolves outside the root', async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-outside-'));
    temporaryRoots.push(outside);
    await mkdir(path.join(outside, 'nested'));
    await symlink(outside, path.join(root, 'escape-link'), 'junction');
    const policy = await createPathPolicy(root);

    await expect(policy.resolve('escape-link/key.txt')).rejects.toThrow('outside the allowed root');
  });

  test('rejects sensitive paths', async () => {
    const root = await makeWorkspace();
    const policy = await createPathPolicy(root);

    for (const relativePath of ['.env', 'cert.pem', 'private.key', 'credentials.json', 'token.txt', '.git/config']) {
      await expect(policy.resolve(relativePath)).rejects.toThrow('sensitive');
    }
  });

  test('denies a canonical excluded root even when it is below the workspace root', async () => {
    const root = await makeWorkspace();
    const stateRoot = path.join(root, '.codex', 'state');
    await mkdir(stateRoot, { recursive: true });
    const policy = await createPathPolicy(root, { deniedRoots: [stateRoot] });

    await expect(policy.resolve('.codex/state/task.json')).rejects.toThrow('denied');
  });
});
