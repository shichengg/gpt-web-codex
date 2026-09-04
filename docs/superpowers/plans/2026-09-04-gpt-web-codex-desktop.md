# GPT Web Codex Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Windows Electron executable that manages an OpenAI Tunnel and the secure local MCP runtime, with desktop workspace, Skills, local MCP, task, log, and diagnostic management.

**Architecture:** Keep `src/` as the bounded Node MCP runtime. Add an Electron launcher that owns private configuration, one runtime process, the OpenAI Tunnel, pairing, secure IPC, and packaging. Its React renderer has no Node access and operates only on redacted typed snapshots.

**Tech Stack:** Node.js 20+, TypeScript, Electron, React, Vite, electron-builder, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-04-gpt-web-codex-desktop-design.md`

## Global Constraints

- Windows is the first packaging target; create a per-user NSIS installer.
- One active profile owns one loopback runtime and one Tunnel target.
- Keep credentials, runtime keys, logs, and window state inside Electron per-user app data; never expose them over renderer IPC.
- Preserve all existing workspace, process, output, Skills, MCP allowlist, cancellation, and redaction limits.
- Reuse only required MIT upstream launcher/Tunnel code and retain NOTICE attribution.
- Do not ship browser automation, extensions, DOM injection, cookies, chat history, remote MCP registry entries, or arbitrary command execution.

---

### Task 1: Expose a launcher-controlled runtime

**Files:**
- Create: `src/runtime.ts`
- Modify: `src/index.ts`, `src/config.ts`
- Create: `tests/runtime-lifecycle.test.ts`

**Interfaces:** `startRuntime(config: BridgeConfig): Promise<ManagedRuntime>` returns `{ url, snapshot(), close() }`. CLI emits one JSON `runtime-ready` record.

- [ ] **Step 1: Write the failing tests**

```ts
test('reports a loopback MCP URL', async () => {
  const runtime = await startRuntime(configWithPort(0));
  expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  await runtime.close();
});

