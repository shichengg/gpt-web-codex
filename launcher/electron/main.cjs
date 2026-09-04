'use strict';

const path = require('node:path');

const preload = path.join(__dirname, 'preload.cjs');
const rendererEntry = path.join(__dirname, '..', 'dist', 'index.html');
const ALLOWED_EXTERNAL_ORIGINS = new Set(['https://platform.openai.com']);

const windowOptions = Object.freeze({
  width: 1180,
  height: 800,
  minWidth: 900,
  minHeight: 640,
  show: false,
  backgroundColor: '#101827',
  webPreferences: Object.freeze({
    preload,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  }),
});

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_EXTERNAL_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

function createDefaultController() {
  const snapshot = Object.freeze({ state: 'stopped', workspace: null, message: 'Launcher is ready.' });
  return Object.freeze({
    snapshot: async () => snapshot,
    start: async () => snapshot,
    stop: async () => snapshot,
    selectWorkspace: async () => snapshot,
    saveSkills: async () => snapshot,
    saveMcpRegistry: async () => snapshot,
    cancelTask: async () => snapshot,
    doctor: async () => ({ checks: [] }),
    openLogs: async () => undefined,
  });
}

function registerIpcHandlers(ipcMain, controller = createDefaultController()) {
  const handlers = {
    'launcher:snapshot': () => controller.snapshot(),
    'launcher:start': () => controller.start(),
    'launcher:stop': () => controller.stop(),
    'launcher:select-workspace': () => controller.selectWorkspace(),
    'launcher:save-skills': (_event, skillIds) => controller.saveSkills(skillIds),
    'launcher:save-mcp-registry': (_event, draft) => controller.saveMcpRegistry(draft),
    'launcher:cancel-task': (_event, taskId) => controller.cancelTask(taskId),
    'launcher:doctor': () => controller.doctor(),
    'launcher:open-logs': () => controller.openLogs(),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
}

function createMainWindow(electron) {
  const { BrowserWindow, shell } = electron;
  const window = new BrowserWindow(windowOptions);

  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  void window.loadFile(rendererEntry);
  return window;
}

function boot() {
  const electron = require('electron');
  const { app, ipcMain } = electron;
  app.whenReady().then(() => {
    registerIpcHandlers(ipcMain);
    createMainWindow(electron);
    app.on('activate', () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) {
        createMainWindow(electron);
      }
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

if (require.main === module) {
  boot();
}

module.exports = {
  ALLOWED_EXTERNAL_ORIGINS,
  boot,
  createMainWindow,
  isAllowedExternalUrl,
  registerIpcHandlers,
  windowOptions,
};
