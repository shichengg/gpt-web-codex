'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createProfileStore, resolveProfileRoots, validateProfile } = require('./profiles.cjs');
const { openSkillFolder, saveSkillDefaults, scanSkills } = require('./skills.cjs');

const preload = path.join(__dirname, 'preload.cjs');
const rendererEntry = path.join(__dirname, '..', 'dist', 'index.html');
const rendererEntryUrl = pathToFileURL(rendererEntry).href;
const ALLOWED_EXTERNAL_ORIGINS = new Set(['https://platform.openai.com']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
    listProfiles: async () => [],
    saveProfile: async () => undefined,
    setActiveProfile: async () => undefined,
    listSkills: async () => [],
    openSkillFolder: async () => undefined,
    saveMcpRegistry: async () => snapshot,
    cancelTask: async () => snapshot,
    doctor: async () => ({ checks: [] }),
    openLogs: async () => undefined,
  });
}

async function createProfileController({ userDataPath, shell }) {
  const profiles = await createProfileStore(path.join(userDataPath, 'profiles.json'));
  const base = createDefaultController();

  return Object.freeze({
    ...base,
    listProfiles: () => profiles.list(),
    saveProfile: async (profile) => {
      const canonicalProfile = await resolveProfileRoots(profile);
      // Validate choices supplied by the renderer and defaults retained from
      // an existing profile against the prospective workspace catalog.
      await saveSkillDefaults(canonicalProfile, canonicalProfile.enabledSkillIds);
      const existing = await profiles.get(canonicalProfile.id);
      if (existing) await saveSkillDefaults(canonicalProfile, existing.enabledSkillIds);
      return profiles.save(canonicalProfile);
    },
    setActiveProfile: (id) => profiles.setActive(id),
    listSkills: async () => {
      const active = await profiles.getActive();
      return active ? scanSkills(active) : [];
    },
    saveSkills: async (skillIds) => {
      const active = await profiles.getActive();
      if (!active) throw new Error('Select a workspace profile before saving Skill defaults');
      const defaults = await saveSkillDefaults(active, skillIds);
      await profiles.saveDefaults(active.id, defaults);
      return base.snapshot();
    },
    openSkillFolder: async (skillId) => {
      const active = await profiles.getActive();
      if (!active) throw new Error('Select a workspace profile before opening a Skill folder');
      return openSkillFolder(active, skillId, shell);
    },
  });
}

function rejectUntrustedSender(event, getTrustedWebContents) {
  const trustedWebContents = getTrustedWebContents();
  if (!event || event.sender !== trustedWebContents || event.sender.getURL() !== rendererEntryUrl) {
    throw new Error('IPC request rejected from untrusted renderer');
  }
}

function requireNoPayload(args, operation) {
  if (args.length !== 0) {
    throw new TypeError(`${operation} does not accept a payload`);
  }
}

function validateSkillIds(skillIds) {
  if (!Array.isArray(skillIds) || skillIds.length > 128 ||
    new Set(skillIds).size !== skillIds.length ||
    !skillIds.every((id) => typeof id === 'string' && SKILL_ID.test(id))) {
    throw new TypeError('Skill IDs must be a unique bounded list of valid IDs');
  }
  return skillIds;
}

function validateWorkspaceProfileDraft(profile) {
  return validateProfile(profile);
}

function validateProfileId(profileId) {
  if (typeof profileId !== 'string' || !IDENTIFIER.test(profileId)) {
    throw new TypeError('Workspace profile ID must be a bounded identifier');
  }
  return profileId;
}

function validateMcpRegistryDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
    Object.keys(draft).some((key) => key !== 'servers') || !Array.isArray(draft.servers) || draft.servers.length > 32) {
    throw new TypeError('MCP registry draft must contain a bounded servers list');
  }

  for (const server of draft.servers) {
    if (!server || typeof server !== 'object' || Array.isArray(server) ||
      Object.keys(server).some((key) => !['id', 'command', 'args', 'allowedTools', 'timeoutMs'].includes(key)) ||
      typeof server.id !== 'string' || !IDENTIFIER.test(server.id) ||
      typeof server.command !== 'string' || server.command.length === 0 || server.command.length > 512 ||
      !Array.isArray(server.args) || server.args.length > 64 ||
      !server.args.every((arg) => typeof arg === 'string' && arg.length <= 1024) ||
      !Array.isArray(server.allowedTools) || server.allowedTools.length === 0 || server.allowedTools.length > 128 ||
      new Set(server.allowedTools).size !== server.allowedTools.length ||
      !server.allowedTools.every((tool) => typeof tool === 'string' && IDENTIFIER.test(tool)) ||
      !Number.isInteger(server.timeoutMs) || server.timeoutMs < 100 || server.timeoutMs > 300000) {
      throw new TypeError('MCP registry server has invalid allowedTools or bounded fields');
    }
  }
  return draft;
}

function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !IDENTIFIER.test(taskId)) {
    throw new TypeError('task ID must be a bounded identifier');
  }
  return taskId;
}

function registerIpcHandlers(ipcMain, controller = createDefaultController(), getTrustedWebContents = () => undefined) {
  const guarded = (handler) => (event, ...args) => {
    rejectUntrustedSender(event, getTrustedWebContents);
    return handler(args);
  };
  const handlers = {
    'launcher:snapshot': guarded((args) => { requireNoPayload(args, 'snapshot'); return controller.snapshot(); }),
    'launcher:start': guarded((args) => { requireNoPayload(args, 'start'); return controller.start(); }),
    'launcher:stop': guarded((args) => { requireNoPayload(args, 'stop'); return controller.stop(); }),
    'launcher:select-workspace': guarded((args) => { requireNoPayload(args, 'selectWorkspace'); return controller.selectWorkspace(); }),
    'launcher:list-profiles': guarded((args) => { requireNoPayload(args, 'listProfiles'); return controller.listProfiles(); }),
    'launcher:save-profile': guarded((args) => {
      if (args.length !== 1) throw new TypeError('saveProfile requires one payload');
      return controller.saveProfile(validateWorkspaceProfileDraft(args[0]));
    }),
    'launcher:set-active-profile': guarded((args) => {
      if (args.length !== 1) throw new TypeError('setActiveProfile requires one payload');
      return controller.setActiveProfile(validateProfileId(args[0]));
    }),
    'launcher:list-skills': guarded((args) => { requireNoPayload(args, 'listSkills'); return controller.listSkills(); }),
    'launcher:save-skills': guarded((args) => {
      if (args.length !== 1) throw new TypeError('saveSkills requires one payload');
      return controller.saveSkills(validateSkillIds(args[0]));
    }),
    'launcher:open-skill-folder': guarded((args) => {
      if (args.length !== 1) throw new TypeError('openSkillFolder requires one payload');
      return controller.openSkillFolder(validateSkillIds([args[0]])[0]);
    }),
    'launcher:save-mcp-registry': guarded((args) => {
      if (args.length !== 1) throw new TypeError('saveMcpRegistry requires one payload');
      return controller.saveMcpRegistry(validateMcpRegistryDraft(args[0]));
    }),
    'launcher:cancel-task': guarded((args) => {
      if (args.length !== 1) throw new TypeError('cancelTask requires one payload');
      return controller.cancelTask(validateTaskId(args[0]));
    }),
    'launcher:doctor': guarded((args) => { requireNoPayload(args, 'doctor'); return controller.doctor(); }),
    'launcher:open-logs': guarded((args) => { requireNoPayload(args, 'openLogs'); return controller.openLogs(); }),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
}

function createMainWindow(electron) {
  const { BrowserWindow, shell } = electron;
  const window = new BrowserWindow(windowOptions);

  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
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
  let mainWindow;
  app.whenReady().then(async () => {
    mainWindow = createMainWindow(electron);
    const controller = await createProfileController({ userDataPath: app.getPath('userData'), shell: electron.shell });
    registerIpcHandlers(ipcMain, controller, () => mainWindow?.webContents);
    app.on('activate', () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(electron);
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
  createProfileController,
  isAllowedExternalUrl,
  rendererEntryUrl,
  registerIpcHandlers,
  validateMcpRegistryDraft,
  validateProfileId,
  validateSkillIds,
  validateWorkspaceProfileDraft,
  validateTaskId,
  windowOptions,
};
