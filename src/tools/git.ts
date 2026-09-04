import { spawn } from 'node:child_process';
import type { PathPolicy } from '../security/paths.js';

const MAX_GIT_BYTES = 128 * 1024;

export interface NotGitRepository {
  code: 'not_git_repository';
}

export interface TruncatedGitOutput {
  code: 'output_truncated';
  output: string;
  truncated: true;
}

export type GitResult = string | NotGitRepository | TruncatedGitOutput;

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
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let output = '';
    let stderr = '';
    let truncated = false;
    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      const remaining = MAX_GIT_BYTES - output.length;
      if (remaining > 0) output += text.slice(0, remaining);
      if (text.length > Math.max(remaining, 0)) truncated = true;
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const remaining = 4096 - stderr.length;
      if (remaining > 0) stderr += chunk.toString().slice(0, remaining);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(truncated ? { code: 'output_truncated', output, truncated: true } : output);
        return;
      }
      if (code === 128 || stderr.toLowerCase().includes('not a git repository')) {
        resolve({ code: 'not_git_repository' });
        return;
      }
      reject(new Error(`git exited with code ${code}: ${stderr}`));
    });
  });
}
