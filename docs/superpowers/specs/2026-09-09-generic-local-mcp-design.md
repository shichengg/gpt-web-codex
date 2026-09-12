# Generic Local MCP and Branding Design

## Goal

Split the public connector surface into `skills` and optional `mcp`, support generic local stdio and loopback Streamable HTTP MCP services, and use one Electron atom icon across every product surface.

## Public tools

`skills` exposes `status`, `list`, and `read`. List and status return bounded metadata; read returns one selected `SKILL.md`.

`mcp` exposes `status`, `list_servers`, `list_tools`, and `call_tool`. With no configured servers it returns a successful optional/unconfigured result. The old `skills_mcp` route remains callable only as a compatibility alias and is omitted from MCP `tools/list`.

## Registry

Each server has `id`, `transport`, `allowedTools`, `timeoutMs`, and `enabled`.

- `stdio`: absolute executable or an approved Node command, argument array, optional absolute working directory, and a bounded environment map. No shell is used.
- `streamable-http`: URL restricted to `http://127.0.0.1:<port>/mcp` or `http://[::1]:<port>/mcp`.

Renderer-visible registry data never contains bearer tokens. HTTP tokens are stored separately in the main-process credential store.

## Discovery

Before enabling a server, the launcher connects with the selected transport and requests `tools/list`. The UI displays discovered tool names and descriptions. The user selects an explicit allowlist; wildcards remain invalid.

## Presets

- Stata GUI MCP: detected absolute `stata-gui-mcp.exe`, stdio, 120-second timeout.
- Zotero MCP: `http://127.0.0.1:23120/mcp`, Streamable HTTP, optional encrypted token.

Presets prefill configuration but use the same validation, discovery, persistence, and call paths as custom services.

## Branding

Use a clean Electron atom artwork, without screenshot background, shortcut arrow, or embedded text. Generate PNG and ICO assets for the installer, executable, title bar, taskbar, tray, and manager brand mark.

## Security

- Remote hosts, HTTPS public URLs, shell commands, `cmd /c`, PowerShell command strings, wildcard tools, and renderer-visible credentials are rejected.
- Executables are canonicalized before persistence and again before runtime use.
- HTTP MCP is loopback-only.
- Existing empty registries and node `.cjs` registries remain valid.
