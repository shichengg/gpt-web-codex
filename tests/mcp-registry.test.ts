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

  test('loads approved Stata GUI MCP executable and Python module forms', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-stata-mcp-'));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const registryPath = path.join(root, 'mcp-registry.json');
    const stataCommand = path.join(root, 'stata-gui-mcp.exe');
    const pythonCommand = path.join(root, 'python.exe');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(stataCommand, 'stub');
    await writeFile(pythonCommand, 'stub');
    await writeFile(registryPath, JSON.stringify({ servers: [
      { id: 'stata', command: stataCommand, args: [], allowedTools: ['stata_status'] },
      { id: 'stata-python', command: pythonCommand, args: ['-m', 'stata_mcp'], allowedTools: ['stata_status'] },
    ] }));
    const registry = await loadMcpRegistry(registryPath, workspaceRoot);
    expect(registry.list()).toHaveLength(2);
  });

  test('loads a loopback Streamable HTTP MCP and rejects remote HTTP', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-http-mcp-'));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const registryPath = path.join(root, 'mcp-registry.json');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ servers: [{ id: 'zotero', transport: 'streamable-http', command: '', args: [], url: 'http://127.0.0.1:23120/mcp', allowedTools: ['search_library'] }] }));
    await expect(loadMcpRegistry(registryPath, workspaceRoot)).resolves.toBeDefined();
    expect(() => McpRegistry.fromJson({ servers: [{ id: 'remote', transport: 'streamable-http', command: '', url: 'https://example.com/mcp', allowedTools: ['search'] }] })).toThrow(/loopback/i);
  });

  test('preserves disabled MCP servers without exposing credentials', () => {
    const registry = McpRegistry.fromJson({
      servers: [{ id: 'zotero', transport: 'streamable-http', url: 'http://127.0.0.1:23120/mcp', allowedTools: ['search_library'], timeoutMs: 30000, enabled: false }],
    });
    expect(registry.get('zotero')).toMatchObject({ enabled: false });
    expect(registry.list()).not.toContainEqual(expect.objectContaining({ headers: expect.anything() }));
    return expect(registry.call('zotero', 'search_library', {}, fakeTransport)).rejects.toThrow(/disabled/i);
  });

  test('allows an initially empty tool allowlist for discovery', () => {
    const registry = McpRegistry.fromJson({
      servers: [{ id: 'custom', command: 'node', args: ['custom.cjs'], allowedTools: [], timeoutMs: 30000 }],
    });
    expect(registry.get('custom')?.allowedTools).toEqual([]);
    return expect(registry.call('custom', 'unknown', {}, fakeTransport)).rejects.toThrow(/not allowed/i);
  });

  test('loads a generic absolute local executable but rejects shell hosts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-exe-mcp-'));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const registryPath = path.join(root, 'mcp-registry.json');
    const command = path.join(root, 'local-mcp.exe');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(command, 'stub');
    await writeFile(registryPath, JSON.stringify({ servers: [{ id: 'local', command, args: ['--stdio'], allowedTools: ['status'] }] }));
    await expect(loadMcpRegistry(registryPath, workspaceRoot)).resolves.toBeDefined();
    expect(() => McpRegistry.fromJson({ servers: [{ id: 'shell', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'whoami'], allowedTools: ['status'] }] })).not.toThrow();
    await writeFile(registryPath, JSON.stringify({ servers: [{ id: 'shell', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'whoami'], allowedTools: ['status'] }] }));
    await expect(loadMcpRegistry(registryPath, workspaceRoot)).rejects.toThrow(/approved/i);
  });
});
