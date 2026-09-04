import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { BridgeConfig } from '../src/config.js';
import { startRuntime } from '../src/runtime.js';

const runtimes: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('managed runtime lifecycle', () => {
  test('reports a loopback MCP URL for an ephemeral port', async () => {
    const runtime = await startRuntime(await configWithPort(0));
    runtimes.push(runtime);

    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  test('closes the listener and reports its stopped snapshot', async () => {
    const runtime = await startRuntime(await configWithPort(0));
    runtimes.push(runtime);

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(runtime.snapshot()).toMatchObject({ state: 'stopped' });
  });
});

async function configWithPort(port: number): Promise<BridgeConfig> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-runtime-'));
  const skillsRoot = path.join(workspaceRoot, 'skills');
  const stateDir = path.join(workspaceRoot, 'state');
  const mcpRegistryPath = path.join(workspaceRoot, 'mcp-registry.json');
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(mcpRegistryPath, '{"servers":[]}\n');
  return {
    host: '127.0.0.1',
    port,
    workspaceRoot,
    skillsRoot,
    stateDir,
    connectorToken: 'test-token',
    mcpRegistryPath,
  };
}
