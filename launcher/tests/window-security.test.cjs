const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMainWindow,
  createActivityPublisher,
  isAllowedExternalUrl,
  registerIpcHandlers,
  rendererEntryUrl,
  windowOptions,
} = require('../electron/main.cjs');

test('redacts and byte-bounds activity in the main process before renderer IPC', () => {
  const sent = [];
  const publish = createActivityPublisher(() => ({ send: (channel, entry) => sent.push([channel, entry]) }), 128);

  publish(`{"access_token":"private","client_secret":"hidden"} ${'界'.repeat(8_000)}`);

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'launcher:log');
  assert.equal(Buffer.byteLength(sent[0][1], 'utf8') <= 128, true);
  assert.match(sent[0][1], /\[REDACTED\]/);
  assert.equal(sent[0][1].includes('private') || sent[0][1].includes('hidden'), false);
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
