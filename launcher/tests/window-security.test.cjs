const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMainWindow,
  createActivityPublisher,
  createSnapshotPublisher,
  installQuitGuard,
  isAllowedExternalUrl,
  registerIpcHandlers,
  rendererEntryUrl,
  stopRuntimeBeforeQuit,
  windowOptions,
} = require('../electron/main.cjs');

test('redacts and byte-bounds activity in the main process before renderer IPC', () => {
  const sent = [];
  const publish = createActivityPublisher(() => ({ send: (channel, entry) => sent.push([channel, entry]) }), 128);

  publish(`runtime_key=private-runtime-key {"access_token":"private","client_secret":"hidden"} ${'界'.repeat(8_000)}`);

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'launcher:log');
  assert.equal(Buffer.byteLength(sent[0][1], 'utf8') <= 128, true);
  assert.match(sent[0][1], /\[REDACTED\]/);
  assert.equal(sent[0][1].includes('private') || sent[0][1].includes('hidden'), false);
  assert.equal(sent[0][1].includes('private-runtime-key'), false);
});

test('redacts and sends lifecycle snapshots only through the snapshot IPC channel', () => {
  const sent = [];
  const publish = createSnapshotPublisher(() => ({ send: (channel, snapshot) => sent.push([channel, snapshot]) }), 128);

  publish({
    state: 'error',
    workspace: 'C:\\workspace',
    message: 'runtime_key=private-runtime-key',
    tunnelState: 'error',
    tunnelConfigured: true,
    paired: true,
    connectorName: 'GPT Web Codex',
    tunnelMessage: 'key=private-runtime-key',
    runtimeKey: 'private-runtime-key',
  });

  assert.deepEqual(sent, [[
    'launcher:snapshot-changed',
    {
      state: 'error',
      workspace: 'C:\\workspace',
      message: 'runtime_key=[REDACTED]',
      tunnelState: 'error',
      tunnelConfigured: true,
      paired: true,
      connectorName: 'GPT Web Codex',
      tunnelMessage: 'key=[REDACTED]',
    },
  ]]);
  assert.equal(JSON.stringify(sent).includes('private-runtime-key'), false);
});

test('window has isolated renderer preferences', () => {
  assert.deepEqual(windowOptions.webPreferences, {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    preload: windowOptions.webPreferences.preload,
  });
});

test('main process permits only the explicit documentation allowlist', () => {
  assert.equal(isAllowedExternalUrl('https://platform.openai.com/docs'), true);
  assert.equal(isAllowedExternalUrl('https://evil.example/docs'), false);
  assert.equal(isAllowedExternalUrl('file:///C:/secrets.txt'), false);
});

test('does not quit Electron when the owned runtime cannot stop', async () => {
  let quitCalls = 0;
  const stopped = await stopRuntimeBeforeQuit(
    { stop: async () => { throw new Error('runtime stop failed'); } },
    () => { quitCalls += 1; },
  );

  assert.equal(stopped, false);
  assert.equal(quitCalls, 0);
});

test('stops the owned tunnel before the runtime during Electron shutdown', async () => {
  const calls = [];
  const stopped = await stopRuntimeBeforeQuit(
    { stop: async () => { calls.push('runtime-stop'); } },
    () => { calls.push('quit'); },
    { stop: async () => { calls.push('tunnel-stop'); } },
  );

  assert.equal(stopped, true);
  assert.deepEqual(calls, ['tunnel-stop', 'runtime-stop', 'quit']);
});

