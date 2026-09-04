# GPT Web Codex MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a connector-only, single-workspace service that gives ChatGPT safe inspection, Skills discovery, explicit local MCP access, and bounded Codex task execution.

**Architecture:** A strict TypeScript server composes independently tested configuration, path security, Skills, MCP-registry, workspace/Git, and Codex-task modules. The external tool layer authenticates each request and delegates only to those modules; Codex source changes occur only through a fixed `codex exec` child process.

**Tech Stack:** Node.js 24+, TypeScript 5.9, ESM, `@modelcontextprotocol/sdk`, Zod, Vitest, native `child_process.spawn`.

**Spec:** `docs/superpowers/specs/2026-09-04-gpt-web-codex-design.md`

## Global Constraints

- Repository path is `connectors/gpt-web-codex`; never modify `Software/`, `Software-worktrees/`, or `SoftwareBackup/DeepSeekPP-Backup/`.
- The first release has exactly one canonical workspace root and one canonical Skills root.
- Use `spawn(command, args, { shell: false })`; never construct a shell command.
- Default connector bind address is loopback; connector calls require a configured authentication token.
- Reject traversal, absolute-path escapes, symlink escapes, and sensitive credential paths.
- Skills are read-only `SKILL.md` packages. MCP uses only explicitly configured local stdio servers and explicitly allowed tools.
- Do not add browser DOM access, content scripts, remote MCP endpoints, automatic MCP discovery, arbitrary write tools, or arbitrary shell tools.
- Run the focused test after every production change and commit each completed task.

---

### Task 1: Project foundation and validated configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/config.ts`
- Create: `tests/config.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces `BridgeConfig`, `loadConfig(env: NodeJS.ProcessEnv): BridgeConfig`, and `ConfigError`.

- [ ] **Step 1: Write failing configuration tests**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/config.test.ts`

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Add package and configuration implementation**

Create `package.json` with scripts `typecheck: tsc --noEmit`, `test: vitest run`, `build: tsc -p tsconfig.json`, and `start: node dist/index.js`; add `@modelcontextprotocol/sdk`, `zod`, `typescript`, `vitest`, and Node type definitions. Implement:

```ts
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

export class ConfigError extends Error {}
export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig { /* validate required values */ }
```

Use Zod to validate nonempty strings, port range `1..65535`, and loopback-only defaults.

- [ ] **Step 4: Run focused tests, typecheck, and build**

Run: `npm test -- tests/config.test.ts && npm run typecheck && npm run build`

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/config.ts tests/config.test.ts
git commit -m "feat: add validated bridge configuration"
```

### Task 2: Canonical workspace path security

**Files:**
- Create: `src/security/paths.ts`
- Create: `tests/path-security.test.ts`

**Interfaces:**
- Consumes `BridgeConfig.workspaceRoot` and `BridgeConfig.skillsRoot`.
- Produces `createPathPolicy(root: string): PathPolicy`, with `resolve(relativePath: string): Promise<string>`.

- [ ] **Step 1: Write failing path-policy tests**

```ts
test('rejects traversal and absolute paths', async () => {
  const policy = await createPathPolicy(workspaceRoot);
  await expect(policy.resolve('../secret.txt')).rejects.toThrow('outside the allowed root');
  await expect(policy.resolve('C:/secret.txt')).rejects.toThrow('relative path');
});

