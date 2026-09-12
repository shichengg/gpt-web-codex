import { describe, expect, test } from 'vitest';
import { StdioMcpTransport } from '../src/mcp/transport.js';
import type { RegisteredMcpServer } from '../src/mcp/registry.js';

describe('StdioMcpTransport', () => {
  test('reuses one MCP client so stateful stdio sessions survive calls', async () => {
    let connects = 0;
    let closes = 0;
    const client = {
      connect: async () => { connects += 1; },
      callTool: async ({ name }: { name: string }) => ({ name }),
      listTools: async () => ({ tools: [{ name: 'stata_run_dofile', description: 'Open Stata', inputSchema: { type: 'object', required: ['path'] } }] }),
      close: async () => { closes += 1; },
    };
    const transport = new StdioMcpTransport(undefined, {
      createClient: () => client,
      createTransport: () => ({ close: async () => undefined }),
    });
    const server: RegisteredMcpServer = { id: 'stata', command: 'stata-gui-mcp', args: [], allowedTools: ['stata_status'], timeoutMs: 30000 };

    await transport.call(server, 'stata_status', {});
    await transport.call(server, 'stata_status', {});

    expect(connects).toBe(1);
    expect(closes).toBe(0);
    await expect(transport.listTools(server)).resolves.toEqual([{
      name: 'stata_run_dofile', description: 'Open Stata', inputSchema: { type: 'object', required: ['path'] },
    }]);
    expect(connects).toBe(1);
    await transport.close();
    expect(closes).toBe(1);
  });

  test('waits and retries one Stata do-file call when the startup log is not ready', async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = {
      connect: async () => undefined,
      callTool: async () => {
        calls += 1;
        return calls === 1
          ? { isError: false, content: [{ type: 'text', text: "❌ Stata 日志读取失败\nerror: [Errno 2] No such file or directory" }] }
          : { isError: false, content: [{ type: 'text', text: '✅ Stata 执行完成' }] };
      },
      listTools: async () => ({ tools: [] }),
      close: async () => undefined,
    };
    const transport = new StdioMcpTransport(undefined, {
      createClient: () => client,
      createTransport: () => ({ close: async () => undefined }),
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
    } as never);
    const server: RegisteredMcpServer = { id: 'stata', command: 'stata-gui-mcp', args: [], allowedTools: ['stata_run_dofile'], timeoutMs: 30000 };

    const result = await transport.call(server, 'stata_run_dofile', { path: 'E:/project/test/test.do', session_id: 'main' });

    expect(calls).toBe(2);
    expect(delays).toEqual([2000]);
    expect(result).toMatchObject({ content: [{ text: '✅ Stata 执行完成' }] });
    await transport.close();
  });
});
