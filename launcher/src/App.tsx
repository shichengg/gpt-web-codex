import { useEffect, useState } from "react";
import type {
  DiagnosticReport,
  GuideStep,
  LauncherSnapshot,
  LauncherUiPreferences,
  McpRegistryDraft,
  McpServerDraft,
  SkillSummary,
  TaskActivity,
  WorkspaceProfile,
} from "./types";

const views = [
  "home",
  "workspace",
  "skills",
  "mcp",
  "tasks",
  "settings",
] as const;
type View = (typeof views)[number];
type TextKey = keyof (typeof dictionary)["zh-CN"];
type Translate = (key: TextKey, values?: Record<string, string>) => string;

const defaultPreferences: LauncherUiPreferences = {
  language: "zh-CN",
  theme: "system",
  guideDismissedSteps: [],
};
const initialSnapshot: LauncherSnapshot = {
  state: "stopped",
  workspace: null,
  message: "正在加载启动器状态…",
  preferences: defaultPreferences,
  guide: [],
};

const dictionary = {
  "zh-CN": {
    home: "主页",
    workspace: "工作区",
    skills: "Skills",
    mcp: "MCP",
    tasks: "任务与日志",
    settings: "设置与引导",
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
    openChatGpt: "打开 ChatGPT",
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
    mcpTitle: "本地 stdio MCP 注册表",
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
    clearChatGpt: "清除 ChatGPT 登录状态",
    sessionCleared: "ChatGPT 登录状态已清除。",
    sessionClearError: "无法清除 ChatGPT 登录状态。",
    guide: "设置引导",
    guideHelp:
      "根据本机实际状态完成设置。引导不显示或导出 URL、Cookie 或登录会话。",
    chooseWorkspace: "选择工作区",
    configureSkillsMcp: "配置 Skills 与本地 MCP",
    checkTunnel: "检测本地运行时与兼容 Tunnel 客户端",
    guideOpenChat: "打开 ChatGPT",
    runDoctor: "运行 Doctor",
    guideComplete: "已完成",
    guideNeedsAction: "需要操作",
    guideUnavailable: "不可用",
    dismiss: "关闭此步骤",
    guideDismissed: "引导步骤已关闭。",
    guideDismissError: "无法保存引导步骤状态。",
    tunnelUnavailable:
      "Doctor 未找到兼容的 Tunnel 客户端；请安装或配置兼容客户端后重新检测。",
    diagnostics: "本地诊断",
    diagnosticsHelp:
      "检查只报告本地前置条件与固定状态，不会导出凭证、令牌或运行时密钥。",
    openLogs: "打开本地日志",
    diagnosticsError: "无法运行本地诊断。",
    logsOpened: "已打开本地诊断日志文件夹。",
    logsOpenError: "无法打开本地诊断日志文件夹。",
  },
  en: {
    home: "Home",
    workspace: "Workspace",
    skills: "Skills",
    mcp: "MCP",
    tasks: "Tasks & Logs",
    settings: "Settings & Guide",
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
    openChatGpt: "Open ChatGPT",
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
    mcpTitle: "Local stdio MCP registry",
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
    clearChatGpt: "Clear ChatGPT sign-in state",
    sessionCleared: "ChatGPT sign-in state cleared.",
    sessionClearError: "Unable to clear ChatGPT sign-in state.",
    guide: "Setup guide",
    guideHelp:
      "Complete setup from real local status. The guide never displays or exports URLs, cookies, or login sessions.",
    chooseWorkspace: "Choose workspace",
    configureSkillsMcp: "Configure Skills and local MCP",
    checkTunnel: "Check local runtime and compatible Tunnel client",
    guideOpenChat: "Open ChatGPT",
    runDoctor: "Run Doctor",
    guideComplete: "Complete",
    guideNeedsAction: "Needs action",
    guideUnavailable: "Unavailable",
    dismiss: "Dismiss step",
    guideDismissed: "Guide step dismissed.",
    guideDismissError: "Unable to save guide state.",
    tunnelUnavailable:
      "Doctor did not find a compatible Tunnel client. Install or configure one, then check again.",
    diagnostics: "Local diagnostics",
    diagnosticsHelp:
      "Checks report local prerequisites and fixed status only. Credentials, tokens, and runtime keys are never exported.",
    openLogs: "Open local logs",
    diagnosticsError: "Unable to run local diagnostics.",
    logsOpened: "Opened the local diagnostic log folder.",
    logsOpenError: "Unable to open the local diagnostic log folder.",
  },
} as const;

