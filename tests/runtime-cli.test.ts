import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map(async (child) => { await once(child, 'exit'); }));
  children.clear();
});

test('emits one secret-free IPv6 runtime-ready record on stdout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-cli-'));
  const skillsRoot = path.join(root, 'skills');
  const stateDir = path.join(root, 'state');
  const registryPath = path.join(root, 'mcp-registry.json');
  const token = 'runtime-test-secret';
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(registryPath, '{"servers":[]}\n');
  const child = spawn(process.execPath, [path.resolve('node_modules/vite-node/vite-node.mjs'), 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_WORKSPACE_ROOT: root,
      CODEX_CONNECTOR_TOKEN: token,
      CODEX_SKILLS_ROOT: skillsRoot,
      CODEX_STATE_DIR: stateDir,
      CODEX_MCP_REGISTRY: registryPath,
      CODEX_HOST: '::1',
      CODEX_PORT: '0',
    },
  });
  children.add(child);
  let stdout = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });

  await waitFor(() => stdout.includes('\n'));
  const records = stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; url: string });

  expect(records).toEqual([{ type: 'runtime-ready', url: expect.stringMatching(/^http:\/\/\[::1\]:\d+\/mcp$/) }]);
  expect(stdout).not.toContain(token);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for runtime-ready output');
}
