import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpTransport, RegisteredMcpServer } from './registry.js';

/** MCP stdio boundary; command and arguments always come from the validated registry. */
export class StdioMcpTransport implements McpTransport {
  async call(server: RegisteredMcpServer, tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const transport = new StdioClientTransport({ command: server.command, args: server.args, stderr: 'pipe' });
    const client = new Client({ name: 'gpt-web-codex', version: '0.1.0' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        await client.connect(transport, { timeout: server.timeoutMs });
        return client.callTool({ name: tool, arguments: isRecord(input) ? input : {} });
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void transport.close();
          reject(new Error(`MCP tool call timed out after ${server.timeoutMs}ms`));
        }, server.timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => {
          void transport.close();
          reject(new Error('MCP tool call cancelled'));
        }, { once: true });
      });
      return await Promise.race([operation, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      await Promise.allSettled([client.close(), transport.close()]);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
