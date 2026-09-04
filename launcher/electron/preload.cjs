'use strict';

const IPC_CHANNELS = Object.freeze({
  snapshot: 'launcher:snapshot',
  start: 'launcher:start',
  stop: 'launcher:stop',
  selectWorkspace: 'launcher:select-workspace',
  saveSkills: 'launcher:save-skills',
  saveMcpRegistry: 'launcher:save-mcp-registry',
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
    saveSkills: (skillIds) => ipcRenderer.invoke(IPC_CHANNELS.saveSkills, skillIds),
    saveMcpRegistry: (draft) => ipcRenderer.invoke(IPC_CHANNELS.saveMcpRegistry, draft),
    cancelTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.cancelTask, taskId),
    doctor: () => ipcRenderer.invoke(IPC_CHANNELS.doctor),
    openLogs: () => ipcRenderer.invoke(IPC_CHANNELS.openLogs),
    onSnapshot: (listener) => subscribe(ipcRenderer, IPC_CHANNELS.snapshotChanged, listener),
    onLog: (listener) => subscribe(ipcRenderer, IPC_CHANNELS.log, listener),
  });
}

if (require.main === module) {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('gptWebCodex', createPreloadApi(ipcRenderer));
}

module.exports = { IPC_CHANNELS, createPreloadApi };
