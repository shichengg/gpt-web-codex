# GPT Web Codex Launcher UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the Electron renderer as a complete GPT-WebCodex-style management console while preserving the existing secure IPC, Tunnel, Skills, MCP, memory, and diagnostics behavior.

**Architecture:** Keep `launcher/electron/*` as the authority for lifecycle, credentials, filesystem and process operations. Reorganize the React renderer into a stable page registry with shared status cards, action bars, forms, empty states, and error feedback. Every visible command maps to an existing preload method or an explicit unavailable state; no browser DOM injection is introduced.

**Tech Stack:** React 19, TypeScript, Vite, Electron preload IPC, CSS custom properties, Node test runner, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-gpt-web-codex-full-parity-design.md`

## Global Constraints

- Simplified Chinese is the default UI language; English remains available.
- MCP is optional and an empty registry must not block startup.
- Runtime API keys, Tunnel IDs, connector tokens and ChatGPT session data never cross renderer snapshots or logs.
- ChatGPT remains an isolated Electron window; no website DOM injection.
- Only existing, tested IPC capabilities may be wired to buttons; unsupported reference features show explicit unavailable states.
- Maintain the minimum Electron width of 900px and responsive layout below that width.

### Task 1: Establish page registry and shared shell

**Files:**
- Modify: `launcher/src/App.tsx`
- Modify: `launcher/src/styles.css`
- Test: `launcher/tests/settings-guide-contract.test.cjs`

- [ ] Write a failing contract asserting the nine reference pages and shared navigation/action classes exist.
- [ ] Run `node --test tests/settings-guide-contract.test.cjs` and confirm the new contract fails before the shell is updated.
- [ ] Replace the ad-hoc view labels with a page registry containing `overview`, `deploy`, `workspace`, `tasks`, `build`, `health`, `guide`, `logs`, and `settings`, while keeping aliases for existing deep links.
- [ ] Add shared `PageHeader`, `StatusPill`, `MetricCard`, `ActionBar`, and `EmptyState` renderer components in `App.tsx`.
- [ ] Update CSS grid, sidebar, topbar, cards, buttons, forms, tables and responsive breakpoints to match the reference density without nested decorative cards.
- [ ] Run the focused contract and `npm run typecheck`.

### Task 2: Rebuild overview and deployment pages

**Files:**
- Modify: `launcher/src/App.tsx`
- Modify: `launcher/src/styles.css`
- Test: `launcher/tests/tasks-view-contract.test.cjs`

- [ ] Add tests for overview controls (`start`, `stop`, `restart`, `openChatGpt`, `refresh`) and deployment controls (`setupTunnel`, proxy save, workspace navigation).
- [ ] Run focused tests and observe the expected missing-control failures.
- [ ] Implement a reference-style overview with runtime, Tunnel, connector, proxy, workspace, Skills, and MCP metrics; each metric must render redacted state only.
- [ ] Implement deployment sections for workspace/profile, Runtime Key/Tunnel ID pairing, proxy detection, local endpoint status, and save/redeploy actions.
- [ ] Add disabled/loading/error states so duplicate starts and pair attempts are prevented while an operation is pending.
- [ ] Run focused tests and typecheck.

### Task 3: Rebuild workspace, Skills and MCP pages

**Files:**
- Modify: `launcher/src/App.tsx`
- Modify: `launcher/src/styles.css`
- Test: `launcher/tests/skills.test.cjs`
- Test: `launcher/tests/registry-form.test.cjs`

- [ ] Add renderer contracts for profile selection, authorized-root presentation, Skill catalog count, default toggles, MCP optional empty state, and saved registry reload.
- [ ] Run focused tests to verify the missing parity assertions.
- [ ] Implement workspace permission cards using existing profile APIs and show containment/security explanations without exposing secrets.
- [ ] Implement Skills as searchable/toggleable rows with preview, enabled count, open-folder action, save defaults, and nested bundle IDs.
- [ ] Implement MCP as an optional registry editor with server rows, allowed-tool chips, timeout display, remove/edit actions, reload status and an explicit empty state.
- [ ] Run focused tests and typecheck.

### Task 4: Rebuild tasks, build verification, health, guide and logs

**Files:**
- Modify: `launcher/src/App.tsx`
- Modify: `launcher/src/styles.css`
- Test: `launcher/tests/tasks-view-contract.test.cjs`
- Test: `launcher/tests/settings-guide-contract.test.cjs`

- [ ] Add contracts for task status actions, build command fields, health repair, guide step actions, log filters and redaction.
- [ ] Run focused tests and confirm failures.
- [ ] Implement task center with current task lookup, polling, cancellation, progress timeline, unavailable worktree/build controls and explicit capability messages.
- [ ] Implement build page as a safe command form that only calls the existing task/command bridge and displays output/artifact placeholders when unavailable.
- [ ] Implement health page with doctor checks, proxy/Tunnel/MCP/connector rows, open logs and repair guidance.
- [ ] Implement guide page with five setup steps and direct navigation actions.
- [ ] Implement logs page with level filters, refresh, clear/open-folder actions and renderer-side redaction.
- [ ] Run focused tests and typecheck.

### Task 5: Settings, theme, localization and ChatGPT controls

**Files:**
- Modify: `launcher/src/App.tsx`
- Modify: `launcher/src/styles.css`
- Modify: `launcher/src/types.ts`
- Test: `launcher/tests/settings-guide-contract.test.cjs`

- [ ] Add contracts for language/theme selectors, start-at-login, auto-start, keep-running, clear ChatGPT session and external documentation links.
- [ ] Run focused tests and confirm failures.
- [ ] Implement settings groups matching the reference order and preserve the existing validated preference payload.
- [ ] Add stable translations for every new label and status; no raw internal keys may render.
- [ ] Add ChatGPT controls and connector documentation links through the existing guarded IPC/open-external boundary.
- [ ] Run focused tests and typecheck.

### Task 6: Full verification and Windows artifact

**Files:**
- Modify: `README.md` if UI instructions need correction
- Test: all existing root and launcher tests

- [ ] Run root `npm test`, launcher `npm test`, both typechecks, and `git diff --check`.
- [ ] Run launcher `npm run build` and `npm run package:win`.
- [ ] Run launcher `npm run smoke:package`.
- [ ] Verify `artifacts/win-unpacked/resources/tools/tunnel-client.exe`, installer size/path, and Tunnel SHA256.
- [ ] Capture final `git status` and report any remaining reference feature gaps explicitly.
