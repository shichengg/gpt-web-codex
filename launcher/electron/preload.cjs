'use strict';

const IPC_CHANNELS = Object.freeze({
  snapshot: 'launcher:snapshot',
  start: 'launcher:start',
  stop: 'launcher:stop',
  selectWorkspace: 'launcher:select-workspace',
  listProfiles: 'launcher:list-profiles',
  saveProfile: 'launcher:save-profile',
  setActiveProfile: 'launcher:set-active-profile',
  listSkills: 'launcher:list-skills',
  saveSkills: 'launcher:save-skills',
  openSkillFolder: 'launcher:open-skill-folder',
  saveMcpRegistry: 'launcher:save-mcp-registry',
  listMcpRegistry: 'launcher:list-mcp-registry',
  listMcpCredentials: 'launcher:list-mcp-credentials',
  saveMcpCredential: 'launcher:save-mcp-credential',
  removeMcpCredential: 'launcher:remove-mcp-credential',
  discoverMcpTools: 'launcher:discover-mcp-tools',
  listMemory: 'launcher:list-memory',
  saveMemory: 'launcher:save-memory',
  removeMemory: 'launcher:remove-memory',
  setupTunnel: 'launcher:setup-tunnel',
  task: 'launcher:task',
  cancelTask: 'launcher:cancel-task',
  doctor: 'launcher:doctor',
  openLogs: 'launcher:open-logs',
  closeManager: 'launcher:close-manager',
  preferences: 'launcher:preferences',
  savePreferences: 'launcher:save-preferences',
  snapshotChanged: 'launcher:snapshot-changed',
  log: 'launcher:log',
  logs: 'launcher:logs',
});

function subscribe(ipcRenderer, channel, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Subscription listener must be a function');
  }

  const wrappedListener = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrappedListener);
  return () => ipcRenderer.removeListener(channel, wrappedListener);
}

function createPreloadApi(ipcRenderer) {
  return Object.freeze({
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.snapshot),
    start: () => ipcRenderer.invoke(IPC_CHANNELS.start),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.stop),
    selectWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.selectWorkspace),
    listProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.listProfiles),
    saveProfile: (profile) => ipcRenderer.invoke(IPC_CHANNELS.saveProfile, profile),
    setActiveProfile: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.setActiveProfile, profileId),
    listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.listSkills),
    saveSkills: (skillIds) => ipcRenderer.invoke(IPC_CHANNELS.saveSkills, skillIds),
    openSkillFolder: (skillId) => ipcRenderer.invoke(IPC_CHANNELS.openSkillFolder, skillId),
    saveMcpRegistry: (draft) => ipcRenderer.invoke(IPC_CHANNELS.saveMcpRegistry, draft),
    listMcpRegistry: () => ipcRenderer.invoke(IPC_CHANNELS.listMcpRegistry),
    listMcpCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.listMcpCredentials),
    saveMcpCredential: (credential) => ipcRenderer.invoke(IPC_CHANNELS.saveMcpCredential, credential),
    removeMcpCredential: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.removeMcpCredential, serverId),
    discoverMcpTools: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.discoverMcpTools, serverId),
    listMemory: () => ipcRenderer.invoke(IPC_CHANNELS.listMemory),
    saveMemory: (draft) => ipcRenderer.invoke(IPC_CHANNELS.saveMemory, draft),
    removeMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.removeMemory, id),
    setupTunnel: (setup) => ipcRenderer.invoke(IPC_CHANNELS.setupTunnel, setup),
    task: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.task, taskId),
    cancelTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.cancelTask, taskId),
    doctor: () => ipcRenderer.invoke(IPC_CHANNELS.doctor),
    openLogs: () => ipcRenderer.invoke(IPC_CHANNELS.openLogs),
    preferences: () => ipcRenderer.invoke(IPC_CHANNELS.preferences),
    savePreferences: (preferences) => ipcRenderer.invoke(IPC_CHANNELS.savePreferences, preferences),
    onSnapshot: (listener) => subscribe(ipcRenderer, IPC_CHANNELS.snapshotChanged, listener),
    onLog: (listener) => subscribe(ipcRenderer, IPC_CHANNELS.log, listener),
  });
}

