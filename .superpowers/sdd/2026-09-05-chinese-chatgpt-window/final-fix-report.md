# Final Review Fix Report

Date: 2026-09-05

## Changes

- Added a `will-redirect` navigation guard to the dedicated ChatGPT window. Redirects use the same HTTPS host allowlist as ordinary top-level navigation; unknown targets are cancelled and allowed targets are replayed through the guarded loader. Existing isolation, popup denial, download cancellation, and permission denial remain unchanged.
- Added session-lifetime ChatGPT window state. The controller records `opened: true` only after the first successful `loadURL`, retains that fact after the child window closes, and exposes it to the main-process launcher snapshot as `chatGptOpened`. Guide step 4 now completes only from this state, never from Tunnel pairing, and uses dedicated ChatGPT-specific Chinese and English copy.
- Added renderer-side localization maps for runtime states, task states, diagnostic check IDs/statuses, and known diagnostic/runtime messages. Raw internal status and normal diagnostic/error text are no longer rendered directly in the launcher UI.
- Added regression and contract coverage for redirect handling, session-lifetime opened state, guide step 4, and renderer localization mappings.

## Red/Green Proof

- RED: the initial focused run failed 3 tests: missing `will-redirect`, step 4 remained actionable after an opened-state fixture, and localization maps were absent. Updating the guide message-key contracts then produced the expected 3 failures until the dedicated ChatGPT keys were implemented.
- GREEN: `node --test launcher/tests/chatgpt-window.test.cjs launcher/tests/settings-guide-contract.test.cjs launcher/tests/registry-form.test.cjs launcher/tests/tunnel-supervisor.test.cjs` passed all 39 tests after the production changes.

## Verification

- Root `npm test`: 64 passed, 1 skipped.
- Root `npm run typecheck`: passed.
- Root `npm run build`: passed.
- `npm --prefix launcher test`: 107 passed.
- `npm --prefix launcher run typecheck`: passed.
- `npm --prefix launcher run build`: passed.
- `npm --prefix launcher run package:win`: passed; NSIS installer generated.
- `npm --prefix launcher run smoke:package`: passed (`Packaged diagnostic smoke test passed: GPT Web Codex.exe`).
- `git diff --check`: passed.

## Package Output

- Installer: `launcher/artifacts/GPT Web Codex Setup 0.1.0.exe`, 95,764,062 bytes, Authenticode `NotSigned`.
- Unpacked executable: `launcher/artifacts/win-unpacked/GPT Web Codex.exe`, 204,521,984 bytes, Authenticode `NotSigned`.

No signing certificate was configured for this package build; unsigned status is reported as-is.
