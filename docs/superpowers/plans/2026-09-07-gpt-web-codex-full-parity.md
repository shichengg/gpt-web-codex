# GPT Web Codex Full Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Electron manager and MCP endpoint to functional parity with the reference `gpt-webcodex` workflows while keeping Skills first-class, MCP optional, and all existing security boundaries intact.

**Architecture:** Keep the current TypeScript connector core and Electron supervisors. Add a focused proxy service and versioned launcher preferences, make the MCP HTTP boundary streamable for GET/SSE discovery, then expand the renderer around a route-driven page model. The ChatGPT website remains isolated and unmodified; all status/tool integration stays in the local manager or MCP server.

**Tech Stack:** TypeScript, Node.js HTTP, `@modelcontextprotocol/sdk` Streamable HTTP transport, Electron CommonJS main/preload, React/Vite renderer, Node test runner, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-gpt-web-codex-full-parity-design.md`

## Global Constraints

- One canonical primary workspace remains the only runtime root.
- Skills are direct packages under `<workspace>/.codex/skills` and remain renderer-safe.
- MCP registry is optional; `{ "servers": [] }` must never block runtime or Tunnel startup.
- Renderer never receives Runtime API Keys, connector tokens, cookies, loopback URLs, or full sensitive proxy credentials.
- Local MCP accepts only the existing audited stdio policy; no remote URLs, shells, `npx`, wildcards, or arbitrary executables.
- Tunnel is the only component allowed to map a validated proxy URL to `--control-plane.http-proxy`.
- Every implementation change follows a failing-test-first cycle and preserves existing security/lifecycle tests.

---

### Task 1: Make MCP discovery compatible with ChatGPT

**Files:**
- Modify: `src/server.ts:139-180`
- Test: `tests/connector.integration.test.ts`

**Interfaces:**
- Consumes: existing `ConnectorDependencies`, auth token, and SDK `StreamableHTTPServerTransport`.
- Produces: authenticated `/mcp` handling for GET discovery/SSE and POST JSON-RPC, with SDK-generated protocol responses.

- [ ] **Step 1: Add a failing GET discovery test**

Start the HTTP connector on an ephemeral port, send `GET /mcp` with `Accept: text/event-stream`, and assert the response is not the current hard-coded 404. Keep the request unauthenticated first and assert the endpoint returns an authentication response rather than a route-not-found response.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npm test -- tests/connector.integration.test.ts -t "GET /mcp"`

Expected: FAIL because `handleMcpRequest` currently allows only `POST`.

- [ ] **Step 3: Delegate GET/POST/DELETE to the SDK transport**

Change the route guard to accept only `/mcp` and methods `GET`, `POST`, or `DELETE`. Preserve bearer validation for requests that carry JSON-RPC calls, create the SDK transport once per request as the current implementation does, and call `transport.handleRequest(request, response, body)` for all accepted methods. Do not hand-write SSE frames.

- [ ] **Step 4: Verify GET and existing POST behavior**

Run: `npm test -- tests/connector.integration.test.ts`

Expected: GET discovery no longer returns the repository's 404; existing authenticated POST tool calls remain green.

- [ ] **Step 5: Commit the protocol boundary change**

```powershell
git add src/server.ts tests/connector.integration.test.ts
git commit -m "fix: support streamable MCP discovery"
```

### Task 2: Add proxy discovery and validated launcher preferences

**Files:**
- Create: `launcher/electron/proxy-service.cjs`
- Modify: `launcher/electron/launcher-state.cjs`
- Modify: `launcher/src/types.ts`
- Test: `launcher/tests/proxy-service.test.cjs`
- Test: `launcher/tests/settings-guide-contract.test.cjs`

**Interfaces:**
- Consumes: Windows registry/WinHTTP/environment candidates and bounded network probes.
- Produces: `resolveProxy(settings, options) -> { mode, source, reachable, configured, proxyUrl? }`, `clearProxyCache()`, and migrated `LauncherUiPreferences` with `proxyMode`, `proxyUrl`, `startAtLogin`, `autoStartServices`, and `keepRunningOnClose`.

- [ ] **Step 1: Add failing proxy normalization and preference migration tests**