test('waits for active work cancellation during close', async () => {
  const runtime = await startRuntime(configWithBlockingCodex());
  await runtime.submit('wait');
  await expect(runtime.close()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/runtime-lifecycle.test.ts`

Expected: FAIL because `startRuntime` is absent.

- [ ] **Step 3: Implement the minimal boundary**

```ts
export interface ManagedRuntime {
  url: string;
  snapshot(): RuntimeSnapshot;
  close(): Promise<void>;
}

export async function startRuntime(config: BridgeConfig): Promise<ManagedRuntime> {
  const server = await startHttpConnector(config, await createDependencies(config));
  return { url: server.url(), snapshot: () => server.snapshot(), close: () => server.close() };
}
```

Make the CLI load config, call `startRuntime`, print `{ type: 'runtime-ready', url }`, and shut down on SIGINT/SIGTERM.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/runtime-lifecycle.test.ts && npm run typecheck && npm run build`

Expected: PASS.

Commit: `feat: expose managed MCP runtime lifecycle`.

### Task 2: Add Electron shell and secure preload contract

**Files:**
- Create: `launcher/package.json`, `launcher/tsconfig.json`, `launcher/vite.config.ts`
- Create: `launcher/electron/main.cjs`, `launcher/electron/preload.cjs`
- Create: `launcher/src/main.tsx`, `launcher/src/App.tsx`, `launcher/src/types.ts`, `launcher/src/styles.css`
- Create: `launcher/tests/preload-contract.test.cjs`, `launcher/tests/window-security.test.cjs`

**Interfaces:** `window.gptWebCodex` exposes only `snapshot`, `start`, `stop`, `selectWorkspace`, `saveSkills`, `saveMcpRegistry`, `cancelTask`, `doctor`, `openLogs`, and subscriptions.

- [ ] **Step 1: Write failing IPC tests**

```js
test('preload exposes only declared launcher methods', () => {
  expect(Object.keys(createPreloadApi(fakeIpc))).toEqual([
    'snapshot', 'start', 'stop', 'selectWorkspace', 'saveSkills',
    'saveMcpRegistry', 'cancelTask', 'doctor', 'openLogs', 'onSnapshot', 'onLog',
  ]);
});

test('window has isolated renderer preferences', () => {
  expect(windowOptions.webPreferences).toMatchObject({
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm --prefix launcher test -- preload-contract.test.cjs window-security.test.cjs`

Expected: FAIL because launcher files are absent.

- [ ] **Step 3: Implement shell**

```js
new BrowserWindow({
  webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
});
```

Create Status, Workspace, Skills, MCP, Tasks/Logs and Settings/Diagnostics views. Block renderer navigation and all external URLs except explicit main-process allowlist.

- [ ] **Step 4: Verify and commit**

Run: `npm --prefix launcher run typecheck && npm --prefix launcher run build && npm --prefix launcher test`

Expected: PASS.

Commit: `feat: add secure desktop launcher shell`.

### Task 3: Add private profiles and per-workspace Skills defaults

**Files:**
- Create: `launcher/electron/state.cjs`, `launcher/electron/profiles.cjs`, `launcher/electron/skills.cjs`
- Modify: `launcher/electron/main.cjs`, `launcher/src/App.tsx`, `launcher/src/types.ts`
- Create: `launcher/tests/profiles.test.cjs`, `launcher/tests/skills.test.cjs`

**Interfaces:** `WorkspaceProfile = { id, workspaceRoot, skillsRoot, enabledSkillIds }`. `saveDefaults(id, skillIds)` validates IDs against the current catalog and persists no secret.

- [ ] **Step 1: Write failing profile tests**

```js
test('stores Skills defaults per workspace', () => {
  store.saveDefaults('one', ['review']);
  store.saveDefaults('two', ['sql']);
  expect(store.get('one').enabledSkillIds).toEqual(['review']);
});

test('rejects defaults outside the scanned catalog', async () => {
  await expect(saveSkillDefaults(profile, ['outside'])).rejects.toThrow('Unknown Skill');
});
```

- [ ] **Step 2: Verify failure**

Run: `npm --prefix launcher test -- profiles.test.cjs skills.test.cjs`

Expected: FAIL because profile services are absent.

- [ ] **Step 3: Implement profiles and UI**

Write atomically under `app.getPath('userData')`; keep paths and UI choices only. Scan catalog summaries and bounded previews; Skills view saves checkboxes and opens folders through a main-process allowlist.

- [ ] **Step 4: Verify and commit**

Run: `npm --prefix launcher test && npm --prefix launcher run build`

Expected: PASS.

Commit: `feat: manage workspace Skills defaults`.

### Task 4: Add MCP registry and task activity panels

**Files:**
- Create: `launcher/electron/registry.cjs`, `launcher/electron/runtime-client.cjs`
- Modify: `launcher/electron/main.cjs`, `launcher/src/App.tsx`, `launcher/src/types.ts`
- Create: `launcher/tests/registry-form.test.cjs`, `launcher/tests/runtime-client.test.cjs`

**Interfaces:** `validateRegistryDraft(draft)` applies local-stdio-only rules. `RuntimeClient` uses fixed runtime tool calls for snapshots, tasks, bounded logs and cancellation.

- [ ] **Step 1: Write failing boundary tests**

```js
test('rejects remote MCP URL and wildcard tool', () => {
  expect(() => validateRegistryDraft({
    servers: [{ id: 'x', url: 'https://x', allowedTools: ['*'] }],
  })).toThrow();
});

test('cancels activity through fixed runtime tool', async () => {
  await client.cancel('task-1');
  expect(fake.calls).toContainEqual(['codex_cancel', { taskId: 'task-1' }]);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm --prefix launcher test -- registry-form.test.cjs runtime-client.test.cjs`

Expected: FAIL because services are absent.

- [ ] **Step 3: Implement form and activity boundaries**

Validate ID, command, args, allowlisted tools and timeout before atomic registry save. Restart only after a valid save. Render only bounded redacted task/log output.

- [ ] **Step 4: Verify and commit**

Run: `npm --prefix launcher test && npm --prefix launcher run build`

Expected: PASS.

Commit: `feat: manage local MCP and task activity`.

### Task 5: Supervise one local runtime process

**Files:**
- Create: `launcher/electron/runtime-supervisor.cjs`
- Modify: `launcher/electron/main.cjs`, `launcher/electron/state.cjs`
- Create: `launcher/tests/runtime-supervisor.test.cjs`

**Interfaces:** `RuntimeSupervisor.start(profile)`, `stop()`, and `status()` own a single core child. No status/snapshot includes connector tokens.

- [ ] **Step 1: Write failing supervisor tests**

```js
test('uses Electron-as-Node with fixed entrypoint and shell false', async () => {
  await supervisor.start(profile);
  expect(spawn).toHaveBeenCalledWith(process.execPath, [coreEntrypoint], expect.objectContaining({ shell: false }));
});

test('reports stopped only after child exit', async () => {
  const stopping = supervisor.stop();
  child.emit('exit', 0);
  await stopping;
  expect(supervisor.status().state).toBe('stopped');
});
```

- [ ] **Step 2: Verify failure**

Run: `npm --prefix launcher test -- runtime-supervisor.test.cjs`

Expected: FAIL because supervisor is absent.

- [ ] **Step 3: Implement process ownership**

Use `ELECTRON_RUN_AS_NODE=1`, fixed core entrypoint and `shell: false`. Pass profile roots, state/registry paths, generated loopback token and port only through child environment. Parse only JSON `runtime-ready`. Switch profiles by fully stopping before starting the next child.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm --prefix launcher test && npm run typecheck && npm --prefix launcher run typecheck`

Expected: PASS.

Commit: `feat: supervise one local MCP runtime`.

### Task 6: Integrate OpenAI Tunnel and connector pairing

**Files:**
- Create: `launcher/electron/tunnel-supervisor.cjs`, `launcher/electron/connector-identity.cjs`
- Modify: `launcher/electron/main.cjs`, `launcher/electron/preload.cjs`, `launcher/src/App.tsx`
- Create: `launcher/tests/tunnel-supervisor.test.cjs`, `launcher/tests/connector-identity.test.cjs`

**Interfaces:** `restoreOrConnect({ runtimeUrl, connectorName })` allows only the managed active loopback URL. Credentials enter through setup IPC only, are redacted, and are never returned.

- [ ] **Step 1: Write failing Tunnel tests**

```js
test('forwards only to the managed active runtime', async () => {
  await tunnel.restoreOrConnect({
    runtimeUrl: 'http://127.0.0.1:48765/mcp',
    connectorName: 'GPT Web Codex',
  });
  expect(runTunnel).toHaveBeenCalledWith(expect.objectContaining({
    target: 'http://127.0.0.1:48765/mcp',
  }));
});

test('redacts runtime keys from diagnostics', () => {
  expect(redactTunnelLog('key=secret')).not.toContain('secret');
});
```

- [ ] **Step 2: Verify failure**

Run: `npm --prefix launcher test -- tunnel-supervisor.test.cjs connector-identity.test.cjs`

Expected: FAIL because Tunnel supervision is absent.

- [ ] **Step 3: Adapt reference pure-MCP Tunnel model**

Adapt the upstream launcher’s validated configuration, stable connector identity, health checks, owned-process recovery and stop ordering. Keep only pure MCP Tunnel code; reject non-managed targets and do not automate ChatGPT’s webpage.

- [ ] **Step 4: Verify and commit**

Run: `npm --prefix launcher test && npm test && npm --prefix launcher run build`

Expected: PASS.

Commit: `feat: manage OpenAI Tunnel from desktop app`.

### Task 7: Package Windows EXE and diagnostics

**Files:**
- Modify: `launcher/package.json`, `launcher/electron/main.cjs`, `launcher/src/App.tsx`, `README.md`
- Create: `launcher/scripts/prepare-core.cjs`, `launcher/scripts/package.cjs`, `launcher/scripts/smoke-package.cjs`, `launcher/electron/doctor.cjs`
- Create: `launcher/tests/packaging-contract.test.cjs`, `launcher/tests/doctor.test.cjs`

**Interfaces:** `npm --prefix launcher run package:win` creates an NSIS `.exe` in `launcher/artifacts/`. `doctor()` reports redacted checks for Codex CLI, package assets, profile, runtime and Tunnel.

- [ ] **Step 1: Write failing packaging tests**

```js
test('Windows package targets NSIS and includes core resources', () => {
  expect(packageJson.build.win.target).toContain('nsis');
  expect(packageJson.build.extraResources).toContainEqual(expect.objectContaining({ to: 'core' }));
});

test('doctor reports missing Codex without secrets', async () => {
  const report = await doctor({ which: async () => null });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: 'codex', status: 'error' }));
  expect(JSON.stringify(report)).not.toContain('CODEX_CONNECTOR_TOKEN');
});
```

- [ ] **Step 2: Verify failure**

Run: `npm --prefix launcher test -- packaging-contract.test.cjs doctor.test.cjs`

Expected: FAIL because package and doctor are absent.

- [ ] **Step 3: Implement package and diagnostics**

Stage only core production runtime files under `extraResources`; use `asar: true`, per-user NSIS, `publish: never`, and disabled automatic signing discovery. Diagnostics can export only redacted records and open the local log directory.

- [ ] **Step 4: Verify and commit**

Run: `npm run build && npm --prefix launcher run package:win && npm --prefix launcher run smoke:package`

Expected: NSIS `.exe` exists and smoke test starts the packaged executable in diagnostic mode.

Commit: `feat: package desktop tunnel launcher for Windows`.

### Task 8: Validate full desktop lifecycle

**Files:**
- Create: `launcher/tests/e2e-lifecycle.test.cjs`, `launcher/tests/e2e-tunnel.test.cjs`
- Modify: `README.md`

**Interfaces:** acceptance flow is profile configuration → Skills defaults → MCP validation → runtime start → Tunnel restore/connect → fixed tool call → task submit/poll/cancel → clean stop.

- [ ] **Step 1: Write failing E2E tests**

```js
test('uses profile Skills defaults only when task omits skillIds', async () => {
  await launcher.selectWorkspace(profileWithDefaults(['review']));
  await launcher.start();
  await launcher.callTool('codex_submit', { prompt: 'inspect' });
  expect(runtime.lastTask.skillIds).toEqual(['review']);
});

test('stop leaves no owned runtime or Tunnel child alive', async () => {
  await launcher.start();
  await launcher.startBlockingTask();
  await launcher.stop();
  expect(processes.alive()).toEqual([]);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm --prefix launcher test -- e2e-lifecycle.test.cjs e2e-tunnel.test.cjs`

Expected: FAIL until services are wired.

- [ ] **Step 3: Wire only public supervisor APIs and document use**

Document fresh pairing, restore-existing-tunnel, diagnosis and installer location. Do not weaken core security controls for the desktop UI.

- [ ] **Step 4: Run full verification**

Run: `npm test && npm --prefix launcher test && npm run typecheck && npm --prefix launcher run typecheck && npm run build && npm --prefix launcher run build && npm --prefix launcher run package:win && npm --prefix launcher run smoke:package`

Expected: all suites pass, package exists, and diagnostics contain no credentials.

- [ ] **Step 5: Commit**

Commit: `test: verify desktop tunnel connector lifecycle`.