export default function App() {
  const [view, setView] = useState<View>("home");
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
  async function invoke(action: "start" | "stop") {
    try {
      setError(undefined);
      setSnapshot(await window.gptWebCodex[action]());
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

  return (
    <main className="launcher-shell">
      <aside aria-label="Launcher views" className="sidebar">
        <div className="brand">GPT Web Codex</div>
        {views.map((item) => (
          <button
            className={view === item ? "active" : ""}
            key={item}
            onClick={() => setView(item)}
            type="button"
          >
            {t(item)}
          </button>
        ))}
      </aside>
      <section className="content">
        <header>
          <div>
            <p className="eyebrow">{t(view)}</p>
            <h1>{t(view)}</h1>
          </div>
          <span className={`status status-${snapshot.state}`}>
            {snapshot.state}
          </span>
        </header>
        {view === "home" && (
          <Status
            snapshot={snapshot}
            onInvoke={invoke}
            onSetupTunnel={setupTunnel}
            t={t}
          />
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
        {view === "settings" && (
          <SettingsGuide
            guide={snapshot.guide}
            onUpdatePreferences={updatePreferences}
            preferences={preferences}
            t={t}
          />
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
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
    <section className="panel stack">
      <h2>{t("profiles")}</h2>
      <p>{t("profileHelp")}</p>
      <form className="stack" onSubmit={(event) => void save(event)}>
        <label>
          {t("profileId")}
          <input
            onChange={(event) => setId(event.target.value)}
            required
            value={id}
          />
        </label>
        <label>
          {t("workspaceRoot")}
          <input
            onChange={(event) => setWorkspaceRoot(event.target.value)}
            required
            value={workspaceRoot}
          />
        </label>
        <label>
          {t("skillsRoot")}
          <input
            onChange={(event) => setSkillsRoot(event.target.value)}
            required
            value={skillsRoot}
          />
        </label>
        <div className="actions">
          <button type="submit">{t("saveSelect")}</button>
        </div>
      </form>
      {profiles.length > 0 && (
        <ul className="plain-list">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <code>{profile.id}</code>
              <span>{profile.workspaceRoot}</span>
              <button
                className="secondary"
                onClick={() => void activate(profile.id)}
                type="button"
              >
                {t("select")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p>{message}</p>}
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
    } catch {
      setMessage(t("tunnelPairError"));
    } finally {
      setRuntimeKey("");
    }
  }
  async function openChatGpt() {
    try {
      await window.gptWebCodex.openChatGpt();
    } catch {
      setMessage(t("diagnosticsError"));
    }
  }
  return (
    <section className="panel stack">
      <h2>{t("status")}</h2>
      <dl>
        <dt>{t("workspaceLabel")}</dt>
        <dd>{snapshot.workspace ?? t("noWorkspace")}</dd>
        <dt>{t("runtime")}</dt>
        <dd>{snapshot.message ?? t("awaitingStatus")}</dd>
        <dt>{t("tunnel")}</dt>
        <dd>{snapshot.tunnelState ?? t("notConfigured")}</dd>
        <dt>{t("connector")}</dt>
        <dd>
          {snapshot.connectorName ?? "GPT Web Codex"} (
          {snapshot.paired ? t("paired") : t("notPaired")})
        </dd>
      </dl>
      <div className="actions">
        <button onClick={() => void onInvoke("start")} type="button">
          {t("start")}
        </button>
        <button
          className="secondary"
          onClick={() => void onInvoke("stop")}
          type="button"
        >
          {t("stop")}
        </button>
        <button
          className="secondary"
          onClick={() => void openChatGpt()}
          type="button"
        >
          {t("openChatGpt")}
        </button>
      </div>
      <form className="stack" onSubmit={(event) => void setupTunnel(event)}>
        <h3>{t("tunnelSetup")}</h3>
        <p>{t("tunnelHelp")}</p>
        <label>
          {t("tunnelId")}
          <input
            autoComplete="off"
            onChange={(event) => setTunnelId(event.target.value)}
            required
            value={tunnelId}
          />
        </label>
        <label>
          {t("runtimeKey")}
          <input
            autoComplete="off"
            onChange={(event) => setRuntimeKey(event.target.value)}
            required
            type="password"
            value={runtimeKey}
          />
        </label>
        <div className="actions">
          <button type="submit">{t("pairTunnel")}</button>
        </div>
      </form>
      {snapshot.tunnelMessage && (
        <p className="error" role="alert">
          {snapshot.tunnelMessage}
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
            <code>{task.id}</code> · {task.state}
          </p>
          {task.error && (
            <p className="error">{rendererSafeText(task.error)}</p>
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
  const [report, setReport] = useState<DiagnosticReport>();
  const [message, setMessage] = useState<string>();
  async function save(next: LauncherUiPreferences) {
    try {
      await onUpdatePreferences(next);
      setMessage(t("preferencesSaved"));
    } catch {
      setMessage(t("preferencesSaveError"));
    }
  }
  async function runDoctor() {
    try {
      setMessage(undefined);
      setReport(await window.gptWebCodex.doctor());
    } catch {
      setMessage(t("diagnosticsError"));
    }
  }
  async function clearSession() {
    try {
      await window.gptWebCodex.clearChatGptSession();
      setMessage(t("sessionCleared"));
    } catch {
      setMessage(t("sessionClearError"));
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
    <section className="stack">
      <section className="panel stack">
        <h2>{t("preferences")}</h2>
        <label>
          {t("language")}
          <select
            onChange={(event) =>
              void save({
                ...preferences,
                language: event.target
                  .value as LauncherUiPreferences["language"],
              })
            }
            value={preferences.language}
          >
            <option value="zh-CN">{t("simplifiedChinese")}</option>
            <option value="en">{t("english")}</option>
          </select>
        </label>
        <label>
          {t("theme")}
          <select
            onChange={(event) =>
              void save({
                ...preferences,
                theme: event.target.value as LauncherUiPreferences["theme"],
              })
            }
            value={preferences.theme}
          >
            <option value="system">{t("system")}</option>
            <option value="light">{t("light")}</option>
            <option value="dark">{t("dark")}</option>
          </select>
        </label>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => void clearSession()}
            type="button"
          >
            {t("clearChatGpt")}
          </button>
        </div>
      </section>
      <section className="panel stack">
        <h2>{t("guide")}</h2>
        <p>{t("guideHelp")}</p>
        {visibleGuide.map((step) => (
          <GuideStepCard
            key={step.id}
            onDismiss={() => void dismiss(step)}
            onRunDoctor={() => void runDoctor()}
            step={step}
            t={t}
          />
        ))}
        {visibleGuide.length === 0 && <p>{t("guideComplete")}</p>}
      </section>
      <section className="panel stack">
        <h2>{t("diagnostics")}</h2>
        <p>{t("diagnosticsHelp")}</p>
        <div className="actions">
          <button onClick={() => void runDoctor()} type="button">
            {t("runDoctor")}
          </button>
          <button
            className="secondary"
            onClick={() => void openLogs()}
            type="button"
          >
            {t("openLogs")}
          </button>
        </div>
        {report && (
          <ul className="plain-list">
            {report.checks.map((check) => (
              <li key={check.id}>
                <strong>{check.id}</strong>
                <span
                  className={`status status-${check.status === "error" ? "error" : check.status === "warning" ? "stopping" : "running"}`}
                >
                  {check.status}
                </span>
                <span>{check.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {message && <p>{message}</p>}
    </section>
  );
}

function GuideStepCard({
  onDismiss,
  onRunDoctor,
  step,
  t,
}: {
  onDismiss: () => void;
  onRunDoctor: () => void;
  step: GuideStep;
  t: Translate;
}) {
  const title: Record<number, TextKey> = {
    1: "chooseWorkspace",
    2: "configureSkillsMcp",
    3: "checkTunnel",
    4: "guideOpenChat",
    5: "runDoctor",
  };
  const status: Record<GuideStep["status"], TextKey> = {
    complete: "guideComplete",
    "needs-action": "guideNeedsAction",
    unavailable: "guideUnavailable",
  };
  return (
    <article className="guide-step">
      <div>
        <h3>{t(title[step.id])}</h3>
        <span className={`status guide-${step.status}`}>
          {t(status[step.status])}
        </span>
      </div>
      <p>
        {step.status === "unavailable" && step.id === 3
          ? t("tunnelUnavailable")
          : step.messageKey}
      </p>
      <div className="actions">
        {step.id === 4 && (
          <button
            onClick={() => void window.gptWebCodex.openChatGpt()}
            type="button"
          >
            {t("openChatGpt")}
          </button>
        )}
        {step.id === 5 && (
          <button onClick={onRunDoctor} type="button">
            {t("runDoctor")}
          </button>
        )}
        {step.status !== "needs-action" && (
          <button className="secondary" onClick={onDismiss} type="button">
            {t("dismiss")}
          </button>
        )}
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
