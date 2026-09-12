# GPT-WebCodex Reference Source Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the approximate React launcher and ad-hoc ChatGPT shell with the upstream `gpt-webcodex` renderer/browser source, then add the existing Skills and optional MCP features without weakening current security boundaries.

**Architecture:** The upstream static renderer files become the only launcher UI and are copied verbatim first, then extended with two additive pages and a narrow compatibility preload. The current connector runtime, Tunnel supervisor, credential storage, Skills catalog, MCP registry, task bridge and diagnostics remain authoritative. The ChatGPT page uses the upstream toolbar and `WebContentsView` structure without upstream DOM injection.

**Tech Stack:** Electron 37, static HTML/CSS/JavaScript renderer, Node.js IPC, TypeScript connector, Vitest and Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-07-gpt-web-codex-full-parity-design.md`

## Global Constraints

- The files in `E:\project\Develop\_reference-gpt-webcodex-20260905\renderer` are the visual and structural source of truth.
- Runtime API keys, Tunnel credentials, connector tokens and ChatGPT cookies never cross into renderer snapshots or logs.
- ChatGPT remains in a dedicated persistent Electron partition and receives no DOM injection.
- Skills default selection sends metadata only; explicit selection may send full `SKILL.md` content.
- MCP is optional and an empty registry is valid.
- Existing user changes remain intact and no Git commit is created without an explicit request.

---

### Task 1: Replace the manager renderer entry

**Files:**
- Create: `launcher/renderer/index.html`
- Create: `launcher/renderer/app.js`
- Create: `launcher/renderer/styles.css`
- Create: `launcher/renderer/settings-compact.css`
- Modify: `launcher/scripts/build-renderer.cjs`
- Modify: `launcher/package.json`
- Test: `launcher/tests/reference-renderer-contract.test.cjs`

- [ ] Copy the four upstream manager renderer files without restructuring their existing page hierarchy.
- [ ] Add a build script that stages those files into `launcher/dist`.
- [ ] Verify the build output contains the upstream navigation, page identifiers and scrolling container.

### Task 2: Add the compatibility preload and manager IPC

**Files:**
- Modify: `launcher/electron/preload.cjs`
- Modify: `launcher/electron/main.cjs`
- Test: `launcher/tests/preload-contract.test.cjs`
- Test: `launcher/tests/reference-renderer-contract.test.cjs`

- [ ] Expose the upstream `mcpAssistant` API while retaining the current narrow `gptWebCodex` bridge during migration.
- [ ] Translate current snapshots into the upstream renderer's settings/environment/status schema.
- [ ] Route workspace, lifecycle, diagnostics, task, log and preference controls through validated IPC.

### Task 3: Replace the ChatGPT browser shell

**Files:**
- Create: `launcher/renderer/browser.html`
- Create: `launcher/renderer/browser.css`
- Create: `launcher/renderer/browser.js`
- Modify: `launcher/electron/browser-shell-preload.cjs`
- Modify: `launcher/electron/chatgpt-window.cjs`
- Test: `launcher/tests/chatgpt-window.test.cjs`

- [ ] Use the upstream browser toolbar markup and CSS as-is.
- [ ] Mount the isolated ChatGPT `WebContentsView` below the 112px toolbar.
- [ ] Wire navigation, manager, workspace and status controls without injecting the ChatGPT DOM.
- [ ] Surface ChatGPT load failures in the toolbar and keep the shell visible.

### Task 4: Add Skills and optional MCP to the upstream manager

**Files:**
- Modify: `launcher/renderer/index.html`
- Modify: `launcher/renderer/app.js`
- Modify: `launcher/renderer/styles.css`
- Modify: `launcher/electron/preload.cjs`
- Test: `launcher/tests/reference-renderer-contract.test.cjs`
- Test: `launcher/tests/skills.test.cjs`
- Test: `launcher/tests/registry-form.test.cjs`

- [ ] Add Skills and MCP navigation entries without moving or renaming upstream pages.
- [ ] Add a Skills catalog/default selector that displays bounded metadata and explains on-demand loading.
- [ ] Add the optional local MCP registry editor and a valid empty state.
- [ ] Preserve all existing upstream manager controls and page navigation.

### Task 5: Remove the approximate renderer from the runtime path

**Files:**
- Modify: `launcher/vite.config.ts`
- Modify: `launcher/package.json`
- Modify: `launcher/tests/packaging-contract.test.cjs`

- [ ] Remove Vite/React from the production renderer build path while leaving source history intact until verification completes.
- [ ] Ensure Electron loads only the staged upstream renderer entry.
- [ ] Ensure packaging includes manager and browser assets plus the compatibility preload.

### Task 6: Verify and package

**Files:**
- Verify: connector and launcher test suites
- Produce: `launcher/artifacts/GPT Web Codex Setup 0.1.0.exe`

- [ ] Run connector tests, typecheck and build.
- [ ] Run launcher tests and static renderer contract tests.
- [ ] Build the Windows installer and run packaged smoke diagnostics.
- [ ] Report the installer path, size and SHA256.
