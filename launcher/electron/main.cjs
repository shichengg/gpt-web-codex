'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn: spawnChild } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createProfileStore, resolveProfileRoots, validateProfile } = require('./profiles.cjs');
const { createRegistryStore, validateRegistryDraft, validateRegistryForProfile } = require('./registry.cjs');
const { RuntimeClient } = require('./runtime-client.cjs');
const { createRuntimeSupervisor } = require('./runtime-supervisor.cjs');
const { createConnectorIdentity, validateTunnelSetup } = require('./connector-identity.cjs');
const { openSkillFolder, saveSkillDefaults, scanSkills } = require('./skills.cjs');
const { createTunnelSupervisor, redactTunnelLog } = require('./tunnel-supervisor.cjs');
const { doctor: runDoctor, openDiagnosticLogs } = require('./doctor.cjs');

const preload = path.join(__dirname, 'preload.cjs');
const rendererEntry = path.join(__dirname, '..', 'dist', 'index.html');
const rendererEntryUrl = pathToFileURL(rendererEntry).href;
const ALLOWED_EXTERNAL_ORIGINS = new Set(['https://platform.openai.com']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TUNNEL_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);
const RUNTIME_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);

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
    doctor: () => runDoctor(),
    openLogs: async () => undefined,
  });
}

async function createProfileController({
  userDataPath,
  shell,
  runtimeSupervisor,
  runtimeClient,
  publishActivity,
  publishSnapshot,
  tunnelSupervisor,
  connectorIdentity,
  coreAssetsAvailable,
  tunnelAvailable = false,
  diagnosticLogDirectory,
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

  async function publishCurrentSnapshot() {
    const snapshot = await runtimeSnapshot();
    try {
      await publishSnapshot?.(snapshot);
    } catch {
      // Renderer availability must never interfere with runtime ownership.
    }
    return snapshot;
  }

  async function publishSnapshotAfterFailure() {
    try {
      await publishCurrentSnapshot();
    } catch {
      // Preserve the actual lifecycle failure for the IPC caller.
    }
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

  function requireActiveRuntimeUrlForTunnel() {
    const runtimeUrl = runtimeSupervisor?.getActiveRuntimeUrl?.();
    if (typeof runtimeUrl !== 'string') {
      throw new Error('Start the managed local runtime before pairing the OpenAI Tunnel');
    }
    return runtimeUrl;
  }

  if (runtimeSupervisor?.subscribeLifecycle && tunnelSupervisor?.stop) {
    runtimeSupervisor.subscribeLifecycle(() => {
      // An unexpected exit/error is delivered synchronously by the process
      // owner. Queue route withdrawal ahead of any subsequent launcher action.
      void serializeRuntimeOperation(async () => {
        try {
          await tunnelSupervisor.stop();
        } finally {
          await publishSnapshotAfterFailure();
        }
      }).catch(() => undefined);
    });
  }

  return Object.freeze({
    ...base,
    snapshot: runtimeSnapshot,
    start: () => serializeRuntimeOperation(async () => {
      try {
        const active = await profiles.getActive();
        if (!active || !runtimeSupervisor) throw new Error('Select a workspace profile before starting the local runtime');
        const registry = registryFor(active.id);
        // A registry file can predate this process or be manually modified.
        // Reapply canonical active-profile containment immediately before spawn,
        // then persist the canonical form that the child will load.
        await registry.save(await validateRegistryForProfile(await registry.load(), active));
        await runtimeSupervisor.start(active, registryPathFor(active.id));
        await restoreTunnelForActiveRuntime();
        return publishCurrentSnapshot();
      } catch (error) {
        await publishSnapshotAfterFailure();
        throw error;
      }
    }),
    stop: () => serializeRuntimeOperation(async () => {
      try {
        // The public route is withdrawn before the local process can exit.
        await tunnelSupervisor?.stop?.();
        await runtimeSupervisor?.stop?.();
        return publishCurrentSnapshot();
      } catch (error) {
        await publishSnapshotAfterFailure();
        throw error;
      }
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
      try {
        // One local child belongs to one profile. Stop before changing the
        // canonical roots that the next start can pass to the child.
        await tunnelSupervisor?.stop?.();
        await runtimeSupervisor?.stop?.();
        const selected = await profiles.setActive(id);
        await publishCurrentSnapshot();
        return selected;
      } catch (error) {
        await publishSnapshotAfterFailure();
        throw error;
      }
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
      try {
        const active = await profiles.getActive();
        if (!active) throw new Error('Select a workspace profile before saving an MCP registry');
        // Save only a fully validated registry. A runtime reload is deliberately
        // sequenced after the atomic write so it can never run a rejected draft.
        await registryFor(active.id).save(await validateRegistryForProfile(draft, active));
        await tunnelSupervisor?.stop?.();
        await runtimeSupervisor?.restart?.(active, registryPathFor(active.id));
        await restoreTunnelForActiveRuntime();
        return publishCurrentSnapshot();
      } catch (error) {
        await publishSnapshotAfterFailure();
        throw error;
      }
    }),
    setupTunnel: (setup) => serializeRuntimeOperation(async () => {
      if (!tunnelSupervisor || !connectorIdentity?.configure || !connectorIdentity?.credentials) {
        throw new Error('OpenAI Tunnel setup is unavailable');
      }
      const previousCredentials = connectorIdentity.credentials();
      const runtimeUrl = requireActiveRuntimeUrlForTunnel();
      try {
        // Pair with transient credentials first. They are persisted only after
        // the Tunnel is healthy for the currently owned loopback runtime.
        await tunnelSupervisor.configure(setup);
        await tunnelSupervisor.restoreOrConnect({ runtimeUrl, connectorName: connectorIdentity.name() });
        await connectorIdentity.configure(setup);
        return publishCurrentSnapshot();
      } catch (error) {
        try {
          if (previousCredentials) {
            await tunnelSupervisor.configure(previousCredentials);
            await restoreTunnelForActiveRuntime();
          } else {
            await tunnelSupervisor.discardConfiguration?.();
          }
        } catch {
          // Keep the original pairing failure; both supervisor snapshots stay
          // credential-free and allow a later explicit recovery attempt.
        }
        await publishSnapshotAfterFailure();
        throw error;
      }
    }),
    cancelTask: async (taskId) => {
      if (!client) throw new Error('Local runtime activity is unavailable');
      await client.cancel(taskId);
      return runtimeSnapshot();
    },
    doctor: async () => runDoctor({
      runtimeStatus: () => runtimeSupervisor?.status?.(),
      getActiveProfile: () => profiles.getActive(),
      tunnelStatus: () => tunnelSupervisor?.status?.(),
      connectorSnapshot: () => connectorIdentity?.snapshot?.(),
      tunnelAvailable,
      coreAssetsAvailable: await resolveCoreAssetsAvailable(coreAssetsAvailable),
    }),
    openLogs: () => openDiagnosticLogs(diagnosticLogDirectory ?? path.join(userDataPath, 'logs'), shell),
  });
}

async function resolveCoreAssetsAvailable(value) {
  if (typeof value === 'function') {
    try {
      return await value();
    } catch {
      return false;
    }
  }
  return value;
}

/** Redact and byte-bound runtime activity before it can cross Electron IPC. */
function createActivityPublisher(getTrustedWebContents, maximumBytes = 4_096) {
  if (typeof getTrustedWebContents !== 'function') throw new TypeError('Activity publisher requires trusted web contents');
  return (entry) => {
    const safeEntry = redactTunnelLog(typeof entry === 'string' ? entry : 'Invalid runtime activity entry', maximumBytes);
    const webContents = getTrustedWebContents();
    if (webContents && typeof webContents.send === 'function' && !webContents.isDestroyed?.()) {
      webContents.send('launcher:log', safeEntry);
    }
    return safeEntry;
  };
}

/**
 * Send only a structured, redacted lifecycle snapshot to the trusted renderer.
 * This second boundary keeps credentials out of snapshots even if a future
 * controller accidentally includes an extra field.
 */
function createSnapshotPublisher(getTrustedWebContents, maximumBytes = 4_096) {
  if (typeof getTrustedWebContents !== 'function') throw new TypeError('Snapshot publisher requires trusted web contents');
  return (snapshot) => {
    const safeSnapshot = sanitizeLauncherSnapshot(snapshot, maximumBytes);
    const webContents = getTrustedWebContents();
    if (webContents && typeof webContents.send === 'function' && !webContents.isDestroyed?.()) {
      webContents.send('launcher:snapshot-changed', safeSnapshot);
    }
    return safeSnapshot;
  };
}

function sanitizeLauncherSnapshot(snapshot, maximumBytes) {
  const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const safe = {
    state: RUNTIME_STATES.has(source.state) ? source.state : 'error',
    workspace: typeof source.workspace === 'string' ? redactTunnelLog(source.workspace, maximumBytes) : null,
  };
  if (typeof source.message === 'string') safe.message = redactTunnelLog(source.message, maximumBytes);
  if (TUNNEL_STATES.has(source.tunnelState)) safe.tunnelState = source.tunnelState;
  if (typeof source.tunnelConfigured === 'boolean') safe.tunnelConfigured = source.tunnelConfigured;
  if (typeof source.paired === 'boolean') safe.paired = source.paired;
  if (typeof source.connectorName === 'string') safe.connectorName = redactTunnelLog(source.connectorName, maximumBytes);
  if (typeof source.tunnelMessage === 'string') safe.tunnelMessage = redactTunnelLog(source.tunnelMessage, maximumBytes);
  return Object.freeze(safe);
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

/**
 * Electron cannot await an async `before-quit` listener itself. Prevent the
 * first quit, stop our public route and local child in order, then reissue quit
 * only after both have confirmed completion. This applies on every platform.
 */
function installQuitGuard(app, getRuntimeSupervisor, getTunnelSupervisor) {
  if (!app || typeof app.on !== 'function' || typeof app.quit !== 'function' ||
      typeof getRuntimeSupervisor !== 'function' || typeof getTunnelSupervisor !== 'function') {
    throw new TypeError('Quit guard requires Electron app and supervisor accessors');
  }
  let shutdownInProgress = false;
  let shutdownComplete = false;
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event?.preventDefault?.();
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    void stopRuntimeBeforeQuit(
      getRuntimeSupervisor(),
      () => {
        shutdownComplete = true;
        app.quit();
      },
      getTunnelSupervisor(),
    ).then((stopped) => {
      if (!stopped) shutdownInProgress = false;
    }).catch(() => {
      shutdownInProgress = false;
    });
  });
}

function boot() {
  const electron = require('electron');
  const { app, ipcMain } = electron;
  if (process.argv.includes('--smoke-diagnostics')) {
    bootDiagnosticMode(electron);
    return;
  }
  let mainWindow;
  let runtimeSupervisor;
  let tunnelSupervisor;
  app.whenReady().then(async () => {
    mainWindow = createMainWindow(electron);
    const userDataPath = app.getPath('userData');
    const runtimeEntry = runtimeEntryForApp(app);
    runtimeSupervisor = createRuntimeSupervisor({
      appDataPath: userDataPath,
      runtimeEntry,
    });
    const connectorIdentity = await createConnectorIdentity(path.join(userDataPath, 'connector.json'));
    const tunnelAdapter = createUnavailableTunnelAdapter();
    tunnelSupervisor = createTunnelSupervisor({
      getActiveRuntimeUrl: () => runtimeSupervisor?.getActiveRuntimeUrl?.(),
      ...tunnelAdapter,
    });
    const runtimeClient = new RuntimeClient(runtimeSupervisor);
    const publishActivity = createActivityPublisher(() => mainWindow?.webContents);
    const publishSnapshot = createSnapshotPublisher(() => mainWindow?.webContents);
    const controller = await createProfileController({
      userDataPath,
      shell: electron.shell,
      runtimeSupervisor,
      runtimeClient,
      publishActivity,
      publishSnapshot,
      tunnelSupervisor,
      connectorIdentity,
      coreAssetsAvailable: () => isReadableFile(runtimeEntry),
      diagnosticLogDirectory: path.join(userDataPath, 'logs'),
    });
    registerIpcHandlers(ipcMain, controller, () => mainWindow?.webContents);
    app.on('activate', () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(electron);
      }
    });
  });
  installQuitGuard(app, () => runtimeSupervisor, () => tunnelSupervisor);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      // Calling app.quit enters the guarded before-quit flow on every platform.
      app.quit();
    }
  });
}

