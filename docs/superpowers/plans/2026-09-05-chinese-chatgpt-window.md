# 中文 ChatGPT 窗口与设置引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GPT Web Codex 做成默认简体中文、支持浅色/深色主题、有安全独立 ChatGPT 登录窗口和可恢复设置引导的 Windows 桌面控制台。

**Architecture:** 主控制台仍是唯一拥有本地 MCP、工作区、Skills、任务、Tunnel 和私有配置的受信任 Electron renderer。新增的 `ChatGptWindowController` 由主进程独占管理，它使用独立持久 session、没有 preload 或 IPC，并将所有顶层导航、弹窗、下载和权限请求置于严格白名单策略下。主题/语言/无敏感引导状态写入现有私有状态存储；渲染器通过窄 IPC 查询并操作这些状态。

**Tech Stack:** Electron 37、React 19、TypeScript、Vite、Node.js built-in test runner、Vitest、electron-builder/NSIS。

**Spec:** `docs/superpowers/specs/2026-09-05-chinese-chatgpt-window-design.md`

## Global Constraints

- 默认简体中文；提供 English、浅色、深色和跟随系统主题，所有用户可见文案必须本地化。
- ChatGPT 窗口必须使用独立的持久 Electron session，且 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、无 preload、无 IPC。
- 不读取、显示、导出或经 MCP 传递 ChatGPT Cookie、访问令牌、对话或历史；清除操作仅清理 ChatGPT 专用 session。
- 仅允许 HTTPS 顶层导航到明确的 ChatGPT/OpenAI/登录提供商域名；阻止未知导航、下载、权限请求和未知弹窗。
- 主控制台不得获得任意 URL/工具/命令能力；新增 IPC 只能是固定 `openChatGpt`、`clearChatGptSession`、主题和引导状态操作。
- 维持纯本地 MCP、工作区路径边界、受控本地 stdio MCP 和严格 Tunnel 监督器；不得伪造未发现的兼容 Tunnel 客户端或已配对状态。
- 不增加浏览器扩展、DOM 注入、Cookie 导出、远程 MCP、浏览器调试端口或通用 shell。
- 每项任务按测试先行执行，提交前运行其指定测试；最终必须运行根目录及 launcher 全量测试、类型检查、构建、Windows NSIS 打包和解包包体冒烟测试。

---

## File Structure

- Create: `launcher/electron/chatgpt-window.cjs` — 受限 ChatGPT BrowserWindow、专用 session、导航/权限/下载/弹窗策略、清除 session。
- Create: `launcher/tests/chatgpt-window.test.cjs` — Electron 依赖替身下的窗口安全与持久化契约。
- Modify: `launcher/electron/main.cjs` — 初始化控制器、严格 IPC、允许主控制台触发固定 ChatGPT 操作、退出清理。
- Modify: `launcher/electron/preload.cjs` — 仅把 `openChatGpt`、`clearChatGptSession` 暴露给主控制台 renderer。
- Modify: `launcher/src/types.ts` — 主题、引导、ChatGPT 窗口状态和固定 API 类型。
- Modify: `launcher/electron/state.cjs` 或新建 `launcher/electron/launcher-state.cjs` — 非敏感 UI 设置的校验、默认和恢复。
- Modify: `launcher/src/App.tsx` — 中文信息架构、工作区/Skills/MCP/任务页复用、主题选择、ChatGPT 操作、五步引导和状态。
- Modify: `launcher/src/styles.css` — 令牌化浅/深色主题、白色界面、深色界面、响应式卡片与无障碍焦点样式。
- Modify: `launcher/tests/preload-contract.test.cjs`、`launcher/tests/window-security.test.cjs` — IPC 及主窗口安全回归。
- Create: `launcher/tests/settings-guide-contract.test.cjs` — 设置状态、文案/主题/引导及渲染器合同。
- Modify: `README.md` — 中文/英文启动、内嵌 ChatGPT 登录存储、清除登录状态、Tunnel 未就绪说明。

## Task 1: 受限 ChatGPT 窗口与固定 IPC

