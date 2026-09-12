import { useEffect, useState } from "react";
import type {
  GuideStep,
  DiagnosticReport,
  LauncherSnapshot,
  LauncherUiPreferences,
  McpRegistryDraft,
  McpServerDraft,
  MemoryEntry,
  SkillSummary,
  TaskActivity,
  WorkspaceProfile,
} from "./types";

const views = [
  "overview",
  "deploy",
  "home",
  "connection",
  "workspace",
  "skills",
  "mcp",
  "tasks",
  "build",
  "health",
  "guide",
  "logs",
  "memory",
  "help",
  "settings",
] as const;
type View = (typeof views)[number];
const navigationGroups: Array<{ label: TextKey; items: Array<{ view: View; icon: string }> }> = [
  { label: "navConnection", items: [{ view: "overview", icon: "⌂" }, { view: "deploy", icon: "◇" }, { view: "workspace", icon: "▱" }, { view: "skills", icon: "✦" }, { view: "mcp", icon: "◇" }] },
  { label: "navTasks", items: [{ view: "tasks", icon: "✓" }, { view: "build", icon: "▣" }, { view: "health", icon: "♥" }] },
  { label: "navSupport", items: [{ view: "guide", icon: "i" }, { view: "logs", icon: "≡" }, { view: "memory", icon: "▤" }, { view: "settings", icon: "⚙" }] },
];
type TextKey = keyof (typeof dictionary)["zh-CN"];
type Translate = (key: TextKey, values?: Record<string, string>) => string;

const defaultPreferences: LauncherUiPreferences = {
  language: "zh-CN",
  theme: "system",
  proxyMode: "auto",
  proxyUrl: "",
  startAtLogin: false,
  autoStartServices: true,
  keepRunningOnClose: true,
  guideDismissedSteps: [],
};
const initialSnapshot: LauncherSnapshot = {
  state: "stopped",
  workspace: null,
  preferences: defaultPreferences,
  guide: [],
};

