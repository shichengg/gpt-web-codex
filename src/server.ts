import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
  http?: { host: string; port: number };
}

export interface ConnectorError {
  code: 'unauthorized' | 'validation_error' | 'policy_denied' | 'unknown_id' | 'timeout' | 'internal_error' | 'unknown_tool';
  message: string;
}

export type ConnectorResponse = Record<string, unknown> | { error: ConnectorError };
export interface ConnectorServer {
  call(tool: string, input: unknown, auth?: { token?: string }): Promise<ConnectorResponse>;
  close(): Promise<void>;
  readonly httpAddress?: string;
}

interface ActiveMcpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface McpRuntime {
  sessions: Set<ActiveMcpSession>;
  requests: Set<IncomingMessage>;
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
  call_mcp_tool: z.object({ serverId: z.string().trim().min(1), tool: z.string().trim().min(1), input: z.record(z.unknown()).default({}) }).strict(),
  codex_submit: z.object({ prompt: z.string().trim().min(1), skillIds: z.array(z.string().trim().min(1)).default([]) }).strict(),
  codex_status: z.object({ taskId: z.string().uuid() }).strict(),
  codex_output: z.object({ taskId: z.string().uuid() }).strict(),
} as const;

export async function createServer(dependencies: ConnectorDependencies): Promise<ConnectorServer> {
  if (!dependencies.token.trim()) throw new Error('Connector token must not be empty');
  let closed = false;
  const runtime: McpRuntime = { sessions: new Set(), requests: new Set() };
  let httpServer: HttpServer | undefined;
  if (dependencies.http) {
    httpServer = createHttpServer((request, response) => {
      void handleMcpRequest(request, response, dependencies, runtime).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        if (!response.writableEnded) response.end(JSON.stringify({ error: 'Connector request failed' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer!.once('error', reject);
      httpServer!.listen(dependencies.http!.port, dependencies.http!.host, resolve);
    });
  }

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
    get httpAddress() {
      const address = httpServer?.address();
      return address && typeof address === 'object' ? `http://${address.address}:${address.port}/mcp` : undefined;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const request of runtime.requests) request.destroy();
      await Promise.all([...runtime.sessions].map(async ({ server, transport }) => {
        await Promise.allSettled([server.close(), transport.close()]);
      }));
      if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      await dependencies.close?.();
    },
  };
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, dependencies: ConnectorDependencies, runtime: McpRuntime): Promise<void> {
  if (request.url !== '/mcp' || request.method !== 'POST') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
  if (!authorized(dependencies.token, token)) {
    response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized' } }));
    return;
  }
  runtime.requests.add(request);
  const body = await readJson(request);
  const server = createMcpServer(dependencies);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const session = { server, transport };
  runtime.sessions.add(session);
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    runtime.sessions.delete(session);
    runtime.requests.delete(request);
    await Promise.allSettled([server.close(), transport.close()]);
  }
}

function createMcpServer(dependencies: ConnectorDependencies): McpServer {
  const server = new McpServer({ name: 'gpt-web-codex', version: '0.1.0' });
  for (const name of Object.keys(tools)) {
    server.registerTool(name, { description: `GPT Web Codex ${name}`, inputSchema: tools[name as keyof typeof tools] }, (async (input: unknown) => {
      const schema = tools[name as keyof typeof tools];
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return { isError: true, content: [{ type: 'text', text: 'Invalid tool input' }] };
      }
      try {
        const result = await route(name, parsed.data, dependencies);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Connector operation failed' }] };
      }
    }) as never);
  }
  return server;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(value);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
