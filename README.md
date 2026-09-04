# GPT Web Codex

GPT Web Codex is a connector-only bridge between ChatGPT and one local
workspace. It exposes an authenticated MCP endpoint and delegates approved
tasks to the installed `codex` CLI. It does not inject scripts into websites
and does not contain a browser extension.

## Requirements

- Node.js 20 or newer
- A working `codex` executable on `PATH`
- A workspace directory that the connector is allowed to inspect
- A long, private connector token

Install dependencies and build:

```sh
npm install
npm run typecheck
npm test
npm run build
```

## Configuration

The two required variables are `CODEX_WORKSPACE_ROOT` and
`CODEX_CONNECTOR_TOKEN`. Defaults are loopback-only and local to the selected
workspace:

| Variable | Required | Default |
| --- | --- | --- |
| `CODEX_WORKSPACE_ROOT` | yes | — |
| `CODEX_CONNECTOR_TOKEN` | yes | — |
| `CODEX_HOST` | no | `127.0.0.1` |
| `CODEX_PORT` | no | `48765` |
| `CODEX_SKILLS_ROOT` | no | `<workspace>/.codex/skills` |
| `CODEX_STATE_DIR` | no | `<workspace>/.codex/state` |
| `CODEX_MCP_REGISTRY` | no | `<workspace>/mcp-registry.json` |

Start locally (PowerShell):

```powershell
$env:CODEX_WORKSPACE_ROOT = 'E:\project\Develop'
$env:CODEX_CONNECTOR_TOKEN = '<private-token>'
npm start
```

The MCP endpoint is `http://127.0.0.1:48765/mcp` and requires
`Authorization: Bearer <private-token>`. This loopback bridge is intended for
compatible MCP clients running on the same host. ChatGPT cannot register or
reach a loopback address with a manually supplied Bearer token. To connect
ChatGPT, deploy an explicit HTTPS endpoint or tunnel with connector-supported
authentication (including OAuth or a supported token exchange); that
deployment and authentication layer is outside this MVP and is not currently
implemented. Do not expose the local service publicly without such an access
control layer.

The connector binds to exactly one workspace at startup. Restart it with a
different `CODEX_WORKSPACE_ROOT` to switch projects; requests cannot select a
second root.

## Skills

Skills are read-only packages directly beneath `CODEX_SKILLS_ROOT`:

```text
.codex/skills/<skill-id>/SKILL.md
```

Each `SKILL.md` starts with simple frontmatter containing `name` and
`description`, followed by the instructions. ChatGPT can list available
skills, read a selected skill, and submit a Codex task with explicit `skillIds`.
Skills are never selected implicitly by a request. Keep skill packages
trusted: their content is included in the Codex prompt.

## MCP registry

The registry is local JSON and accepts only explicitly allowlisted stdio
servers. Remote `url` entries, wildcard tools, duplicate IDs, and empty tool
lists are rejected. Start with the empty example:

```json
{ "servers": [] }
```

An entry has this shape:

```json
{
  "servers": [
    {
      "id": "repo-linter",
      "command": "node",
      "args": ["tools/repo-linter.mjs"],
      "allowedTools": ["check"],
      "timeoutMs": 30000
    }
  ]
}
```

Only commands and arguments in this file are launched. Register the smallest
tool allowlist needed for the workspace and review every command before
starting the service. `timeoutMs` must be between 1,000 and 120,000 ms.

### Desktop launcher executable policy

The Electron launcher applies a stricter policy before it writes a profile
registry: it permits only `node`/`node.exe` with exactly one absolute `.cjs`
entrypoint canonically contained in `<workspace>/.codex/mcp`. It rejects
`npx`, shells (`cmd`, PowerShell, and similar launchers), `node -e`, additional
arguments, relative paths, links escaping that directory, remote URLs, and
proxy-style arguments. Put an approved local server at a path such as
`C:\workspace\.codex\mcp\repo-linter.cjs`. The core runtime repeats this
trusted-workspace validation when it loads a mutable non-empty registry.

## Connector tools and task states

The connector provides workspace metadata, bounded directory/file reads,
workspace search, Git status/diff, explicit Skills reads, MCP registry calls,
and Codex task submission/status/output. A task moves through:

```text
queued -> running -> succeeded
                 \-> failed
                 \-> timed_out
                 \-> cancelled
```

Task state is persisted as JSON in `CODEX_STATE_DIR`. It is automatically
excluded from all workspace read, list, and search tools, including when the
state directory is beneath the workspace. The state directory is local
operational data; do not commit it or place credentials in it.

## Safety limits

- Workspace reads: 64 KiB per file, 200 directory entries, 100 search matches.
- Workspace search: 200 entries, 200 files, 512 KiB, and one second in total;
  responses include scan metadata and say when a limit truncated results.
- Git output: 128 KiB and truncated when necessary.
- HTTP request body: 1 MiB.
- Codex prompt: 256 KiB; selected Skills context: 64 KiB; at most 64 Skills.
- Task output: 128 KiB; task metadata: 512 KiB.
- Sensitive paths such as `.git`, `.env`, credentials, `.pem`, and `.key` are
  denied. Paths must remain beneath the configured workspace.

These bounds protect the bridge from accidental disclosure and oversized
requests; they are not a substitute for reviewing prompts, Skills, or MCP
commands.

## ChatGPT setup

Run the connector with a same-host compatible MCP client. Start by calling
`workspace_info`, then `list_skills` and `list_mcp_servers` to verify the
binding. Submit only the task and Skills needed for the current workspace. A
successful `codex_submit` returns a running task ID immediately; poll
`codex_status`, use `codex_cancel` when needed, and fetch the bounded result
with `codex_output`. A ChatGPT deployment requires the
explicit HTTPS/tunnel and connector authentication layer described above;
ChatGPT registration is outside this MVP.

## License and attribution

See [`NOTICE`](NOTICE) for attribution to the MIT-licensed connection-model
reference and the explicit browser-extension scope boundary.