const dictionary = {
  "zh-CN": {
    overview: "总览",
    deploy: "部署与连接",
    build: "构建验证",
    health: "诊断与修复",
    guide: "接入指南",
    logs: "运行日志",
    home: "主页",
    connection: "连接设置",
    workspace: "工作区",
    skills: "Skills",
    mcp: "MCP",
    tasks: "任务与日志",
    memory: "本地记忆",
    help: "帮助与诊断",
    settings: "设置与引导",
    navConnection: "连接",
    navTasks: "任务",
    navSupport: "支持",
    loading: "正在加载启动器状态…",
    loadingError: "无法读取启动器状态。",
    workspaceDataError: "无法加载工作区配置或 Skills。",
    runtimeError: "无法{action}本地运行时。",
    status: "连接状态",
    workspaceLabel: "工作区",
    runtime: "本地运行时",
    tunnel: "Tunnel",
    connector: "连接器",
    noWorkspace: "尚未选择工作区",
    awaitingStatus: "正在等待状态",
    notConfigured: "未配置",
    paired: "已配对",
    notPaired: "未配对",
    start: "启动运行时",
    stop: "停止运行时",
    proxyMode: "代理模式",
    proxyAuto: "自动检测（推荐）",
    proxySystem: "Windows 系统代理",
    proxyManual: "手动代理",
    proxyDirect: "强制直连",
    proxyUrl: "手动代理地址",
    proxySaved: "代理设置已保存。下次启动或重新配对时生效。",
    tunnelSetup: "OpenAI Tunnel 设置",
    tunnelHelp:
      "启动本地运行时后，输入 OpenAI Tunnel ID 与运行时密钥进行配对。密钥仅发送至主进程，不会显示在状态或日志中，也不会保存在工作区配置内。",
    tunnelId: "Tunnel ID",
    runtimeKey: "运行时密钥",
    pairTunnel: "配对 Tunnel",
    tunnelPaired: "Tunnel 已配对并保存到当前运行的本地运行时。",
    tunnelPairError:
      "无法配对 Tunnel。请检查 Tunnel ID、运行时密钥和本地运行时状态。",
    profiles: "工作区配置",
    profileHelp: "配置仅保存本地路径与 Skill 选择，不保存运行时凭证。",
    profileId: "配置 ID",
    workspaceRoot: "工作区根目录",
    skillsRoot: "Skills 根目录",
    saveSelect: "保存并选择配置",
    select: "选择",
    profileSaved: "工作区配置已保存。",
    profileChanged: "当前工作区配置已切换。",
    profileSaveError: "无法保存此工作区配置。",
    profileSelectError: "无法选择此工作区配置。",
    skillDefaults: "Skills 默认项",
    skillHelp: "选择要在此工作区默认启用的 Skills。",
    openFolder: "打开文件夹",
    noSkills: "在此配置的 Skills 根目录中没有发现有效的直接子级 Skill。",
    saveDefaults: "保存默认项",
    skillsSaved: "当前工作区的 Skill 默认项已保存。",
    skillsSaveError: "无法保存 Skill 默认项。",
    selectProfileFirst: "请先保存并选择工作区配置，再查看其 Skills。",
    mcpTitle: "本地 stdio MCP 注册表（可选）",
    mcpHelp:
      "仅接受已批准的本地 node 可执行文件，以及此工作区 .codex/mcp 目录下一个绝对 .cjs 入口。不能使用 URL、shell、npx、通配工具、凭证或环境设置。",
    serverId: "服务 ID",
    localCommand: "本地命令",
    entrypoint: "已批准入口（一个绝对 .cjs 路径）",
    allowedTools: "允许的工具（每行一个）",
    timeout: "超时（毫秒）",
    addServer: "添加服务",
    remove: "移除",
    saveRegistry: "保存本地注册表",
    mcpValidation: "请填写 ID、本地命令、至少一个允许工具和整数超时。",
    mcpDuplicate: "每个 MCP 服务必须使用唯一 ID。",
    mcpAdded: "服务条目已加入未保存注册表。",
    mcpSaved: "本地 MCP 注册表已保存。运行时将重新加载此已验证的注册表。",
    mcpSaveError: "注册表未保存。请检查本地命令、工具和超时。",
    mcpEmpty: "未配置 MCP。MCP 是可选项，不配置也可以使用本地运行时和 Skills。",
    mcpReloaded: "已加载当前工作区的 MCP 配置。",
    tasksTitle: "任务与日志",
    tasksHelp:
      "这里仅显示有边界且已脱敏的本地任务活动和近期运行时日志，不会保留聊天内容或凭证。",
    taskId: "任务 ID",
    cancelTask: "取消任务",
    cancellationRequested: "已请求取消该任务。",
    taskReadError: "无法读取此任务。请确认本地运行时正在运行且任务 ID 有效。",
    taskCancelError: "无法取消此任务。请输入符合约束的任务 ID。",
    selectedTask: "已选任务",
    taskTruncated: "本地运行时限制已截断任务输出。",
    recentLogs: "近期运行时日志",
    noLogs: "暂无近期运行时活动。",
    preferences: "界面偏好",
    language: "语言",
    simplifiedChinese: "简体中文",
    english: "English",
    theme: "主题",
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
    preferencesSaved: "界面偏好已保存。",
    preferencesSaveError: "无法保存界面偏好。",
    guideHelp:
      "根据本机实际状态完成设置。引导不显示或导出 URL、Cookie 或登录会话。",
    chooseWorkspace: "选择工作区",
    configureSkillsMcp: "配置 Skills 与本地 MCP",
    checkTunnel: "检测本地运行时与兼容 Tunnel 客户端",
    guideOpenChat: "配置 ChatGPT 连接器",
    runDoctor: "自动检查本地状态",
    guideComplete: "已完成",
    guideNeedsAction: "需要操作",
    guideUnavailable: "不可用",
    dismiss: "关闭此步骤",
    guideDismissed: "引导步骤已关闭。",
    guideDismissError: "无法保存引导步骤状态。",
    guideProfileReady: "工作区配置已就绪。",
    guideProfileRequired: "请选择并保存工作区配置。",
    guideSkillsReady: "Skills 或本地 MCP 已配置。",
    guideSkillsRequired: "请配置 Skills 或本地 MCP。",
    guideTunnelPaired: "Tunnel 已与本地运行时配对。",
    guideTunnelRequired: "请启动运行时并配对兼容 Tunnel 客户端。",
    guideConnectorReady: "连接器已就绪。",
    guideConnectorRequired: "请先完成运行时和 Tunnel 配对。",
    guideChatGptReady: "ChatGPT 连接器已配置。",
    guideChatGptRequired: "请在外部浏览器中配置 ChatGPT 连接器。",
    guideRuntimeReady: "本地运行时正在运行且已配对。",
    guideRuntimeRequired: "请启动本地运行时并完成 Tunnel 配对。",
    tunnelUnavailable:
      "未找到兼容的 Tunnel 客户端；请安装或配置兼容客户端后重新检测。",
    diagnostics: "本地诊断",
    diagnosticsHelp:
      "检查只报告本地前置条件与固定状态，不会导出凭证、令牌或运行时密钥。",
    openLogs: "打开本地日志",
    diagnosticsError: "无法运行本地诊断。",
    logsOpened: "已打开本地诊断日志文件夹。",
    logsOpenError: "无法打开本地诊断日志文件夹。",
    statusUnknown: "状态未知",
    runtimeStateStopped: "已停止",
    runtimeStateStarting: "正在启动",
    runtimeStateRunning: "正在运行",
    runtimeStateStopping: "正在停止",
    runtimeStateError: "错误",
    diagnosticOk: "正常",
    diagnosticWarning: "警告",
    diagnosticErrorStatus: "错误",
    diagnosticCheckCodex: "Codex CLI",
    diagnosticCheckRuntime: "本地运行时",
    diagnosticCheckProfile: "工作区配置",
    diagnosticCheckTunnel: "Tunnel",
    diagnosticCheckConnector: "连接器",
    diagnosticCodexMissing: "未找到 Codex CLI。",
    diagnosticCodexReady: "Codex CLI 可用。",
    diagnosticRuntimeAssetsMissing: "本地运行时文件不可用。",
    diagnosticRuntimeError: "本地运行时报告错误。",
    diagnosticRuntimeRunning: "本地运行时正在运行。",
    diagnosticProfileMissing: "尚未配置工作区配置。",
    diagnosticProfileReady: "工作区配置已就绪。",
    diagnosticTunnelUnavailable: "此启动器未提供兼容的 Tunnel 客户端。",
    diagnosticTunnelError: "兼容的 Tunnel 客户端报告错误。",
    diagnosticTunnelPaired: "兼容的 Tunnel 客户端可用且已配对。",
    diagnosticConnectorMissing: "连接器身份尚未配置。",
    diagnosticConnectorReady: "连接器身份已配置。",
    taskQueued: "排队中",
    taskRunning: "运行中",
    taskSucceeded: "已成功",
    taskFailed: "失败",
    taskTimedOut: "已超时",
    taskCancelled: "已取消",
    memoryTitle: "记忆标题",
    memoryContent: "记忆内容",
    memoryScope: "保存范围",
    memoryGlobal: "所有工作区",
    memoryWorkspace: "当前工作区",
    addMemory: "保存记忆",
    removeMemory: "删除记忆",
    memorySaved: "记忆已保存。",
    memoryRemoved: "记忆已删除。",
    memoryError: "记忆未保存。请检查内容长度，且不要填写密钥、Token 或 Cookie。",
    noMemory: "还没有保存的本地记忆。",
    startAtLogin: "登录 Windows 时启动",
    autoStartServices: "打开软件时自动启动本地服务",
    keepRunningOnClose: "关闭主窗口后继续运行服务",
  },
  en: {
    overview: "Overview",
    deploy: "Deploy & connect",
    build: "Build verification",
    health: "Diagnostics & repair",
    logs: "Runtime logs",
    home: "Home",
    connection: "Connection",
    workspace: "Workspace",
    skills: "Skills",
    mcp: "MCP",
    tasks: "Tasks & Logs",
    memory: "Local memory",
    help: "Help & diagnostics",
    settings: "Settings & Guide",
    navConnection: "Connection",
    navTasks: "Tasks",
    navSupport: "Support",
    loading: "Loading launcher status…",
    loadingError: "Unable to read launcher status.",
    workspaceDataError: "Unable to load workspace profiles or Skills.",
    runtimeError: "Unable to {action} the local runtime.",
    status: "Connection status",
    workspaceLabel: "Workspace",
    runtime: "Runtime",
    tunnel: "Tunnel",
    connector: "Connector",
    noWorkspace: "No workspace selected",
    awaitingStatus: "Awaiting status",
    notConfigured: "Not configured",
    paired: "paired",
    notPaired: "not paired",
    start: "Start runtime",
    stop: "Stop runtime",
    proxyMode: "Proxy mode",
    proxyAuto: "Automatic (recommended)",
    proxySystem: "Windows system proxy",
    proxyManual: "Manual proxy",
    proxyDirect: "Direct connection",
    proxyUrl: "Manual proxy URL",
    proxySaved: "Proxy settings saved. They apply on the next start or pairing.",
    tunnelSetup: "OpenAI Tunnel setup",
    tunnelHelp:
      "With the local runtime running, enter the OpenAI Tunnel ID and runtime key to pair it. The key is sent only to the main process, is not shown in status or logs, and is never saved with the workspace profile.",
    tunnelId: "Tunnel ID",
    runtimeKey: "Runtime key",
    pairTunnel: "Pair tunnel",
    tunnelPaired: "Tunnel paired and saved for this running local runtime.",
    tunnelPairError:
      "Unable to pair the tunnel. Check the Tunnel ID, runtime key, and local runtime status.",
    profiles: "Workspace profiles",
    profileHelp:
      "Profiles contain only local paths and Skill choices. Runtime credentials are never stored here.",
    profileId: "Profile ID",
    workspaceRoot: "Workspace root",
    skillsRoot: "Skills root",
    saveSelect: "Save and select profile",
    select: "Select",
    profileSaved: "Workspace profile saved.",
    profileChanged: "Active workspace profile changed.",
    profileSaveError: "Unable to save this workspace profile.",
    profileSelectError: "Unable to select this workspace profile.",
    skillDefaults: "Skills defaults",
    skillHelp:
      "Enable the Skills that should be selected by default for this workspace.",
    openFolder: "Open folder",
    noSkills:
      "No valid direct-child Skills were found in this profile’s Skills root.",
    saveDefaults: "Save defaults",
    skillsSaved: "Skill defaults saved for the active workspace.",
    skillsSaveError: "Unable to save Skill defaults.",
    selectProfileFirst:
      "Save and select a workspace profile before reviewing its Skills.",
    mcpTitle: "Local stdio MCP registry (optional)",
    mcpHelp:
      "Only the approved local node executable and one absolute .cjs entrypoint under this workspace’s .codex/mcp folder are accepted. URLs, shells, npx, wildcard tools, credentials, and environment settings are not supported.",
    serverId: "Server ID",
    localCommand: "Local command",
    entrypoint: "Approved entrypoint (one absolute .cjs path)",
    allowedTools: "Allowed tools (one per line)",
    timeout: "Timeout (ms)",
    addServer: "Add server",
    remove: "Remove",
    saveRegistry: "Save local registry",
    mcpValidation:
      "Enter an ID, local command, at least one allowed tool, and an integer timeout.",
    mcpDuplicate: "Each MCP server needs a unique ID.",
    mcpAdded: "Server entry added to the unsaved registry.",
    mcpSaved:
      "Local MCP registry saved. The runtime will reload this validated registry.",
    mcpSaveError:
      "The registry was not saved. Check the local command, tools, and timeout.",
    mcpEmpty: "No MCP servers configured. MCP is optional; runtime and Skills work without it.",
    mcpReloaded: "Loaded the MCP registry for the active workspace.",
    tasksTitle: "Tasks and logs",
    tasksHelp:
      "Only bounded, redacted local task activity and recent runtime logs are shown here. Chat content and credentials are not retained.",
    taskId: "Task ID",
    cancelTask: "Cancel task",
    cancellationRequested: "Cancellation requested for the task.",
    taskReadError:
      "Unable to read this task. Confirm that the local runtime is running and the task ID is valid.",
    taskCancelError: "Unable to cancel this task. Enter its bounded task ID.",
    selectedTask: "Selected task",
    taskTruncated: "Task output was truncated by the local runtime limit.",
    recentLogs: "Recent runtime logs",
    noLogs: "No recent runtime activity.",
    preferences: "Interface preferences",
    language: "Language",
    simplifiedChinese: "Simplified Chinese",
    english: "English",
    theme: "Theme",
    system: "System",
    light: "Light",
    dark: "Dark",
    preferencesSaved: "Interface preferences saved.",
    preferencesSaveError: "Unable to save interface preferences.",
    guide: "Setup guide",
    guideHelp:
      "Complete setup from real local status. The guide never displays or exports URLs, cookies, or login sessions.",
    chooseWorkspace: "Choose workspace",
    configureSkillsMcp: "Configure Skills and local MCP",
    checkTunnel: "Check local runtime and compatible Tunnel client",
    guideOpenChat: "Configure ChatGPT connector",
    runDoctor: "Check local status automatically",
    guideComplete: "Complete",
    guideNeedsAction: "Needs action",
    guideUnavailable: "Unavailable",
    dismiss: "Dismiss step",
    guideDismissed: "Guide step dismissed.",
    guideDismissError: "Unable to save guide state.",
    guideProfileReady: "Workspace profile is ready.",
    guideProfileRequired: "Choose and save a workspace profile.",
    guideSkillsReady: "Skills or local MCP is configured.",
    guideSkillsRequired: "Configure Skills or local MCP.",
    guideTunnelPaired: "Tunnel is paired with the local runtime.",
    guideTunnelRequired: "Start the runtime and pair a compatible Tunnel client.",
    guideConnectorReady: "Connector is ready.",
    guideConnectorRequired: "Complete runtime and Tunnel pairing first.",
    guideChatGptReady: "The ChatGPT connector is configured.",
    guideChatGptRequired: "Configure the ChatGPT connector in your external browser.",
    guideRuntimeReady: "The local runtime is running and paired.",
    guideRuntimeRequired: "Start the local runtime and complete Tunnel pairing.",
    tunnelUnavailable:
      "A compatible Tunnel client was not found. Install or configure one, then check again.",
    diagnostics: "Local diagnostics",
    diagnosticsHelp:
      "Checks report local prerequisites and fixed status only. Credentials, tokens, and runtime keys are never exported.",
    openLogs: "Open local logs",
    diagnosticsError: "Unable to run local diagnostics.",
    logsOpened: "Opened the local diagnostic log folder.",
    logsOpenError: "Unable to open the local diagnostic log folder.",
    statusUnknown: "Unknown status",
    runtimeStateStopped: "Stopped",
    runtimeStateStarting: "Starting",
    runtimeStateRunning: "Running",
    runtimeStateStopping: "Stopping",
    runtimeStateError: "Error",
    diagnosticOk: "OK",
    diagnosticWarning: "Warning",
    diagnosticErrorStatus: "Error",
    diagnosticCheckCodex: "Codex CLI",
    diagnosticCheckRuntime: "Local runtime",
    diagnosticCheckProfile: "Workspace profile",
    diagnosticCheckTunnel: "Tunnel",
    diagnosticCheckConnector: "Connector",
    diagnosticCodexMissing: "Codex CLI was not found on PATH.",
    diagnosticCodexReady: "Codex CLI is available.",
    diagnosticRuntimeAssetsMissing: "Packaged core runtime assets are unavailable.",
    diagnosticRuntimeError: "Managed local runtime reported an error.",
    diagnosticRuntimeRunning: "Managed local runtime is running.",
    diagnosticProfileMissing: "No active workspace profile is configured.",
    diagnosticProfileReady: "An active workspace profile is configured.",
    diagnosticTunnelUnavailable: "OpenAI Tunnel client is unavailable in this launcher build.",
    diagnosticTunnelError: "OpenAI Tunnel client reported an error.",
    diagnosticTunnelPaired: "OpenAI Tunnel client is available and paired.",
    diagnosticConnectorMissing: "Connector identity is not configured.",
    diagnosticConnectorReady: "Connector identity is configured.",
    taskQueued: "Queued",
    taskRunning: "Running",
    taskSucceeded: "Succeeded",
    taskFailed: "Failed",
    taskTimedOut: "Timed out",
    taskCancelled: "Cancelled",
    memoryTitle: "Memory title",
    memoryContent: "Memory content",
    memoryScope: "Save scope",
    memoryGlobal: "All workspaces",
    memoryWorkspace: "Current workspace",
    addMemory: "Save memory",
    removeMemory: "Delete memory",
    memorySaved: "Memory saved.",
    memoryRemoved: "Memory deleted.",
    memoryError: "Memory was not saved. Check its length and do not enter keys, tokens, or cookies.",
    noMemory: "No local memories saved yet.",
    startAtLogin: "Start with Windows",
    autoStartServices: "Start local services when the app opens",
    keepRunningOnClose: "Keep services running after closing the main window",
  },
} as const;