function runtimeEntryForApp(app) {
  return app?.isPackaged === true
    ? path.join(process.resourcesPath, 'core', 'index.js')
    : path.join(__dirname, '..', '..', 'dist', 'index.js');
}

async function isReadableFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => undefined);
  return stat?.isFile() === true;
}

function bootDiagnosticMode(electron) {
  const { app } = electron;
  app.whenReady().then(async () => {
    const runtimeEntry = runtimeEntryForApp(app);
    await verifyCoreRuntimeLoadability(runtimeEntry);
    const report = await runDoctor({
      coreAssetsAvailable: await isReadableFile(runtimeEntry),
      tunnelAvailable: false,
    });
    // The smoke harness receives only this fixed-shape, redaction-safe report.
    process.stdout.write(`${JSON.stringify(report)}\n`);
    app.exit(0);
  }).catch(() => app.exit(1));
}

/**
 * Load the packaged ESM runtime graph without starting the connector. The
 * --help path imports all runtime dependencies but exits before configuration
 * or network startup. NODE_PATH is removed to prevent ambient repo modules
 * from masking an incomplete resources/core/node_modules directory.
 */
function verifyCoreRuntimeLoadability(runtimeEntry, options = {}) {
  if (typeof runtimeEntry !== 'string' || !path.isAbsolute(runtimeEntry)) {
    return Promise.reject(new TypeError('Core runtime entrypoint must be an absolute path'));
  }
  const executable = options.executable ?? process.execPath;
  const spawn = options.spawn ?? spawnChild;
  const environment = { ...(options.environment ?? process.env), ELECTRON_RUN_AS_NODE: '1' };
  for (const name of ['NODE_PATH', 'CODEX_CONNECTOR_TOKEN', 'OPENAI_API_KEY', 'OPENAI_API_TOKEN']) delete environment[name];

  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Packaged core runtime could not be loaded.'));
    let child;
    try {
      child = spawn(executable, [runtimeEntry, '--help'], {
        cwd: path.dirname(runtimeEntry),
        env: environment,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      fail();
      return;
    }
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else fail();
    });
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
  createSnapshotPublisher,
  bootDiagnosticMode,
  installQuitGuard,
  isAllowedExternalUrl,
  rendererEntryUrl,
  runtimeEntryForApp,
  verifyCoreRuntimeLoadability,
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
