# GPT Web Codex

[English](#english)

GPT Web Codex 是一个面向 Windows 的本地开发连接器。它通过 OpenAI Tunnel 将 ChatGPT 连接到本机代码工作区，使网页端 AI 可以在明确授权的目录中读取项目、检查 Git、调用 Codex、使用 Skills，并访问可选的本地 MCP 服务。

桌面程序只提供后端设置、状态和诊断界面，不内嵌 ChatGPT 网页，也不保存 ChatGPT Cookie 或登录会话。

## 核心功能

### ChatGPT 连接本地开发环境

- 通过官方 OpenAI Tunnel 暴露经过认证的 MCP 服务。
- Windows 安装包包含内置 Tunnel 客户端，无需 Docker。
- 软件启动后可自动启动本地 Runtime 并恢复 Tunnel 连接。
- ChatGPT 连接器刷新后即可使用当前工作区提供的工具。

### 工作区与权限管理

- 每个配置文件绑定一个经过规范化检查的本地工作区。
- 支持切换工作区，并在切换后重新加载 Runtime 和 MCP 配置。
- 文件读取、目录浏览和搜索均限制在授权工作区内。
- `.git`、`.env`、密钥、证书和运行状态目录等敏感路径默认拒绝访问。

### Codex 与 Git

- 向本机 Codex CLI 提交有边界的开发任务。
- 查询任务状态、读取输出和取消任务。
- 查看工作区概况、Git 状态和受限大小的 Git diff。
- 对输入、输出、运行时间和可访问路径设置明确上限。

### Skills

- 扫描工作区中的 `.codex/skills/<skill-id>/SKILL.md`。
- 支持 `.codex/skills/<bundle>/skills/<skill-id>/SKILL.md` 形式的 Skills bundle。
- 默认只向 ChatGPT 提供 Skill 名称和描述，需要时才读取完整 `SKILL.md`。
- 可以在桌面设置中保存当前工作区的默认 Skills。
- 提交任务时仍可显式选择、替换或禁用默认 Skills。

### 可选的本地 MCP

- MCP 完全可选；不配置 MCP 也可以使用工作区、Skills 和 Codex 功能。
- 支持同时添加多个本地 MCP 服务，无需在服务之间切换。
- 支持本地 stdio MCP 和 `127.0.0.1` / `::1` 上的 Streamable HTTP MCP。
- 自动执行 `tools/list` 连接测试，并将发现的工具加入当前服务的 allowlist。
- 每个 MCP 可以独立启用、停用、编辑、删除和测试。
- 支持 Stata、Zotero 预设，也支持其他本地 Python、Node.js 和独立 EXE MCP。
- HTTP MCP Token 单独保存在主进程私有存储中，不写入 registry、日志或界面快照。

### Stata GUI MCP

GPT Web Codex 提供通用的本地 MCP 接入能力。当前 Stata 兼容性仅测试了配套使用的 [Stata GUI MCP](https://github.com/shichengg/stata-mcp)；该 MCP 是独立项目，由 `shichengg` 开发维护，不包含在本仓库中。其他 Stata MCP 实现尚未经过兼容性测试。

Stata GUI MCP 通过 Windows Stata Automation COM 控制可见的 Stata GUI，支持：

- 持久 Stata Session；
- 运行完整 `.do` 文件和多行 Stata 命令；
- 自动读取真实 Stata text log；
- 获取数据结构、返回结果和估计结果；
- 在不同 `session_id` 中维护独立的 Stata GUI 会话。

GPT Web Codex 会保持 Stata MCP 的 stdio 连接，使网页端多轮调用能够复用同一 Session。如果首次 `stata_run_dofile` 恰逢 `profile.do` 初始化，且返回日志尚未生成，程序会等待 2 秒并在同一 Session 自动重试一次。普通 Stata 语法错误不会自动重试。

首次建立 Stata GUI Session 时，应调用：

```text
mcp(action="call_tool", server_id="stata", tool="stata_run_dofile", input={
  "path": "E:/project/example/analysis.do",
  "session_id": "main",
  "role": "entry"
})
```

`stata_status` 只检查状态，`stata_run` 需要已有 Session；两者都不会创建首次 GUI Session。

### 后端桌面管理

- 简体中文和英文界面。
- 浅色、深色和跟随系统主题。
- 工作区、Skills、MCP、Tunnel、代理和日志集中管理。
- 自动检测直连、Windows 系统代理和常见本地代理。
- 关闭窗口后可以继续在系统托盘运行。
- 托盘只提供“打开设置”和“退出”，不包含内置网页浏览器。

## 工作原理

```text
ChatGPT 网页
    │
    │ OpenAI Tunnel / MCP
    ▼
GPT Web Codex Runtime
    ├── 工作区读取与搜索
    ├── Git 状态与 diff
    ├── Codex 任务
    ├── Skills
    └── 可选本地 MCP
          ├── Stata GUI MCP
          ├── Zotero MCP
          └── 其他本地 MCP
```

Tunnel 只负责把 ChatGPT 请求安全转发到本机 Runtime。本地 Runtime 负责鉴权、工具 schema、工作区边界、Skills、任务和下游 MCP 调用。

## 安全边界

- Runtime 和本地 HTTP MCP 只允许监听回环地址。
- 不允许将远程 URL 注册为下游 MCP。
- stdio MCP 不通过 shell 启动；拒绝 `cmd.exe`、PowerShell 和通配工具。
- 下游 MCP 必须使用显式工具 allowlist。
- Tunnel Runtime Key、MCP Token 和内部 Bearer Token 不发送到渲染进程。
- 日志和任务输出在进入界面前会脱敏并限制长度。
- 工作区外路径和常见敏感文件默认拒绝访问。

本工具能够读取和修改授权项目，也可以执行 Codex 与本地 MCP 操作。建议始终使用 Git，并只配置可信的工作区、Skills 和 MCP。

## 安装与首次配置

### 环境要求

- Windows 10/11 x64；
- 已安装并可运行的 Codex CLI；
- OpenAI Tunnel ID 和 Runtime API Key；
- 使用 Stata MCP 时，需要已授权的 Stata 17/18/19、Python 3.10–3.13 和已注册的 Stata Automation COM。

### 安装桌面程序

从源码构建 `GPT Web Codex Setup 0.1.0.exe`，运行安装程序。安装完成后：

1. 选择本地工作区；
2. 配置需要使用的默认 Skills；
3. 按需添加 Stata、Zotero 或其他本地 MCP；
4. 填写 Tunnel ID 和 Runtime API Key；
5. 启动本地 Runtime 与 Tunnel；
6. 在系统浏览器中打开 ChatGPT，并刷新或创建自定义连接器。

桌面程序不会打开内置 ChatGPT 页面。ChatGPT 登录和连接器注册始终在用户自己的外部浏览器中完成。

### Stata MCP 安装

```powershell
pip install stata-gui-mcp
```

以管理员身份注册实际安装的 Stata：

```powershell
Start-Process -FilePath "D:\Stata18\StataMP-64.exe" -ArgumentList "/Register" -Wait
```

然后在 GPT Web Codex 的 MCP 页面选择 Stata 预设，确认 `stata-gui-mcp.exe` 路径，保存并测试连接。

## 源码运行与构建

```powershell
git clone https://github.com/shichengg/gpt-web-codex.git
cd gpt-web-codex

npm install
npm run typecheck
npm test
npm run build

npm --prefix launcher install
npm --prefix launcher run typecheck
npm --prefix launcher test
npm --prefix launcher run build
```

构建 Windows 安装包：

```powershell
npm --prefix launcher run package:win
npm --prefix launcher run smoke:package
```

安装包输出到 `launcher/artifacts/`。

## 许可证与致谢

项目代码按 MIT License 发布，第三方组件和来源说明见 [NOTICE](NOTICE)。

- 配套测试的 [Stata GUI MCP](https://github.com/shichengg/stata-mcp) 是独立项目，由 `shichengg` 开发维护；
- OpenAI Tunnel 客户端及其他第三方组件保留各自许可证与权利声明。

---

<a id="english"></a>

# English

GPT Web Codex is a Windows desktop connector that links ChatGPT to a local development workspace through OpenAI Tunnel. It lets a web AI inspect authorized projects, check Git, submit bounded Codex tasks, use Skills, and call optional local MCP services.

The desktop application provides backend settings, status, and diagnostics only. It does not embed the ChatGPT website or store ChatGPT cookies and sign-in sessions.

## Features

### Connect ChatGPT to a local workspace

- Exposes an authenticated MCP runtime through the official OpenAI Tunnel.
- Bundles the Tunnel client in the Windows installer; Docker is not required.
- Can start the local runtime and restore the Tunnel connection automatically.
- Works with a ChatGPT custom connector after its tool definitions are refreshed.

### Workspace and permission management

- Binds each profile to a canonical local workspace.
- Reloads runtime and MCP configuration when the active workspace changes.
- Keeps file reads, directory inspection, and search inside authorized roots.
- Denies common sensitive locations such as `.git`, `.env`, credentials, keys, certificates, and runtime state.

### Codex and Git

- Submits bounded development tasks to the local Codex CLI.
- Reads task status and output and supports cancellation.
- Reports workspace context, Git status, and bounded Git diffs.
- Applies explicit limits to paths, inputs, outputs, and execution time.

### Skills

- Discovers `.codex/skills/<skill-id>/SKILL.md` packages.
- Supports bundled `.codex/skills/<bundle>/skills/<skill-id>/SKILL.md` layouts.
- Exposes Skill names and descriptions first and reads full instructions only when needed.
- Saves validated default Skills per workspace.
- Allows each task to explicitly select, replace, or disable workspace defaults.

### Optional local MCP services

- MCP configuration is optional; workspace, Skills, and Codex features work without it.
- Multiple local MCP services can remain enabled at the same time.
- Supports local stdio and loopback Streamable HTTP MCP transports.
- Uses `tools/list` for connection testing and automatically adds discovered tools to the service allowlist.
- Lets each service be enabled, disabled, edited, removed, and tested independently.
- Includes Stata and Zotero presets and supports other local Python, Node.js, and standalone executable MCP servers.
- Stores HTTP MCP tokens separately in private main-process state, never in registry files, logs, or renderer snapshots.

### Stata GUI MCP

GPT Web Codex provides generic local MCP integration. Its Stata compatibility has currently been tested only with the companion [Stata GUI MCP](https://github.com/shichengg/stata-mcp). That MCP is a separate project developed and maintained by `shichengg`; it is not bundled as part of this repository. Other Stata MCP implementations have not been compatibility-tested.

Stata GUI MCP controls a visible Stata GUI through Windows Stata Automation COM and provides:

- persistent Stata sessions;
- complete `.do` file and multiline command execution;
- automatic retrieval of real Stata text logs;
- data inspection and returned/estimated result collection;
- separate GUI sessions identified by `session_id`.

GPT Web Codex keeps the Stata MCP stdio connection alive so web requests can reuse the same session. If the first `stata_run_dofile` call races with `profile.do` initialization and its log is not ready, GPT Web Codex waits two seconds and retries once in the same session. Ordinary Stata syntax errors are not retried.

The first visible Stata GUI session must be created with `stata_run_dofile` and an absolute `.do` path. `stata_status` only reports status, while `stata_run` requires an existing session.

### Backend desktop manager

- Simplified Chinese and English UI.
- Light, dark, and system themes.
- Central management for workspaces, Skills, MCP, Tunnel, proxy, and logs.
- Automatic detection of direct, Windows system, and common local proxy routes.
- Optional background operation through the Windows system tray.
- The tray contains only backend Settings and Exit actions; there is no embedded browser.

## How it works

```text
ChatGPT web
    │
    │ OpenAI Tunnel / MCP
    ▼
GPT Web Codex Runtime
    ├── Workspace inspection
    ├── Git status and diff
    ├── Codex tasks
    ├── Skills
    └── Optional local MCP
          ├── Stata GUI MCP
          ├── Zotero MCP
          └── Other local MCP services
```

OpenAI Tunnel forwards authenticated requests to the local runtime. The runtime owns tool schemas, workspace boundaries, Skills, tasks, and downstream MCP calls.

## Security

- Runtime and local HTTP MCP endpoints are loopback-only.
- Remote downstream MCP URLs are rejected.
- stdio MCP servers start without a shell; `cmd.exe`, PowerShell, and tool wildcards are rejected.
- Downstream tools require an explicit allowlist.
- Tunnel Runtime Keys, MCP tokens, and internal Bearer tokens never enter the renderer.
- Logs and task output are redacted and bounded before display.
- Paths outside authorized workspaces and common sensitive files are denied.

GPT Web Codex can read and modify authorized projects and can invoke Codex and local MCP tools. Use version control and register only trusted workspaces, Skills, and MCP services.

## Installation and first-time setup

### Requirements

- Windows 10/11 x64;
- an installed and working Codex CLI;
- an OpenAI Tunnel ID and Runtime API Key;
- for Stata MCP: licensed Stata 17/18/19, Python 3.10–3.13, and registered Stata Automation COM.

### Desktop installation

Build `GPT Web Codex Setup 0.1.0.exe` from source, run the installer, and then:

1. select a local workspace;
2. configure workspace default Skills;
3. optionally add Stata, Zotero, or other local MCP services;
4. enter the Tunnel ID and Runtime API Key;
5. start the local runtime and Tunnel;
6. open ChatGPT in your system browser and refresh or create the custom connector.

The desktop application never opens an embedded ChatGPT page. ChatGPT authentication and connector registration remain in the user's external browser.

### Development

```powershell
git clone https://github.com/shichengg/gpt-web-codex.git
cd gpt-web-codex

npm install
npm run typecheck
npm test
npm run build

npm --prefix launcher install
npm --prefix launcher run typecheck
npm --prefix launcher test
npm --prefix launcher run build
```

Build the Windows installer:

```powershell
npm --prefix launcher run package:win
npm --prefix launcher run smoke:package
```

The installer is written to `launcher/artifacts/`.

## License and acknowledgements

Project source is released under the MIT License. See [NOTICE](NOTICE) for third-party attribution.

- The compatibility-tested companion [Stata GUI MCP](https://github.com/shichengg/stata-mcp) is a separate project developed and maintained by `shichengg`.
- OpenAI Tunnel and other third-party components retain their respective licenses and notices.
