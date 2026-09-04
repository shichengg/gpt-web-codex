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
  });
});