test('rejects a symlink that resolves outside the root', async () => {
  const policy = await createPathPolicy(workspaceRoot);
  await expect(policy.resolve('escape-link/key.txt')).rejects.toThrow('outside the allowed root');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/path-security.test.ts`

Expected: FAIL because `createPathPolicy` is missing.

- [ ] **Step 3: Implement the canonical path policy**

Use `fs.promises.realpath` for the root and the deepest existing requested ancestor. Reject non-relative input, normalized paths beginning with `..`, and any resolved path outside the canonical root using `path.relative`. Add `isSensitivePath(relativePath)` to reject `.env`, `.pem`, `.key`, `credentials`, `token`, and `.git` metadata paths.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/path-security.test.ts`

Expected: PASS for an ordinary in-root file and each denied path.

- [ ] **Step 5: Commit path security**

```bash
git add src/security/paths.ts tests/path-security.test.ts
git commit -m "feat: enforce canonical workspace paths"
```

### Task 3: Read-only Skills catalog

**Files:**
- Create: `src/skills/catalog.ts`
- Create: `tests/skills-catalog.test.ts`

**Interfaces:**
- Consumes `PathPolicy` rooted at `BridgeConfig.skillsRoot`.
- Produces `SkillCatalog`, `list(): Promise<SkillSummary[]>`, and `read(id: string): Promise<SkillDocument>`.

- [ ] **Step 1: Write failing Skills tests**

```ts
test('lists only directories containing a valid SKILL.md', async () => {
  const catalog = await SkillCatalog.create(skillsRoot);
  await expect(catalog.list()).resolves.toEqual([
    { id: 'review', name: 'review', description: 'Review code safely.' },
  ]);
});

test('reads an explicit skill and rejects an unregistered identifier', async () => {
  const catalog = await SkillCatalog.create(skillsRoot);
  await expect(catalog.read('review')).resolves.toMatchObject({ id: 'review' });
  await expect(catalog.read('../outside')).rejects.toThrow('Unknown skill');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/skills-catalog.test.ts`

Expected: FAIL because `SkillCatalog` is missing.

- [ ] **Step 3: Implement Skills discovery and reading**

Read only direct child directories with a `SKILL.md`. Parse the YAML frontmatter's `name` and `description`; ignore malformed packages rather than exposing them. Do not execute package scripts or follow links outside the Skills root.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/skills-catalog.test.ts`

Expected: PASS and no file outside the Skills root is read.

- [ ] **Step 5: Commit the Skills catalog**

```bash
git add src/skills/catalog.ts tests/skills-catalog.test.ts
git commit -m "feat: add read-only skills catalog"
```

### Task 4: Explicit local MCP registry

**Files:**
- Create: `src/mcp/registry.ts`
- Create: `src/mcp/transport.ts`
- Create: `tests/mcp-registry.test.ts`

**Interfaces:**
- Produces `McpRegistry`, `RegisteredMcpServer`, `loadMcpRegistry(path: string): Promise<McpRegistry>`, and `McpTransport`.
- `McpTransport.call(server: RegisteredMcpServer, tool: string, input: unknown): Promise<unknown>` is injected for tests.

- [ ] **Step 1: Write failing registry tests**

```ts
test('permits only a registered local stdio tool', async () => {
  const registry = McpRegistry.fromJson({
    servers: [{ id: 'lint', command: 'node', args: ['lint.mjs'], allowedTools: ['check'] }],
  });
  await expect(registry.call('lint', 'check', {}, fakeTransport)).resolves.toEqual({ ok: true });
});

test('rejects remote URLs, unknown servers, and unlisted tools', async () => {
  expect(() => McpRegistry.fromJson({ servers: [{ id: 'bad', url: 'https://example.test' }] })).toThrow('local stdio');
  await expect(registry.call('lint', 'delete', {}, fakeTransport)).rejects.toThrow('not allowed');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-registry.test.ts`

Expected: FAIL because the registry modules do not exist.

- [ ] **Step 3: Implement allowlisted registry types and transport boundary**

Use this configuration shape:

```ts
export interface RegisteredMcpServer {
  id: string;
  command: string;
  args: string[];
  allowedTools: string[];
  timeoutMs: number;
}
```

Reject URL fields, wildcard tool names, empty command arrays, duplicate IDs, and a timeout outside `1000..120000`. Keep the production stdio client behind `McpTransport`; it must use the SDK client with fixed registry command/arguments and must terminate on timeout.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/mcp-registry.test.ts`

Expected: PASS for allowed calls and closed failures.

- [ ] **Step 5: Commit MCP registry support**

```bash
git add src/mcp/registry.ts src/mcp/transport.ts tests/mcp-registry.test.ts
git commit -m "feat: add allowlisted local mcp registry"
```

### Task 5: Workspace and Git inspection adapters

**Files:**
- Create: `src/tools/workspace.ts`
- Create: `src/tools/git.ts`
- Create: `tests/workspace-tools.test.ts`
- Create: `tests/git-tools.test.ts`

**Interfaces:**
- Consumes `PathPolicy`.
- Produces `WorkspaceTools` (`info`, `listDirectory`, `readFile`, `search`) and `GitTools` (`status`, `diff`).

- [ ] **Step 1: Write failing read-only tool tests**

```ts
test('reads and searches only allowed workspace files', async () => {
  await expect(tools.readFile('src/a.ts')).resolves.toContain('export');
  await expect(tools.readFile('.env')).rejects.toThrow('sensitive');
  await expect(tools.search('needle')).resolves.toMatchObject({ matches: expect.any(Array) });
});

test('returns status and a bounded diff from the configured Git repository', async () => {
  await expect(git.status()).resolves.toContain('M ');
  await expect(git.diff()).resolves.toContain('diff --git');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/workspace-tools.test.ts tests/git-tools.test.ts`

Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement bounded read-only adapters**

Use the path policy before every file operation. Limit directory entries, search matches, returned bytes, and diff bytes. Invoke `git` with fixed argument arrays and the configured workspace cwd. Return a structured `not_git_repository` result rather than throwing for a non-Git root.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/workspace-tools.test.ts tests/git-tools.test.ts`

Expected: PASS using temporary workspace and Git fixtures.

- [ ] **Step 5: Commit inspection adapters**

```bash
git add src/tools/workspace.ts src/tools/git.ts tests/workspace-tools.test.ts tests/git-tools.test.ts
git commit -m "feat: add bounded workspace and git tools"
```

### Task 6: Fixed Codex runner and persisted task lifecycle

**Files:**
- Create: `src/codex/runner.ts`
- Create: `src/codex/tasks.ts`
- Create: `tests/codex-runner.test.ts`
- Create: `tests/codex-tasks.test.ts`

**Interfaces:**
- Produces `CodexRunner.submit(request: CodexRequest): Promise<RunningTask>` and `TaskStore` (`create`, `get`, `appendOutput`, `complete`).
- `CodexRequest` has `{ prompt: string; skillIds: string[] }`; it has no executable, cwd, or raw shell field.

- [ ] **Step 1: Write failing task tests**

```ts
test('spawns the fixed executable with the configured cwd and without a shell', async () => {
  await runner.submit({ prompt: 'Summarize src.', skillIds: ['review'] });
  expect(spawnCalls[0]).toMatchObject({ command: 'codex', cwd: workspaceRoot, shell: false });
});

test('persists bounded status and redacts secret-shaped output', async () => {
  const task = await store.create({ prompt: 'test', skillIds: [] });
  await store.appendOutput(task.id, 'token=abc123');
  await expect(store.get(task.id)).resolves.toMatchObject({ output: expect.not.stringContaining('abc123') });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/codex-runner.test.ts tests/codex-tasks.test.ts`

Expected: FAIL because the runner and store are absent.

- [ ] **Step 3: Implement runner and task store**

Generate opaque task IDs, atomically persist JSON records under the configured state directory, cap output, redact `token=`, `api_key=`, and `password=` values, and expose states `queued`, `running`, `succeeded`, `failed`, `timed_out`, and `cancelled`. Assemble the fixed `codex exec --json` argument array internally; append only validated Skill document references from the catalog.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/codex-runner.test.ts tests/codex-tasks.test.ts`

Expected: PASS with the fake spawn implementation and no real Codex invocation.

- [ ] **Step 5: Commit task execution boundary**

```bash
git add src/codex/runner.ts src/codex/tasks.ts tests/codex-runner.test.ts tests/codex-tasks.test.ts
git commit -m "feat: add bounded codex task lifecycle"
```

### Task 7: Authenticated MCP connector server

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Create: `tests/connector.integration.test.ts`

**Interfaces:**
- Consumes all modules from Tasks 1 through 6.
- Produces `createServer(dependencies: ServerDependencies): Promise<ConnectorServer>` and `ConnectorServer.close(): Promise<void>`.

- [ ] **Step 1: Write failing integration tests**

```ts
test('rejects an unauthenticated connector request', async () => {
  const { client } = await createInMemoryConnectorClient(server);
  const response = await client.call('workspace_info', {}, { token: 'wrong' });
  expect(response.error.code).toBe('unauthorized');
});

test('serves Skills, allowed MCP tools, and fake Codex task status through one connector', async () => {
  const { client, auth } = await createInMemoryConnectorClient(server);
  expect(await client.call('list_skills', {}, auth)).toMatchObject({ skills: [{ id: 'review' }] });
  expect(await client.call('call_mcp_tool', { serverId: 'lint', tool: 'check', input: {} }, auth)).toMatchObject({ ok: true });
  const task = await client.call('codex_submit', { prompt: 'Review.', skillIds: ['review'] }, auth);
  expect(await client.call('codex_status', { taskId: task.id }, auth)).toMatchObject({ state: 'succeeded' });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm test -- tests/connector.integration.test.ts`

Expected: FAIL because the connector server is missing.

- [ ] **Step 3: Register the fixed tool surface**

Authenticate every request before routing. Register exactly the tools named in the spec: workspace/Git, Skills, MCP registry, and Codex task tools. Validate each input with Zod. Return structured errors for authentication, validation, policy denial, unknown IDs, timeouts, and internal failures. Ensure shutdown terminates the server and owned child processes.

- [ ] **Step 4: Run integration and complete unit suites**

Run: `npm test -- tests/connector.integration.test.ts && npm test`

Expected: PASS with fake Codex and MCP dependencies.

- [ ] **Step 5: Commit connector server**

```bash
git add src/server.ts src/index.ts tests/connector.integration.test.ts
git commit -m "feat: expose authenticated connector tools"
```

### Task 8: Documentation, attribution, and release verification

**Files:**
- Create: `README.md`
- Create: `NOTICE`
- Create: `examples/mcp-registry.json`
- Modify: `package.json`

**Interfaces:**
- Documents environment variables, Skills layout, MCP registry schema, connector setup, task states, and safety limits.

- [ ] **Step 1: Write a failing documentation smoke test**

```ts
test('the example MCP registry passes production validation', async () => {
  await expect(loadMcpRegistry('examples/mcp-registry.json')).resolves.toMatchObject({ servers: [] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-registry.test.ts`

Expected: FAIL because the example registry is absent.

- [ ] **Step 3: Add documentation and attribution**

Document a loopback-first deployment, authentication, required `codex` installation, single-workspace binding, Skills selection, and local-only MCP registry. Include a `NOTICE` attributing the MIT-licensed connection-model reference `m4j2rpf766-crypto/gpt-web-codex`, while explicitly stating that this project does not include its browser-extension code. Add an empty registry example with a documented local stdio entry format.

- [ ] **Step 4: Run all release gates**

Run: `npm run typecheck && npm test && npm run build`

Expected: PASS with no warnings or type errors.

- [ ] **Step 5: Run a local smoke test and commit**

Run: `node dist/index.js --help`

Expected: exits successfully and prints local startup/configuration usage without launching a browser.

```bash
git add README.md NOTICE examples/mcp-registry.json package.json tests/mcp-registry.test.ts
git commit -m "docs: add connector setup and attribution"
```

## Plan self-review

- Spec coverage: Tasks 1-7 implement configuration, path containment, read-only workspace/Git, Skills, local allowlisted MCP, fixed Codex tasks, authentication, lifecycle, and tests. Task 8 covers setup, attribution, and verification.
- Placeholder scan: no incomplete implementation markers are present; each task defines file paths, interfaces, a failing test, focused command, passing condition, and commit.
- Type consistency: `BridgeConfig`, `PathPolicy`, `SkillCatalog`, `McpRegistry`, `CodexRunner`, `TaskStore`, and `ConnectorServer` are introduced before their consumers.
