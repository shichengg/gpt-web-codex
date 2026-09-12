import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpTransport, RegisteredMcpServer } from './registry.js';

type ToolMetadata = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type ClientLike = {
  connect(transport: never, options?: { timeout?: number }): Promise<void>;
  callTool(params: { name: string; arguments: Record<string, unknown> }, resultSchema?: undefined, options?: { timeout?: number }): Promise<unknown>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  close(): Promise<void>;
};
type TransportLike = { close(): Promise<void> };
type TransportFactories = {
  createClient?: () => ClientLike;
  createTransport?: (server: RegisteredMcpServer, token?: string) => TransportLike;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};
type ActiveSession = { fingerprint: string; client: ClientLike; transport: TransportLike };

/** Persistent MCP boundary; stateful servers such as Stata keep one session per registered service. */
export class StdioMcpTransport implements McpTransport {
  private readonly sessions = new Map<string, Promise<ActiveSession>>();
  private readonly createClient: () => ClientLike;
  private readonly createTransport: (server: RegisteredMcpServer, token?: string) => TransportLike;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly tokenProvider?: (serverId: string) => Promise<string | undefined>,
    factories: TransportFactories = {},
  ) {
    this.createClient = factories.createClient ?? (() => new Client({ name: 'gpt-web-codex', version: '0.1.0' }) as ClientLike);
    this.createTransport = factories.createTransport ?? createSdkTransport;
    this.sleep = factories.sleep ?? waitWithSignal;
  }

  async call(server: RegisteredMcpServer, tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (server.enabled === false) throw new Error(`MCP server is disabled: ${server.id}`);
    const session = await this.sessionFor(server);
    const invoke = () => this.raceOperation(
      server,
      session.client.callTool({ name: tool, arguments: isRecord(input) ? input : {} }, undefined, { timeout: server.timeoutMs }),
      signal,
      'tool call',
    );
    const result = await invoke();
    if (!isStataStartupLogRace(server, tool, result)) return result;
    await this.sleep(2_000, signal);
    return invoke();
  }

  async listTools(server: RegisteredMcpServer, signal?: AbortSignal): Promise<ToolMetadata[]> {
    if (server.enabled === false) throw new Error(`MCP server is disabled: ${server.id}`);
    const session = await this.sessionFor(server);
    const result = await this.raceOperation(server, session.client.listTools(), signal, 'discovery');
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
    }));
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async (pending) => closeSession(await pending)));
  }

  private async sessionFor(server: RegisteredMcpServer): Promise<ActiveSession> {
    const fingerprint = JSON.stringify([server.transport ?? 'stdio', server.command, server.args, server.url, server.timeoutMs]);
    const existing = this.sessions.get(server.id);
    if (existing) {
      const session = await existing;
      if (session.fingerprint === fingerprint) return session;
      this.sessions.delete(server.id);
      await closeSession(session);
    }
    const pending = this.openSession(server, fingerprint);
    this.sessions.set(server.id, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.sessions.get(server.id) === pending) this.sessions.delete(server.id);
      throw error;
    }
  }

  private async openSession(server: RegisteredMcpServer, fingerprint: string): Promise<ActiveSession> {
    const token = server.transport === 'streamable-http' ? await this.tokenProvider?.(server.id) : undefined;
    const transport = this.createTransport(server, token);
    const client = this.createClient();
    try {
      await client.connect(transport as never, { timeout: server.timeoutMs });
      return { fingerprint, client, transport };
    } catch (error) {
      await Promise.allSettled([client.close(), transport.close()]);
      throw error;
    }
  }

  private async raceOperation<T>(server: RegisteredMcpServer, operation: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP ${label} timed out after ${server.timeoutMs}ms`)), server.timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error(`MCP ${label} cancelled`));
      if (signal?.aborted) abortListener();
      else signal?.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await Promise.race([operation, timeout, aborted]);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && /timed out|cancelled/i.test(error.message))) {
        await this.invalidate(server.id);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    }
  }

  private async invalidate(serverId: string): Promise<void> {
    const pending = this.sessions.get(serverId);
    if (!pending) return;
    this.sessions.delete(serverId);
    await Promise.allSettled([pending.then(closeSession)]);
  }
}

function createSdkTransport(server: RegisteredMcpServer, token?: string): TransportLike {
  return server.transport === 'streamable-http'
    ? new StreamableHTTPClientTransport(new URL(server.url!), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined)
    : new StdioClientTransport({ command: server.command, args: server.args, stderr: 'ignore' });
}

async function closeSession(session: ActiveSession): Promise<void> {
  await Promise.allSettled([session.client.close(), session.transport.close()]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStataStartupLogRace(server: RegisteredMcpServer, tool: string, result: unknown): boolean {
  if (server.id.toLowerCase() !== 'stata' || tool !== 'stata_run_dofile' || !isRecord(result) || !Array.isArray(result.content)) return false;
  const text = result.content
    .filter(isRecord)
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('\n');
  return /Stata 日志读取失败/i.test(text) && /\[Errno 2\]|No such file or directory/i.test(text);
}

function waitWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('MCP retry cancelled'));
      return;
    }
    const timer = setTimeout(() => finish(), milliseconds);
    const onAbort = () => finish(new Error('MCP retry cancelled'));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
