# GPT Web Codex: connector-only design

## Purpose

GPT Web Codex is an independent, TypeScript-based bridge between a ChatGPT
connector and one configured local workspace. It lets ChatGPT inspect the
workspace, use explicitly registered capabilities, and submit bounded tasks to
Codex. Codex remains the only component that changes source files.

The project deliberately does not automate or modify the ChatGPT web page. It
does not reuse the browser-extension layer in the upstream `gpt-web-codex`
reference. Its connection model, task lifecycle, security boundary, and
attribution requirements will be inspected before implementation.

## Scope

The first release lives in this standalone repository:

```text
connectors/gpt-web-codex/
```

It must not modify `Software/`, `Software-worktrees/`, or
`SoftwareBackup/DeepSeekPP-Backup/`.

The release provides:

- An authenticated connector server bound to one workspace.
- Read-only workspace and Git inspection tools.
- A bounded Codex task lifecycle: submit, status, and output.
- A local Skills catalog that lists and reads `SKILL.md` packages and lets a
  task explicitly select them.
- A local MCP registry with explicit server and tool allowlists.
- TypeScript, ESM, strict type checking, Vitest tests, and a documented local
  setup path.

It does not provide browser DOM access, content scripts, generic shell access,
arbitrary file writes, automatic MCP discovery, remote MCP servers, model
provider routing, memory, automation, or multi-workspace operation.

## Architecture

```text
ChatGPT connector
        |
authenticated bridge server
        |
  +-----+----------------+--------------------+
  |                      |                    |
workspace / Git      Skills catalog       MCP registry
  |                      |                    |
single workspace      read-only metadata   explicitly allowed local tools
        |
Codex task service
        |
fixed Codex executable + fixed workspace cwd
```

The bridge accepts only structured tool inputs. It never invokes a shell. The
Codex adapter uses `spawn` with a fixed executable, explicit argument array,
and the configured workspace as its working directory. A caller cannot choose
another host path, executable, or command fragment.

## Components

| Component | Responsibility |
| --- | --- |
| `config` | Validate bind address, authentication material, workspace root, state directory, Codex executable, Skills root, and MCP registry path. |
| `security/paths` | Canonicalize paths, prevent traversal and symlink escapes, and reject sensitive credential paths. |
| `tools/workspace` | List, read, and search only permitted workspace files. |
| `tools/git` | Return status and diff for a Git repository contained by the configured workspace. |
| `skills` | Enumerate valid `SKILL.md` packages and read one selected package within the Skills root. |
| `mcp-registry` | Load an explicit local-only registry, expose only approved servers and tools, and reject unregistered calls. |
| `codex/tasks` | Create task IDs, persist bounded state/output, and expose status and sanitized output. |
| `codex/runner` | Run the fixed Codex command with selected Skill references and no shell interpretation. |
| `server` | Authenticate requests, register tools, and manage startup and shutdown. |

## Tool surface

The connector exposes the following first-release tools:

- `workspace_info`, `list_directory`, `read_file`, `search_workspace`
- `git_status`, `git_diff`
- `list_skills`, `read_skill`
- `list_mcp_servers`, `list_mcp_tools`, `call_mcp_tool`
- `codex_submit`, `codex_status`, `codex_output`

`codex_submit` accepts a task request and optional IDs of registered Skills. It
does not accept raw shell commands or a caller-supplied working directory.

`call_mcp_tool` is limited to a server and tool already named in the registry.
The registry permits local stdio servers only in the first release. Each entry
has an explicit command, fixed arguments, optional fixed environment keys, and
an `allowedTools` list. No HTTP endpoint, wildcard tool name, automatic
discovery, or user-supplied executable is accepted.

## Security and failure handling

- Bind to loopback by default; remote exposure is an explicit deployment step.
- Require connector authentication before any tool invocation.
- Resolve the workspace and Skills roots once at startup; validate every later
  path against its canonical root.
- Deny `.env`, credential, key, token, and state files by policy.
- Cap task input, output, and persisted metadata sizes; redact obvious secrets
  from stored diagnostics.
- Fail closed when a Skill, MCP registry entry, path, or tool is not allowed.
- Time out MCP and Codex child processes and terminate them during shutdown.
- Return structured error codes without command lines, environment values, or
  source content that was not explicitly requested through a read tool.

## Test strategy

The implementation proceeds test first:

1. Path-security tests cover traversal, absolute paths, sibling paths,
   sensitive files, and symlink escapes.
2. Skills tests cover package discovery, metadata validation, allowed reads,
   and root escapes.
3. MCP-registry tests cover local-only configuration, allowed-tool checks,
   rejected unknown servers/tools, and timeout cleanup using a fake transport.
4. Workspace and Git tests use temporary fixtures and a temporary Git repo.
5. Codex-runner tests use a fake executable to prove fixed cwd/argv and no
   shell interpretation.
6. Task lifecycle tests cover submit, polling, bounded output, and redaction.
7. An integration test initializes the authenticated server, invokes the
   tool surface against fakes, and verifies the full task-status-output cycle.

Required release gates are `npm run typecheck`, `npm test`, `npm run build`,
and a local connector smoke test.

## Delivery sequence

1. Inspect upstream license, attribution, and connector/task lifecycle.
2. Scaffold package metadata and test harness.
3. Implement and test configuration plus path security.
4. Implement workspace, Git, and Skills tools.
5. Implement the allowlisted MCP registry and its tests.
6. Implement the Codex runner and task persistence with fakes first.
7. Register the authenticated connector tools and add integration coverage.
8. Document setup, threat boundaries, Skills, MCP registry configuration, and
   upstream attribution.
