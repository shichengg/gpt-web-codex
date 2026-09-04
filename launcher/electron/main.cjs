'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createProfileStore, resolveProfileRoots, validateProfile } = require('./profiles.cjs');
const { createRegistryStore, validateRegistryDraft, validateRegistryForProfile } = require('./registry.cjs');
const { RuntimeClient, redactAndBound } = require('./runtime-client.cjs');
const { createRuntimeSupervisor } = require('./runtime-supervisor.cjs');
const { createConnectorIdentity, validateTunnelSetup } = require('./connector-identity.cjs');
const { openSkillFolder, saveSkillDefaults, scanSkills } = require('./skills.cjs');
const { createTunnelSupervisor, redactTunnelLog } = require('./tunnel-supervisor.cjs');

const preload = path.join(__dirname, 'preload.cjs');
const rendererEntry = path.join(__dirname, '..', 'dist', 'index.html');
const rendererEntryUrl = pathToFileURL(rendererEntry).href;
const ALLOWED_EXTERNAL_ORIGINS = new Set(['https://platform.openai.com']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TUNNEL_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);

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
    setupTunnel: async () => snapshot,
    cancelTask: async () => snapshot,
    doctor: async () => ({ checks: [] }),
    openLogs: async () => undefined,
  });
}

async function createProfileController({
  userDataPath,
  shell,
  runtimeSupervisor,
  runtimeClient,
  publishActivity,
  tunnelSupervisor,
  connectorIdentity,
}) {
  const profiles = await createProfileStore(path.join(userDataPath, 'profiles.json'));
  const base = createDefaultController();
  const registries = new Map();
  const client = runtimeClient ?? (typeof runtimeSupervisor?.call === 'function' ? new RuntimeClient(runtimeSupervisor) : undefined);
  let runtimeOperationQueue = Promise.resolve();

  if (runtimeSupervisor?.subscribeLogs && publishActivity) {
    runtimeSupervisor.subscribeLogs(publishActivity);
  }
  if (tunnelSupervisor && connectorIdentity?.credentials) {
    const savedCredentials = connectorIdentity.credentials();
    if (savedCredentials) await tunnelSupervisor.configure(savedCredentials);
  }

  function registryFor(profileId) {
    let registry = registries.get(profileId);
    if (!registry) {
      // profileId is validated on save and when selected; it is never a path
      // supplied directly by the renderer to this private per-user directory.
      registry = createRegistryStore(path.join(userDataPath, 'mcp-registries', `${profileId}.json`));
      registries.set(profileId, registry);
    }
    return registry;
  }

  function registryPathFor(profileId) {
    return path.join(userDataPath, 'mcp-registries', `${profileId}.json`);
  }

  function serializeRuntimeOperation(operation) {
    const next = runtimeOperationQueue.then(operation, operation);
    runtimeOperationQueue = next.catch(() => undefined);
    return next;
  }

  async function runtimeSnapshot() {
    if (!client) return base.snapshot();
    const snapshot = await client.snapshot();
    return {
      state: snapshot.state,
      workspace: snapshot.workspace ?? null,
      ...(snapshot.message ? { message: snapshot.message } : {}),
      ...tunnelSnapshot(),
    };
  }

  function tunnelSnapshot() {
    if (!tunnelSupervisor?.status) return {};
    const tunnel = tunnelSupervisor.status();
    const identity = connectorIdentity?.snapshot?.();
    const state = TUNNEL_STATES.has(tunnel?.state) ? tunnel.state : 'error';
    const connectorName = typeof identity?.connectorName === 'string'
      ? identity.connectorName
      : typeof tunnel?.connectorName === 'string'
        ? tunnel.connectorName
        : undefined;
    return {
      tunnelState: state,
      tunnelConfigured: identity?.configured === true || tunnel?.configured === true,
      paired: tunnel?.paired === true && state === 'running',
      ...(connectorName ? { connectorName } : {}),
      ...(typeof tunnel?.message === 'string' ? { tunnelMessage: redactTunnelLog(tunnel.message) } : {}),
    };
  }

  async function restoreTunnelForActiveRuntime() {
    if (!tunnelSupervisor || !connectorIdentity?.credentials || !connectorIdentity?.name) return;
    const credentials = connectorIdentity.credentials();
    if (!credentials) return;
    const runtimeUrl = runtimeSupervisor?.getActiveRuntimeUrl?.();
    if (typeof runtimeUrl !== 'string') {
      throw new Error('The managed runtime did not provide a loopback URL for Tunnel pairing');
    }
    await tunnelSupervisor.restoreOrConnect({ runtimeUrl, connectorName: connectorIdentity.name() });
  }

  return Object.freeze({
    ...base,
    snapshot: runtimeSnapshot,
    start: () => serializeRuntimeOperation(async () => {
      const active = await profiles.getActive();
      if (!active || !runtimeSupervisor) throw new Error('Select a workspace profile before starting the local runtime');
      const registry = registryFor(active.id);
      // A registry file can predate this process or be manually modified.
      // Reapply canonical active-profile containment immediately before spawn,
      // then persist the canonical form that the child will load.
      await registry.save(await validateRegistryForProfile(await registry.load(), active));
      await runtimeSupervisor.start(active, registryPathFor(active.id));
      await restoreTunnelForActiveRuntime();
      return runtimeSnapshot();
    }),
    stop: () => serializeRuntimeOperation(async () => {
      // The public route is withdrawn before the local process can exit.
      await tunnelSupervisor?.stop?.();
      await runtimeSupervisor?.stop?.();
      return runtimeSnapshot();
    }),
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
    setActiveProfile: (id) => serializeRuntimeOperation(async () => {
      // One local child belongs to one profile. Stop before changing the
      // canonical roots that the next start can pass to the child.
      await tunnelSupervisor?.stop?.();
      await runtimeSupervisor?.stop?.();
      return profiles.setActive(id);
    }),
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
    saveMcpRegistry: (draft) => serializeRuntimeOperation(async () => {
      const active = await profiles.getActive();
      if (!active) throw new Error('Select a workspace profile before saving an MCP registry');
      // Save only a fully validated registry. A runtime reload is deliberately
      // sequenced after the atomic write so it can never run a rejected draft.
      await registryFor(active.id).save(await validateRegistryForProfile(draft, active));
      await tunnelSupervisor?.stop?.();
      await runtimeSupervisor?.restart?.(active, registryPathFor(active.id));
      await restoreTunnelForActiveRuntime();
      return runtimeSnapshot();
    }),
    setupTunnel: (setup) => serializeRuntimeOperation(async () => {
      if (!tunnelSupervisor || !connectorIdentity?.configure || !connectorIdentity?.credentials) {
        throw new Error('OpenAI Tunnel setup is unavailable');
      }
      await connectorIdentity.configure(setup);
      const credentials = connectorIdentity.credentials();
      // The private credential object goes only from identity storage to the
      // main-process supervisor. The result below is a redacted snapshot.
      await tunnelSupervisor.configure(credentials);
      await restoreTunnelForActiveRuntime();
      return runtimeSnapshot();
    }),
    cancelTask: async (taskId) => {
      if (!client) throw new Error('Local runtime activity is unavailable');
      await client.cancel(taskId);
      return runtimeSnapshot();
    },
  });
}

