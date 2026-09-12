# Generic Local MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separate public Skills/MCP tools, generic local transports, discovery, presets, and unified product branding.

**Architecture:** Extend the shared registry schema with explicit transport variants, route each variant through its MCP SDK transport, and keep tokens in main-process storage. Keep the reference renderer and add the generic MCP manager through the existing extension layer.

**Tech Stack:** Electron, TypeScript, MCP SDK, Node test runner, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-generic-local-mcp-design.md`

## Global Constraints

- MCP remains optional.
- Only local stdio and loopback HTTP are accepted.
- Credentials never enter renderer snapshots or registry files.
- The old `skills_mcp` route is compatibility-only and hidden from `tools/list`.

### Task 1: Split public tools

**Files:** `src/server.ts`, `tests/connector.integration.test.ts`

- [ ] Add failing schema/list/call tests for `skills` and `mcp`.
- [ ] Implement both tools and hide `skills_mcp` from public discovery.
- [ ] Verify an empty MCP registry returns success.

### Task 2: Add registry transport variants

**Files:** `src/mcp/registry.ts`, `launcher/electron/registry.cjs`, related tests.

- [ ] Add failing tests for generic stdio, loopback HTTP, and rejected remote/shell forms.
- [ ] Implement canonical transport-specific validation.
- [ ] Verify old node and empty registries still load.

### Task 3: Add transport routing and discovery

**Files:** `src/mcp/transport.ts`, launcher IPC/preload, related tests.

- [ ] Add failing tests for stdio and Streamable HTTP calls and `tools/list` discovery.
- [ ] Implement transport selection with timeout/cancellation.
- [ ] Return only bounded tool metadata to the renderer.

### Task 4: Build the generic MCP UI

**Files:** `launcher/public/extensions.js`, `launcher/public/styles.css`, UI tests.

- [ ] Add transport, command/URL, args, cwd, environment, token, timeout, enabled and discovery controls.
- [ ] Add Stata and Zotero presets using the generic flow.
- [ ] Preserve optional empty state and explicit tool allowlist.

### Task 5: Unify icon assets

**Files:** Electron PNG/ICO assets, package metadata, browser/manager renderer.

- [ ] Generate clean Electron atom PNG and ICO assets.
- [ ] Apply them to installer, executable, windows, tray and renderer branding.
- [ ] Verify packaged resources and product naming.

### Task 6: Verify and package

- [ ] Run core and launcher tests, typecheck and builds.
- [ ] Build the Windows installer and run smoke diagnostics.
- [ ] Report installer SHA256.
