'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn: spawnChild } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { MAX_ENABLED_SKILLS, createProfileStore, resolveProfileRoots, validateProfile } = require('./profiles.cjs');
const { createRegistryStore, validateRegistryDraft, validateRegistryForProfile } = require('./registry.cjs');
const { createMcpCredentialStore } = require('./mcp-credentials.cjs');
const { RuntimeClient } = require('./runtime-client.cjs');
const { createRuntimeSupervisor } = require('./runtime-supervisor.cjs');
const { createConnectorIdentity, validateTunnelSetup } = require('./connector-identity.cjs');
const { openSkillFolder, saveSkillDefaults, scanSkills } = require('./skills.cjs');
const { createTunnelSupervisor, redactTunnelLog } = require('./tunnel-supervisor.cjs');
const { createPackagedTunnelAdapter, DEFAULT_HEALTH_PORT } = require('./tunnel-client.cjs');
const { resolveProxy } = require('./proxy-service.cjs');
const { createMemoryStore, validateMemoryEntry } = require('./memory-store.cjs');
const { doctor: runDoctor, openDiagnosticLogs } = require('./doctor.cjs');
const { createLauncherState, validatePreferences } = require('./launcher-state.cjs');

const preload = path.join(__dirname, 'preload.cjs');
const rendererEntry = path.join(__dirname, '..', 'dist', 'index.html');
const rendererEntryUrl = pathToFileURL(rendererEntry).href;
const ALLOWED_EXTERNAL_ORIGINS = new Set(['https://platform.openai.com']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TUNNEL_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);
const RUNTIME_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);
const TUNNEL_HEALTH_PORT = DEFAULT_HEALTH_PORT;

