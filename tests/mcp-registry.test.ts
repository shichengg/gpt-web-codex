import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { McpRegistry, type McpTransport, type RegisteredMcpServer, loadMcpRegistry } from '../src/mcp/registry.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fakeTransport: McpTransport = {
  async call(_server: RegisteredMcpServer, tool: string, input: unknown) {
    return { ok: true, tool, input };
  },
};

describe('McpRegistry', () => {
  test('the example MCP registry passes production validation', async () => {
    const registry = await loadMcpRegistry(path.resolve('examples/mcp-registry.json'));
    expect(registry.list()).toEqual([]);
  });

  test('permits only a registered local stdio tool', async () => {
    const registry = McpRegistry.fromJson({
      servers: [{ id: 'lint', command: 'node', args: ['lint.mjs'], allowedTools: ['check'] }],
    });

    await expect(registry.call('lint', 'check', {}, fakeTransport)).resolves.toEqual({
      ok: true,
      tool: 'check',
      input: {},
    });
  });

  test('rejects remote URLs, unknown servers, and unlisted tools', async () => {
    expect(() => McpRegistry.fromJson({ servers: [{ id: 'bad', url: 'https://example.test' }] })).toThrow('local stdio');
    const registry = McpRegistry.fromJson({
      servers: [{ id: 'lint', command: 'node', allowedTools: ['check'] }],
    });

    await expect(registry.call('missing', 'check', {}, fakeTransport)).rejects.toThrow('Unknown MCP server');
    await expect(registry.call('lint', 'delete', {}, fakeTransport)).rejects.toThrow('not allowed');
  });

  test('rejects unsafe or malformed server entries', () => {
    const invalidEntries = [
      { id: 'empty-command', command: '', allowedTools: ['check'] },
      { id: 'wildcard', command: 'node', allowedTools: ['*'] },
      { id: 'bad-timeout', command: 'node', allowedTools: ['check'], timeoutMs: 999 },
      { id: 'bad-timeout', command: 'node', allowedTools: ['check'], timeoutMs: 120001 },
    ];

    for (const entry of invalidEntries) {
      expect(() => McpRegistry.fromJson({ servers: [entry] })).toThrow();
    }
    expect(() => McpRegistry.fromJson({
      servers: [
        { id: 'duplicate', command: 'node', allowedTools: ['check'] },
        { id: 'duplicate', command: 'node', allowedTools: ['check'] },
      ],
    })).toThrow('duplicate');
  });

  test('loads and applies defaults from a JSON registry file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-mcp-'));
    temporaryRoots.push(root);
    const registryPath = path.join(root, 'mcp-registry.json');
    const workspaceRoot = path.join(root, 'workspace');
    const entrypoint = path.join(workspaceRoot, '.codex', 'mcp', 'lint.cjs');
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, 'process.stdin.resume();');
    await writeFile(registryPath, JSON.stringify({
      servers: [{ id: 'lint', command: 'node', args: [entrypoint], allowedTools: ['check'] }],
    }));

    const registry = await loadMcpRegistry(registryPath, workspaceRoot);
    expect(registry.get('lint')).toMatchObject({ id: 'lint', command: 'node', args: [entrypoint], timeoutMs: 30000 });
  });

  test('rejects mutable registry files with an external entrypoint before a stdio process can run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-mcp-external-'));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const outsideEntrypoint = path.join(root, 'outside.cjs');
    const registryPath = path.join(root, 'mcp-registry.json');
    await mkdir(path.join(workspaceRoot, '.codex', 'mcp'), { recursive: true });
    await writeFile(outsideEntrypoint, 'process.stdin.resume();');
    await writeFile(registryPath, JSON.stringify({
      servers: [{ id: 'outside', command: 'node', args: [outsideEntrypoint], allowedTools: ['check'] }],
    }));

    await expect(loadMcpRegistry(registryPath, workspaceRoot)).rejects.toThrow('contained');
  });
});