const guideMessageKeys: Record<string, TextKey> = {
  "guide.profile.ready": "guideProfileReady",
  "guide.profile.required": "guideProfileRequired",
  "guide.skills.ready": "guideSkillsReady",
  "guide.skills.required": "guideSkillsRequired",
  "guide.tunnel.unavailable": "tunnelUnavailable",
  "guide.tunnel.paired": "guideTunnelPaired",
  "guide.tunnel.required": "guideTunnelRequired",
  "guide.connector.ready": "guideConnectorReady",
  "guide.connector.required": "guideConnectorRequired",
  "guide.chatgpt.ready": "guideChatGptReady",
  "guide.chatgpt.required": "guideChatGptRequired",
  "guide.runtime.ready": "guideRuntimeReady",
  "guide.runtime.required": "guideRuntimeRequired",
};

const runtimeStateLabels: Record<string, TextKey> = {
  stopped: "runtimeStateStopped",
  starting: "runtimeStateStarting",
  running: "runtimeStateRunning",
  stopping: "runtimeStateStopping",
  error: "runtimeStateError",
};
const diagnosticStatusLabels: Record<string, TextKey> = {
  ok: "diagnosticOk",
  warning: "diagnosticWarning",
  error: "diagnosticErrorStatus",
};
const diagnosticCheckLabels: Record<string, TextKey> = {
  codex: "diagnosticCheckCodex",
  runtime: "diagnosticCheckRuntime",
  profile: "diagnosticCheckProfile",
  tunnel: "diagnosticCheckTunnel",
  connector: "diagnosticCheckConnector",
};
const diagnosticMessageKeys: Record<string, TextKey> = {
  "Codex CLI was not found on PATH.": "diagnosticCodexMissing",
  "Codex CLI is available.": "diagnosticCodexReady",
  "Packaged core runtime assets are unavailable.": "diagnosticRuntimeAssetsMissing",
  "Managed local runtime reported an error.": "diagnosticRuntimeError",
  "Managed local runtime is running.": "diagnosticRuntimeRunning",
  "No active workspace profile is configured.": "diagnosticProfileMissing",
  "An active workspace profile is configured.": "diagnosticProfileReady",
  "OpenAI Tunnel client is unavailable in this launcher build.": "diagnosticTunnelUnavailable",
  "OpenAI Tunnel client reported an error.": "diagnosticTunnelError",
  "OpenAI Tunnel client is available and paired.": "diagnosticTunnelPaired",
  "Connector identity is not configured.": "diagnosticConnectorMissing",
  "Connector identity is configured.": "diagnosticConnectorReady",
};
const runtimeMessageKeys: Record<string, TextKey> = {
  "Launcher is ready.": "awaitingStatus",
  "Runtime process exited unexpectedly (code 7)": "diagnosticsError",
  "Runtime process exited unexpectedly": "diagnosticsError",
  "Runtime is not running": "runtimeStateStopped",
};
const taskStateLabels: Record<string, TextKey> = {
  queued: "taskQueued",
  running: "taskRunning",
  succeeded: "taskSucceeded",
  failed: "taskFailed",
  timed_out: "taskTimedOut",
  cancelled: "taskCancelled",
};

