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
For the direct connector, Skills are never selected implicitly by a request.
When the desktop launcher has saved validated workspace defaults, an omitted
`skillIds` field uses those defaults; any explicit `skillIds` array, including
`[]`, overrides them for that task. Keep skill packages trusted: their content
is included in the Codex prompt.

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

## Windows desktop package

The Electron launcher can create a per-user NSIS installer after the core and
launcher have been built:

```powershell
npm run build
npm --prefix launcher run package:win
npm --prefix launcher run smoke:package
```

The installer is written to `launcher/artifacts/`. It uses an ASAR archive and
stages only the audited production connector runtime, Electron main/preload
files, and renderer assets. Publishing and automatic signing discovery are
disabled; signing is an explicit release operation outside this repository.

The **Settings & Diagnostics** view checks Codex, the managed runtime, active
profile, connector identity, and Tunnel availability, and can open the local
diagnostic-log folder. Its records contain fixed, redacted status messages.

Each workspace profile can enable a default set of Skills in the desktop
window. The launcher passes that validated selection privately to its managed
runtime. A ChatGPT `codex_submit` call that omits `skillIds` uses those
defaults; an explicit `skillIds` array (including `[]`) overrides them for
that task only.

This MVP does not package an OpenAI Tunnel client. The Task 6 adapter remains
unavailable until a compatible client and its command contract are explicitly
provisioned and verified.

### 中文桌面端首次使用

安装完成后，在桌面端按以下顺序完成首次配置：

1. 选择本地工作区。
2. 配置该工作区允许使用的 Skills 和 MCP 服务器。
3. 在“设置与诊断”的引导中检查 Tunnel 状态。只有发现并验证兼容 Tunnel 客户端后，才能继续配对；当前未发现兼容 Tunnel 客户端时，应用不会假装已经配对，必须由用户提供已验证客户端。
4. 从主控制台打开独立 ChatGPT 窗口并在其中登录 ChatGPT。
5. 使用已验证的连接器添加流程添加连接器，然后验证工作区、Skills 和 MCP 配置。

独立 ChatGPT 窗口使用 Electron 专用 session 持久化登录状态。主控制台和 MCP 不读取、显示、导出 ChatGPT Cookie，也不会访问该 session 存储目录。选择“清除 ChatGPT 登录状态”会移除这个专用 session 中的 Cookie 和相关站点数据；这不会改变工作区、Skills 或 MCP 配置。该窗口不承诺同步 ChatGPT 对话。

桌面端仅在存在并通过验证的兼容 Tunnel 客户端时才可配对；本项目不随安装包提供 Tunnel 客户端。请使用已验证的客户端和连接器支持的认证方式，避免将本地 MCP 服务直接暴露到公网。

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