const windowOptions = Object.freeze({
  width: 1180,
  height: 800,
  minWidth: 900,
  minHeight: 640,
  show: false,
  backgroundColor: '#101827',
  icon: path.join(__dirname, 'app-icon.ico'),
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
    listMcpRegistry: async () => ({ servers: [] }),
    listMcpCredentials: async () => [],
    saveMcpCredential: async () => ({ configured: true }),
    removeMcpCredential: async () => true,
    discoverMcpTools: async () => [],
    listMemory: async () => [],
    saveMemory: async () => undefined,
    removeMemory: async () => false,
    setupTunnel: async () => snapshot,
    task: async () => { throw new Error('Local runtime activity is unavailable'); },
    cancelTask: async () => snapshot,
    doctor: () => runDoctor(),
    openLogs: async () => undefined,
    logs: async () => [],
    closeManager: async () => true,
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
  managerWindow,
  coreAssetsAvailable,
  tunnelAvailable = false,
  diagnosticLogDirectory,
  setLoginItemSettings,
  onPreferencesChanged,
  dialog,
  proxyResolver = async () => ({ mode: 'auto', source: 'auto-direct', reachable: true, configured: false }),
}) {
  const profiles = await createProfileStore(path.join(userDataPath, 'profiles.json'));
  const launcherState = createLauncherState(path.join(userDataPath, 'launcher-state.json'));
  const memoryStore = createMemoryStore(path.join(userDataPath, 'memory.json'));
  const base = createDefaultController();
  const registries = new Map();
  const mcpCredentials = createMcpCredentialStore(path.join(userDataPath, 'mcp-credentials.json'));
  const client = runtimeClient ?? (typeof runtimeSupervisor?.call === 'function' ? new RuntimeClient(runtimeSupervisor) : undefined);
  let runtimeOperationQueue = Promise.resolve();
  let proxyResolution = Object.freeze({ mode: 'auto', source: 'not-detected', reachable: false, configured: false });

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
  function mcpCredentialsPath() {
    return path.join(userDataPath, 'mcp-credentials.json');
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
    const snapshot = client ? await client.snapshot() : await base.snapshot();
    const runtime = {
      state: snapshot.state,
      workspace: snapshot.workspace ?? null,
      ...(snapshot.message ? { message: snapshot.message } : {}),
      ...tunnelSnapshot(),
      proxy: {
        mode: proxyResolution.mode,
        source: proxyResolution.source,
        reachable: proxyResolution.reachable,
        configured: proxyResolution.configured,
      },
    };
    const activeProfile = await profiles.getActive();
    const [savedProfiles, preferences, doctor, mcpRegistry] = await Promise.all([
      profiles.list(),
      launcherState.preferences.read(),
      createDoctorReport(),
      activeProfile ? registryFor(activeProfile.id).load() : { servers: [] },
    ]);
    return {
      ...runtime,
      preferences,
      guide: guideStateFrom({
        snapshot: runtime,
        profiles: savedProfiles,
        skills: activeProfile?.enabledSkillIds ?? [],
        mcpRegistry,
        doctor,
      }),
    };
  }

  async function createDoctorReport() {
    return runDoctor({
      runtimeStatus: () => runtimeSupervisor?.status?.(),
      getActiveProfile: () => profiles.getActive(),
      tunnelStatus: () => tunnelSupervisor?.status?.(),
      connectorSnapshot: () => connectorIdentity?.snapshot?.(),
      tunnelAvailable,
      coreAssetsAvailable: await resolveCoreAssetsAvailable(coreAssetsAvailable),
    });
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
    const request = { runtimeUrl, connectorName: connectorIdentity.name() };
    if (typeof runtimeSupervisor.getActiveRuntimeToken === 'function') {
      request.healthPort = TUNNEL_HEALTH_PORT;
      const mcpToken = runtimeSupervisor.getActiveRuntimeToken();
      if (mcpToken) request.mcpToken = mcpToken;
    }
    if (proxyResolution.configured && proxyResolution.proxyUrl) request.proxyUrl = proxyResolution.proxyUrl;
    await tunnelSupervisor.restoreOrConnect(request);
  }

  async function resolveEffectiveProxy(force = false) {
    const preferences = await launcherState.preferences.read();
    const result = await proxyResolver(preferences, { force });
    proxyResolution = Object.freeze({
      mode: result.mode,
      source: result.source,
      reachable: result.reachable === true,
      configured: result.configured === true,
      ...(result.proxyUrl ? { proxyUrl: result.proxyUrl } : {}),
    });
    if (preferences.proxyMode === 'manual' && proxyResolution.reachable !== true) {
      throw new Error('Configured manual proxy is unreachable');
    }
    return proxyResolution.configured ? proxyResolution.proxyUrl : undefined;
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
        await runtimeSupervisor.start(active, registryPathFor(active.id), mcpCredentialsPath());
        await resolveEffectiveProxy(true);
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
    selectWorkspace: async () => {
      if (!dialog?.showOpenDialog) return runtimeSnapshot();
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths?.[0]) return runtimeSnapshot();
      const workspaceRoot = path.resolve(result.filePaths[0]);
      const profileId = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'workspace';
      const existing = await profiles.get(profileId);
      const profile = existing ?? { id: profileId, workspaceRoot, skillsRoot: path.join(workspaceRoot, '.codex', 'skills'), enabledSkillIds: [] };
      if (!existing) await saveSkillDefaults(profile, []);
      await profiles.save(profile);
      await profiles.setActive(profile.id);
      return runtimeSnapshot();
    },
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
      return publishCurrentSnapshot();
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
        await runtimeSupervisor?.restart?.(active, registryPathFor(active.id), mcpCredentialsPath());
        await resolveEffectiveProxy(true);
        await restoreTunnelForActiveRuntime();
        return publishCurrentSnapshot();
      } catch (error) {
        await publishSnapshotAfterFailure();
        throw error;
      }
    }),
    listMcpRegistry: async () => {
      const active = await profiles.getActive();
      return active ? registryFor(active.id).load() : { servers: [] };
    },
    listMcpCredentials: () => mcpCredentials.list(),
    saveMcpCredential: async (value) => {
      const active = await profiles.getActive();
      const server = active ? (await registryFor(active.id).load()).servers.find((item) => item.id === value?.serverId) : undefined;
      if (!server || server.transport !== 'streamable-http') throw new Error('MCP credentials require a configured HTTP MCP server');
      return mcpCredentials.save(value);
    },
    removeMcpCredential: (serverId) => mcpCredentials.remove(serverId),
    discoverMcpTools: async (serverId) => {
      if (!client?.mcpTools) throw new Error('Start the local runtime before discovering MCP tools');
      try {
        await waitForRuntimeReady(runtimeSupervisor);
        const tools = await client.mcpTools(serverId);
        publishActivity?.(`MCP ${serverId} discovery succeeded`);
        return tools;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        publishActivity?.(`MCP ${serverId} discovery failed: ${redactTunnelLog(detail)}`);
        throw error;
      }
    },
    listMemory: () => memoryStore.list(),
    saveMemory: (draft) => memoryStore.add(validateMemoryEntry(draft)),
    removeMemory: (id) => memoryStore.remove(id),
    setupTunnel: (setup) => serializeRuntimeOperation(async () => {
      if (!tunnelSupervisor || !connectorIdentity?.configure || !connectorIdentity?.credentials) {
        throw new Error('OpenAI Tunnel setup is unavailable');
      }
      const previousCredentials = connectorIdentity.credentials();
      const runtimeUrl = requireActiveRuntimeUrlForTunnel();
      try {
        await resolveEffectiveProxy(true);
        // Pair with transient credentials first. They are persisted only after
        // the Tunnel is healthy for the currently owned loopback runtime.
        await tunnelSupervisor.configure(setup);
        const request = { runtimeUrl, connectorName: connectorIdentity.name() };
        if (typeof runtimeSupervisor.getActiveRuntimeToken === 'function') {
          request.healthPort = TUNNEL_HEALTH_PORT;
          const mcpToken = runtimeSupervisor.getActiveRuntimeToken();
          if (mcpToken) request.mcpToken = mcpToken;
        }
        if (proxyResolution.configured && proxyResolution.proxyUrl) request.proxyUrl = proxyResolution.proxyUrl;
        await tunnelSupervisor.restoreOrConnect(request);
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
    task: async (taskId) => {
      if (!client) throw new Error('Local runtime activity is unavailable');
      return client.task(taskId);
    },
    logs: async () => client?.logs?.() ?? [],
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
    preferences: () => launcherState.preferences.read(),
    savePreferences: async (preferences) => {
      const validated = validatePreferences(preferences);
      const saved = await launcherState.preferences.write(validated);
      if (typeof setLoginItemSettings === 'function') {
        await setLoginItemSettings(saved.startAtLogin === true);
      }
      await onPreferencesChanged?.(saved);
      return saved;
    },
    openLogs: () => openDiagnosticLogs(diagnosticLogDirectory ?? path.join(userDataPath, 'logs'), shell),
    closeManager: async () => {
      managerWindow?.hide?.();
      return true;
    },
  });
}

