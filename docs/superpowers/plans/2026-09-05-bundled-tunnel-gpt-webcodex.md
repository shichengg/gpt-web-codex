# Implementation Plan: Bundled Tunnel and GPT Web Codex Console

## 1. Establish the fixed Tunnel adapter

- Add `launcher/electron/tunnel-client.cjs` with a constructor accepting only an absolute executable path, log path, and injectable spawn/health/kill functions for tests.
- Build the exact `tunnel-client.exe run` argument list from validated supervisor inputs, using environment variables for runtime and MCP bearer credentials.
- Return owned process state, probe the configured loopback health port, redact diagnostics, and kill the owned process tree on failure/stop.
- Add focused tests before implementation for arguments, missing binary, unhealthy startup cleanup, and credential redaction.

## 2. Wire resource resolution and diagnostics

- Add `launcher/electron/resources.cjs` to resolve `resources/tools/tunnel-client.exe` in development and packaged Electron modes.
- Replace `createUnavailableTunnelAdapter()` in `electron/main.cjs` with the packaged adapter and pass the resolved path to the doctor report.
- Update diagnostic and guide text to distinguish missing packaged assets from an unpaired/failed Tunnel.
- Extend main-process contract tests so the renderer cannot override executable or target values.

## 3. Package the Tunnel client

- Add the verified reference binary at `launcher/resources/tools/tunnel-client.exe`.
- Add an explicit `extraResources` entry and packaging preflight validation in `scripts/package.cjs`.
- Update packaging contract tests and README instructions to state that Docker is not required and credentials are entered after installation.

## 4. Align the console layout

- Compare the current React views with the reference project’s navigation and card hierarchy.
- Consolidate the sidebar labels and overview status into the same scan-friendly order while preserving existing IPC contracts.
- Keep the existing Skills/MCP editors, guide, theme switcher, and ChatGPT window; only adjust presentation and copy needed for bundled Tunnel status.
- Add renderer contract tests for the new navigation labels and truthful Tunnel states.

## 5. Verify and ship

- Run root tests and launcher tests.
- Run typecheck and Vite build.
- Run `prepare-core` and electron-builder NSIS packaging.
- Run packaged `--smoke-diagnostics`; inspect the generated installer contents for `resources/tools/tunnel-client.exe`.
- Report the installer path and any external prerequisite (OpenAI Tunnel ID/runtime key) without claiming a live pairing.
