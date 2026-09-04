import { z } from 'zod';

export interface BridgeConfig {
  host: string;
  port: number;
  workspaceRoot: string;
  skillsRoot: string;
  stateDir: string;
  connectorToken: string;
  codexExecutable: string;
  mcpRegistryPath: string;
}

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

const configSchema = z.object({
  host: z.string().min(1).refine((value) => value === '127.0.0.1' || value === 'localhost' || value === '::1', {
    message: 'host must be loopback-only',
  }),
  port: z.number().int().min(1).max(65535),
  workspaceRoot: z.string().trim().min(1),
  skillsRoot: z.string().trim().min(1),
  stateDir: z.string().trim().min(1),
  connectorToken: z.string().trim().min(1),
  codexExecutable: z.string().trim().min(1),
  mcpRegistryPath: z.string().trim().min(1),
});

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new ConfigError(`Missing required configuration: ${name}`);
  }
  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const workspaceRoot = required(env, 'CODEX_WORKSPACE_ROOT');
  const connectorToken = required(env, 'CODEX_CONNECTOR_TOKEN');
  const portText = env.CODEX_PORT?.trim() ?? '48765';
  const port = Number(portText);

  const result = configSchema.safeParse({
    host: env.CODEX_HOST?.trim() || '127.0.0.1',
    port,
    workspaceRoot,
    skillsRoot: env.CODEX_SKILLS_ROOT?.trim() || `${workspaceRoot}/.codex/skills`,
    stateDir: env.CODEX_STATE_DIR?.trim() || `${workspaceRoot}/.codex/state`,
    connectorToken,
    codexExecutable: env.CODEX_EXECUTABLE?.trim() || 'codex',
    mcpRegistryPath: env.CODEX_MCP_REGISTRY?.trim() || `${workspaceRoot}/mcp-registry.json`,
  });

  if (!result.success) {
    throw new ConfigError(`Invalid configuration: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }

  return result.data;
}