async function waitForRuntimeReady(runtimeSupervisor, timeoutMs = 15_000) {
  if (typeof runtimeSupervisor?.status !== 'function') return;
  const startedAt = Date.now();
  while (true) {
    const current = runtimeSupervisor.status();
    if (current?.state === 'running') return;
    if (current?.state === 'error') throw new Error(current.message || '本地运行时启动失败');
    if (Date.now() - startedAt >= timeoutMs) throw new Error('本地运行时仍在启动，请稍后重试');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  if (source.preferences) {
    try { safe.preferences = validatePreferences(source.preferences); } catch { /* omit invalid state */ }
  }
  if (Array.isArray(source.guide)) {
    safe.guide = source.guide.filter((step) => step && Number.isInteger(step.id) &&
      [1, 2, 3, 4, 5].includes(step.id) && ['complete', 'needs-action', 'unavailable'].includes(step.status) &&
      typeof step.messageKey === 'string').map((step) => Object.freeze({
      id: step.id, status: step.status, messageKey: step.messageKey,
    }));
  }
  return Object.freeze(safe);
}

function guideStateFrom({ snapshot = {}, profiles = [], skills = [], mcpRegistry = {}, doctor = {} } = {}) {
  const hasProfile = Array.isArray(profiles) && profiles.length > 0;
  const tunnelCheck = Array.isArray(doctor.checks) ? doctor.checks.find((check) => check?.id === 'tunnel') : undefined;
  const tunnelUnavailable = tunnelCheck?.message === 'OpenAI Tunnel client is unavailable in this launcher build.';
  const hasSkillDefaults = Array.isArray(skills) && skills.length > 0;
  const hasMcpServers = Array.isArray(mcpRegistry?.servers) && mcpRegistry.servers.length > 0;
  const paired = snapshot.paired === true;
  return [
    { id: 1, status: hasProfile ? 'complete' : 'needs-action', messageKey: hasProfile ? 'guide.profile.ready' : 'guide.profile.required' },
    { id: 2, status: hasSkillDefaults || hasMcpServers ? 'complete' : 'needs-action', messageKey: hasSkillDefaults || hasMcpServers ? 'guide.skills.ready' : 'guide.skills.required' },
    { id: 3, status: tunnelUnavailable ? 'unavailable' : (paired ? 'complete' : 'needs-action'), messageKey: tunnelUnavailable ? 'guide.tunnel.unavailable' : (paired ? 'guide.tunnel.paired' : 'guide.tunnel.required') },
    { id: 4, status: 'needs-action', messageKey: 'guide.chatgpt.required' },
    { id: 5, status: snapshot.state === 'running' && paired ? 'complete' : 'needs-action', messageKey: snapshot.state === 'running' && paired ? 'guide.runtime.ready' : 'guide.runtime.required' },
  ].map((step) => Object.freeze(step));
}

function rejectUntrustedSender(event, getTrustedWebContents) {
  const trustedWebContents = getTrustedWebContents();
  if (!event || event.sender !== trustedWebContents || !isRendererEntryUrl(event.sender.getURL?.())) {
    throw new Error('IPC request rejected from untrusted renderer');
  }
}

function isRendererEntryUrl(value) {
  try {
    const expected = new URL(rendererEntryUrl);
    const actual = new URL(String(value || ''));
    if (expected.protocol !== 'file:' || actual.protocol !== 'file:') return false;
    return decodeURIComponent(actual.pathname).toLowerCase() === decodeURIComponent(expected.pathname).toLowerCase();
  } catch {
    return false;
  }
}

function requireNoPayload(args, operation) {
  if (args.length !== 0) {
    throw new TypeError(`${operation} does not accept a payload`);
  }
}

function validateSkillIds(skillIds) {
  if (!Array.isArray(skillIds) || skillIds.length > MAX_ENABLED_SKILLS ||
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

function validateMemoryId(memoryId) {
  if (typeof memoryId !== 'string' || !/^[a-f0-9-]{36}$/i.test(memoryId)) {
    throw new TypeError('memory ID must be a UUID');
  }
  return memoryId;
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
    'launcher:list-mcp-registry': guarded((args) => { requireNoPayload(args, 'listMcpRegistry'); return controller.listMcpRegistry(); }),
    'launcher:list-mcp-credentials': guarded((args) => { requireNoPayload(args, 'listMcpCredentials'); return controller.listMcpCredentials(); }),
    'launcher:save-mcp-credential': guarded((args) => {
      if (args.length !== 1 || !args[0] || typeof args[0] !== 'object') throw new TypeError('saveMcpCredential requires one payload');
      return controller.saveMcpCredential({ serverId: String(args[0].serverId || ''), token: String(args[0].token || '') });
    }),
    'launcher:remove-mcp-credential': guarded((args) => {
      if (args.length !== 1) throw new TypeError('removeMcpCredential requires one server ID');
      return controller.removeMcpCredential(String(args[0]));
    }),
    'launcher:discover-mcp-tools': guarded((args) => {
      if (args.length !== 1) throw new TypeError('discoverMcpTools requires one server ID');
      return controller.discoverMcpTools(validateProfileId(args[0]));
    }),
    'launcher:list-memory': guarded((args) => { requireNoPayload(args, 'listMemory'); return controller.listMemory(); }),
    'launcher:save-memory': guarded((args) => {
      if (args.length !== 1) throw new TypeError('saveMemory requires one payload');
      return controller.saveMemory(validateMemoryEntry(args[0]));
    }),
    'launcher:remove-memory': guarded((args) => {
      if (args.length !== 1) throw new TypeError('removeMemory requires one payload');
      return controller.removeMemory(validateMemoryId(args[0]));
    }),
    'launcher:setup-tunnel': guarded((args) => {
      if (args.length !== 1) throw new TypeError('setupTunnel requires one payload');
      return controller.setupTunnel(validateTunnelSetupDraft(args[0]));
    }),
    'launcher:task': guarded((args) => {
      if (args.length !== 1) throw new TypeError('task requires one payload');
      return controller.task(validateTaskId(args[0]));
    }),
    'launcher:cancel-task': guarded((args) => {
      if (args.length !== 1) throw new TypeError('cancelTask requires one payload');
      return controller.cancelTask(validateTaskId(args[0]));
    }),
    'launcher:doctor': guarded((args) => { requireNoPayload(args, 'doctor'); return controller.doctor(); }),
    'launcher:open-logs': guarded((args) => { requireNoPayload(args, 'openLogs'); return controller.openLogs(); }),
    'launcher:logs': guarded((args) => { requireNoPayload(args, 'logs'); return controller.logs(); }),
    'launcher:close-manager': guarded((args) => { requireNoPayload(args, 'closeManager'); return controller.closeManager(); }),
    'launcher:preferences': guarded((args) => { requireNoPayload(args, 'preferences'); return controller.preferences(); }),
    'launcher:save-preferences': guarded((args) => {
      if (args.length !== 1) throw new TypeError('savePreferences requires one payload');
      return controller.savePreferences(validatePreferences(args[0]));
    }),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
}

function createMainWindow(electron, options = {}) {
  const { BrowserWindow, shell } = electron;
  const window = new BrowserWindow(windowOptions);
  window.removeMenu?.();

  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  if (options.showOnReady !== false) window.once('ready-to-show', () => window.show());
  window.on?.('close', (event) => {
    if (options.forceQuit?.()) return;
    event.preventDefault();
    window.hide();
  });
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
  let tray;
  let keepRunningOnClose = true;
  let forceQuit = false;
  if (!acquireSingleInstanceLock(app, () => mainWindow)) return;
  app.whenReady().then(async () => {
    mainWindow = createMainWindow(electron, { forceQuit: () => forceQuit });
    tray = createTray(
      electron,
      path.join(__dirname, 'app-icon.png'),
      () => { mainWindow?.show?.(); mainWindow?.focus?.(); },
      () => { forceQuit = true; app.quit(); },
    );
    const userDataPath = app.getPath('userData');
    const runtimeEntry = runtimeEntryForApp(app);
    runtimeSupervisor = createRuntimeSupervisor({
      appDataPath: userDataPath,
      runtimeEntry,
    });
    const connectorIdentity = await createConnectorIdentity(path.join(userDataPath, 'connector.json'));
    const tunnelAdapter = createPackagedTunnelAdapter({
      executablePath: tunnelExecutableForApp(app),
      logFile: path.join(userDataPath, 'logs', 'tunnel.log'),
    });
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
      dialog: electron.dialog,
      managerWindow: mainWindow,
      coreAssetsAvailable: () => isReadableFile(runtimeEntry),
      tunnelAvailable: await isReadableFile(tunnelExecutableForApp(app)),
      diagnosticLogDirectory: path.join(userDataPath, 'logs'),
      proxyResolver: resolveProxy,
      setLoginItemSettings: async (openAtLogin) => {
        if (typeof electron.app.setLoginItemSettings === 'function') {
          electron.app.setLoginItemSettings({ openAtLogin });
        }
      },
      onPreferencesChanged: (preferences) => { keepRunningOnClose = preferences.keepRunningOnClose === true; },
    });
    registerIpcHandlers(ipcMain, controller, () => mainWindow?.webContents);
    const initialPreferences = await controller.preferences().catch(() => ({ autoStartServices: true, keepRunningOnClose: true }));
    keepRunningOnClose = initialPreferences.keepRunningOnClose === true;
    if (initialPreferences.autoStartServices !== false) void controller.start().catch(() => undefined);
    app.on('activate', () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(electron, { forceQuit: () => forceQuit });
      }
    });
  });
  installQuitGuard(app, () => runtimeSupervisor, () => tunnelSupervisor);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      if (keepRunningOnClose) return;
      // Calling app.quit enters the guarded before-quit flow on every platform.
      app.quit();
    }
  });
}

