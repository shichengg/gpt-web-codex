# GPT Web Codex Desktop Design

## Goal

Deliver a Windows desktop executable that manages an OpenAI Tunnel and exposes
one local, authenticated MCP runtime to ChatGPT. The runtime delegates bounded
work to the local Codex CLI and provides workspace tools, explicit Skills, and
an allowlisted local stdio MCP registry. The executable is the only management
surface; no browser extension, DOM injection, cookies, or chat-history storage
is included.

## Reference and scope

Use the `gpt-web-codex` launcher architecture as the reference for Electron,
OpenAI Tunnel lifecycle, connector pairing, private local state, Windows
packaging, diagnostics, and process supervision. Reuse or adapt only the
required launcher/Tunnel portions with attribution under the upstream MIT
license. Do not copy or ship its browser-extension, ChatGPT-web automation,
Luna, attachment, or session code.

The existing secure MCP runtime remains the execution boundary. The launcher
owns it as a child process/service rather than creating a parallel tool API.

## Architecture

```text
ChatGPT
  -> OpenAI Tunnel managed by the desktop executable
  -> local MCP runtime managed by the executable
  -> selected workspace, Codex CLI, explicit Skills, allowlisted local MCP
```

The Electron main process owns tunnel lifecycle, runtime lifecycle, private
application data, secure IPC, shutdown ordering, and diagnostics. A narrow
preload bridge exposes typed, allowlisted operations to the renderer. The
renderer does not receive tunnel credentials, raw environment variables, or
unbounded runtime output.

The runtime continues to bind to loopback. The tunnel forwards only to the
runtime created for the active profile. Startup either restores an existing
connector/tunnel identity or begins a pairing flow. A stable connector name and
tool contract are retained across restarts.

## Desktop UI

The executable has six views:

1. **Status and connection**: active workspace, runtime health, tunnel state,
   connector pairing state, start/stop/reconnect, and recent redacted errors.
2. **Workspace**: choose one workspace profile and display safe Git summary.
   Switching profiles stops the current runtime before starting the next.
3. **Skills**: scan direct `.codex/skills/<id>/SKILL.md` packages; show name,
   description, path, and preview; save enabled default IDs per workspace.
   The app can rescan and open the folder but does not edit Skill content.
4. **MCP**: form-based management of explicit local stdio servers: ID, command,
   arguments, allowed tools, and timeout. The existing registry schema rejects
   remote URLs, wildcards, empty lists, and invalid values.
5. **Tasks and logs**: show runtime task state, bounded output, cancellation,
   and redacted logs. ChatGPT conversation content is not persisted.
6. **Settings and diagnostics**: startup checks for Codex CLI, runtime,
   Tunnel, workspace access, and connector health; export redacted diagnostics.

Skills defaults are stored per workspace. A ChatGPT request with no `skillIds`
uses the profile default. Explicit `skillIds` can temporarily override defaults
only with IDs from that profile's validated catalog.

## Data and security boundaries

Private configuration, connector identity, tunnel credentials, window state,
and logs live in the Windows per-user application-data directory. Workspace
profiles retain only paths and non-secret UI choices. The runtime state directory
is excluded from workspace reads, lists, and searches.

The desktop app preserves the runtime's existing controls: one workspace per
active runtime; canonical path and sensitive-file denial; bounded text/search/
Git/task output; fixed `codex exec --json` invocation; explicit Skills; local
stdio-only MCP allowlist; cancellation propagation; secret redaction; and
structured errors. Shutdown waits for active work to cancel before stopping the
runtime and tunnel.

## Packaging and verification

Build a Windows installation package or portable executable using the upstream
launcher packaging model. First launch verifies platform support, Codex CLI,
runtime assets, workspace readability, and tunnel availability.

Required verification covers tunnel create/restore/stop, connector pairing,
profile switching, default Skills persistence, MCP validation, real tunnel tool
calls, task submit/poll/cancel, diagnostic redaction, runtime shutdown, and a
packaged Windows smoke test.

## Non-goals

No browser extension, webpage automation, DOM injection, browser profile or
cookie storage, ChatGPT history sync, arbitrary shell execution, or remote MCP
registry entries are part of this release.