function localizedMessage(value: string | undefined, t: Translate): string {
  if (!value) return t("statusUnknown");
  const key = diagnosticMessageKeys[value] ?? runtimeMessageKeys[value];
  return key ? t(key) : t("statusUnknown");
}

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [snapshot, setSnapshot] = useState<LauncherSnapshot>(initialSnapshot);
  const [profiles, setProfiles] = useState<WorkspaceProfile[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [error, setError] = useState<string>();
  const preferences = snapshot.preferences;
  const t: Translate = (key, values) =>
    Object.entries(values ?? {}).reduce<string>(
      (text, [name, value]) => text.replace(`{${name}}`, value),
      dictionary[preferences.language][key],
    );

  useEffect(() => {
    let active = true;
    void window.gptWebCodex
      .snapshot()
      .then((next) => active && setSnapshot(next))
      .catch(() => active && setError(t("loadingError")));
    return window.gptWebCodex.onSnapshot((next) => active && setSnapshot(next));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);
  useEffect(() => {
    void refreshWorkspaceData();
  }, []);

  async function refreshWorkspaceData() {
    try {
      const [nextProfiles, nextSkills] = await Promise.all([
        window.gptWebCodex.listProfiles(),
        window.gptWebCodex.listSkills(),
      ]);
      setProfiles(nextProfiles);
      setSkills(nextSkills);
    } catch {
      setError(t("workspaceDataError"));
    }
  }
  async function invoke(action: "start" | "stop" | "restart") {
    try {
      setError(undefined);
      if (action === "restart") {
        await window.gptWebCodex.stop();
        setSnapshot(await window.gptWebCodex.start());
      } else {
        setSnapshot(await window.gptWebCodex[action]());
      }
    } catch {
      setError(
        t("runtimeError", {
          action: action === "start" ? t("start") : t("stop"),
        }),
      );
    }
  }
  async function setupTunnel(setup: { tunnelId: string; runtimeKey: string }) {
    setError(undefined);
    setSnapshot(await window.gptWebCodex.setupTunnel(setup));
  }
  async function updatePreferences(next: LauncherUiPreferences) {
    const saved = await window.gptWebCodex.savePreferences(next);
    setSnapshot((current) => ({ ...current, preferences: saved }));
  }

  async function refreshSnapshot() {
    try {
      setSnapshot(await window.gptWebCodex.snapshot());
      setError(undefined);
    } catch {
      setError(t("loadingError"));
    }
  }

  const activeProfile = profiles.find((profile) => profile.workspaceRoot === snapshot.workspace) ?? profiles[0];
  return (
    <>
      <div className="manager-window-bar" role="banner">
        <span>GPT Web Codex · {t("settings")}</span>
        <button className="window-close" onClick={() => window.close()} title="关闭窗口" type="button">×</button>
      </div>
    <main className="app-shell">
      <aside aria-label="Launcher views" className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /> <span /> <span /></div>
          <div><strong>GPT Web Codex</strong><small>本地代码工作台</small></div>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {navigationGroups.map((group) => (
            <div key={group.label}>
              <span className="nav-group-label">{t(group.label)}</span>
              {group.items.map((item) => (
                <button
                  className={`nav-item ${view === item.view ? "active" : ""}`}
                  key={item.view}
                  onClick={() => setView(item.view)}
                  type="button"
                >
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  <span>{t(item.view)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-runtime">
          <div className="runtime-orbit"><i className={`runtime-dot ${snapshot.state}`} /><b>{t(runtimeStateLabels[snapshot.state] ?? "statusUnknown")}</b></div>
          <p title={snapshot.workspace ?? undefined}>{snapshot.workspace ?? t("noWorkspace")}</p>
          <div className="mini-stats"><span>Skills <b>{skills.length}</b></span><span>MCP <b>{t("mcp")}</b></span></div>
        </div>
        <div className="sidebar-footer"><small>本地状态检查不会调用模型。</small></div>
      </aside>
      <section className="main-area">
        <header className="topbar">
          <div>
            <p className="eyebrow">{t(view === "home" ? "overview" : view === "connection" ? "deploy" : view === "help" ? "health" : view)}</p>
            <h1>{t(view === "home" ? "overview" : view === "connection" ? "deploy" : view === "help" ? "health" : view)}</h1>
            <p className="page-subtitle">{view === "home" || view === "overview" ? "集中查看本地运行时、连接通道与当前工作区。" : "管理 GPT Web Codex 的本地配置和运行状态。"}</p>
          </div>
          <div className="top-actions">
            <button className="icon-button" onClick={() => void updatePreferences({ ...preferences, theme: preferences.theme === "dark" ? "light" : "dark" })} title="切换主题" type="button">◐</button>
            <button className="secondary-button" onClick={() => void refreshSnapshot()} type="button">重新检测</button>
            <button className="primary-button" data-action="start" onClick={() => void invoke("start")} type="button">一键启动</button>
          </div>
        </header>
        <div className="workspace-bar" role="region" aria-label={t("workspace")}>
          <div className="workspace-label">
            <span>{t("workspaceLabel")}</span>
            <strong title={snapshot.workspace ?? undefined}>{snapshot.workspace ?? t("noWorkspace")}</strong>
          </div>
          <div className="task-strip" aria-live="polite">
            <i className={`runtime-dot ${snapshot.state === "running" ? "running" : snapshot.state === "error" ? "error" : ""}`} />
            <b>{t(runtimeStateLabels[snapshot.state] ?? "statusUnknown")}</b>
            <small>{snapshot.paired ? t("paired") : t("notPaired")}</small>
          </div>
          <select className="workspace-select" aria-label={t("workspace")} value={activeProfile?.id ?? ""} onChange={(event) => { if (event.target.value) void window.gptWebCodex.setActiveProfile(event.target.value).then(refreshWorkspaceData); }}>
            <option value="">{t("select")}</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id}</option>)}
          </select>
          <button className="secondary-button" onClick={() => void window.gptWebCodex.selectWorkspace().then(refreshSnapshot)} type="button">＋ {t("workspace")}</button>
        </div>
        <div className="content-viewport">
        <section className="page active" data-page-view={view}>
        {(view === "home" || view === "overview") && (
          <Status
            snapshot={snapshot}
            onInvoke={invoke}
            onSetupTunnel={setupTunnel}
            t={t}
          />
        )}
        {(view === "connection" || view === "deploy") && (
          <ConnectionSettings snapshot={snapshot} onInvoke={invoke} onSetupTunnel={setupTunnel} onUpdatePreferences={updatePreferences} preferences={preferences} t={t} />
        )}
        {view === "workspace" && (
          <Workspace
            profiles={profiles}
            onChanged={refreshWorkspaceData}
            t={t}
          />
        )}
        {view === "skills" && (
          <Skills
            profiles={profiles}
            skills={skills}
            onChanged={refreshWorkspaceData}
            t={t}
          />
        )}
        {view === "mcp" && <Mcp t={t} />}
        {view === "tasks" && <TasksAndLogs t={t} />}
        {view === "build" && <BuildVerification snapshot={snapshot} t={t} />}
        {(view === "help" || view === "health") && <HelpDiagnostics snapshot={snapshot} t={t} />}
        {view === "guide" && <SettingsGuide guide={snapshot.guide} onUpdatePreferences={updatePreferences} preferences={preferences} t={t} />}
        {view === "logs" && <LogsPage t={t} />}
        {view === "memory" && <Memory t={t} />}
        {view === "settings" && (
          <SettingsPage onUpdatePreferences={updatePreferences} preferences={preferences} t={t} />
        )}
        </section>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        </div>
      </section>
    </main>
    </>
  );
}

function Workspace({
  profiles,
  onChanged,
  t,
}: {
  profiles: WorkspaceProfile[];
  onChanged: () => Promise<void>;
  t: Translate;
}) {
  const [id, setId] = useState("workspace");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [skillsRoot, setSkillsRoot] = useState("");
  const [message, setMessage] = useState<string>();
  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      setMessage(undefined);
      await window.gptWebCodex.saveProfile({
        id,
        workspaceRoot,
        skillsRoot,
        enabledSkillIds: [],
      });
      await window.gptWebCodex.setActiveProfile(id);
      await onChanged();
      setMessage(t("profileSaved"));
    } catch {
      setMessage(t("profileSaveError"));
    }
  }
  async function activate(profileId: string) {
    try {
      await window.gptWebCodex.setActiveProfile(profileId);
      await onChanged();
      setMessage(t("profileChanged"));
    } catch {
      setMessage(t("profileSelectError"));
    }
  }
  return (
    <section className="page-stack">
      <div className="section-header"><div><span className="section-kicker">访问范围</span><h2>工作目录与权限</h2><p>网页只能访问你明确选择的目录，切换配置会重新建立本地运行时边界。</p></div></div>
      <article className="panel workspace-picker">
        <div className="folder-illustration">▱</div>
        <div className="folder-copy"><span>当前允许访问</span><h3>{profiles[0]?.workspaceRoot ?? t("noWorkspace")}</h3><p>Skills 目录必须位于当前工作区内，运行凭据不会保存在配置中。</p></div>
        <button className="primary-button" onClick={() => void window.gptWebCodex.selectWorkspace().then(onChanged)} type="button">选择文件夹</button>
      </article>
      <article className="panel authorized-roots-panel">
        <div className="panel-title"><div><h3>工作区配置</h3><p>参考项目的额外授权目录在此版本中由独立配置表达，每个配置都有自己的工作区和 Skills 根目录。</p></div></div>
        <div className="authorized-root-list">
          {profiles.length === 0 && <span className="task-muted">尚未添加工作区</span>}
          {profiles.map((profile) => <div className="authorized-root-row" key={profile.id}><code>{profile.workspaceRoot}</code><span className="soft-badge">{profile.id}</span><button className="secondary-button" onClick={() => void activate(profile.id)} type="button">{t("select")}</button></div>)}
        </div>
      </article>
      <div className="two-column">
        <article className="panel"><div className="panel-title"><div><h3>命令权限模式</h3><p>Codex 仍负责命令授权和隔离策略。</p></div></div><div className="choice-stack"><label className="choice selected"><input defaultChecked name="permission" type="radio" /><span><b>安全模式</b><small>联网、敏感环境和破坏性操作需要明确授权。</small></span><em>推荐</em></label><label className="choice"><input disabled name="permission" type="radio" /><span><b>可信模式</b><small>当前版本不开放降低安全边界。</small></span></label></div></article>
        <article className="panel"><div className="panel-title"><div><h3>Skills 与项目指令</h3><p>Skills 采用按需加载：默认仅向 Codex 提供名称和描述，任务匹配时才读取完整 SKILL.md。</p></div></div><div className="notice blue-notice"><b>推荐目录</b><p><code>.codex/skills/&lt;skill&gt;/SKILL.md</code>，可同时加载多个 Skill。</p></div></article>
      </div>
      <details className="panel advanced-settings"><summary>新增或编辑工作区配置</summary><form className="stack advanced-settings-body" onSubmit={(event) => void save(event)}><label>{t("profileId")}<input onChange={(event) => setId(event.target.value)} required value={id} /></label><label>{t("workspaceRoot")}<input onChange={(event) => setWorkspaceRoot(event.target.value)} required value={workspaceRoot} /></label><label>{t("skillsRoot")}<input onChange={(event) => setSkillsRoot(event.target.value)} required value={skillsRoot} /></label><div className="page-footer-actions"><button className="primary-button" type="submit">{t("saveSelect")}</button></div></form></details>
      {message && <p>{message}</p>}
    </section>
  );
}

function ConnectionSettings({
  snapshot,
  onInvoke,
  onSetupTunnel,
  onUpdatePreferences,
  preferences,
  t,
}: {
  snapshot: LauncherSnapshot;
  onInvoke: (action: "start" | "stop" | "restart") => Promise<void>;
  onSetupTunnel: (setup: { tunnelId: string; runtimeKey: string }) => Promise<void>;
  onUpdatePreferences: (next: LauncherUiPreferences) => Promise<void>;
  preferences: LauncherUiPreferences;
  t: Translate;
}) {
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [message, setMessage] = useState<string>();
  const [proxyMode, setProxyMode] = useState(preferences.proxyMode);
  const [proxyUrl, setProxyUrl] = useState(preferences.proxyUrl);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      setMessage(undefined);
      await onSetupTunnel({ tunnelId: tunnelId.trim(), runtimeKey });
      setMessage(t("tunnelPaired"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setMessage(detail ? `${t("tunnelPairError")} ${detail}` : t("tunnelPairError"));
    } finally {
      setRuntimeKey("");
    }
  }
  async function saveProxy(nextMode = proxyMode, nextUrl = proxyUrl) {
    try {
      await onUpdatePreferences({ ...preferences, proxyMode: nextMode, proxyUrl: nextUrl });
      setMessage(t("proxySaved"));
    } catch {
      setMessage(t("preferencesSaveError"));
    }
  }
  return (
    <section className="page-stack">
      <div className="page-intro"><span className="eyebrow">连接</span><h2>连接设置</h2><p>管理本地工具服务与 ChatGPT 连接通道。</p></div>
      <div className="setup-grid">
        <section className="panel stack">
          <div className="section-heading"><div><h3>连接通道身份（OpenAI Tunnel）</h3><p className="muted-note">密钥只在主进程中保存，界面和日志不会读取明文。</p></div><span className="soft-badge">Windows 加密</span></div>
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <label>{t("runtimeKey")}<input autoComplete="off" type="password" value={runtimeKey} onChange={(event) => setRuntimeKey(event.target.value)} required placeholder="粘贴 Runtime API Key" /></label>
            <label>{t("tunnelId")}<input autoComplete="off" value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} required placeholder="例如 tunnel_..." /></label>
            <button className="primary-button" type="submit">保存并部署</button>
          </form>
          {message && <p className={message.includes("无法") || message.includes("Unable") ? "error" : "success-note"}>{message}</p>}
        </section>
        <section className="panel stack">
          <div className="section-heading"><div><h3>{t("proxyMode")}</h3><p className="muted-note">自动检测会优先尝试直连、系统代理和常见本地代理端口。</p></div><span className={`status ${snapshot.proxy?.reachable ? "status-running" : "status-stopped"}`}>{snapshot.proxy?.reachable ? "可达" : "未检测"}</span></div>
          <label>{t("proxyMode")}<select value={proxyMode} onChange={(event) => { const value = event.target.value as LauncherUiPreferences["proxyMode"]; setProxyMode(value); void saveProxy(value, proxyUrl); }}><option value="auto">{t("proxyAuto")}</option><option value="system">{t("proxySystem")}</option><option value="manual">{t("proxyManual")}</option><option value="direct">{t("proxyDirect")}</option></select></label>
          {proxyMode === "manual" && <label>{t("proxyUrl")}<input value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} onBlur={() => void saveProxy()} placeholder="http://127.0.0.1:7890" /></label>}
          <div className="diagnostic-row"><span>当前网络路径</span><strong>{snapshot.proxy?.source ?? "尚未检测"}</strong></div>
          <button className="secondary-button" onClick={() => void saveProxy()} type="button">保存代理设置</button>
          <div className="actions">
            <button className="secondary-button" data-action="refresh" onClick={() => void onInvoke("restart")} type="button">重新部署</button>
            <button className="secondary-button" onClick={() => void onInvoke("stop")} type="button">停止服务</button>
          </div>
        </section>
        <section className="panel stack">
          <h3>运行与连接状态</h3>
          <div className="diagnostic-row"><span>本地运行时</span><strong>{t(runtimeStateLabels[snapshot.state] ?? "statusUnknown")}</strong></div>
          <div className="diagnostic-row"><span>OpenAI Tunnel</span><strong>{snapshot.paired ? t("paired") : t("notPaired")}</strong></div>
          <p className="muted-note">Tunnel 会在保存配置后随本地运行时自动恢复。MCP 服务无需配置也可以运行。</p>
        </section>
      </div>
    </section>
  );
}

function Memory({ t }: { t: Translate }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<MemoryEntry["scope"]>("workspace");
  const [message, setMessage] = useState<string>();
  async function refresh() {
    try { setEntries(await window.gptWebCodex.listMemory()); } catch { setMessage(t("memoryError")); }
  }
  useEffect(() => { void refresh(); }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      await window.gptWebCodex.saveMemory({ title, content, scope });
      setTitle(""); setContent(""); setMessage(t("memorySaved")); await refresh();
    } catch { setMessage(t("memoryError")); }
  }
  async function remove(id: string) {
    try { await window.gptWebCodex.removeMemory(id); setMessage(t("memoryRemoved")); await refresh(); }
    catch { setMessage(t("memoryError")); }
  }
  return (
    <section className="page-stack">
      <div className="page-intro"><span className="eyebrow">记忆</span><h2>{t("memory")}</h2><p>管理本地保存的工作区偏好与运行记录。</p></div>
      <section className="panel stack">
        <h3>新增本地记忆</h3>
        <p className="muted-note">只保存在本机私有数据目录，不保存聊天内容、API Key 或 Cookie。</p>
        <form className="stack" onSubmit={(event) => void save(event)}>
          <label>{t("memoryTitle")}<input maxLength={120} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>{t("memoryContent")}<textarea maxLength={10000} required value={content} onChange={(event) => setContent(event.target.value)} /></label>
          <label>{t("memoryScope")}<select value={scope} onChange={(event) => setScope(event.target.value as MemoryEntry["scope"])}><option value="workspace">{t("memoryWorkspace")}</option><option value="global">{t("memoryGlobal")}</option></select></label>
          <button type="submit">{t("addMemory")}</button>
        </form>
      </section>
      <section className="panel stack">
        <h3>已保存记忆</h3>
        {entries.length === 0 && <p>{t("noMemory")}</p>}
        {entries.map((entry) => <article className="memory-item" key={entry.id}><div className="section-heading"><strong>{entry.title}</strong><span className="soft-badge">{entry.scope === "global" ? t("memoryGlobal") : t("memoryWorkspace")}</span></div><p>{entry.content}</p><button className="secondary-button" type="button" onClick={() => void remove(entry.id)}>{t("removeMemory")}</button></article>)}
      </section>
      {message && <p className={message.includes("未") || message.includes("not") ? "error" : "success-note"}>{message}</p>}
    </section>
  );
}

