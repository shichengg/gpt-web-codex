# GPT Web Codex Full Parity Design

## Goal

Turn the current desktop launcher into a local-first ChatGPT coding-workspace
manager that follows the user-facing flows of `3169657175/gpt-webcodex`, while
retaining this repository's one-workspace security model and adding Skills as a
first-class capability. Local stdio MCP remains an optional extension.

## Scope

The product has two distinct surfaces:

1. The Electron manager configures and supervises a local runtime, OpenAI
   Tunnel, workspaces, Skills, and optional local MCP servers.
2. ChatGPT reaches the runtime through an OpenAI Tunnel and discovers the
   runtime's MCP tool list dynamically.

The manager must provide these reference-project user flows:

- overview, connection setup, workspace and permissions, task activity,
  local memory, help/diagnostics, preferences, and an isolated ChatGPT window;
- automatic startup/recovery of a configured runtime and Tunnel;
- Windows, environment, and manual HTTP-proxy support;
- a clear distinction between required connection setup and optional MCP
  registry setup.

The manager must not inject content scripts into ChatGPT, expose credentials
to the renderer, expose the loopback runtime URL/token to IPC, or permit
remote/unbounded MCP command configuration.

## Reference Alignment

The reference repository establishes the interaction model, not a code-copy
target. Its Python runtime, broad permission implementation, and settings
store will not be copied. This repository keeps its existing Node runtime,
strict workspace containment, private connector identity, and audited local
MCP registry.

| Reference capability | GPT Web Codex implementation |
| --- | --- |
| Overview dashboard | `LauncherSnapshot` aggregate with runtime, Tunnel, active profile, task, proxy, and ChatGPT-window state |
| Connection setup | private identity store plus new proxy preferences and explicit deploy/redeploy action |
| Workspace permissions | one canonical primary root; additional roots and per-operation policy are introduced only when enforced by core tools |
| Task center | current `codex_submit/status/output/cancel` state shown as task timeline; no fabricated pause/resume capability until Codex runtime supports it |
| Local memory | locally stored, user-confirmed notes with export/import and secret filtering; never derive memory from ChatGPT conversations |
| Help/diagnostics | read-only report covering runtime, Tunnel, control-plane network route, MCP discovery, and log directory |
| Chat window | existing isolated persistent Electron session, with workspace/status bar and Settings entrypoint |
| Skills | direct packages under `<workspace>/.codex/skills`, scanned and selected as task defaults |
| Optional MCP | current restricted stdio registry; empty registry is valid and never blocks start/deploy |

## Architecture

### 1. Streamable MCP Compatibility

`src/server.ts` must delegate both `GET /mcp` and `POST /mcp` to
`StreamableHTTPServerTransport.handleRequest`. The current server-level
`POST` gate causes ChatGPT's SSE discovery request to receive 404 before tool
discovery.

Authorization remains mandatory for task calls. The implementation must use
the MCP SDK's documented authentication handoff for GET/SSE discovery rather
than emitting a hand-written SSE response. Compatibility tests must assert
that the endpoint no longer rejects a valid GET discovery request solely by
method.

### 2. Proxy Subsystem

Create `launcher/electron/proxy-service.cjs` with only these responsibilities:

- normalize HTTP/HTTPS proxy addresses and reject credential-bearing URLs;
- discover Windows Internet Settings, WinHTTP, `HTTP[S]_PROXY` variables, and
  local ports `10808`, `10809`, `7890`, `7897`, `8080`;
- probe direct OpenAI control-plane connectivity and HTTP CONNECT proxy
  reachability with bounded timeouts;
- return a renderer-safe `ProxyResolution`:
  `{ mode, source, reachable, configured, proxyUrl? }`;
- cache results for at most 60 seconds and allow explicit invalidation.

Modes are `auto`, `system`, `manual`, and `direct`. A manual unreachable
proxy prevents Tunnel launch with a specific, credential-free error. An
unreachable automatic route continues with direct connection but marks the
diagnostic result unavailable. Proxy values remain in private launcher state,
not workspace profiles or logs.

`createProfileController.start`, `setupTunnel`, and MCP-registry-triggered
restart resolve the proxy immediately before `restoreOrConnect` and pass only
the selected `proxyUrl` to the Tunnel supervisor. `tunnel-client.cjs` remains
the only component that maps this into `--control-plane.http-proxy`.

### 3. Persistent Launcher State

Extend `LauncherUiPreferences` to a versioned manager preferences model:

```ts
type ProxyMode = 'auto' | 'system' | 'manual' | 'direct';
interface LauncherUiPreferences {
  language: 'zh-CN' | 'en';
  theme: 'system' | 'light' | 'dark';
  proxyMode: ProxyMode;
  proxyUrl: string;
  startAtLogin: boolean;
  autoStartServices: boolean;
  keepRunningOnClose: boolean;
  guideDismissedSteps: number[];
}
```

The state validator must reject unknown keys, credentials in `proxyUrl`,
invalid ports, and malformed modes. Existing preference files migrate by
adding defaults. Auto-start with Windows is a later Electron integration;
the first implementation persists and displays the setting only after a
platform test proves `app.setLoginItemSettings` is safe in this launcher.

### 4. Manager Pages and Navigation

Replace the current simplified view switcher with the reference information
architecture. Every nav item must call one route state updater, update the
top bar, reset content scroll, and render an explicit empty/loading/error
state.

- **Overview:** visual connection flow, four status cards, deploy/redeploy,
  task summary, links to connection/workspace/task pages.
- **Connection:** Runtime API Key/Tunnel ID form, proxy controls, route
  status, manual re-detect, deploy/redeploy; MCP configuration is absent.
- **Workspace:** selected root, selected Skills root, profile switcher,
  available Skills/default selection. Additional roots and operation policy
  render only after enforcement APIs exist.
- **Skills:** package list, safe preview, default selection, open folder.
- **MCP (Optional):** existing restricted local registry with an empty-state
  callout saying no configuration is required.
- **Tasks:** selected task, bounded output, cancellation, recent runtime
  activity. Pause/resume/worktree controls remain hidden until core support is
  implemented.
- **Local memory:** manually authored notes stored under private app data,
  confirmation before save, import/export JSON, and redaction of sensitive
  tokens. It does not scrape ChatGPT content.
- **Help & diagnostics:** proxy/control-plane status, Tunnel process status,
  runtime health, MCP discovery result, safe log-folder action, support report
  export with redaction.
- **Settings:** theme, language, startup choices, auto-start services,
  close behavior, ChatGPT-session reset, and links to ChatGPT connector
  settings/OpenAI Tunnels/OpenAI API Keys.

### 5. ChatGPT Window

The existing `chatgpt-window.cjs` retains a separate Electron partition and
navigation allowlist. Add a compact toolbar/status region implemented in the
wrapper window, not injected into `chatgpt.com`: active workspace display,
runtime/Tunnel indicators, open manager, and reload. The website DOM remains
untouched.

### 6. Error Handling and Observability

All renderer-visible errors must be bounded and redacted. Tunnel failures must
include their safe operational cause, for example missing binary, unreachable
manual proxy, control-plane reset, or local MCP discovery failure. The tunnel
log parent directory is created before spawn. Diagnostic reports must not
include Tunnel IDs, Runtime API Keys, runtime bearer tokens, cookies, or full
proxy URLs when they contain sensitive portions.

## Delivery Phases

1. Fix streamable MCP GET/SSE compatibility and implement proxy detection,
   persistence, Tunnel forwarding, and diagnostics.
2. Rebuild manager navigation, Overview, Connection, Workspace, Skills, and
   optional MCP around the expanded snapshot.
3. Add task-center refinement, manual local-memory store, Help/Diagnostics,
   and Settings flows.
4. Add the non-injected ChatGPT wrapper toolbar and finalize responsive
   styling to the reference layout.
5. Run root and launcher tests, typecheck, build, package smoke, and verify
   the unpacked Tunnel path before delivering the EXE.

## Testing Requirements

- Unit-test proxy normalization, system-candidate parsing, local candidate
  ordering, direct/proxy probing boundaries, cache invalidation, and manual
  proxy failure.
- Add a controller test proving a resolved proxy URL reaches
  `tunnelSupervisor.restoreOrConnect` while no proxy or credentials enter IPC
  snapshots.
- Add streamable MCP HTTP tests for GET discovery and POST tool calls.
- Add state migration and validation tests for all new preferences.
- Add renderer contracts for page navigation, optional MCP copy, proxy fields,
  and no credential-bearing state display.
- Preserve current security, packaging, and lifecycle tests.

## Non-Goals

- Browser extensions, DOM injection, or interception of ChatGPT messages.
- Reading or writing ChatGPT account data, cookies, or conversations.
- Accepting arbitrary remote MCP URLs, shell commands, `npx`, or unbounded
  local process execution.
- Advertising pause/resume/worktree/document workflows before their matching
  core MCP implementation exists.
