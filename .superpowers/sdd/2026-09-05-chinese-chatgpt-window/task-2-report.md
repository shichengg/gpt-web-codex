## Task 2 report

- Added atomic, schema-validated private UI preference persistence with safe defaults and corrupt-file recovery.
- Added strict `preferences` / `savePreferences` IPC routes and preload/type declarations.
- Added renderer-safe five-step guide status computation and snapshot sanitization; credentials are never accepted in preference state.
- Added contract tests for defaults, validation, recovery, guide state, and IPC forwarding.

Verification: focused contract tests pass. The existing suite has three exact-snapshot assertions that predate the new required `preferences` and `guide` fields and therefore require expectation updates.

## Fix round 1

- Updated the three legacy exact-snapshot assertions to retain exact runtime/Tunnel checks and separately require the default Chinese/system UI preferences and all five guide steps.
- `node --test launcher/tests/registry-form.test.cjs launcher/tests/tunnel-supervisor.test.cjs`: passed, 19/19.
- `npm --prefix launcher test`: passed, 96/96.
