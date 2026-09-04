import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { createGitTools } from '../src/tools/git.js';
import { createPathPolicy } from '../src/security/paths.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('git tools', () => {
  test('returns status and a bounded diff from the configured Git repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-git-'));
    roots.push(root);
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    const file = path.join(root, 'README.md');
    await writeFile(file, 'before\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root });
    await writeFile(file, 'after\n');
    const git = createGitTools(root, await createPathPolicy(root));

    await expect(git.status()).resolves.toContain(' M README.md');
    await expect(git.diff()).resolves.toContain('diff --git');
  });

  test('returns a structured result for a non-Git root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-not-git-'));
    roots.push(root);
    const git = createGitTools(root, await createPathPolicy(root));

    await expect(git.status()).resolves.toEqual({ code: 'not_git_repository' });
    await expect(git.diff()).resolves.toEqual({ code: 'not_git_repository' });
  });
});
