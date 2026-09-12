import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface RegisteredMcpServer {
  id: string;
  enabled?: boolean;
  transport?: 'stdio' | 'streamable-http';
  command: string;
  args: string[];
  url?: string;
  headers?: Record<string, string>;
  allowedTools: string[];
  timeoutMs: number;
}

export interface McpTransport {
  call(server: RegisteredMcpServer, tool: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  listTools?(server: RegisteredMcpServer, signal?: AbortSignal): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>;
  close?(): Promise<void>;
}

const serverSchema = z.object({
  id: z.string().trim().min(1),
  transport: z.enum(['stdio', 'streamable-http']).default('stdio'),
  command: z.string().trim().default(''),
  args: z.array(z.string()).default([]),
  url: z.string().trim().optional(),
  headers: z.record(z.string()).optional(),
  // Empty until the launcher completes tools/list discovery.
  allowedTools: z.array(z.string().trim().min(1)).max(128),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
}).strict().superRefine((server, context) => {
  if (server.allowedTools.some((tool) => tool === '*' || tool.includes('*'))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP tool wildcards are not allowed' });
  }
  if (server.transport === 'stdio' && !server.command) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP stdio server must define a command' });
  }
  if (server.transport === 'streamable-http' && !isLoopbackMcpUrl(server.url)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP HTTP URL must be a loopback /mcp endpoint' });
  }
  if (server.headers && Object.keys(server.headers).length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP registry must not contain credentials' });
  }
});

const registrySchema = z.object({ servers: z.array(serverSchema) }).strict();
const APPROVED_EXECUTABLES = new Set(['node', 'node.exe']);

export class McpRegistry {
  private constructor(private readonly servers: Map<string, RegisteredMcpServer>) {}

  static fromJson(value: unknown): McpRegistry {
    const parsed = registrySchema.safeParse(value);
    if (!parsed.success) {
      const remote = value && typeof value === 'object' && 'servers' in value
        && Array.isArray(value.servers)
        && value.servers.some((server) => server && typeof server === 'object' && 'url' in server);
      const prefix = remote ? 'MCP registry accepts local stdio servers only: ' : 'Invalid MCP registry: ';
      throw new Error(`${prefix}${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }

    const servers = new Map<string, RegisteredMcpServer>();
    for (const server of parsed.data.servers) {
      if (servers.has(server.id)) {
        throw new Error(`Duplicate MCP server id: ${server.id}`);
      }
      servers.set(server.id, { ...server, transport: server.transport ?? 'stdio', enabled: server.enabled !== false });
    }
    return new McpRegistry(servers);
  }

  get(id: string): RegisteredMcpServer | undefined {
    const server = this.servers.get(id);
    return server ? { ...server, args: [...server.args], allowedTools: [...server.allowedTools], ...(server.headers ? { headers: { ...server.headers } } : {}) } : undefined;
  }

  list(): RegisteredMcpServer[] {
    return [...this.servers.values()].map((server) => ({ ...server, args: [...server.args], allowedTools: [...server.allowedTools], ...(server.headers ? { headers: { ...server.headers } } : {}) }));
  }

  async call(serverId: string, tool: string, input: unknown, transport: McpTransport, signal?: AbortSignal): Promise<unknown> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    if (server.enabled === false) {
      throw new Error(`MCP server is disabled: ${serverId}`);
    }
    if (!server.allowedTools.includes(tool)) {
      throw new Error(`MCP tool is not allowed: ${serverId}/${tool}`);
    }
    return transport.call(server, tool, input, signal);
  }
}

export async function loadMcpRegistry(filePath: string, workspaceRoot?: string): Promise<McpRegistry> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read MCP registry: ${filePath}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid MCP registry JSON: ${filePath}`, { cause: error });
  }
  return bindRegistryToTrustedWorkspace(McpRegistry.fromJson(value), workspaceRoot);
}

/**
 * Registry JSON is mutable configuration, so core loading repeats the
 * launcher's executable and canonical profile-containment policy before a
 * stdio transport can spawn anything. Empty registries need no MCP directory.
 */
async function bindRegistryToTrustedWorkspace(registry: McpRegistry, workspaceRoot?: string): Promise<McpRegistry> {
  const servers = registry.list();
  if (servers.length === 0) return registry;
  if (!workspaceRoot) throw new Error('MCP registry with servers requires a trusted workspace root');

  const nodeServers = servers.filter((server) => commandKind(server.command) === 'node');
  const approvedRoot = nodeServers.length > 0
    ? await canonicalDirectory(path.join(workspaceRoot, '.codex', 'mcp'), 'MCP entrypoint root')
    : undefined;
  const canonicalServers: RegisteredMcpServer[] = [];
  for (const server of servers) {
    if (server.transport === 'streamable-http') {
      if (!isLoopbackMcpUrl(server.url)) throw new Error('MCP HTTP URL must be a loopback /mcp endpoint');
      canonicalServers.push({ ...server, command: '', args: [] });
      continue;
    }
    const kind = commandKind(server.command);
    if (!kind) {
      throw new Error('MCP registry command is not an approved local executable');
    }
    if (kind === 'stata' && server.args.length === 0) {
      canonicalServers.push({ ...server, command: await canonicalFile(server.command, 'MCP executable') });
      continue;
    }
    if (kind === 'python' && server.args.length >= 2 && server.args[0] === '-m' && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(server.args[1])) {
      canonicalServers.push({ ...server, command: await canonicalFile(server.command, 'MCP executable') });
      continue;
    }
    if (kind === 'executable') {
      canonicalServers.push({ ...server, command: await canonicalFile(server.command, 'MCP executable') });
      continue;
    }
    if (kind !== 'node' || server.args.length !== 1 || !path.isAbsolute(server.args[0]) || path.extname(server.args[0]).toLowerCase() !== '.cjs') {
      throw new Error('MCP registry requires exactly one absolute local .cjs entrypoint');
    }
    const entrypoint = await canonicalFile(server.args[0], 'MCP entrypoint');
    if (!approvedRoot || !isContained(approvedRoot, entrypoint)) {
      throw new Error('MCP entrypoint must be contained in the workspace .codex/mcp directory');
    }
    canonicalServers.push({ ...server, args: [entrypoint] });
  }
  return McpRegistry.fromJson({ servers: canonicalServers });
}

function isLoopbackMcpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/mcp' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function commandKind(value: string): 'node' | 'stata' | 'python' | 'executable' | undefined {
  const lower = value.toLowerCase();
  if (APPROVED_EXECUTABLES.has(lower)) return 'node';
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) return undefined;
  const base = path.basename(value).toLowerCase();
  if (base === 'stata-gui-mcp.exe') return 'stata';
  if (base === 'python.exe' || base === 'python3.exe') return 'python';
  if (path.extname(base) === '.exe' && !['cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe'].includes(base)) return 'executable';
  return undefined;
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  try {
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch {
    throw new Error(`${label} must be an existing directory`);
  }
}

async function canonicalFile(value: string, label: string): Promise<string> {
  try {
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isFile()) throw new Error('not a file');
    return resolved;
  } catch {
    throw new Error(`${label} must be an existing local file`);
  }
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
