export interface LauncherSnapshot {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  workspace: string | null;
  message?: string;
}

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
  saveMcpRegistry(draft: unknown): Promise<LauncherSnapshot>;
  cancelTask(taskId: string): Promise<LauncherSnapshot>;
  doctor(): Promise<DiagnosticReport>;
  openLogs(): Promise<void>;
  onSnapshot(listener: (snapshot: LauncherSnapshot) => void): () => void;
  onLog(listener: (entry: string) => void): () => void;
}

declare global {
  interface Window {
    gptWebCodex: GptWebCodexApi;
  }
}
