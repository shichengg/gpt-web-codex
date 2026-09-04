import { loadConfig } from './config.js';
import { CodexRunner } from './codex/runner.js';
import { TaskStore } from './codex/tasks.js';
import { loadMcpRegistry } from './mcp/registry.js';
import { StdioMcpTransport } from './mcp/transport.js';
import { createPathPolicy } from './security/paths.js';
import { SkillCatalog } from './skills/catalog.js';
import { createGitTools } from './tools/git.js';
import { createWorkspaceTools } from './tools/workspace.js';
import { createServer } from './server.js';

if (process.argv.includes('--help')) {
  console.log('GPT Web Codex connector: configure CODEX_WORKSPACE_ROOT and CODEX_CONNECTOR_TOKEN, then start the bridge.');
} else {
  const config = loadConfig(process.env);
  const paths = await createPathPolicy(config.workspaceRoot);
  const skills = await SkillCatalog.create(config.skillsRoot);
  const tasks = new TaskStore(config.stateDir);
  const bridge = await createServer({
    token: config.connectorToken,
    workspace: createWorkspaceTools(config.workspaceRoot, paths),
    git: createGitTools(config.workspaceRoot, paths),
    skills,
    mcp: await loadMcpRegistry(config.mcpRegistryPath),
    mcpTransport: new StdioMcpTransport(),
    codex: new CodexRunner({ workspaceRoot: config.workspaceRoot, catalog: skills, store: tasks }),
    tasks,
    http: { host: config.host, port: config.port },
  });
  console.error(`GPT Web Codex connector listening at ${bridge.httpAddress}`);
  const shutdown = () => { void bridge.close().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