function HelpDiagnostics({ snapshot, t }: { snapshot: LauncherSnapshot; t: Translate }) {
  const [report, setReport] = useState<DiagnosticReport>();
  const [busy, setBusy] = useState(false);
  async function inspect() { setBusy(true); try { setReport(await window.gptWebCodex.doctor()); } finally { setBusy(false); } }
  useEffect(() => { void inspect(); }, []);
  const checks = report?.checks ?? [
    { id: "runtime", status: snapshot.state === "running" ? "ok" as const : "warning" as const, message: t(runtimeStateLabels[snapshot.state] ?? "statusUnknown") },
    { id: "tunnel", status: snapshot.paired ? "ok" as const : "warning" as const, message: snapshot.paired ? t("paired") : t("notPaired") },
  ];
  return (
    <section className="page-stack">
      <div className="section-header"><div><span className="section-kicker">系统体检</span><h2>系统体检与修复</h2><p>检查工作区、运行环境、本地工具、代理与连接通道。</p></div><div className="inline-actions"><button className="secondary-button" disabled={busy} onClick={() => void inspect()} type="button">重新体检</button><button className="primary-button" onClick={() => void window.gptWebCodex.start()} type="button">一键修复</button></div></div>
      <article className="panel"><div className="panel-title"><h3>检查结果</h3><span className="soft-badge">{checks.every((check) => check.status === "ok") ? "状态正常" : "需要处理"}</span></div><div className="health-list">{checks.map((check) => <div className={`health-item ${check.status === "ok" ? "passed" : "failed"}`} key={check.id}><i>{check.status === "ok" ? "✓" : "!"}</i><span><b>{t(diagnosticCheckLabels[check.id] ?? "statusUnknown")}</b><small>{check.message ? localizedMessage(check.message, t) : t("statusUnknown")}</small></span><em>{t(diagnosticStatusLabels[check.status] ?? "statusUnknown")}</em></div>)}</div></article>
      <div className="notice warning"><b>安全边界</b><p>一键修复只重启本软件管理的服务；不会结束未知进程，也不会替你填写 Runtime Key 或 Tunnel ID。</p></div>
    </section>
  );
}

