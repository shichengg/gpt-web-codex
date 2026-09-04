export interface LauncherSnapshot {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  workspace: string | null;
  message?: string;
}

export interface DiagnosticReport {
  checks: Array<{ id: string; status: 'ok' | 'warning' | 'error'; message?: string }>;
}

export interface GptWebCodexApi {
  snapshot(): Promise<LauncherSnapshot>;
  start(): Promise<LauncherSnapshot>;
  stop(): Promise<LauncherSnapshot>;
  selectWorkspace(): Promise<LauncherSnapshot>;
  saveSkills(skillIds: string[]): Promise<LauncherSnapshot>;
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
