import type { BridgeConfig } from './config.js';
import { readFile } from 'node:fs/promises';
import { CodexRunner } from './codex/runner.js';
import { TaskStore } from './codex/tasks.js';
import { loadMcpRegistry } from './mcp/registry.js';
import { StdioMcpTransport } from './mcp/transport.js';
import { createPathPolicy } from './security/paths.js';
import { createServer, type ConnectorDependencies, type ConnectorServer } from './server.js';
import { SkillCatalog } from './skills/catalog.js';
import { createGitTools } from './tools/git.js';
import { createWorkspaceTools } from './tools/workspace.js';

export interface RuntimeSnapshot {
  state: 'running' | 'stopped';
  url: string;
}

export interface ManagedRuntime {
  readonly url: string;
  snapshot(): RuntimeSnapshot;
  close(): Promise<void>;
}

/** Starts the authenticated loopback MCP server owned by a launcher process. */
export async function startRuntime(config: BridgeConfig): Promise<ManagedRuntime> {
  const server = await createServer({
    ...await createDependencies(config),
    http: { host: config.host, port: config.port },
  });
  const url = requireRuntimeUrl(server);
  let state: RuntimeSnapshot['state'] = 'running';
  let closing: Promise<void> | undefined;

  return {
    url,
    snapshot: () => ({ state, url }),
    close: async () => {
      if (!closing) closing = server.close().finally(() => { state = 'stopped'; });
      await closing;
    },
  };
}

async function createDependencies(config: BridgeConfig): Promise<ConnectorDependencies> {
  const paths = await createPathPolicy(config.workspaceRoot, { deniedRoots: [config.stateDir] });
  const skills = await SkillCatalog.create(config.skillsRoot);
  const tasks = new TaskStore(config.stateDir);
  const mcpTransport = new StdioMcpTransport(async (serverId) => loadMcpToken(config.mcpCredentialsPath ?? `${config.workspaceRoot}/.codex/mcp-credentials.json`, serverId));
  return {
    token: config.connectorToken,
    workspace: createWorkspaceTools(config.workspaceRoot, paths),
    git: createGitTools(config.workspaceRoot, paths),
    skills,
    mcp: await loadMcpRegistry(config.mcpRegistryPath, config.workspaceRoot),
    mcpTransport,
    codex: new CodexRunner({ workspaceRoot: config.workspaceRoot, catalog: skills, store: tasks }),
    tasks,
    defaultSkillIds: config.defaultSkillIds,
    close: () => mcpTransport.close(),
  };
}

async function loadMcpToken(filePath: string, serverId: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as { credentials?: Record<string, unknown> };
    const token = value.credentials?.[serverId];
    return typeof token === 'string' && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

function requireRuntimeUrl(server: ConnectorServer): string {
  if (!server.httpAddress) throw new Error('Runtime did not expose an HTTP address');
  return server.httpAddress;
}
