import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CodexRunner } from './codex/runner.js';
import type { TaskStore } from './codex/tasks.js';
import type { McpRegistry, McpTransport } from './mcp/registry.js';
import type { SkillCatalog } from './skills/catalog.js';
import type { GitTools } from './tools/git.js';
import type { WorkspaceTools } from './tools/workspace.js';

export interface ConnectorDependencies {
  token: string;
  workspace: WorkspaceTools;
  git: GitTools;
  skills: SkillCatalog;
  mcp: McpRegistry;
  mcpTransport: McpTransport;
  codex: CodexRunner;
  tasks: TaskStore;
  close?: () => Promise<void>;
}

export interface ConnectorError {
  code: 'unauthorized' | 'validation_error' | 'policy_denied' | 'unknown_id' | 'timeout' | 'internal_error' | 'unknown_tool';
  message: string;
}

export type ConnectorResponse = Record<string, unknown> | { error: ConnectorError };
export interface ConnectorServer {
  call(tool: string, input: unknown, auth?: { token?: string }): Promise<ConnectorResponse>;
  close(): Promise<void>;
}

const tools = {
  workspace_info: z.object({}).strict(),
  list_directory: z.object({ relativePath: z.string().trim().min(1).default('.') }).strict(),
  read_file: z.object({ relativePath: z.string().trim().min(1) }).strict(),
  search_workspace: z.object({ needle: z.string().min(1) }).strict(),
  git_status: z.object({}).strict(),
  git_diff: z.object({}).strict(),
  list_skills: z.object({}).strict(),
  read_skill: z.object({ id: z.string().trim().min(1) }).strict(),
  list_mcp_servers: z.object({}).strict(),
  list_mcp_tools: z.object({ serverId: z.string().trim().min(1) }).strict(),
  call_mcp_tool: z.object({ serverId: z.string().trim().min(1), tool: z.string().trim().min(1), input: z.unknown().default({}) }).strict(),
  codex_submit: z.object({ prompt: z.string().trim().min(1), skillIds: z.array(z.string().trim().min(1)).default([]) }).strict(),
  codex_status: z.object({ taskId: z.string().uuid() }).strict(),
  codex_output: z.object({ taskId: z.string().uuid() }).strict(),
} as const;

export async function createServer(dependencies: ConnectorDependencies): Promise<ConnectorServer> {
  if (!dependencies.token.trim()) throw new Error('Connector token must not be empty');
  let closed = false;

  return {
    async call(tool, input, auth = {}) {
      if (closed) return { error: { code: 'internal_error', message: 'Connector is closed' } };
      if (!authorized(dependencies.token, auth.token)) return { error: { code: 'unauthorized', message: 'Unauthorized' } };
      const schema = tools[tool as keyof typeof tools];
      if (!schema) return { error: { code: 'unknown_tool', message: `Unknown tool: ${tool}` } };
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { error: { code: 'validation_error', message: 'Invalid tool input' } };
      try {
        return await route(tool, parsed.data, dependencies);
      } catch (error) {
        return { error: classifyError(error) };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await dependencies.close?.();
    },
  };
}

function authorized(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

async function route(tool: string, input: unknown, dependencies: ConnectorDependencies): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'workspace_info': return { ...(await dependencies.workspace.info()) };
    case 'list_directory': return { entries: await dependencies.workspace.listDirectory((input as { relativePath: string }).relativePath) };
    case 'read_file': return { content: await dependencies.workspace.readFile((input as { relativePath: string }).relativePath) };
    case 'search_workspace': return { ...(await dependencies.workspace.search((input as { needle: string }).needle)) };
    case 'git_status': return { result: await dependencies.git.status() };
    case 'git_diff': return { result: await dependencies.git.diff() };
    case 'list_skills': return { skills: await dependencies.skills.list() };
    case 'read_skill': return { ...(await dependencies.skills.read((input as { id: string }).id)) };
    case 'list_mcp_servers': return { servers: dependencies.mcp.list().map(({ id, allowedTools, timeoutMs }) => ({ id, allowedTools, timeoutMs })) };
    case 'list_mcp_tools': {
      const server = dependencies.mcp.get((input as { serverId: string }).serverId);
      if (!server) throw new Error(`Unknown MCP server: ${String((input as { serverId: string }).serverId)}`);
      return { serverId: server.id, tools: server.allowedTools };
    }
    case 'call_mcp_tool': {
      const value = input as { serverId: string; tool: string; input: unknown };
      return asRecord(await dependencies.mcp.call(value.serverId, value.tool, value.input, dependencies.mcpTransport));
    }
    case 'codex_submit': {
      const task = await dependencies.codex.submit(input as { prompt: string; skillIds: string[] });
      return { id: task.id, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt };
    }
    case 'codex_status': {
      const task = await dependencies.tasks.get((input as { taskId: string }).taskId);
      return { id: task.id, state: task.state, error: task.error, createdAt: task.createdAt, updatedAt: task.updatedAt };
    }
    case 'codex_output': {
      const task = await dependencies.tasks.get((input as { taskId: string }).taskId);
      return { id: task.id, state: task.state, output: task.output, error: task.error };
    }
    default: throw new Error(`Unknown tool: ${tool}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
}

function classifyError(error: unknown): ConnectorError {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('not allowed') || normalized.includes('policy') || normalized.includes('sensitive')) return { code: 'policy_denied', message: 'Operation denied by policy' };
  if (normalized.includes('unknown')) return { code: 'unknown_id', message: 'Requested identifier was not found' };
  if (normalized.includes('timed out') || normalized.includes('timeout')) return { code: 'timeout', message: 'Operation timed out' };
  if (normalized.includes('invalid') || normalized.includes('must not') || normalized.includes('exceeds')) return { code: 'validation_error', message: 'Operation input is invalid' };
  return { code: 'internal_error', message: 'Connector operation failed' };
}
