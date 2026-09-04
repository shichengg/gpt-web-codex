import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CodexRunner } from '../src/codex/runner.js';
import { TaskStore } from '../src/codex/tasks.js';
import { McpRegistry, type McpTransport } from '../src/mcp/registry.js';
import { createPathPolicy } from '../src/security/paths.js';
import { SkillCatalog } from '../src/skills/catalog.js';
import { createGitTools } from '../src/tools/git.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';
import { createServer, type ConnectorServer, type ConnectorDependencies } from '../src/server.js';

async function fixture(http = false, codexOverride?: CodexRunner): Promise<{ server: ConnectorServer; auth: { token: string } }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-'));
  const skillsRoot = path.join(root, 'skills');
  const stateDir = path.join(root, 'state');
  await mkdir(path.join(skillsRoot, 'review'), { recursive: true });
  await writeFile(path.join(skillsRoot, 'review', 'SKILL.md'), '---\nname: Review\ndescription: Review code\n---\nReview the code.\n');
  const paths = await createPathPolicy(root);
  const catalog = await SkillCatalog.create(skillsRoot);
  const taskStore = new TaskStore(stateDir);
  const runner = new CodexRunner({
    workspaceRoot: root,
    catalog,
    store: taskStore,
    spawn: () => ({
      stdout: { on: (_event: string, _listener: (chunk: unknown) => void) => undefined },
      stderr: { on: (_event: string, _listener: (chunk: unknown) => void) => undefined },
      on: (_event: string, _listener: (...args: unknown[]) => void) => undefined,
      once: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'close') queueMicrotask(() => listener(0, null));
        return undefined;
      },
      kill: () => true,
    }),
  });
  const registry = McpRegistry.fromJson({
    servers: [{ id: 'lint', command: 'lint-server', allowedTools: ['check'] }],
  });
  const transport: McpTransport = { call: async () => ({ ok: true }) };
  const dependencies: ConnectorDependencies = {
    token: 'secret',
    workspace: createWorkspaceTools(root, paths),
    git: createGitTools(root, paths),
    skills: catalog,
    mcp: registry,
    mcpTransport: transport,
    codex: codexOverride ?? runner,
    tasks: taskStore,
    ...(http ? { http: { host: '127.0.0.1', port: 0 } } : {}),
  };
  return { server: await createServer(dependencies), auth: { token: 'secret' } };
}

describe('authenticated connector', () => {
  test('rejects an unauthenticated connector request', async () => {
    const { server } = await fixture();
    try {
      const response = await server.call('workspace_info', {}, { token: 'wrong' });
      expect(response).toEqual({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    } finally {
      await server.close();
    }
  });

  test('serves Skills, allowed MCP tools, and fake Codex task status through one connector', async () => {
    const { server, auth } = await fixture();
    try {
      expect(await server.call('list_skills', {}, auth)).toMatchObject({ skills: [{ id: 'review' }] });
      expect(await server.call('call_mcp_tool', { serverId: 'lint', tool: 'check', input: {} }, auth)).toMatchObject({ ok: true });
      const task = await server.call('codex_submit', { prompt: 'Review.', skillIds: ['review'] }, auth) as { id: string };
      expect(await server.call('codex_status', { taskId: task.id }, auth)).toMatchObject({ state: 'succeeded' });
    } finally {
      await server.close();
    }
  });

  test('rejects unknown tools and malformed input with structured errors', async () => {
    const { server, auth } = await fixture();
    try {
      expect(await server.call('no_such_tool', {}, auth)).toMatchObject({ error: { code: 'unknown_tool' } });
      expect(await server.call('read_file', { relativePath: 1 }, auth)).toMatchObject({ error: { code: 'validation_error' } });
      expect(await server.call('call_mcp_tool', { serverId: 'lint', tool: 'check', input: [] }, auth)).toMatchObject({ error: { code: 'validation_error' } });
    } finally {
      await server.close();
    }
  });

  test('serves the real MCP protocol with authenticated schemas and parameterized calls', async () => {
    const { server } = await fixture(true);
    const client = new Client({ name: 'integration-test', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.httpAddress!), {
      requestInit: { headers: { authorization: 'Bearer secret' } },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const readFile = listed.tools.find((tool) => tool.name === 'read_file');
      expect(readFile?.inputSchema).toMatchObject({ required: ['relativePath'] });
      const result = await client.callTool({ name: 'list_directory', arguments: { relativePath: '.' } });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('closes an active MCP request before stopping the listener', async () => {
    const { server } = await fixture(true);
    const address = new URL(server.httpAddress!);
    const request = httpRequest({ hostname: address.hostname, port: Number(address.port), path: '/mcp', method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' } });
    request.on('error', () => undefined);
    const ended = new Promise<void>((resolve) => request.once('close', resolve));
    request.write('{');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.close();
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 500))]);
    request.destroy();
    expect(server.httpAddress).toBeUndefined();
  });

  test('propagates close cancellation to an active Codex operation', async () => {
    const blockingCodex = {
      submit: async (_request: unknown, signal?: AbortSignal) => await new Promise<{ id: string; state: 'cancelled'; createdAt: string; updatedAt: string }>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ id: '00000000-0000-0000-0000-000000000000', state: 'cancelled', createdAt: '', updatedAt: '' }), { once: true });
      }),
    };
    const { server, auth } = await fixture(false, blockingCodex as unknown as CodexRunner);
    const pending = server.call('codex_submit', { prompt: 'Wait.', skillIds: [] }, auth);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.close();
    await expect(pending).resolves.toMatchObject({ state: 'cancelled' });
  });
});