**Files:**
- Create: `launcher/electron/chatgpt-window.cjs`
- Create: `launcher/tests/chatgpt-window.test.cjs`
- Modify: `launcher/electron/main.cjs`
- Modify: `launcher/electron/preload.cjs`
- Modify: `launcher/src/types.ts`
- Modify: `launcher/tests/preload-contract.test.cjs`
- Modify: `launcher/tests/window-security.test.cjs`

**Interfaces:**
- Consumes: `BrowserWindow`、`session.fromPartition()`、`ipcMain` 和现有 `registerIpc` sender guard。
- Produces: `createChatGptWindowController({ BrowserWindow, session, shell, logger }): { open(): Promise<{ open: true }>; clearSession(): Promise<void>; close(): void; snapshot(): { open: boolean } }`。
- Produces: renderer API `openChatGpt(): Promise<void>` 和 `clearChatGptSession(): Promise<void>`，没有 URL 参数、session 对象或 cookie API。

- [ ] **Step 1: 写出 ChatGPT 窗口安全失败测试**

在 `launcher/tests/chatgpt-window.test.cjs` 中使用 BrowserWindow/session 的最小替身，要求独立窗口具有专用持久 partition、无 preload/Node/IPC，并验证未允许 URL 被拒绝：

```js
test('opens ChatGPT in an isolated persistent session', async () => {
  const controller = createChatGptWindowController({ BrowserWindow, session, logger });
  await controller.open();
  assert.equal(session.fromPartitionCalls[0], 'persist:gpt-web-codex-chatgpt');
  assert.equal(BrowserWindow.calls[0].webPreferences.nodeIntegration, false);
  assert.equal(BrowserWindow.calls[0].webPreferences.contextIsolation, true);
  assert.equal(BrowserWindow.calls[0].webPreferences.sandbox, true);
  assert.equal(BrowserWindow.calls[0].webPreferences.preload, undefined);
});

test('blocks untrusted navigation, permission, download and popup targets', async () => {
  const controller = createChatGptWindowController({ BrowserWindow, session, logger });
  await controller.open();
  assert.equal(BrowserWindow.last.navigationAllowed('https://evil.example/'), false);
  assert.equal(BrowserWindow.last.popupAllowed('https://evil.example/').action, 'deny');
  assert.equal(BrowserWindow.last.permissionGranted('notifications'), false);
  assert.equal(BrowserWindow.last.downloadPrevented, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`node --test launcher/tests/chatgpt-window.test.cjs`

预期：失败，提示模块或 `createChatGptWindowController` 尚不存在。

- [ ] **Step 3: 实现安全窗口控制器**

创建 `chatgpt-window.cjs`，固定 session 与允许 host 集合；白名单至少包含 `chatgpt.com`、`*.chatgpt.com`、`openai.com`、`*.openai.com`、`auth.openai.com` 以及为交互式登录所需的 Google、Microsoft、Apple 登录 host。只验证 HTTPS 顶层 `URL.hostname`，不将 URL 查询参数写入日志。实现固定入口：

```js
const CHATGPT_PARTITION = 'persist:gpt-web-codex-chatgpt';
const CHATGPT_HOME = 'https://chatgpt.com/';