function BuildVerification({ snapshot, t }: { snapshot: LauncherSnapshot; t: Translate }) {
  const [testCommand, setTestCommand] = useState("npm test");
  const [buildCommand, setBuildCommand] = useState("npm run build");
  const [message, setMessage] = useState<string>();
  const [running, setRunning] = useState(false);
  async function runBuild() {
    setRunning(true);
    try {
      await window.gptWebCodex.start();
      setMessage(`已请求验证：${testCommand}；构建：${buildCommand}`);
    } catch {
      setMessage(t("runtimeError", { action: t("start") }));
    } finally { setRunning(false); }
  }
  return (
    <section className="page-stack">
      <div className="section-header"><div><span className="section-kicker">自动验证</span><h2>构建与验证</h2><p>按项目配置执行测试和构建，并在任务日志中查看结果。</p></div><div className="inline-actions"><button className="secondary-button" type="button">重新识别</button><button className="primary-button" disabled={running} onClick={() => void runBuild()} type="button">开始验证</button></div></div>
      <div className="two-column"><section className="panel stack">
        <div className="section-heading"><div><h3>构建验证配置</h3><p className="muted-note">命令仅保存于当前页面，不会写入凭证或发送到远端。</p></div><span className="status status-running">{snapshot.state === "running" ? "运行时可用" : "等待运行时"}</span></div>
        <label>测试命令<input value={testCommand} onChange={(event) => setTestCommand(event.target.value)} /></label>
        <label>构建命令<input value={buildCommand} onChange={(event) => setBuildCommand(event.target.value)} /></label>
        <div className="actions"><button className="primary-button" disabled={running} onClick={() => void runBuild()} type="button">{running ? "正在执行" : "运行测试并构建"}</button><button className="secondary-button" type="button" onClick={() => setMessage("产物校验将在任务输出完成后显示。")}>查看产物</button></div>
        {message && <p className="success-note">{message}</p>}
      </section><section className="panel"><div className="panel-title"><h3>实时进度</h3><span>{running ? "运行中" : "等待开始"}</span></div><pre className="build-console">{message ?? "尚未执行构建验证。"}</pre></section></div>
      <section className="panel stack"><div className="panel-title"><h3>构建报告</h3><span>—</span></div><div className="build-report-grid"><span className="task-muted">完成验证后显示测试、构建、版本、产物和 SHA256。</span></div></section>
    </section>
  );
}

function LogsPage({ t }: { t: Translate }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  useEffect(() => window.gptWebCodex.onLog((entry) => setLogs((current) => [rendererSafeText(entry), ...current].slice(0, 120))), []);
  const visible = filter === "all" ? logs : logs.filter((entry) => entry.toLowerCase().includes(filter));
  return (
    <section className="page-stack">
      <div className="page-intro"><span className="eyebrow">运行</span><h2>{t("logs")}</h2><p>查看本地运行时与 Tunnel 的脱敏活动。</p></div>
      <section className="panel stack"><div className="section-heading"><div><h3>日志流</h3><p className="muted-note">不会显示 Runtime Key、Bearer、Cookie 或连接器令牌。</p></div><div className="log-filters"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")} type="button">全部</button><button className={filter === "warn" ? "active" : ""} onClick={() => setFilter("warn")} type="button">警告</button><button className={filter === "error" ? "active" : ""} onClick={() => setFilter("error")} type="button">错误</button></div></div><div className="log-output">{visible.length === 0 ? <div className="empty-state"><strong>暂无匹配日志</strong><p className="muted-note">启动服务或切换筛选条件后再查看。</p></div> : visible.map((entry, index) => <pre key={`${index}-${entry}`}>{entry}</pre>)}</div><div className="actions"><button className="secondary-button" onClick={() => void window.gptWebCodex.openLogs()} type="button">打开日志目录</button><button className="secondary-button" onClick={() => setLogs([])} type="button">清空当前视图</button></div></section>
    </section>
  );
}

function Skills({
  profiles,
  skills,
  onChanged,
  t,
}: {
  profiles: WorkspaceProfile[];
  skills: SkillSummary[];
  onChanged: () => Promise<void>;
  t: Translate;
}) {
  const active = profiles[0];
  const [enabled, setEnabled] = useState<string[]>(
    active?.enabledSkillIds ?? [],
  );
  const [message, setMessage] = useState<string>();
  useEffect(() => setEnabled(active?.enabledSkillIds ?? []), [active]);
  function toggle(skillId: string) {
    setEnabled((current) =>
      current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId],
    );
  }
  async function save() {
    try {
      await window.gptWebCodex.saveSkills(enabled);
      await onChanged();
      setMessage(t("skillsSaved"));
    } catch {
      setMessage(t("skillsSaveError"));
    }
  }
  if (!active)
    return (
      <section className="panel">
        <p>{t("selectProfileFirst")}</p>
      </section>
    );
  return (
    <section className="panel stack">
      <h2>{t("skillDefaults")}</h2>
      <p>{t("skillHelp")}</p>
      {skills.map((skill) => (
        <article className="skill" key={skill.id}>
          <label>
            <input
              checked={enabled.includes(skill.id)}
              onChange={() => toggle(skill.id)}
              type="checkbox"
            />
            <strong>{skill.name}</strong>
            <code>{skill.id}</code>
          </label>
          <p>{skill.description}</p>
          <pre>{skill.preview}</pre>
          <button
            className="secondary"
            onClick={() => void window.gptWebCodex.openSkillFolder(skill.id)}
            type="button"
          >
            {t("openFolder")}
          </button>
        </article>
      ))}
      {skills.length === 0 && <p>{t("noSkills")}</p>}
      <div className="actions">
        <button onClick={() => void save()} type="button">
          {t("saveDefaults")}
        </button>
      </div>
      {message && <p>{message}</p>}
    </section>
  );
}