function createReferenceApi(ipcRenderer) {
  let pendingRuntimeKey = '';
  let pendingTunnelId = '';
  const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((data) => ({ ok: true, data }));
  const safeSnapshot = async () => {
    const snapshot = await ipcRenderer.invoke(IPC_CHANNELS.snapshot);
    const profiles = await ipcRenderer.invoke(IPC_CHANNELS.listProfiles).catch(() => []);
    const skills = await ipcRenderer.invoke(IPC_CHANNELS.listSkills).catch(() => []);
    const mcp = await ipcRenderer.invoke(IPC_CHANNELS.listMcpRegistry).catch(() => ({ servers: [] }));
    const doctor = await ipcRenderer.invoke(IPC_CHANNELS.doctor).catch(() => ({ checks: [] }));
    return { ok: true, data: {
      settings: { workspace: snapshot.workspace || '', proxyMode: snapshot.preferences?.proxyMode || 'auto', proxyUrl: snapshot.preferences?.proxyUrl || '', theme: snapshot.preferences?.theme || 'light', keepRunningOnClose: snapshot.preferences?.keepRunningOnClose !== false, autoStartServices: snapshot.preferences?.autoStartServices !== false, startWithWindows: snapshot.preferences?.startAtLogin === true, guideProgress: {} },
      secrets: { runtimeApiKey: Boolean(snapshot.tunnelConfigured), mcpAuthToken: true },
      environment: { python: { installed: true, version: 'managed' }, proxy: { mode: snapshot.proxy?.mode || 'auto', configured: snapshot.proxy?.configured === true, reachable: snapshot.proxy?.reachable === true, source: snapshot.proxy?.source || 'unknown', url: '' }, tunnelClient: { installed: snapshot.tunnelConfigured !== false }, workspace: { configured: profiles.length > 0, exists: Boolean(snapshot.workspace) }, ports: { mcpListening: snapshot.state === 'running', tunnelListening: snapshot.paired === true } },
      status: { busy: false, runtimeRunning: snapshot.state === 'running', tunnelRunning: snapshot.paired === true, connectionRunning: snapshot.paired === true, connectionMode: 'official', fullyReady: snapshot.state === 'running' && snapshot.paired === true, localMcpUrl: '', tunnelUiUrl: '' },
      profiles, skills, mcpRegistry: mcp, doctor,
    } };
  };
  return Object.freeze({
    snapshot: safeSnapshot,
    start: async () => {
      const started = await invoke(IPC_CHANNELS.start);
      if (pendingRuntimeKey && pendingTunnelId) {
        await invoke(IPC_CHANNELS.setupTunnel, { tunnelId: pendingTunnelId, runtimeKey: pendingRuntimeKey });
        pendingRuntimeKey = '';
      }
      return started;
    },
    stop: () => invoke(IPC_CHANNELS.stop),
    restart: () => invoke(IPC_CHANNELS.start),
    chooseWorkspace: () => invoke(IPC_CHANNELS.selectWorkspace).then((result) => ({ ok: true, data: result.data?.workspace || result.data || '' })),
    workspaceHub: async () => {
      const snapshot = await safeSnapshot();
      return { ok: true, data: { activeWorkspace: snapshot.data.settings.workspace, recentWorkspaces: snapshot.data.profiles.map((profile) => profile.workspaceRoot) } };
    },
    switchWorkspace: async (workspace) => {
      const snapshot = await safeSnapshot();
      const profile = snapshot.data.profiles.find((item) => item.workspaceRoot === workspace);
      return profile ? invoke(IPC_CHANNELS.setActiveProfile, profile.id) : { ok: false, error: 'Workspace profile not found' };
    },
    saveSettings: (settings) => { if (settings.tunnelId) pendingTunnelId = String(settings.tunnelId); return invoke(IPC_CHANNELS.savePreferences, { language: 'zh-CN', theme: settings.theme || 'system', proxyMode: settings.proxyMode || 'auto', proxyUrl: settings.proxyUrl || '', startAtLogin: settings.startWithWindows === true, autoStartServices: settings.autoStartServices !== false, keepRunningOnClose: settings.keepRunningOnClose !== false, guideDismissedSteps: [] }); },
    logs: () => invoke(IPC_CHANNELS.logs),
    clearLogs: () => Promise.resolve({ ok: true, data: true }),
    taskState: () => Promise.resolve({ ok: true, data: { exists: false, state: null } }),
    taskRuntime: () => Promise.resolve({ ok: true, data: { state: { status: 'idle' }, operations: [] } }),
    taskWorktrees: () => Promise.resolve({ ok: true, data: { worktrees: [] } }),
    taskWorktreeDiff: () => Promise.resolve({ ok: true, data: { worktree_diff: null } }),
    applyTaskWorktree: () => Promise.resolve({ ok: true, data: { apply_result: { applied: false, changed_count: 0 } } }),
    discardTaskWorktree: () => Promise.resolve({ ok: true, data: { worktree: { discarded: false } } }),
    taskHistory: () => Promise.resolve({ ok: true, data: [] }),
    clearTaskState: () => Promise.resolve({ ok: true, data: true }),
    pauseTask: () => Promise.resolve({ ok: true, data: {} }),
    resumeTask: () => Promise.resolve({ ok: true, data: {} }),
    stopTask: () => Promise.resolve({ ok: true, data: {} }),
    performanceTrace: () => Promise.resolve({ ok: true, data: null }),
    clearPerformanceTrace: () => Promise.resolve({ ok: true, data: true }),
    workspaceContext: () => Promise.resolve({ ok: true, data: {} }),
    codingToolsGuide: () => Promise.resolve({ ok: true, data: {} }),
    inspectBuild: () => Promise.resolve({ ok: true, data: { type: 'unknown', name: 'workspace', testCommand: '', buildCommand: '', artifacts: [] } }),
    runBuild: () => Promise.resolve({ ok: true, data: { overallStatus: 'skipped', project: {}, testResult: {}, buildResult: {}, artifacts: [] } }),
    inspectHealth: () => invoke(IPC_CHANNELS.doctor).then((result) => ({ ok: true, data: { healthy: result.data?.checks?.every((check) => check.status !== 'error') !== false, checks: (result.data?.checks || []).map((check) => ({ label: check.id, detail: check.message || '', ok: check.status !== 'error' })) } })),
    repairHealth: () => invoke(IPC_CHANNELS.doctor).then((result) => ({ ok: true, data: { healthy: true, checks: [], actions: [], unresolved: [] } })),
    chooseAndSwitchWorkspace: () => invoke(IPC_CHANNELS.selectWorkspace),
    chooseAuthorizedRoot: () => Promise.resolve({ ok: true, data: '' }),
    updateAuthorizedRoots: () => Promise.resolve({ ok: true, data: true }),
    saveRuntimeKey: (value) => { pendingRuntimeKey = String(value || ''); return Promise.resolve({ ok: true, data: { runtimeApiKey: Boolean(pendingRuntimeKey) } }); },
    removeRuntimeKey: () => Promise.resolve({ ok: true, data: {} }),
    regenerateMcpToken: () => Promise.resolve({ ok: true, data: {} }),
    detectProxy: () => invoke(IPC_CHANNELS.snapshot),
    installPython: () => Promise.resolve({ ok: true, data: true }),
    testTaskNotification: () => Promise.resolve({ ok: true, data: true }),
    openExternal: () => Promise.resolve({ ok: true, data: true }),
    closeManager: () => invoke(IPC_CHANNELS.closeManager),
    listSkills: () => invoke(IPC_CHANNELS.listSkills),
    saveSkills: (ids) => invoke(IPC_CHANNELS.saveSkills, ids),
    listMcpRegistry: () => invoke(IPC_CHANNELS.listMcpRegistry),
    saveMcpRegistry: (draft) => invoke(IPC_CHANNELS.saveMcpRegistry, draft),
    listMcpCredentials: () => invoke(IPC_CHANNELS.listMcpCredentials),
    saveMcpCredential: (credential) => invoke(IPC_CHANNELS.saveMcpCredential, credential),
    removeMcpCredential: (serverId) => invoke(IPC_CHANNELS.removeMcpCredential, serverId),
    onProgress: () => () => {}, onStatus: () => () => {}, onHeartbeat: () => () => {}, onBuildProgress: () => () => {},
    onLog: (listener) => subscribe(ipcRenderer, IPC_CHANNELS.log, listener),
  });
}

function exposeBridge(electron) {
  const { contextBridge, ipcRenderer } = electron;
  if (!contextBridge || !ipcRenderer) {
    return false;
  }
  contextBridge.exposeInMainWorld('gptWebCodex', createPreloadApi(ipcRenderer));
  contextBridge.exposeInMainWorld('mcpAssistant', createReferenceApi(ipcRenderer));
  return true;
}

// Sandboxed Electron preload scripts have a restricted synthetic require and
// no reliable require.main. Loading this module is the preload entrypoint.
exposeBridge(require('electron'));

module.exports = { IPC_CHANNELS, createPreloadApi, exposeBridge };
