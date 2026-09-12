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
  /** Launcher-owned defaults applied only when a task omits skillIds. */
  defaultSkillIds?: string[];
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
  operations: Set<Promise<unknown>>;
  controllers: Set<AbortController>;
}

const legacyTools = {
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
  codex_submit: z.object({ prompt: z.string().trim().min(1), skillIds: z.array(z.string().trim().min(1)).optional() }).strict(),
  codex_cancel: z.object({ taskId: z.string().uuid() }).strict(),
  codex_status: z.object({ taskId: z.string().uuid() }).strict(),
  codex_output: z.object({ taskId: z.string().uuid() }).strict(),
} as const;

const publicTools = {
  coding_tools_guide: z.object({
    include_project_instructions: z.boolean().default(false),
  }).strict(),
  workspace_context: z.object({
    path: z.string().trim().min(1).default('.'),
    max_entries: z.number().int().min(1).max(500).default(40),
    detail: z.enum(['compact', 'full']).default('compact'),
  }).strict(),
  agent_workflow: z.object({
    objective: z.string().trim().min(1),
    workflow: z.enum(['bugfix', 'feature', 'greenfield', 'refactor', 'test_failure', 'build_release', 'diagnose', 'document', 'resume', 'custom']).default('custom'),
    phase: z.enum(['prepare', 'execute', 'run', 'resume']).default('prepare'),
    path: z.string().trim().min(1).default('.'),
    workdir: z.string().trim().min(1).optional(),
    queries: z.array(z.string().trim().min(1)).max(32).default([]),
    skill_ids: z.array(z.string().trim().min(1)).max(64).optional(),
    patches: z.array(z.string()).max(20).default([]),
    commands: z.array(z.string()).max(20).default([]),
    test_command: z.string().optional(),
    build_command: z.string().optional(),
    verification: z.enum(['none', 'tests', 'build', 'all']).default('tests'),
    timeout_seconds: z.number().int().min(1).max(600).default(600),
    response_detail: z.enum(['compact', 'full']).default('compact'),
  }).strict(),
  task_control: z.object({
    action: z.enum(['get', 'operation', 'start', 'update', 'pause', 'stop', 'resume', 'clear', 'history', 'worktree_create', 'worktree_list', 'worktree_get', 'worktree_diff', 'worktree_apply', 'worktree_discard']).default('get'),
    task_id: z.string().uuid().optional(),
    operation_id: z.string().trim().min(1).optional(),
    objective: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    next_step: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }).strict(),
  document_workflow: z.object({
    action: z.enum(['capabilities', 'inspect', 'create', 'convert', 'rebuild']).default('inspect'),
    path: z.string().trim().min(1).optional(),
    paths: z.array(z.string().trim().min(1)).max(20).default([]),
    target: z.string().trim().min(1).optional(),
    content: z.string().optional(),
    max_chars: z.number().int().min(1).max(1_000_000).default(200_000),
    detail: z.enum(['compact', 'layout']).default('compact'),
  }).strict(),
  command_control: z.object({
    action: z.enum(['poll', 'write', 'kill', 'read']).default('poll'),
    session_id: z.string().trim().min(1).optional(),
    chars: z.string().default(''),
    wait_ms: z.number().int().min(0).max(30_000).default(3_000),
    output_ref: z.string().trim().min(1).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(1_048_576).default(65_536),
    stream: z.enum(['stdout', 'stderr']).optional(),
  }).strict(),
  request_permissions: z.object({
    tool_name: z.enum(['exec_command', 'apply_patch']),
    permission: z.enum(['network', 'destructive_command', 'long_timeout', 'sensitive_env', 'shell_expansion', 'inline_script', 'privileged_executable', 'write_generated_or_ignored']),
    reason: z.string().trim().min(1),
    arguments: z.record(z.unknown()),
    scope: z.enum(['once', 'session']).default('once'),
    ttl_seconds: z.number().int().min(1).max(3600).default(300),
  }).strict(),
  view_image: z.object({
    path: z.string().trim().min(1),
    max_bytes: z.number().int().min(1024).max(10_485_760).default(5_242_880),
    max_width: z.number().int().min(1).max(10_000).default(2000),
    max_height: z.number().int().min(1).max(10_000).default(2000),
    auto_resize: z.boolean().default(true),
  }).strict(),
  skills: z.object({
    action: z.enum(['status', 'list', 'read']).default('status'),
    skill_id: z.string().trim().min(1).optional(),
  }).strict(),
  mcp: z.object({
    action: z.enum(['status', 'list_servers', 'list_tools', 'call_tool']).default('status')
      .describe('Use list_servers, then list_tools to obtain each downstream tool inputSchema before call_tool.'),
    server_id: z.string().trim().min(1).optional().describe('Registered local MCP service ID, for example stata.'),
    tool: z.string().trim().min(1).optional().describe('Exact downstream tool name returned by list_tools.'),
    input: z.record(z.unknown()).default({}).describe('Arguments matching the downstream tool inputSchema returned by list_tools.'),
  }).strict(),
} as const;