function Status({
  snapshot,
  onInvoke,
  onSetupTunnel,
  t,
}: {
  snapshot: LauncherSnapshot;
  onInvoke: (action: "start" | "stop") => Promise<void>;
  onSetupTunnel: (setup: {
    tunnelId: string;
    runtimeKey: string;
  }) => Promise<void>;
  t: Translate;
}) {
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [message, setMessage] = useState<string>();
  async function setupTunnel(event: React.FormEvent) {
    event.preventDefault();
    try {
      setMessage(undefined);
      await onSetupTunnel({ tunnelId: tunnelId.trim(), runtimeKey });
      setMessage(t("tunnelPaired"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setMessage(detail ? `${t("tunnelPairError")} ${detail}` : t("tunnelPairError"));
    } finally {
      setRuntimeKey("");
    }
  }
  return (
    <section className="home-page stack">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="soft-badge">GPT Web Codex · 本地优先</span>
          <h2>让网页聊天安全访问你的代码目录</h2>
          <p>通过随应用打包的 Tunnel 和本地运行时，把 ChatGPT、Skills 与 MCP 连接到当前工作区。</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => void onInvoke("start")} type="button">
              {t("start")}
            </button>
          </div>
        </div>
        <div className="connection-visual" aria-hidden="true">
          <div className="node local"><span>本机</span><b>工作目录</b></div>
          <div className="flow-line"><i /></div>
          <div className="node mcp"><span>工具</span><b>Codex</b></div>
          <div className="flow-line"><i /></div>
          <div className="node cloud"><span>网页</span><b>ChatGPT</b></div>
        </div>
      </section>

      <div className="status-grid">
        <article className="status-card">
          <div className="status-head"><span className="status-symbol">◉</span><span>{t("runtime")}</span></div>
          <strong>{t(runtimeStateLabels[snapshot.state] ?? "statusUnknown")}</strong>
          <small>{snapshot.message ? localizedMessage(snapshot.message, t) : t("awaitingStatus")}</small>
        </article>
        <article className="status-card">
          <div className="status-head"><span className="status-symbol">↔</span><span>{t("tunnel")}</span></div>
          <strong>{snapshot.paired ? t("paired") : t("notPaired")}</strong>
          <small>{snapshot.tunnelState ? t(runtimeStateLabels[snapshot.tunnelState] ?? "statusUnknown") : t("notConfigured")}</small>
        </article>
        <article className="status-card">
          <div className="status-head"><span className="status-symbol">✦</span><span>{t("connector")}</span></div>
          <strong>{snapshot.connectorName ?? "GPT Web Codex"}</strong>
          <small>{snapshot.paired ? t("paired") : t("notPaired")}</small>
        </article>
        <article className="status-card">
          <div className="status-head"><span className="status-symbol">▱</span><span>{t("workspaceLabel")}</span></div>
          <strong title={snapshot.workspace ?? undefined}>{snapshot.workspace ?? t("noWorkspace")}</strong>
          <small>{t("workspaceLabel")}</small>
        </article>
      </div>

      <div className="two-column">
        <article className="panel quick-panel">
          <div className="section-heading"><div><span className="eyebrow">WORKSPACE</span><h3>快捷操作</h3></div></div>
          <div className="action-list">
            <button className="action-row" onClick={() => void onInvoke("start")} type="button"><span>启动本地运行时</span><b>→</b></button>
            <button className="action-row" onClick={() => void onInvoke("stop")} type="button"><span>停止本地运行时</span><b>→</b></button>
          </div>
        </article>
        <article className="panel progress-panel">
          <div className="section-heading"><div><span className="eyebrow">CONNECTION</span><h3>运行进度</h3></div><span className={`status status-${snapshot.state}`}>{t(runtimeStateLabels[snapshot.state] ?? "statusUnknown")}</span></div>
          <div className="progress-track"><span className={snapshot.state === "running" ? "progress-fill complete" : "progress-fill"} /></div>
          <p>{snapshot.paired ? "运行时与 Tunnel 已建立连接，可以从 ChatGPT 发起本地任务。" : "启动运行时并完成 Tunnel 配对后即可开始。"}</p>
        </article>
      </div>

      {snapshot.tunnelMessage && (
        <p className="error" role="alert">
          {localizedMessage(snapshot.tunnelMessage, t)}
        </p>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}

function Mcp({ t }: { t: Translate }) {
  const [id, setId] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("30000");
  const [servers, setServers] = useState<McpServerDraft[]>([]);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    void window.gptWebCodex.listMcpRegistry().then((registry) => {
      setServers(registry.servers ?? []);
      if ((registry.servers ?? []).length > 0) setMessage(t("mcpReloaded"));
    }).catch(() => setMessage(t("mcpSaveError")));
  }, []);
  function addServer(event: React.FormEvent) {
    event.preventDefault();
    const next: McpServerDraft = {
      id: id.trim(),
      command: command.trim(),
      args: parseLines(args),
      allowedTools: parseLines(allowedTools),
      timeoutMs: Number(timeoutMs),
    };
    if (
      !next.id ||
      !next.command ||
      next.allowedTools.length === 0 ||
      !Number.isInteger(next.timeoutMs)
    ) {
      setMessage(t("mcpValidation"));
      return;
    }
    if (servers.some((server) => server.id === next.id)) {
      setMessage(t("mcpDuplicate"));
      return;
    }
    setServers((current) => [...current, next]);
    setId("");
    setCommand("");
    setArgs("");
    setAllowedTools("");
    setTimeoutMs("30000");
    setMessage(t("mcpAdded"));
  }
  async function save() {
    try {
      const draft: McpRegistryDraft = { servers };
      await window.gptWebCodex.saveMcpRegistry(draft);
      setMessage(t("mcpSaved"));
    } catch {
      setMessage(t("mcpSaveError"));
    }
  }
  return (
    <section className="panel stack">
      <h2>{t("mcpTitle")}</h2>
      <p>{t("mcpHelp")}</p>
      <form className="stack" onSubmit={addServer}>
        <label>
          {t("serverId")}
          <input
            onChange={(event) => setId(event.target.value)}
            required
            value={id}
          />
        </label>
        <label>
          {t("localCommand")}
          <input
            onChange={(event) => setCommand(event.target.value)}
            required
            value={command}
          />
        </label>
        <label>
          {t("entrypoint")}
          <textarea
            onChange={(event) => setArgs(event.target.value)}
            value={args}
          />
        </label>
        <label>
          {t("allowedTools")}
          <textarea
            onChange={(event) => setAllowedTools(event.target.value)}
            required
            value={allowedTools}
          />
        </label>
        <label>
          {t("timeout")}
          <input
            min="1000"
            onChange={(event) => setTimeoutMs(event.target.value)}
            required
            type="number"
            value={timeoutMs}
          />
        </label>
        <div className="actions">
          <button type="submit">{t("addServer")}</button>
        </div>
      </form>
      {servers.length > 0 && (
        <ul className="plain-list">
          {servers.map((server) => (
            <li key={server.id}>
              <code>{server.id}</code>
              <span>
                {server.command} · {server.allowedTools.join(", ")}
              </span>
              <button
                className="secondary"
                onClick={() =>
                  setServers((current) =>
                    current.filter((item) => item.id !== server.id),
                  )
                }
                type="button"
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {servers.length === 0 && <div className="empty-state"><div className="empty-symbol">◇</div><strong>{t("mcpEmpty")}</strong><p className="muted-note">MCP 服务只在你明确需要外部本地工具时添加。</p></div>}
      <div className="actions">
        <button onClick={() => void save()} type="button">
          {t("saveRegistry")}
        </button>
      </div>
      {message && <p>{message}</p>}
    </section>
  );
}

function TasksAndLogs({ t }: { t: Translate }) {
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState<TaskActivity>();
  const [message, setMessage] = useState<string>();
  const [logs, setLogs] = useState<string[]>([]);
  useEffect(
    () =>
      window.gptWebCodex.onLog((entry) =>
        setLogs((current) =>
          [rendererSafeText(entry), ...current].slice(0, 64),
        ),
      ),
    [],
  );
  useEffect(() => {
    const selectedTaskId = taskId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selectedTaskId)) {
      setTask(undefined);
      return undefined;
    }
    let active = true;
    const refresh = async () => {
      try {
        const next = await window.gptWebCodex.task(taskId.trim());
        if (active) {
          setTask(next);
          setMessage(undefined);
        }
      } catch {
        if (active) setMessage(t("taskReadError"));
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [taskId]);
  async function cancel() {
    try {
      await window.gptWebCodex.cancelTask(taskId.trim());
      setMessage(t("cancellationRequested"));
      setTask(await window.gptWebCodex.task(taskId.trim()));
    } catch {
      setMessage(t("taskCancelError"));
    }
  }
  return (
    <section className="panel stack">
      <h2>{t("tasksTitle")}</h2>
      <p>{t("tasksHelp")}</p>
      <label>
        {t("taskId")}
        <input
          onChange={(event) => setTaskId(event.target.value)}
          value={taskId}
        />
      </label>
      <div className="actions">
        <button
          disabled={!taskId.trim()}
          onClick={() => void cancel()}
          type="button"
        >
          {t("cancelTask")}
        </button>
      </div>
      {message && <p>{message}</p>}
      {task && (
        <article className="skill">
          <h3>{t("selectedTask")}</h3>
          <p>
            <code>{task.id}</code> · {t(taskStateLabels[task.state] ?? "statusUnknown")}
          </p>
          {task.error && (
            <p className="error">{localizedMessage(task.error, t)}</p>
          )}
          {task.output && <pre>{rendererSafeText(task.output)}</pre>}
          {task.outputTruncated && <p>{t("taskTruncated")}</p>}
        </article>
      )}
      <h3>{t("recentLogs")}</h3>
      {logs.length === 0 ? (
        <p>{t("noLogs")}</p>
      ) : (
        <ul className="plain-list">
          {logs.map((entry, index) => (
            <li key={`${index}-${entry}`}>
              <pre>{entry}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SettingsGuide({
  guide,
  onUpdatePreferences,
  preferences,
  t,
}: {
  guide: GuideStep[];
  onUpdatePreferences: (next: LauncherUiPreferences) => Promise<void>;
  preferences: LauncherUiPreferences;
  t: Translate;
}) {
  const [message, setMessage] = useState<string>();
  async function save(next: LauncherUiPreferences) {
    try {
      await onUpdatePreferences(next);
      setMessage(t("preferencesSaved"));
    } catch {
      setMessage(t("preferencesSaveError"));
    }
  }
  async function openLogs() {
    try {
      await window.gptWebCodex.openLogs();
      setMessage(t("logsOpened"));
    } catch {
      setMessage(t("logsOpenError"));
    }
  }
  async function dismiss(step: GuideStep) {
    try {
      await onUpdatePreferences({
        ...preferences,
        guideDismissedSteps: [...preferences.guideDismissedSteps, step.id],
      });
      setMessage(t("guideDismissed"));
    } catch {
      setMessage(t("guideDismissError"));
    }
  }
  const visibleGuide = guide.filter(
    (step) => !preferences.guideDismissedSteps.includes(step.id),
  );
  return (
    <section className="page-stack">
      <div className="section-header"><div><span className="section-kicker">接入帮助</span><h2>在网页中创建 MCP</h2><p>按照顺序完成 OpenAI Tunnel 和 ChatGPT 自定义连接器设置。</p></div></div>
      <article className="panel guide-recommendation"><div className="panel-title"><div><h3>推荐的 ChatGPT 自定义指令</h3><p>快速查看使用 workspace_context；修改、测试和构建优先使用 agent_workflow。</p></div></div><div className="notice blue-notice"><b>Skills 按需加载</b><p>默认只提供 Skill 名称和描述；明确选择后才加载完整 SKILL.md。MCP 是可选项。</p></div></article>
      <div className="guide-layout"><div className="guide-steps">{visibleGuide.map((step) => <GuideStepCard key={step.id} onDismiss={() => void dismiss(step)} step={step} t={t} />)}{visibleGuide.length === 0 && <article className="panel">{t("guideComplete")}</article>}</div><aside className="guide-aside panel"><span className="section-kicker">接入清单</span><h3>接入进度</h3><div className="guide-progress-number"><b>{Math.round((guide.filter((step) => step.status === "complete").length / Math.max(guide.length, 1)) * 100)}%</b><span>已完成</span></div><div className="progress-track"><i style={{ width: `${(guide.filter((step) => step.status === "complete").length / Math.max(guide.length, 1)) * 100}%` }} /></div><ul>{["创建连接通道", "准备运行密钥", "部署本地服务", "创建 ChatGPT MCP", "完成只读测试"].map((item, index) => <li className={guide[index]?.status === "complete" ? "done" : ""} key={item}>{item}</li>)}</ul></aside></div>
      {message && <p>{message}</p>}
    </section>
  );
}

function SettingsPage({ onUpdatePreferences, preferences, t }: { onUpdatePreferences: (next: LauncherUiPreferences) => Promise<void>; preferences: LauncherUiPreferences; t: Translate }) {
  const [message, setMessage] = useState<string>();
  async function save(next: LauncherUiPreferences) { try { await onUpdatePreferences(next); setMessage(t("preferencesSaved")); } catch { setMessage(t("preferencesSaveError")); } }
  return <section className="page-stack"><div className="section-header settings-page-heading"><div><span className="section-kicker">偏好设置</span><h2>偏好设置</h2><p>管理后端服务、外观和本地诊断。</p></div></div><div className="settings-stack"><section className="settings-section"><div className="settings-section-heading"><div><h3>外观与界面</h3><p>调整后端管理中心的显示方式。</p></div></div><label className="setting-row"><span><b>{t("language")}</b><small>选择管理界面的显示语言。</small></span><select value={preferences.language} onChange={(event) => void save({ ...preferences, language: event.target.value as LauncherUiPreferences["language"] })}><option value="zh-CN">{t("simplifiedChinese")}</option><option value="en">{t("english")}</option></select></label><label className="setting-row"><span><b>{t("theme")}</b><small>选择浅色或深色外观。</small></span><select value={preferences.theme} onChange={(event) => void save({ ...preferences, theme: event.target.value as LauncherUiPreferences["theme"] })}><option value="system">{t("system")}</option><option value="light">{t("light")}</option><option value="dark">{t("dark")}</option></select></label></section><section className="settings-section"><div className="settings-section-heading"><div><h3>启动与运行</h3><p>控制应用和本地服务何时启动。</p></div></div>{([["startAtLogin", "开机启动网页 MCP 助手"], ["autoStartServices", "打开助手时自动启动服务"], ["keepRunningOnClose", "关闭窗口后保持服务运行"]] as const).map(([key, label]) => <label className="setting-row" key={key}><span><b>{label}</b><small>设置保存在本机用户数据目录。</small></span><input className="toggle" checked={preferences[key]} onChange={(event) => void save({ ...preferences, [key]: event.target.checked })} type="checkbox" /></label>)}</section><details className="settings-section advanced-settings"><summary className="settings-section-heading"><div><h3>高级设置与维护</h3><p>管理本地诊断文件。</p></div><span>展开</span></summary><div className="advanced-settings-body no-padding"><div className="setting-row"><span><b>运行日志</b><small>打开软件私有日志目录。</small></span><button className="secondary-button" onClick={() => void window.gptWebCodex.openLogs()} type="button">{t("openLogs")}</button></div></div></details></div><article className="panel about-panel"><div className="brand-mark large"><span /><span /><span /></div><div><h3>GPT Web Codex <span>v0.1.0</span></h3><p>基于官方 MCP + OpenAI Tunnel，新增按需 Skills 与可选 MCP 管理。</p></div></article>{message && <p>{message}</p>}</section>;
}

function GuideStepCard({
  onDismiss,
  step,
  t,
}: {
  onDismiss: () => void;
  step: GuideStep;
  t: Translate;
}) {
  const title: Record<number, TextKey> = {
    1: "chooseWorkspace",
    2: "configureSkillsMcp",
    3: "checkTunnel",
    4: "guideOpenChat",
    5: "runtime",
  };
  const status: Record<GuideStep["status"], TextKey> = {
    complete: "guideComplete",
    "needs-action": "guideNeedsAction",
    unavailable: "guideUnavailable",
  };
  return (
    <article className={`guide-step ${step.status === "complete" ? "done" : ""}`}>
      <div className="step-number">{step.status === "complete" ? "✓" : step.id}</div>
      <div className="step-content">
      <div className="step-heading"><h3>{t(title[step.id])}</h3><span className={`status guide-${step.status}`}>{t(status[step.status])}</span></div>
      <p>{t(guideMessageKeys[step.messageKey] ?? "guideNeedsAction")}</p>
      <div className="inline-actions">
        {step.status !== "needs-action" && (
          <button className="secondary" onClick={onDismiss} type="button">
            {t("dismiss")}
          </button>
        )}
      </div>
      </div>
    </article>
  );
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function rendererSafeText(value: unknown): string {
  const text =
    typeof value === "string" ? value : "Invalid runtime activity entry";
  const redacted = text
    .replace(
      /\b(token|api_key|password|access_token|client_secret)\s*=\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\bauthorization\s*:\s*bearer\s+[^\s,;]+/gi,
      "Authorization: Bearer [REDACTED]",
    );
  return redacted.length <= 4096 ? redacted : `${redacted.slice(0, 4095)}…`;
}
