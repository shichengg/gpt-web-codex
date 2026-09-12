import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

async function fixture(http = false, codexOverride?: CodexRunner, transportOverride?: McpTransport, defaultSkillIds: string[] = [], emptyMcp = false): Promise<{ server: ConnectorServer; auth: { token: string } }> {
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
  const registry = McpRegistry.fromJson(emptyMcp ? { servers: [] } : {
    servers: [{ id: 'lint', command: 'lint-server', allowedTools: ['check'] }],
  });
  const transport: McpTransport = { call: async () => ({ ok: true }) };
  const dependencies: ConnectorDependencies = {
    token: 'secret',
    workspace: createWorkspaceTools(root, paths),
    git: createGitTools(root, paths),
    skills: catalog,
    mcp: registry,
    mcpTransport: transportOverride ?? transport,
    codex: codexOverride ?? runner,
    tasks: taskStore,
    defaultSkillIds,
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
      expect(await server.call('skills_mcp', { action: 'status' }, auth)).toMatchObject({ skills: [{ id: 'review' }], mcp_configured: true });
      expect(await server.call('skills_mcp', { action: 'list_mcp_tools', server_id: 'lint' }, auth)).toMatchObject({ server_id: 'lint', tools: ['check'] });
      expect(await server.call('call_mcp_tool', { serverId: 'lint', tool: 'check', input: {} }, auth)).toMatchObject({ ok: true });
      const task = await server.call('codex_submit', { prompt: 'Review.', skillIds: ['review'] }, auth) as { id: string };
      expect(await server.call('codex_status', { taskId: task.id }, auth)).toMatchObject({ state: 'running' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await server.call('codex_status', { taskId: task.id }, auth)).toMatchObject({ state: 'succeeded' });
    } finally {
      await server.close();
    }
  });

  test('skills_mcp reports an optional empty MCP registry without blocking Skills', async () => {
    const { server, auth } = await fixture(false, undefined, undefined, [], true);
    try {
      const empty = await server.call('skills_mcp', { action: 'status' }, auth);
      expect(empty).toMatchObject({ mcp_configured: false, note: expect.stringMatching(/optional/i) });
      const listed = await server.call('skills_mcp', { action: 'list_skills' }, auth);
      expect(listed).toMatchObject({ skills: [{ id: 'review' }] });
    } finally {
      await server.close();
    }
  });

  test('uses workspace default Skills only when a task omits skillIds', async () => {
    const submitted: Array<{ prompt: string; skillIds: string[]; skillSelection?: 'auto' | 'explicit' }> = [];
    const codex = {
      submit: async (request: { prompt: string; skillIds: string[]; skillSelection?: 'auto' | 'explicit' }) => {
        submitted.push(request);
        return { id: '00000000-0000-0000-0000-000000000001', state: 'running', createdAt: '', updatedAt: '' };
      },
    };
    const { server, auth } = await fixture(false, codex as unknown as CodexRunner, undefined, ['review']);
    try {
      await server.call('codex_submit', { prompt: 'Inspect.' }, auth);
      await server.call('codex_submit', { prompt: 'Override.', skillIds: [] }, auth);
      await server.call('codex_submit', { prompt: 'Choose other.', skillIds: ['other'] }, auth);

      expect(submitted).toEqual([
        { prompt: 'Inspect.', skillIds: ['review'], skillSelection: 'auto' },
        { prompt: 'Override.', skillIds: [], skillSelection: 'explicit' },
        { prompt: 'Choose other.', skillIds: ['other'], skillSelection: 'explicit' },
      ]);
    } finally {
      await server.close();
    }
  });

  test('agent workflow loads Skill metadata by default and full instructions when explicit', async () => {
    const submitted: Array<{ prompt: string; skillIds: string[]; skillSelection?: 'auto' | 'explicit' }> = [];
    const codex = {
      submit: async (request: { prompt: string; skillIds: string[]; skillSelection?: 'auto' | 'explicit' }) => {
        submitted.push(request);
        return { id: '00000000-0000-0000-0000-000000000002', state: 'running', createdAt: '', updatedAt: '' };
      },
    };
    const { server, auth } = await fixture(false, codex as unknown as CodexRunner, undefined, ['review']);
    try {
      await server.call('agent_workflow', { objective: 'Inspect.', phase: 'execute' }, auth);
      await server.call('agent_workflow', { objective: 'Use review.', phase: 'execute', skill_ids: ['review'] }, auth);
      await server.call('agent_workflow', { objective: 'No skills.', phase: 'execute', skill_ids: [] }, auth);
      expect(submitted).toEqual([
        { prompt: 'Inspect.', skillIds: ['review'], skillSelection: 'auto' },
        { prompt: 'Use review.', skillIds: ['review'], skillSelection: 'explicit' },
        { prompt: 'No skills.', skillIds: [], skillSelection: 'explicit' },
      ]);
    } finally {
      await server.close();
    }
  });

  test('submits, polls, reads output, and cancels through fixed task routes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-task-lifecycle-'));
    const skillsRoot = path.join(root, 'skills');
    await mkdir(skillsRoot, { recursive: true });
    const paths = await createPathPolicy(root);
    const id = '00000000-0000-0000-0000-000000000001';
    let task = { id, state: 'running', output: 'working', outputTruncated: false, createdAt: '', updatedAt: '' };
    const codex = {
      submit: async () => task,
      cancel: async (taskId: string) => {
        expect(taskId).toBe(id);
        task = { ...task, state: 'cancelled' };
        return task;
      },
    };
    const dependencies: ConnectorDependencies = {
      token: 'secret',
      workspace: createWorkspaceTools(root, paths),
      git: createGitTools(root, paths),
      skills: await SkillCatalog.create(skillsRoot),
      mcp: McpRegistry.fromJson({ servers: [] }),
      mcpTransport: { call: async () => ({}) },
      codex: codex as unknown as CodexRunner,
      tasks: { get: async (taskId: string) => {
        expect(taskId).toBe(id);
        return task;
      } } as unknown as TaskStore,
    };
    const server = await createServer(dependencies);
    const auth = { token: 'secret' };
    try {
      expect(await server.call('codex_submit', { prompt: 'Inspect.', skillIds: [] }, auth)).toMatchObject({ id, state: 'running' });
      expect(await server.call('codex_status', { taskId: id }, auth)).toMatchObject({ id, state: 'running' });
      expect(await server.call('codex_output', { taskId: id }, auth)).toMatchObject({ id, state: 'running', output: 'working' });
      expect(await server.call('codex_cancel', { taskId: id }, auth)).toMatchObject({ id, state: 'cancelled' });
      expect(await server.call('codex_status', { taskId: id }, auth)).toMatchObject({ id, state: 'cancelled' });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
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
      expect(listed.tools.some((tool) => tool.name === 'skills')).toBe(true);
      expect(listed.tools.some((tool) => tool.name === 'mcp')).toBe(true);
      expect(listed.tools.some((tool) => tool.name === 'skills_mcp')).toBe(false);
      const workspaceContext = listed.tools.find((tool) => tool.name === 'workspace_context');
      expect(workspaceContext?.description).toMatch(/Preferred read-only tool/i);
      expect(workspaceContext?.inputSchema).toMatchObject({ properties: { detail: expect.any(Object), max_entries: expect.any(Object) } });
      expect(listed.tools.find((tool) => tool.name === 'agent_workflow')?.inputSchema).toMatchObject({ properties: { objective: expect.any(Object), phase: expect.any(Object) } });
      expect(listed.tools.find((tool) => tool.name === 'coding_tools_guide')?.outputSchema).toBeDefined();
      const result = await client.callTool({ name: 'workspace_context', arguments: { path: '.', max_entries: 10, detail: 'compact' } });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('keeps Skills and optional MCP as separate public tools', async () => {
    const { server, auth } = await fixture(false, undefined, undefined, [], true);
    try {
      expect(await server.call('coding_tools_guide', {}, auth)).toMatchObject({
        preferred_flow: ['workspace_context', 'agent_workflow', 'task_control', 'skills', 'mcp'],
      });
      expect(await server.call('skills', { action: 'list' }, auth)).toMatchObject({ skills: [{ id: 'review' }] });
      expect(await server.call('mcp', { action: 'status' }, auth)).toMatchObject({ configured: false, optional: true });
      expect(await server.call('skills_mcp', { action: 'list_skills' }, auth)).toMatchObject({ skills: [{ id: 'review' }] });
    } finally {
      await server.close();
    }
  });

  test('returns downstream MCP input schemas so ChatGPT can call discovered tools', async () => {
    const transport: McpTransport = {
      call: async () => ({ ok: true }),
      listTools: async () => [{
        name: 'stata_run_dofile',
        description: 'Run a do-file and create a visible Stata session.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, session_id: { type: 'string' } }, required: ['path'] },
      }],
    };
    const { server, auth } = await fixture(false, undefined, transport);
    try {
      expect(await server.call('mcp', { action: 'list_tools', server_id: 'lint' }, auth)).toMatchObject({
        tools: [{ name: 'stata_run_dofile', inputSchema: { required: ['path'] } }],
      });
    } finally {
      await server.close();
    }
  });

  test('explains how ChatGPT must create the first Stata GUI session', async () => {
    const registry = McpRegistry.fromJson({ servers: [{ id: 'stata', command: 'stata-gui-mcp', args: [], allowedTools: ['stata_run_dofile'] }] });
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-stata-guide-'));
    const skills = await SkillCatalog.create(root);
    const paths = await createPathPolicy(root);
    const tasks = new TaskStore(path.join(root, 'state'));
    const server = await createServer({
      token: 'secret', workspace: createWorkspaceTools(root, paths), git: createGitTools(root, paths), skills,
      mcp: registry,
      mcpTransport: { call: async () => ({}), listTools: async () => [{ name: 'stata_run_dofile', inputSchema: { type: 'object', required: ['path'] } }] },
      codex: {} as CodexRunner, tasks,
    } as ConnectorDependencies);
    try {
      expect(await server.call('mcp', { action: 'list_tools', server_id: 'stata' }, { token: 'secret' })).toMatchObject({
        usage_note: expect.stringMatching(/first visible Stata GUI session.*absolute \.do path/i),
      });
    } finally {
      await server.close();
    }
  });

  test('does not reject an authenticated Streamable HTTP GET probe as an unknown route', async () => {
    const { server } = await fixture(true);
    const address = new URL(server.httpAddress!);
    try {
      await expect(getMcpProbe(address)).resolves.not.toBe(404);
    } finally {
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

  test('cleans up malformed and oversized HTTP uploads before serving later MCP calls', async () => {
    const { server } = await fixture(true);
    const address = new URL(server.httpAddress!);
    expect(await postMcp(address, '{')).toBe(500);
    expect(await postMcp(address, 'x'.repeat(1024 * 1024 + 1))).toBe(500);
    const client = new Client({ name: 'cleanup-test', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(address, { requestInit: { headers: { authorization: 'Bearer secret' } } });
    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    } finally {
      await client.close();
      await server.close();
    }
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

  test('aborts an in-flight MCP operation when its HTTP response disconnects', async () => {
    let observedAbort = false;
    const transport: McpTransport = {
      call: async (_server, _tool, _input, signal) => await new Promise((resolve) => {
        signal?.addEventListener('abort', () => { observedAbort = true; resolve({ cancelled: true }); }, { once: true });
      }),
    };
    const { server } = await fixture(true, undefined, transport);
    const client = new Client({ name: 'disconnect-test', version: '0.1.0' });
    const clientTransport = new StreamableHTTPClientTransport(new URL(server.httpAddress!), {
      requestInit: { headers: { authorization: 'Bearer secret' } },
    });
    await client.connect(clientTransport);
    const pending = client.callTool({ name: 'mcp', arguments: { action: 'call_tool', server_id: 'lint', tool: 'check', input: {} } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.close();
    for (let attempt = 0; attempt < 20 && !observedAbort; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await pending;
    expect(observedAbort).toBe(true);
    await server.close();
  });
});

function postMcp(address: URL, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: address.hostname,
      port: Number(address.port),
      path: address.pathname,
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function getMcpProbe(address: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: address.hostname,
      port: Number(address.port),
      path: address.pathname,
      method: 'GET',
      headers: { authorization: 'Bearer secret', accept: 'text/event-stream' },
    }, (response) => {
      resolve(response.statusCode ?? 0);
      response.destroy();
    });
    request.once('error', reject);
    request.end();
  });
}
