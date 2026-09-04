import { z } from 'zod';

export interface BridgeConfig {
  host: string;
  port: number;
  workspaceRoot: string;
  skillsRoot: string;
  stateDir: string;
  connectorToken: string;
  mcpRegistryPath: string;
  defaultSkillIds: string[];
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
  port: z.number().int().min(0).max(65535),
  workspaceRoot: z.string().trim().min(1),
  skillsRoot: z.string().trim().min(1),
  stateDir: z.string().trim().min(1),
  connectorToken: z.string().trim().min(1),
  mcpRegistryPath: z.string().trim().min(1),
  defaultSkillIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).max(64)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'default Skill IDs must be unique' }),
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
    mcpRegistryPath: env.CODEX_MCP_REGISTRY?.trim() || `${workspaceRoot}/mcp-registry.json`,
    defaultSkillIds: loadDefaultSkillIds(env),
  });

  if (!result.success) {
    throw new ConfigError(`Invalid configuration: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }

  return result.data;
}

/** Parse only the launcher-owned JSON array; callers never supply defaults per request. */
function loadDefaultSkillIds(env: NodeJS.ProcessEnv): unknown {
  const raw = env.CODEX_DEFAULT_SKILL_IDS;
  if (!raw?.trim()) return [];
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError('Invalid configuration: CODEX_DEFAULT_SKILL_IDS must be a JSON array');
  }
}
