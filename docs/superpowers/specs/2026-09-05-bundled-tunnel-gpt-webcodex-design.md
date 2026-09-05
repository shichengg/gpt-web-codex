# Bundled Tunnel and GPT Web Codex Console Design

## Goal

Ship a Windows desktop EXE that manages the configured Codex MCP runtime and OpenAI Tunnel without Docker. The launcher keeps the existing security boundaries and adds the verified Tunnel client used by the reference `gpt-webcodex` project.

## Architecture

Electron main process owns two child-process lifecycles: the existing local MCP runtime and a packaged `resources/tools/tunnel-client.exe`. The Tunnel adapter receives only validated Tunnel ID, runtime key, managed MCP URL, and connector name from the main process. It starts the fixed executable with fixed arguments, writes bounded diagnostics to the application log, probes the configured health port, and terminates the owned process tree on stop or quit.

The renderer never chooses an executable, arbitrary URL, shell command, or credential destination. Tunnel credentials remain in the existing protected identity store. The installer contains the client binary and audited core runtime only; no user token, cookie, API key, or workspace data is packaged.

## UI

Keep the current React/Electron console and align its information architecture with `gpt-webcodex`: overview, connection/Tunnel setup, workspace, Skills, MCP, diagnostics, logs, settings, and the dedicated ChatGPT window. Preserve Simplified Chinese and English, light/dark themes, and the existing guide/status model. Add a truthful “Tunnel client bundled” diagnostic and replace unavailable copy once the packaged client is present.

## Packaging

Add a repository-owned `launcher/resources/tools/tunnel-client.exe` source asset and include it through electron-builder `extraResources` at `resources/tools/tunnel-client.exe`. Packaging fails early if the binary is absent or not a regular file. Development mode may use the same path when present; diagnostic mode reports availability based on the resolved path.

## Verification

Unit tests cover adapter argument construction, credential redaction, health failure cleanup, and stop behavior. Contract tests verify the resource is included and the unavailable adapter is no longer wired. Build verification runs core tests, launcher tests, Vite build, `prepare-core`, electron-builder NSIS packaging, and packaged diagnostic smoke tests.
