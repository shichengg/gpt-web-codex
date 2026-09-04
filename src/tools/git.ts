import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PathPolicy } from '../security/paths.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_BYTES = 128 * 1024;

export interface NotGitRepository {
  code: 'not_git_repository';
}

export type GitResult = string | NotGitRepository;

export interface GitTools {
  status(): Promise<GitResult>;
  diff(): Promise<GitResult>;
}

export function createGitTools(root: string, paths: PathPolicy): GitTools {
  return {
    status: () => runGit(root, paths, ['status', '--short']),
    diff: () => runGit(root, paths, ['diff', '--no-ext-diff', '--unified=3']),
  };
}

async function runGit(root: string, paths: PathPolicy, args: string[]): Promise<GitResult> {
  const cwd = await paths.resolve('.');
  try {
    const result = await execFileAsync('git', args, { cwd, maxBuffer: MAX_GIT_BYTES });
    return result.stdout.slice(0, MAX_GIT_BYTES);
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string };
    if (failure.code === 128 || failure.stderr?.toLowerCase().includes('not a git repository')) {
      return { code: 'not_git_repository' };
    }
    throw error;
  }
}