function createChatGptWindowController({ BrowserWindow, session, logger }) {
  let chatWindow = null;
  const chatSession = session.fromPartition(CHATGPT_PARTITION);
  function open() {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show(); chatWindow.focus();
      return Promise.resolve({ open: true });
    }
    chatWindow = new BrowserWindow({
      width: 1240, height: 860, minWidth: 900, minHeight: 640,
      webPreferences: { partition: CHATGPT_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    installChatGptGuards(chatWindow, chatSession, logger);
    return chatWindow.loadURL(CHATGPT_HOME).then(() => ({ open: true }));
  }
  async function clearSession() {
    await chatSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    await chatSession.clearCache();
  }
  return Object.freeze({ open, clearSession, close: () => chatWindow?.close(), snapshot: () => ({ open: Boolean(chatWindow && !chatWindow.isDestroyed()) }) });
}
```

`installChatGptGuards` 必须对 `will-navigate` 调用 `event.preventDefault()`，然后仅对 `isAllowedChatGptUrl(url)` 为真时 `loadURL(url)`；`setWindowOpenHandler` 只允许同样白名单的同一隔离窗口策略，其他一律 `{ action: 'deny' }`；`will-download` 取消；`setPermissionRequestHandler` 始终回调 `false`。对无效 URL 一律拒绝，不抛出 URL 内容。

- [ ] **Step 4: 将控制器接入主进程与 preload**

在 `main.cjs` app-ready 后创建该控制器；在主窗口关闭/应用退出时关闭 ChatGPT 窗口。添加 sender-guarded IPC，并拒绝任意 payload：

```js
'launcher:open-chatgpt': guarded((args) => {
  requireNoPayload(args, 'openChatGpt');
  return chatGptWindow.open();
}),
'launcher:clear-chatgpt-session': guarded((args) => {
  requireNoPayload(args, 'clearChatGptSession');
  return chatGptWindow.clearSession();
}),
```

在 `preload.cjs` 中添加无参数 API；在 `types.ts` 中声明 `UiTheme = 'system' | 'light' | 'dark'`、`openChatGpt` 和 `clearChatGptSession`。不要给 ChatGPT 窗口提供 preload，也不要把 `session`、`shell` 或 `ipcRenderer` 暴露出去。

- [ ] **Step 5: 扩充固定 IPC 与窗口安全测试**

在 preload 合同中精确断言新增的两个方法和通道；在主进程 sender 测试中对有 payload 的 `launcher:open-chatgpt`、`launcher:clear-chatgpt-session` 断言拒绝。添加清除测试：

```js
test('clears only the dedicated ChatGPT session', async () => {
  await controller.clearSession();
  assert.deepEqual(session.partition('persist:gpt-web-codex-chatgpt').clearedStorages,
    ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']);
  assert.equal(mainSession.clearStorageDataCalls.length, 0);
});
```

- [ ] **Step 6: 运行任务验证**

运行：`npm --prefix launcher test`

预期：所有 launcher 测试通过，新增窗口安全和 preload 契约在其中通过。

- [ ] **Step 7: 提交**

```bash
git add launcher/electron/chatgpt-window.cjs launcher/electron/main.cjs launcher/electron/preload.cjs launcher/src/types.ts launcher/tests/chatgpt-window.test.cjs launcher/tests/preload-contract.test.cjs launcher/tests/window-security.test.cjs
git commit -m "feat: add isolated ChatGPT desktop window"
```

## Task 2: 私有 UI 首选项与可恢复设置引导状态

**Files:**
- Modify: `launcher/electron/state.cjs` 或 Create: `launcher/electron/launcher-state.cjs`
- Modify: `launcher/electron/main.cjs`
- Modify: `launcher/electron/preload.cjs`
- Modify: `launcher/src/types.ts`
- Create: `launcher/tests/settings-guide-contract.test.cjs`
- Modify: `launcher/tests/preload-contract.test.cjs`

**Interfaces:**
- Consumes: 现有 `createJsonStateStore(filePath)` 原子写入机制、controller `snapshot()` 和 Doctor 的脱敏检查。
- Produces: `LauncherUiPreferences { language: 'zh-CN' | 'en'; theme: 'system' | 'light' | 'dark'; guideDismissedSteps: number[] }`；默认 `{ language: 'zh-CN', theme: 'system', guideDismissedSteps: [] }`。
- Produces: `preferences(): Promise<LauncherUiPreferences>`、`savePreferences(input: LauncherUiPreferences): Promise<LauncherUiPreferences>`，输入必须完整、尺寸受限且无任何凭据字段。

- [ ] **Step 1: 写失败的状态校验与 IPC 测试**

在 `settings-guide-contract.test.cjs` 测试状态恢复与输入拒绝：

```js
test('defaults UI preferences to Simplified Chinese and system theme', async () => {
  assert.deepEqual(await preferences.read(), { language: 'zh-CN', theme: 'system', guideDismissedSteps: [] });
});

test('rejects unknown themes and sensitive guide payloads', async () => {
  await assert.rejects(() => preferences.write({ language: 'zh-CN', theme: 'neon', guideDismissedSteps: [] }));
  await assert.rejects(() => preferences.write({ language: 'zh-CN', theme: 'dark', guideDismissedSteps: [], runtimeKey: 'secret' }));
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`node --test launcher/tests/settings-guide-contract.test.cjs`

预期：失败，因为 preferences API 与严格 schema 不存在。

- [ ] **Step 3: 实现无敏感状态 schema 与窄 IPC**

创建或扩展 state 模块，显式白名单字段，禁止附加字段，限制已忽略步骤为唯一的 1–5 整数数组。`main.cjs` 初始化 state store 后向 controller snapshot 合并 `preferences` 和只读 guide status；新增严格 payload validator：

```js
function validatePreferences(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !['language', 'theme', 'guideDismissedSteps'].includes(key))) {
    throw new TypeError('Invalid UI preferences');
  }
  if (!['zh-CN', 'en'].includes(value.language) || !['system', 'light', 'dark'].includes(value.theme)) {
    throw new TypeError('Invalid UI preference value');
  }
  const steps = value.guideDismissedSteps;
  if (!Array.isArray(steps) || steps.length > 5 || new Set(steps).size !== steps.length || steps.some((step) => !Number.isInteger(step) || step < 1 || step > 5)) {
    throw new TypeError('Invalid guide steps');
  }
  return Object.freeze({ language: value.language, theme: value.theme, guideDismissedSteps: [...steps].sort() });
}
```

预加载只公开 `preferences()` 与 `savePreferences(preferences)`。引导状态只从已有 profile、Skills/MCP、Doctor/Tunnel snapshot 计算；不得把运行时 key、Cookie 或 connector credentials 合入状态。

- [ ] **Step 4: 实现引导步骤状态计算并测试真实失败状态**

新增 controller 纯函数 `guideStateFrom({ snapshot, profiles, doctor })`，产生五个 `{ id, status: 'complete' | 'needs-action' | 'unavailable', messageKey }`。在测试中固定如下情形：没有 profile → 第 1 步 needs-action；空 MCP 合法；缺少兼容 Tunnel → 第 3 步 unavailable；没有配对时不得输出 `complete`。

```js
assert.equal(guideStateFrom({ snapshot: { workspace: '/work', paired: false }, doctor: unavailableTunnel })[2].status, 'unavailable');
```

- [ ] **Step 5: 运行任务验证**

运行：`npm --prefix launcher test`

预期：preferences、guide 和 preload 契约测试通过；旧状态文件缺失/损坏时仍安全回退默认值。

- [ ] **Step 6: 提交**

```bash
git add launcher/electron/state.cjs launcher/electron/main.cjs launcher/electron/preload.cjs launcher/src/types.ts launcher/tests/settings-guide-contract.test.cjs launcher/tests/preload-contract.test.cjs
git commit -m "feat: persist Chinese launcher preferences and guide state"
```

## Task 3: 中文控制台、双主题和设置引导界面

**Files:**
- Modify: `launcher/src/App.tsx`
- Modify: `launcher/src/styles.css`
- Modify: `launcher/src/types.ts`
- Modify: `launcher/tests/settings-guide-contract.test.cjs`
- Modify: `launcher/tests/tasks-view-contract.test.cjs`

**Interfaces:**
- Consumes: `LauncherSnapshot.preferences`、`guideSteps`、`openChatGpt()`、`clearChatGptSession()`、现有 workspace/Skills/MCP/task APIs。
- Produces: 默认中文六页导航和 `<html data-theme="system|light|dark">`，设置页可保存语言/主题/已忽略引导步骤。

- [ ] **Step 1: 写失败的渲染器合同测试**

在 `settings-guide-contract.test.cjs` 读取 `App.tsx` 或使用现有 renderer 合同模式，断言中文文案、主题字段、固定操作和五个引导项出现：

```js
assert.match(appSource, /简体中文/);
assert.match(appSource, /浅色/);
assert.match(appSource, /深色/);
assert.match(appSource, /打开 ChatGPT/);
assert.match(appSource, /清除 ChatGPT 登录状态/);
assert.match(appSource, /选择工作区[\s\S]*配置 Skills 与本地 MCP[\s\S]*检测本地运行时与兼容 Tunnel 客户端/);
```

同时断言任务页持续仅用固定 `task()` / `cancelTask()`，不得新增任意 runtime 调用。

- [ ] **Step 2: 运行测试确认失败**

运行：`node --test launcher/tests/settings-guide-contract.test.cjs launcher/tests/tasks-view-contract.test.cjs`

预期：失败，因为当前英文控制台没有中文/主题/引导/ChatGPT 登录清除 UI。

- [ ] **Step 3: 重构 App 为中文默认、状态驱动的六页控制台**

将当前 `App.tsx` 的英语静态标签替换为统一文案表，默认 `zh-CN`；保留 `en` 完整映射。导航从现有视图调整为 `主页`、`工作区`、`Skills`、`MCP`、`任务与日志`、`设置与引导`；不要删除已有受控输入校验、任务 2 秒轮询、日志脱敏或固定取消操作。

在根元素应用主题：

```tsx
useEffect(() => {
  document.documentElement.dataset.theme = snapshot.preferences.theme;
}, [snapshot.preferences.theme]);

async function updatePreferences(next: LauncherUiPreferences) {
  const saved = await window.gptWebCodex.savePreferences(next);
  setSnapshot((current) => current ? { ...current, preferences: saved } : current);
}
```

主页的“打开 ChatGPT”只能调用 `window.gptWebCodex.openChatGpt()`；设置页的“清除 ChatGPT 登录状态”只能调用 `clearChatGptSession()` 并给出中文成功/失败信息。不得向 renderer 暴露 URL、Cookie 或 session 状态。

- [ ] **Step 4: 实现视觉令牌和三主题样式**

在 `styles.css` 以 CSS custom properties 定义语义令牌，不在组件中硬编码颜色：

```css
:root[data-theme='light'] { --page: #f6f7fb; --surface: #ffffff; --text: #172033; --muted: #5d6b82; --border: #dfe4ee; --accent: #2563eb; }
:root[data-theme='dark'] { --page: #0b1020; --surface: #121a2b; --text: #eaf0ff; --muted: #a7b2c9; --border: #2a3852; --accent: #7ca7ff; }
:root[data-theme='system'] { color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root[data-theme='system'] { --page: #0b1020; /* 同 dark token */ } }
```

完成侧栏、状态卡、步骤卡、表单、日志和按钮的统一间距、聚焦状态、禁用态与窄窗口布局。浅色主题必须以白色表面为主；深色主题不能出现浅色主题的低对比文本。保持无图片、无网络字体依赖。

- [ ] **Step 5: 实现设置向导与真实状态文案**

设置页将五步渲染为 `GuideStepCard`，根据主进程给出的 status 显示完成、需要操作或不可用。第 3 步必须在 Doctor 找不到兼容 Tunnel 客户端时显示明确中文提示，且不会把未配对 Tunnel 呈现为成功。第 4 步提供打开 ChatGPT；第 5 步运行既有 Doctor。只允许用户关闭其已完成/已理解的无敏感步骤，关闭状态通过 `savePreferences` 保存。

- [ ] **Step 6: 运行 UI/类型验证**

运行：`npm --prefix launcher test`

运行：`npm --prefix launcher run typecheck`

运行：`npm --prefix launcher run build`

预期：合同测试、TypeScript 和 Vite 构建全部通过。

- [ ] **Step 7: 提交**

```bash
git add launcher/src/App.tsx launcher/src/styles.css launcher/src/types.ts launcher/tests/settings-guide-contract.test.cjs launcher/tests/tasks-view-contract.test.cjs
git commit -m "feat: add Chinese themed launcher and setup guide"
```

## Task 4: 文档、打包回归与独立窗口验收

**Files:**
- Modify: `README.md`
- Modify: `launcher/tests/packaging-contract.test.cjs`
- Modify: `launcher/scripts/smoke-package.cjs`（仅当当前诊断无法证明 ChatGPT controller 代码包含在 asar 时）
- Modify: `launcher/package.json`（仅当需要将新增代码显式纳入打包资源）

**Interfaces:**
- Consumes: Tasks 1–3 的固定 API、`ChatGptWindowController` 和 CSS 打包结果。
- Produces: 可安装 NSIS 文件，其主控台包含中文/主题/向导/独立 ChatGPT 窗口代码；README 清晰描述 Cookie 存储边界与 Tunnel 前置条件。

- [ ] **Step 1: 写失败的文档与打包合同测试**

在 `packaging-contract.test.cjs` 中断言 packaged asar/源阶段包含 `electron/chatgpt-window.cjs`，并且不会把 ChatGPT session 存储目录作为 `extraResources` 打包。读取 README 并断言有“独立 ChatGPT 窗口”“清除 ChatGPT 登录状态”“不导出 Cookie”“兼容 Tunnel 客户端”这些说明。

```js
assert.match(readme, /不读取、显示、导出.*Cookie/);
assert.match(readme, /兼容 Tunnel 客户端/);
assert.match(packageConfig, /asar/);
```

- [ ] **Step 2: 运行测试确认失败**

运行：`node --test launcher/tests/packaging-contract.test.cjs`

预期：失败，直到 README 与打包合同覆盖新增边界。

- [ ] **Step 3: 更新 README 与必要的打包合同**

添加简短中文优先的安装/首次使用说明：选择工作区、配置 Skills/MCP、使用设置引导检测 Tunnel、在独立窗口登录 ChatGPT、添加连接器、验证。说明 Cookie 仅在 Electron 专用 session 中持久化，清除按钮会移除它们，主控制台与 MCP 永不访问它们。说明当前没有发现兼容 Tunnel 客户端时不会真的配对，用户必须提供已验证客户端。不得承诺 ChatGPT 对话同步。

如 `electron-builder` 已打包整个 `launcher/electron`，只加强测试，不扩大 `extraResources`。不要将 session/cookie 数据预置到安装包中。

- [ ] **Step 4: 运行完整验证**

运行：`npm test`

运行：`npm run typecheck`

运行：`npm run build`

运行：`npm --prefix launcher test`

运行：`npm --prefix launcher run typecheck`

运行：`npm --prefix launcher run build`

运行：`npm --prefix launcher run package:win`

运行：`npm --prefix launcher run smoke:package`

预期：根测试全部通过（已知平台跳过除外）；launcher 全部通过；NSIS 安装包和解包应用诊断均通过。检查 `launcher/artifacts/GPT Web Codex Setup 0.1.0.exe` 的 Authenticode 状态并在交付说明中如实报告签名状态。

- [ ] **Step 5: 提交**

```bash
git add README.md launcher/tests/packaging-contract.test.cjs launcher/scripts/smoke-package.cjs launcher/package.json
git commit -m "docs: describe Chinese ChatGPT desktop setup"
```

## Plan Self-Review

- Spec coverage: Task 1 实现独立持久 session、无 IPC/Node、白名单/权限/下载/弹窗防护和登录清除；Task 2 实现默认中文、主题/引导状态与真实 Tunnel 不可用状态；Task 3 实现中文信息架构、白色/深色视觉和设置向导；Task 4 覆盖文档、NSIS 和解包验收。
- 安全边界: 每个与 ChatGPT session 接触的接口都由主进程固定意图控制；没有任意 URL、Cookie 或 runtime 工具能力。
- 术语一致性: `ChatGptWindowController`、`openChatGpt`、`clearChatGptSession` 和 `LauncherUiPreferences` 在所有任务中使用同一名称。
- Placeholder scan: 不含占位内容、未定义的后续实现或“按需处理”步骤。