Cover HTTP/HTTPS normalization, rejection of username/password URLs, `auto/system/manual/direct` modes, a cache invalidation case, and migration of an old three-field preferences file to the expanded shape.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/proxy-service.test.cjs tests/settings-guide-contract.test.cjs`

Expected: FAIL because the proxy module and preference fields do not exist.

- [ ] **Step 3: Implement the proxy service**

Port the reference project's bounded candidate discovery: `HTTP[S]_PROXY`, Windows Internet Settings, WinHTTP, and local ports `10808`, `10809`, `7890`, `7897`, `8080`. Implement direct HEAD probing and HTTP CONNECT probing with timeouts capped at 2500ms. Never return credentials in the renderer-safe result.

- [ ] **Step 4: Extend launcher state validation and migration**

Add exact defaults, reject unknown fields and credential-bearing proxy URLs, preserve existing preference files, and return a frozen renderer-safe object. Keep `guideDismissedSteps` validation unchanged.

- [ ] **Step 5: Verify focused tests**

Run: `npm test -- tests/proxy-service.test.cjs tests/settings-guide-contract.test.cjs`

Expected: PASS with no proxy credentials present in serialized values.

### Task 3: Thread proxy resolution through runtime and Tunnel startup

**Files:**
- Modify: `launcher/electron/main.cjs:80-390,680-715`
- Modify: `launcher/electron/tunnel-client.cjs:45-90`
- Modify: `launcher/src/App.tsx`
- Test: `launcher/tests/tunnel-supervisor.test.cjs`
- Test: `launcher/tests/proxy-controller.test.cjs`

**Interfaces:**
- Consumes: `resolveProxy`, launcher preferences, current runtime URL/token, and Tunnel supervisor.
- Produces: `start`, `setupTunnel`, and MCP-registry restart operations that pass only a validated effective proxy URL to `restoreOrConnect`.

- [ ] **Step 1: Add a failing controller forwarding test**

Inject a proxy resolver returning `http://127.0.0.1:7890`, start a valid profile, and assert the Tunnel adapter receives `proxyUrl` while the published snapshot omits it. Add a manual-unreachable case that fails before child spawn with a credential-free message.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- tests/proxy-controller.test.cjs tests/tunnel-supervisor.test.cjs`

Expected: FAIL because the controller currently never resolves preferences or passes proxy data.

- [ ] **Step 3: Wire proxy resolution into controller operations**

Resolve immediately before Tunnel reconnect in `start`, `setupTunnel`, and registry-triggered restart. For manual mode, reject an unreachable result. For auto mode, continue direct when appropriate and publish only safe source/reachability metadata through diagnostics.

- [ ] **Step 4: Keep the Tunnel client boundary strict**

Retain `buildTunnelArgs` as the only mapping to `--control-plane.http-proxy`; create the private log directory before spawn and preserve existing credential indirection.

- [ ] **Step 5: Verify controller and lifecycle behavior**

Run: `npm test -- tests/proxy-controller.test.cjs tests/tunnel-supervisor.test.cjs tests/e2e-tunnel.test.cjs`

Expected: PASS, including redaction and shutdown ordering.

### Task 4: Rebuild manager navigation and reference-aligned operational pages

**Files:**
- Modify: `launcher/src/App.tsx`
- Modify: `launcher/src/styles.css`
- Test: `launcher/tests/settings-guide-contract.test.cjs`
- Test: `launcher/tests/renderer-navigation-contract.test.cjs`

**Interfaces:**
- Consumes: expanded snapshot, preference bridge, existing workspace/Skills/MCP/task IPC methods.
- Produces: route-driven pages for Overview, Connection, Workspace, Skills, optional MCP, Tasks, Local Memory, Help/Diagnostics, and Settings.

- [ ] **Step 1: Add failing renderer contracts**

Assert every reference page route exists, every navigation item updates one route state, Connection includes proxy controls and Runtime API Key/Tunnel ID, MCP is labeled optional, and no renderer source displays secret fields from snapshots.

- [ ] **Step 2: Run focused contracts and verify failure**

Run: `npm test -- tests/renderer-navigation-contract.test.cjs tests/settings-guide-contract.test.cjs`

Expected: FAIL for missing routes/proxy controls.

- [ ] **Step 3: Implement shared route state and page metadata**

Use one `View` route state and one navigation updater. Each route must set topbar metadata, reset scroll, and render loading/empty/error states. Keep Skills as a primary navigation item and move MCP copy to an explicit optional panel.

- [ ] **Step 4: Implement reference page content**

Match the screenshots' information architecture: overview status cards and progress, connection setup/deploy area, workspace profile and permissions boundary, task activity, memory empty/management state, diagnostics, and settings. Use existing IPC methods instead of fake controls.

- [ ] **Step 5: Add proxy controls and safe status display**

Expose mode selection, manual proxy input, current source/reachability, and re-detect action. Never display full credential-bearing URLs or API keys.

