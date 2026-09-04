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
  setupTunnel: 'launcher:setup-tunnel',
  cancelTask: 'launcher:cancel-task',
  doctor: 'launcher:doctor',
  openLogs: 'launcher:open-logs',
  snapshotChanged: 'launcher:snapshot-changed',
  log: 'launcher:log',
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
    setupTunnel: (setup) => ipcRenderer.invoke(IPC_CHANNELS.setupTunnel, setup),
    cancelTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.cancelTask, taskId),
    doctor: () => ipcRenderer.invoke(IPC_CHANNELS.doctor),
    openLogs: () => ipcRenderer.invoke(IPC_CHANNELS.openLogs),
    onSnapshot: (listener) => subscribe(ipcRenderer, IPC_CHANNELS.snapshotChanged, listener),
    onLog: (listener) => subscribe(ipcRenderer, IPC_CHANNELS.log, listener),
  });
}

function exposeBridge(electron) {
  const { contextBridge, ipcRenderer } = electron;
  if (!contextBridge || !ipcRenderer) {
    return false;
  }
  contextBridge.exposeInMainWorld('gptWebCodex', createPreloadApi(ipcRenderer));
  return true;
}

// Sandboxed Electron preload scripts have a restricted synthetic require and
// no reliable require.main. Loading this module is the preload entrypoint.
exposeBridge(require('electron'));

module.exports = { IPC_CHANNELS, createPreloadApi, exposeBridge };