/** Redact and byte-bound runtime activity before it can cross Electron IPC. */
function createActivityPublisher(getTrustedWebContents, maximumBytes = 4_096) {
  if (typeof getTrustedWebContents !== 'function') throw new TypeError('Activity publisher requires trusted web contents');
  return (entry) => {
    const safeEntry = redactAndBound(typeof entry === 'string' ? entry : 'Invalid runtime activity entry', maximumBytes);
    const webContents = getTrustedWebContents();
    if (webContents && typeof webContents.send === 'function' && !webContents.isDestroyed?.()) {
      webContents.send('launcher:log', safeEntry);
    }
    return safeEntry;
  };
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

const validateMcpRegistryDraft = validateRegistryDraft;

function validateTunnelSetupDraft(setup) {
  const validated = validateTunnelSetup(setup);
  return Object.freeze({
    tunnelId: validated.tunnelId,
    runtimeKey: validated.runtimeKey,
  });
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
    'launcher:setup-tunnel': guarded((args) => {
      if (args.length !== 1) throw new TypeError('setupTunnel requires one payload');
      return controller.setupTunnel(validateTunnelSetupDraft(args[0]));
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

/** Quit only after the owned child confirms it has stopped. */
async function stopRuntimeBeforeQuit(runtimeSupervisor, quit, tunnelSupervisor) {
  try {
    await tunnelSupervisor?.stop?.();
    await runtimeSupervisor?.stop?.();
    quit();
    return true;
  } catch {
    // Do not surface a raw child-process error here: it may contain runtime
    // data. Keeping Electron alive lets the supervisor retain ownership.
    return false;
  }
}

function boot() {
  const electron = require('electron');
  const { app, ipcMain } = electron;
  let mainWindow;
  let runtimeSupervisor;
  let tunnelSupervisor;
  app.whenReady().then(async () => {
    mainWindow = createMainWindow(electron);
    const userDataPath = app.getPath('userData');
    runtimeSupervisor = createRuntimeSupervisor({
      appDataPath: userDataPath,
      runtimeEntry: path.join(__dirname, '..', '..', 'dist', 'index.js'),
    });
    const connectorIdentity = await createConnectorIdentity(path.join(userDataPath, 'connector.json'));
    const tunnelAdapter = createUnavailableTunnelAdapter();
    tunnelSupervisor = createTunnelSupervisor({
      getActiveRuntimeUrl: () => runtimeSupervisor?.getActiveRuntimeUrl?.(),
      ...tunnelAdapter,
    });
    const runtimeClient = new RuntimeClient(runtimeSupervisor);
    const publishActivity = createActivityPublisher(() => mainWindow?.webContents);
    const controller = await createProfileController({
      userDataPath,
      shell: electron.shell,
      runtimeSupervisor,
      runtimeClient,
      publishActivity,
      tunnelSupervisor,
      connectorIdentity,
    });
    registerIpcHandlers(ipcMain, controller, () => mainWindow?.webContents);
    app.on('activate', () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(electron);
      }
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      // Keep process ownership local: wait for the owned core to stop before
      // quitting Electron so no runtime survives the launcher window.
      void stopRuntimeBeforeQuit(runtimeSupervisor, () => app.quit(), tunnelSupervisor);
    }
  });
}

/**
 * Task 6 owns the strict runner boundary. A packaged OpenAI Tunnel adapter is
 * deliberately not guessed here because this repository has no client binary
 * or SDK; packaging can supply a verified adapter without widening renderer
 * authority or changing the lifecycle contract.
 */
function createUnavailableTunnelAdapter() {
  return Object.freeze({
    runTunnel: async () => { throw new Error('OpenAI Tunnel runner is unavailable in this launcher build'); },
    checkHealth: async () => false,
    stopTunnel: async () => undefined,
  });
}

if (require.main === module) {
  boot();
}

module.exports = {
  ALLOWED_EXTERNAL_ORIGINS,
  boot,
  createActivityPublisher,
  createMainWindow,
  createProfileController,
  isAllowedExternalUrl,
  rendererEntryUrl,
  registerIpcHandlers,
  validateMcpRegistryDraft,
  validateTunnelSetupDraft,
  validateProfileId,
  validateSkillIds,
  validateWorkspaceProfileDraft,
  validateTaskId,
  stopRuntimeBeforeQuit,
  windowOptions,
};