- [ ] **Step 6: Verify renderer contracts and typecheck**

Run: `npm test -- tests/renderer-navigation-contract.test.cjs tests/settings-guide-contract.test.cjs`; then `npm run typecheck` from `launcher`.

### Task 5: Add local memory and richer task/help flows

**Files:**
- Create: `launcher/electron/memory-store.cjs`
- Modify: `launcher/electron/main.cjs`
- Modify: `launcher/electron/preload.cjs`
- Modify: `launcher/src/types.ts`
- Modify: `launcher/src/App.tsx`
- Test: `launcher/tests/memory-store.test.cjs`
- Test: `launcher/tests/task-help-contract.test.cjs`

**Interfaces:**
- Consumes: private app-data directory and existing bounded task APIs.
- Produces: explicit IPC methods for list/save/delete/import/export of manually authored local notes, plus richer task and diagnostics views.

- [ ] **Step 1: Add failing memory-store tests**

Cover atomic persistence, bounded note size/count, secret-pattern rejection/redaction, JSON export/import, and isolation from workspace files.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/memory-store.test.cjs tests/task-help-contract.test.cjs`

Expected: FAIL because no memory IPC/store exists.

- [ ] **Step 3: Implement private memory store and IPC**

Store only user-confirmed notes under app data. Reject or redact API keys, bearer tokens, cookies, and runtime keys before persistence. Add preload methods with strict payload validation.

- [ ] **Step 4: Refine task and help/diagnostics pages**

Show bounded task status/output/cancel and recent logs. Show runtime, Tunnel, proxy, MCP discovery, and ChatGPT-window state with safe support-report export. Do not add pause/resume/worktree controls without matching core support.

- [ ] **Step 5: Verify focused tests**

Run: `npm test -- tests/memory-store.test.cjs tests/task-help-contract.test.cjs tests/window-security.test.cjs`

Expected: PASS with secret-free IPC payloads.

### Task 6: Align the isolated ChatGPT window wrapper

**Files:**
- Modify: `launcher/electron/chatgpt-window.cjs`
- Modify: `launcher/electron/main.cjs`
- Test: `launcher/tests/chatgpt-window.test.cjs`

**Interfaces:**
- Consumes: current isolated partition and navigation allowlist.
- Produces: a wrapper toolbar/status region outside the ChatGPT DOM with active workspace, runtime/Tunnel indicators, manager open, and reload actions.

- [ ] **Step 1: Add failing window-controller tests**

Assert wrapper actions do not inject scripts, do not expand navigation allowlists, and report only renderer-safe status.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/chatgpt-window.test.cjs`

Expected: FAIL for missing wrapper status/action methods.

- [ ] **Step 3: Implement wrapper controls in the Electron-owned window**

Use the existing BrowserWindow/session boundary and safe IPC messages. Keep ChatGPT cookies and website DOM inaccessible to the manager renderer.

- [ ] **Step 4: Verify window security**

Run: `npm test -- tests/chatgpt-window.test.cjs tests/window-security.test.cjs`

Expected: PASS with unchanged allowlist and isolated session behavior.

### Task 7: Full verification and Windows delivery

**Files:**
- Modify: `README.md`
- Modify: packaging/smoke tests only if new assets or IPC files require contract updates.

- [ ] **Step 1: Run the root project test suite**

Run: `npm test`

Expected: 0 failed tests; investigate any runtime-cli/network failure rather than masking it.

- [ ] **Step 2: Run launcher tests and static checks**

Run from `launcher`: `npm test`; `npm run typecheck`; `npm run build`.

- [ ] **Step 3: Run packaging and smoke checks**

Run from `launcher`: `npm run package:win`; `npm run smoke:package`.

- [ ] **Step 4: Verify packaged paths and hashes**

Confirm:

```powershell
Test-Path artifacts\\win-unpacked\\resources\\tools\\tunnel-client.exe
Get-FileHash artifacts\\win-unpacked\\resources\\tools\\tunnel-client.exe -Algorithm SHA256
Get-Item artifacts\\GPT Web Codex Setup 0.1.0.exe
```

- [ ] **Step 5: Review diff and documentation**

Run `git diff --check` and update README with the proxy modes, optional MCP behavior, ChatGPT connector setup, and the corrected packaged Tunnel path.

- [ ] **Step 6: Commit the verified delivery**

```powershell
git add src launcher README.md docs/superpowers
git commit -m "feat: align desktop manager with gpt-webcodex workflows"
```