function acquireSingleInstanceLock(app, getWindow) {
  if (!app || typeof app.requestSingleInstanceLock !== 'function') return true;
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    app.quit?.();
    return false;
  }
  app.on?.('second-instance', () => {
    const window = getWindow?.();
    if (!window || window.isDestroyed?.()) return;
    if (window.isMinimized?.()) window.restore?.();
    window.show?.();
    window.focus?.();
  });
  return true;
}

function createTray(electron, iconPath, showManager, quit) {
  const { Tray, Menu, nativeImage } = electron;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  const tray = new Tray(icon);
  tray.setToolTip('GPT Web Codex · 后台运行中');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开设置', click: () => showManager() },
    { type: 'separator' },
    { label: '退出 GPT Web Codex', click: () => quit() },
  ]));
  tray.on('click', () => showManager());
  tray.on('double-click', () => showManager());
  return tray;
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
      tunnelAvailable: await isReadableFile(tunnelExecutableForApp(app)),
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
function tunnelExecutableForApp(app) {
  return app?.isPackaged === true
    ? path.join(process.resourcesPath, 'tools', 'tunnel-client.exe')
    : path.join(__dirname, '..', 'resources', 'tools', 'tunnel-client.exe');
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
  tunnelExecutableForApp,
  verifyCoreRuntimeLoadability,
  registerIpcHandlers,
  validateMcpRegistryDraft,
  validateTunnelSetupDraft,
  validateProfileId,
  validateSkillIds,
  validateWorkspaceProfileDraft,
  validateTaskId,
  validateMemoryId,
  guideStateFrom,
  validatePreferences,
  stopRuntimeBeforeQuit,
  windowOptions,
  acquireSingleInstanceLock,
  createTray,
  isRendererEntryUrl,
};