test('guards every Electron quit until tunnel then runtime shutdown succeeds', async () => {
  const handlers = new Map();
  const calls = [];
  let prevented = 0;
  const app = {
    on: (name, listener) => handlers.set(name, listener),
    quit: () => {
      calls.push('quit');
      handlers.get('before-quit')({ preventDefault: () => { prevented += 1; } });
    },
  };
  installQuitGuard(app, () => ({ stop: async () => { calls.push('runtime-stop'); } }), () => ({ stop: async () => { calls.push('tunnel-stop'); } }));

  handlers.get('before-quit')({ preventDefault: () => { prevented += 1; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, 1);
  assert.deepEqual(calls, ['tunnel-stop', 'runtime-stop', 'quit']);
});

test('keeps Electron open after a guarded shutdown failure', async () => {
  const handlers = new Map();
  let quitCalls = 0;
  let prevented = 0;
  const app = {
    on: (name, listener) => handlers.set(name, listener),
    quit: () => { quitCalls += 1; },
  };
  installQuitGuard(app, () => ({ stop: async () => { throw new Error('runtime stop failed'); } }), () => ({ stop: async () => undefined }));

  handlers.get('before-quit')({ preventDefault: () => { prevented += 1; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, 1);
  assert.equal(quitCalls, 0);
});

test('IPC rejects a sender other than the current launcher renderer', () => {
  const handlers = new Map();
  const trustedSender = { getURL: () => rendererEntryUrl };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  let started = false;

  registerIpcHandlers(ipcMain, { start: () => { started = true; } }, () => trustedSender);

  assert.throws(
    () => handlers.get('launcher:start')({ sender: { getURL: () => rendererEntryUrl } }),
    /untrusted renderer/,
  );
  assert.equal(started, false);
});

test('IPC validates bounded Skill, registry, and task payloads before controllers run', () => {
  const handlers = new Map();
  const sender = { getURL: () => rendererEntryUrl };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const controller = {
    saveSkills: () => { throw new Error('controller should not receive invalid Skills'); },
    saveMcpRegistry: () => { throw new Error('controller should not receive invalid registry'); },
    cancelTask: () => { throw new Error('controller should not receive invalid task'); },
  };

  registerIpcHandlers(ipcMain, controller, () => sender);

  assert.throws(() => handlers.get('launcher:save-skills')({ sender }, ['valid', '../escape']), /Skill IDs/);
  assert.throws(() => handlers.get('launcher:save-mcp-registry')({ sender }, {
    servers: [{ id: 'local', command: 'node', args: ['C:\\trusted\\server.cjs'], allowedTools: ['*'], timeoutMs: 5000 }],
  }), /allowedTools/);
  assert.throws(() => handlers.get('launcher:cancel-task')({ sender }, 'task\nnext'), /task ID/);
});

test('setup IPC passes credentials only to the main-process setup operation', async () => {
  const handlers = new Map();
  const sender = { getURL: () => rendererEntryUrl };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const credentials = {
    tunnelId: `tunnel_${'a'.repeat(32)}`,
    runtimeKey: 'runtime-key-which-must-remain-private',
  };
  let received;
  registerIpcHandlers(ipcMain, {
    setupTunnel: async (input) => {
      received = input;
      return { state: 'running', tunnelConfigured: true, paired: true };
    },
  }, () => sender);

  const result = await handlers.get('launcher:setup-tunnel')({ sender }, credentials);

  assert.deepEqual(received, credentials);
  assert.deepEqual(result, { state: 'running', tunnelConfigured: true, paired: true });
  assert.equal(JSON.stringify(result).includes(credentials.runtimeKey), false);
  assert.throws(
    () => handlers.get('launcher:setup-tunnel')({ sender }, { ...credentials, unexpected: true }),
    /setup/i,
  );
});

test('window prevents navigation, denies popups, and denies permission requests', async () => {
  const events = new Map();
  let popupHandler;
  let permissionHandler;
  const externalUrls = [];
  const window = {
    webContents: {
      on: (name, listener) => events.set(name, listener),
      setWindowOpenHandler: (listener) => { popupHandler = listener; },
      session: { setPermissionRequestHandler: (listener) => { permissionHandler = listener; } },
    },
    once: () => {},
    loadFile: async () => {},
    show: () => {},
  };

  createMainWindow({
    BrowserWindow: function BrowserWindow() { return window; },
    shell: { openExternal: async (url) => { externalUrls.push(url); } },
  });

  let prevented = false;
  events.get('will-navigate')({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(popupHandler({ url: 'https://evil.example' }), { action: 'deny' });
  assert.deepEqual(popupHandler({ url: 'https://platform.openai.com/docs' }), { action: 'deny' });
  await Promise.resolve();
  assert.deepEqual(externalUrls, ['https://platform.openai.com/docs']);
  permissionHandler(null, 'notifications', (granted) => assert.equal(granted, false));
});
