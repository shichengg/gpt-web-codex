export interface LauncherSnapshot {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  workspace: string | null;
  message?: string;
  tunnelState?: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  tunnelConfigured?: boolean;
  paired?: boolean;
  connectorName?: string;
  tunnelMessage?: string;
  preferences?: LauncherUiPreferences;
  guide?: GuideStep[];
}

export type UiTheme = 'system' | 'light' | 'dark';
export interface LauncherUiPreferences { language: 'zh-CN' | 'en'; theme: UiTheme; guideDismissedSteps: number[]; }
export interface GuideStep { id: number; status: 'complete' | 'needs-action' | 'unavailable'; messageKey: string; }

export interface DiagnosticReport {
  checks: Array<{ id: string; status: 'ok' | 'warning' | 'error'; message?: string }>;
}

/** Renderer-safe profile data: paths and UI choices only, never credentials. */
export interface WorkspaceProfile {
  id: string;
  workspaceRoot: string;
  skillsRoot: string;
  enabledSkillIds: string[];
}

/** Catalog data is deliberately bounded; Skill source stays in the main process. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  preview: string;
}

/** A local stdio MCP entry. URLs, environment variables, and credentials never cross IPC. */
export interface McpServerDraft {
  id: string;
  command: string;
  args: string[];
  allowedTools: string[];
  timeoutMs: number;
}

export interface McpRegistryDraft {
  servers: McpServerDraft[];
}

/** One-way setup input. Runtime keys never appear in a snapshot or callback. */
export interface TunnelSetup {
  tunnelId: string;
  runtimeKey: string;
}

/** Bounded, redacted activity returned by the fixed task query bridge. */
export interface TaskActivity {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  error?: string;
  output?: string;
  outputTruncated?: boolean;
}

export interface GptWebCodexApi {
  snapshot(): Promise<LauncherSnapshot>;
  start(): Promise<LauncherSnapshot>;
  stop(): Promise<LauncherSnapshot>;
  selectWorkspace(): Promise<LauncherSnapshot>;
  listProfiles(): Promise<WorkspaceProfile[]>;
  saveProfile(profile: WorkspaceProfile): Promise<WorkspaceProfile>;
  setActiveProfile(profileId: string): Promise<WorkspaceProfile>;
  listSkills(): Promise<SkillSummary[]>;
  saveSkills(skillIds: string[]): Promise<LauncherSnapshot>;
  openSkillFolder(skillId: string): Promise<void>;
  saveMcpRegistry(draft: McpRegistryDraft): Promise<LauncherSnapshot>;
  setupTunnel(setup: TunnelSetup): Promise<LauncherSnapshot>;
  task(taskId: string): Promise<TaskActivity>;
  cancelTask(taskId: string): Promise<LauncherSnapshot>;
  doctor(): Promise<DiagnosticReport>;
  openLogs(): Promise<void>;
  openChatGpt(): Promise<void>;
  clearChatGptSession(): Promise<void>;
  preferences(): Promise<LauncherUiPreferences>;
  savePreferences(preferences: LauncherUiPreferences): Promise<LauncherUiPreferences>;
  onSnapshot(listener: (snapshot: LauncherSnapshot) => void): () => void;
  onLog(listener: (entry: string) => void): () => void;
}

declare global {
  interface Window {
    gptWebCodex: GptWebCodexApi;
  }
}
