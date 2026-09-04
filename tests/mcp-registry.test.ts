import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await writeFile(registryPath, JSON.stringify({
      servers: [{ id: 'lint', command: 'node', args: ['lint.mjs'], allowedTools: ['check'] }],
    }));

    const registry = await loadMcpRegistry(registryPath);
    expect(registry.get('lint')).toMatchObject({ id: 'lint', command: 'node', args: ['lint.mjs'], timeoutMs: 30000 });
  });
});