const compatibilityTools = {
  skills_mcp: z.object({
    action: z.enum(['status', 'list_skills', 'read_skill', 'list_mcp_servers', 'list_mcp_tools', 'call_mcp_tool']).default('status'),
    skill_id: z.string().trim().min(1).optional(),
    server_id: z.string().trim().min(1).optional(),
    tool: z.string().trim().min(1).optional(),
    input: z.record(z.unknown()).default({}),
  }).strict(),
} as const;

const toolDescriptions: Record<keyof typeof publicTools, string> = {
  coding_tools_guide: 'Return a compact usage guide. Use workspace_context for inspection, agent_workflow for coding, task_control for long tasks, skills for local Skill metadata, and mcp for optional local MCP services.',
  workspace_context: 'Preferred read-only tool for workspace overview. Returns active workspace, root entries, project hints, Git status, Skills, optional MCP registry, and a recommended next action.',
  agent_workflow: 'Primary end-to-end coding workflow. Prepare context first, then execute one complete change set with optional Skills and verification settings.',
  task_control: 'Inspect or control the current persistent task and its bounded Codex task state. Unsupported worktree actions return an explicit capability result.',
  document_workflow: 'Document workflow entry point. Inspect supported local text/Markdown files and report capabilities; unsupported formats return a structured limitation.',
  command_control: 'Command-session control entry point. This runtime exposes Codex tasks rather than arbitrary shell sessions and returns a structured capability response.',
  request_permissions: 'Report permission status without silently granting network, destructive command, shell, or sensitive environment access.',
  view_image: 'Inspect a workspace image. This runtime reports the image capability boundary when native image decoding is unavailable.',
  skills: 'Inspect local Skills. List returns metadata only; read loads one selected SKILL.md.',
  mcp: 'Inspect or call optional local MCP services. Always call list_tools before call_tool and follow the returned inputSchema. For the Stata GUI server, the first visible GUI session is created by stata_run_dofile with an absolute .do path and session_id; stata_status and stata_run do not create the first session.',
};

export async function createServer(dependencies: ConnectorDependencies): Promise<ConnectorServer> {
  if (!dependencies.token.trim()) throw new Error('Connector token must not be empty');
  let closed = false;
  const runtime: McpRuntime = { sessions: new Set(), requests: new Set(), operations: new Set(), controllers: new Set() };
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
      const schema = (publicTools[tool as keyof typeof publicTools] ?? compatibilityTools[tool as keyof typeof compatibilityTools] ?? legacyTools[tool as keyof typeof legacyTools]);
      if (!schema) return { error: { code: 'unknown_tool', message: `Unknown tool: ${tool}` } };
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { error: { code: 'validation_error', message: 'Invalid tool input' } };
      const controller = new AbortController();
      runtime.controllers.add(controller);
      const operation = (async () => {
        try {
          return await route(tool, parsed.data, dependencies, controller.signal);
        } catch (error) {
          return { error: classifyError(error) };
        }
      })();
      runtime.operations.add(operation);
      try {
        return await operation;
      } finally {
        runtime.operations.delete(operation);
        runtime.controllers.delete(controller);
      }
    },
    get httpAddress() {
      const address = httpServer?.address();
      return address && typeof address === 'object'
        ? `http://${formatHttpHost(address.address)}:${address.port}/mcp`
        : undefined;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const request of runtime.requests) request.destroy();
      for (const controller of runtime.controllers) controller.abort();
      await dependencies.codex.close?.();
      await Promise.allSettled([...runtime.operations]);
      await Promise.all([...runtime.sessions].map(async ({ server, transport }) => {
        await Promise.allSettled([server.close(), transport.close()]);
      }));
      if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      await dependencies.close?.();
    },
  };
}

function formatHttpHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, dependencies: ConnectorDependencies, runtime: McpRuntime): Promise<void> {
  if (request.url !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
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
  const requestController = new AbortController();
  runtime.controllers.add(requestController);
  const abortOnDisconnect = () => {
    if (!response.writableEnded) requestController.abort();
  };
  request.once('aborted', abortOnDisconnect);
  request.once('close', () => { if (request.aborted || !request.complete) abortOnDisconnect(); });
  response.once('close', abortOnDisconnect);
  let server: McpServer | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  let session: ActiveMcpSession | undefined;
  try {
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    if (requestController.signal.aborted) throw new Error('Request aborted');
    server = createMcpServer(dependencies, runtime, requestController.signal);
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    session = { server, transport };
    runtime.sessions.add(session);
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    if (session) runtime.sessions.delete(session);
    runtime.requests.delete(request);
    runtime.controllers.delete(requestController);
    if (server && transport) await Promise.allSettled([server.close(), transport.close()]);
  }
}

function createMcpServer(dependencies: ConnectorDependencies, runtime: McpRuntime, requestSignal?: AbortSignal): McpServer {
  const server = new McpServer({ name: 'gpt-web-codex', version: '0.1.0' });
  for (const name of Object.keys(publicTools) as Array<keyof typeof publicTools>) {
    server.registerTool(name, {
      title: name.replaceAll('_', ' '),
      description: toolDescriptions[name],
      inputSchema: publicTools[name],
      outputSchema: z.object({}).passthrough(),
    }, (async (input: unknown) => {
      const schema = publicTools[name];
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return { isError: true, content: [{ type: 'text', text: 'Invalid tool input' }] };
      }
      const controller = new AbortController();
      runtime.controllers.add(controller);
      const operation = (async () => {
       try {
        const result = await route(name, parsed.data, dependencies, anySignal(controller.signal, requestSignal));
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (cause) {
        const error = classifyError(cause);
        return { isError: true, content: [{ type: 'text', text: error.message }], structuredContent: { error } };
      }
      })();
      runtime.operations.add(operation);
      try { return await operation; } finally { runtime.operations.delete(operation); runtime.controllers.delete(controller); }
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

async function route(tool: string, input: unknown, dependencies: ConnectorDependencies, signal?: AbortSignal): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'coding_tools_guide':
      return {
        summary: 'Use workspace_context for a quick overview; use agent_workflow for coding; use task_control for persistent work; use skills for Skill metadata and mcp for optional MCP services.',
        preferred_flow: ['workspace_context', 'agent_workflow', 'task_control', 'skills', 'mcp'],
        custom_instructions: 'Prefer the high-level tools and keep MCP optional. Do not repeat completed reads or searches.',
      };
    case 'workspace_context': {
      const value = input as { path: string; max_entries: number; detail: 'compact' | 'full' };
      const [info, entries, skills, git] = await Promise.all([
        dependencies.workspace.info(),
        dependencies.workspace.listDirectory(value.path),
        dependencies.skills.list(),
        dependencies.git.status(),
      ]);
      return {
        workspace: info,
        path: value.path,
        entries: entries.slice(0, value.max_entries),
        project: { type: 'local-workspace', name: String(info.root).split(/[\\/]/).pop() ?? 'workspace' },
        git: value.detail === 'full' ? git : (typeof git === 'string' ? git.slice(0, 4096) : git),
        skills: skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
        recommended_next_action: 'Use agent_workflow for coding changes, skills to inspect local Skill metadata, or mcp to inspect optional local MCP servers.',
      };
    }
    case 'agent_workflow': {
      const value = input as { objective: string; phase: string; skill_ids?: string[] };
      if (value.phase === 'prepare') {
        return {
          phase: 'prepare',
          objective: value.objective,
          context: await route('workspace_context', { path: '.', max_entries: 40, detail: 'compact' }, dependencies, signal),
          recommended_next_action: 'Call agent_workflow again with phase=execute and the same objective.',
        };
      }
      const explicitSkills = value.skill_ids !== undefined;
      const task = await dependencies.codex.submit({
        prompt: value.objective,
        skillIds: value.skill_ids ?? dependencies.defaultSkillIds ?? [],
        skillSelection: explicitSkills ? 'explicit' : 'auto',
      }, signal);
      return { phase: value.phase, objective: value.objective, task: { id: task.id, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt }, verification: 'Codex task is running; poll task_control or use the task id with legacy status calls.' };
    }
    case 'task_control': {
      const value = input as { action: string; task_id?: string; objective?: string; reason?: string };
      if (value.action === 'get') return { state: { status: 'active', task_id: value.task_id ?? null }, operations: [] };
      if (value.action === 'start') return { state: { status: 'active', objective: value.objective ?? '' } };
      if (value.action === 'stop' || value.action === 'pause') return { state: { status: value.action === 'stop' ? 'stopped' : 'paused', reason: value.reason ?? '' } };
      if (value.action === 'clear') return { state: { status: 'idle' }, cleared: true };
      return { state: { status: 'idle' }, action: value.action, supported: false, note: 'Persistent worktree/task orchestration is managed by the desktop launcher.' };
    }
    case 'document_workflow':
      return { action: (input as { action: string }).action, capabilities: { runtime_ready: true, supported_inputs: ['txt', 'md', 'json', 'xml', 'html'], supported_output: ['txt', 'md'], note: 'Use the desktop document workflow for PDF/DOCX conversion.' } };
    case 'command_control':
      return { action: (input as { action: string }).action, supported: false, note: 'This connector exposes bounded Codex tasks; arbitrary command sessions are unavailable.' };
    case 'request_permissions':
      return { ok: false, status: 'unsupported', error: { code: 'ELICITATION_UNSUPPORTED', message: 'Permission changes must be configured in the desktop launcher.' } };
    case 'view_image':
      return { supported: false, path: (input as { path: string }).path, note: 'Image viewing is not available in this connector build.' };
    case 'skills_mcp':
      return routeSkillsMcp(input as { action: string; skill_id?: string; server_id?: string; tool?: string; input: Record<string, unknown> }, dependencies, signal);
    case 'skills':
      return routeSkills(input as { action: string; skill_id?: string }, dependencies);
    case 'mcp':
      return routeMcp(input as { action: string; server_id?: string; tool?: string; input: Record<string, unknown> }, dependencies, signal);
    case 'workspace_info': return { ...(await dependencies.workspace.info()) };
    case 'list_directory': return { entries: await dependencies.workspace.listDirectory((input as { relativePath: string }).relativePath) };
    case 'read_file': return { ...(await dependencies.workspace.readFile((input as { relativePath: string }).relativePath)) };
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
      return asRecord(await dependencies.mcp.call(value.serverId, value.tool, value.input, dependencies.mcpTransport, signal));
    }
    case 'codex_submit': {
      const request = input as { prompt: string; skillIds?: string[] };
      // An explicit empty array opts out of workspace defaults. Only omitted
      // skillIds inherit the private, launcher-owned profile selection.
      const task = await dependencies.codex.submit({
        prompt: request.prompt,
        skillIds: request.skillIds ?? dependencies.defaultSkillIds ?? [],
        skillSelection: request.skillIds === undefined ? 'auto' : 'explicit',
      }, signal);
      return { id: task.id, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt };
    }
    case 'codex_cancel': {
      const task = await dependencies.codex.cancel((input as { taskId: string }).taskId);
      return { id: task.id, state: task.state, error: task.error, createdAt: task.createdAt, updatedAt: task.updatedAt };
    }
    case 'codex_status': {
      const task = await dependencies.tasks.get((input as { taskId: string }).taskId);
      return { id: task.id, state: task.state, error: task.error, createdAt: task.createdAt, updatedAt: task.updatedAt };
    }
    case 'codex_output': {
      const task = await dependencies.tasks.get((input as { taskId: string }).taskId);
      return { id: task.id, state: task.state, output: task.output, outputTruncated: task.outputTruncated, error: task.error };
    }
    default: throw new Error(`Unknown tool: ${tool}`);
  }
}

function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

async function routeSkillsMcp(
  input: { action: string; skill_id?: string; server_id?: string; tool?: string; input: Record<string, unknown> },
  dependencies: ConnectorDependencies,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  switch (input.action) {
    case 'status':
      return {
        skills: await dependencies.skills.list(),
        mcp: dependencies.mcp.list().map(({ id, allowedTools, timeoutMs, enabled }) => ({ id, allowedTools, timeoutMs, enabled })),
        mcp_configured: dependencies.mcp.list().some((server) => server.enabled !== false),
        note: dependencies.mcp.list().length === 0 ? 'MCP is optional and currently not configured.' : 'Only allowlisted local MCP tools are available.',
      };
    case 'list_skills':
      return { skills: await dependencies.skills.list() };
    case 'read_skill':
      if (!input.skill_id) throw new Error('skill_id is required for read_skill');
      return { skill: await dependencies.skills.read(input.skill_id) };
    case 'list_mcp_servers':
      return { servers: dependencies.mcp.list().map(({ id, allowedTools, timeoutMs, enabled }) => ({ id, allowedTools, timeoutMs, enabled })) };
    case 'list_mcp_tools': {
      if (!input.server_id) throw new Error('server_id is required for list_mcp_tools');
      const server = dependencies.mcp.get(input.server_id);
      if (!server) throw new Error(`Unknown MCP server: ${input.server_id}`);
      if (server.enabled === false) throw new Error(`MCP server is disabled: ${input.server_id}`);
      return { server_id: server.id, tools: server.allowedTools, timeout_ms: server.timeoutMs };
    }
    case 'call_mcp_tool':
      if (!input.server_id || !input.tool) throw new Error('server_id and tool are required for call_mcp_tool');
      return { server_id: input.server_id, tool: input.tool, result: await dependencies.mcp.call(input.server_id, input.tool, input.input, dependencies.mcpTransport, signal) };
    default:
      throw new Error(`Unknown Skills/MCP action: ${input.action}`);
  }
}

async function routeSkills(
  input: { action: string; skill_id?: string },
  dependencies: ConnectorDependencies,
): Promise<Record<string, unknown>> {
  if (input.action === 'status' || input.action === 'list') {
    const skills = await dependencies.skills.list();
    return { configured: skills.length > 0, skills };
  }
  if (!input.skill_id) throw new Error('skill_id is required for read');
  return { skill: await dependencies.skills.read(input.skill_id) };
}

async function routeMcp(
  input: { action: string; server_id?: string; tool?: string; input: Record<string, unknown> },
  dependencies: ConnectorDependencies,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const servers = dependencies.mcp.list();
  if (input.action === 'status') {
    return { configured: servers.length > 0, optional: true, server_count: servers.length };
  }
  if (input.action === 'list_servers') {
    return { servers: servers.map(({ id, allowedTools, timeoutMs, enabled }) => ({ id, allowedTools, timeoutMs, enabled })) };
  }
  if (!input.server_id) throw new Error('server_id is required');
  const server = dependencies.mcp.get(input.server_id);
  if (!server) throw new Error(`Unknown MCP server: ${input.server_id}`);
  if (server.enabled === false) throw new Error(`MCP server is disabled: ${input.server_id}`);
  if (input.action === 'list_tools') {
    const discovered = dependencies.mcpTransport.listTools
      ? await dependencies.mcpTransport.listTools(server, signal)
      : server.allowedTools.map((name) => ({ name }));
    return {
      server_id: server.id,
      tools: discovered,
      allowed_tools: server.allowedTools,
      timeout_ms: server.timeoutMs,
      ...(server.id.toLowerCase() === 'stata' ? {
        usage_note: 'To create the first visible Stata GUI session, call stata_run_dofile with an absolute .do path and session_id. stata_status only reports status; stata_run requires an existing session.',
      } : {}),
    };
  }
  if (!input.tool) throw new Error('tool is required for call_tool');
  return { server_id: input.server_id, tool: input.tool, result: await dependencies.mcp.call(input.server_id, input.tool, input.input, dependencies.mcpTransport, signal) };
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
