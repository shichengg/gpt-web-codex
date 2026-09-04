import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export interface RegisteredMcpServer {
  id: string;
  command: string;
  args: string[];
  allowedTools: string[];
  timeoutMs: number;
}

export interface McpTransport {
  call(server: RegisteredMcpServer, tool: string, input: unknown): Promise<unknown>;
}

const serverSchema = z.object({
  id: z.string().trim().min(1),
  command: z.string().trim().min(1, 'MCP server must define a local stdio command'),
  args: z.array(z.string()).default([]),
  allowedTools: z.array(z.string().trim().min(1)).min(1),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
}).strict().superRefine((server, context) => {
  if (server.allowedTools.some((tool) => tool === '*' || tool.includes('*'))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP tool wildcards are not allowed' });
  }
});

const registrySchema = z.object({ servers: z.array(serverSchema) }).strict();

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
      servers.set(server.id, server);
    }
    return new McpRegistry(servers);
  }

  get(id: string): RegisteredMcpServer | undefined {
    const server = this.servers.get(id);
    return server ? { ...server, args: [...server.args], allowedTools: [...server.allowedTools] } : undefined;
  }

  list(): RegisteredMcpServer[] {
    return [...this.servers.values()].map((server) => ({ ...server, args: [...server.args], allowedTools: [...server.allowedTools] }));
  }

  async call(serverId: string, tool: string, input: unknown, transport: McpTransport): Promise<unknown> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    if (!server.allowedTools.includes(tool)) {
      throw new Error(`MCP tool is not allowed: ${serverId}/${tool}`);
    }
    return transport.call(server, tool, input);
  }
}

export async function loadMcpRegistry(filePath: string): Promise<McpRegistry> {
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
  return McpRegistry.fromJson(value);
}
