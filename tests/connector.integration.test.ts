import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CodexRunner } from '../src/codex/runner.js';
import { TaskStore } from '../src/codex/tasks.js';
import { McpRegistry, type McpTransport } from '../src/mcp/registry.js';
import { createPathPolicy } from '../src/security/paths.js';
import { SkillCatalog } from '../src/skills/catalog.js';
import { createGitTools } from '../src/tools/git.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';
import { createServer, type ConnectorServer, type ConnectorDependencies } from '../src/server.js';

async function fixture(): Promise<{ server: ConnectorServer; auth: { token: string } }> {
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
    codex: runner,
    tasks: taskStore,
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
    } finally {
      await server.close();
    }
  });
});
