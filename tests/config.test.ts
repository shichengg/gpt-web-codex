import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  test('requires a workspace root and a connector token', () => {
    expect(() => loadConfig({ CODEX_WORKSPACE_ROOT: 'C:/work' })).toThrow(ConfigError);
  });

  test('uses loopback defaults and preserves configured roots', () => {
    const config = loadConfig({
      CODEX_WORKSPACE_ROOT: 'C:/work',
      CODEX_CONNECTOR_TOKEN: 'test-token',
      CODEX_SKILLS_ROOT: 'C:/skills',
      CODEX_STATE_DIR: 'C:/state',
    });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(48765);
    expect(config.workspaceRoot).toBe('C:/work');
    expect(config.skillsRoot).toBe('C:/skills');
    expect(config.stateDir).toBe('C:/state');
  });

  test('derives Skills, state, and registry paths from the workspace root', () => {
    const config = loadConfig({
      CODEX_WORKSPACE_ROOT: 'C:/work',
      CODEX_CONNECTOR_TOKEN: 'test-token',
    });

    expect(config.skillsRoot).toBe('C:/work/.codex/skills');
    expect(config.stateDir).toBe('C:/work/.codex/state');
    expect(config.mcpRegistryPath).toBe('C:/work/mcp-registry.json');
    expect(config.mcpCredentialsPath).toBe('C:/work/.codex/mcp-credentials.json');
  });

  test('rejects non-loopback hosts', () => {
    expect(() => loadConfig({
      CODEX_WORKSPACE_ROOT: 'C:/work',
      CODEX_CONNECTOR_TOKEN: 'test-token',
      CODEX_HOST: '0.0.0.0',
    })).toThrow(ConfigError);
  });

  test('rejects ports outside the valid range', () => {
    for (const port of ['-1', '65536', 'not-a-number']) {
      expect(() => loadConfig({
        CODEX_WORKSPACE_ROOT: 'C:/work',
        CODEX_CONNECTOR_TOKEN: 'test-token',
        CODEX_PORT: port,
      })).toThrow(ConfigError);
    }
  });

  test('allows port zero so a launcher can request an ephemeral loopback port', () => {
    expect(loadConfig({
      CODEX_WORKSPACE_ROOT: 'C:/work',
      CODEX_CONNECTOR_TOKEN: 'test-token',
      CODEX_PORT: '0',
    }).port).toBe(0);
  });

  test('reads bounded desktop Skill defaults from the supervised runtime environment', () => {
    const config = loadConfig({
      CODEX_WORKSPACE_ROOT: 'C:/work',
      CODEX_CONNECTOR_TOKEN: 'test-token',
      CODEX_DEFAULT_SKILL_IDS: '["review","sql"]',
    });

    expect(config.defaultSkillIds).toEqual(['review', 'sql']);
  });

  test('rejects whitespace-only required values', () => {
    expect(() => loadConfig({
      CODEX_WORKSPACE_ROOT: '   ',
      CODEX_CONNECTOR_TOKEN: 'test-token',
    })).toThrow(ConfigError);
    expect(() => loadConfig({
      CODEX_WORKSPACE_ROOT: 'C:/work',
      CODEX_CONNECTOR_TOKEN: '\t',
    })).toThrow(ConfigError);
  });
});
