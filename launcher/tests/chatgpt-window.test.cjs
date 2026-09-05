const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHATGPT_PARTITION,
  createChatGptWindowController,
  isAllowedChatGptUrl,
} = require('../electron/chatgpt-window.cjs');

function createDoubles({ deferredLoad = false } = {}) {
  const session = {
    fromPartitionCalls: [],
    clearStorageDataCalls: [],
    clearCacheCalls: 0,
    handlers: {},
    fromPartition(partition) {
      this.fromPartitionCalls.push(partition);
      return {
        setPermissionRequestHandler: (handler) => { session.handlers.permission = handler; },
        on: (name, handler) => { session.handlers[name] = handler; },
        clearStorageData: async (options) => { session.clearStorageDataCalls.push(options); },
        clearCache: async () => { session.clearCacheCalls += 1; },
      };
    },
  };
  const BrowserWindow = function BrowserWindow(options) {
    this.options = options;
    this.events = {};
    this.webContents = {
      events: {},
      loadCalls: [],
      on: (name, handler) => { this.webContents.events[name] = handler; },
      setWindowOpenHandler: (handler) => { this.popupAllowed = handler; },
      loadURL: (url) => {
        this.webContents.loadCalls.push(url);
        this.loadedURL = url;
        return deferredLoad ? new Promise(() => {}) : Promise.resolve();
      },
    };
    this.on = (name, handler) => { this.events[name] = handler; };
    this.isDestroyed = () => false;
    this.loadURL = async (url) => { this.loadedURL = url; };
    this.show = () => { this.shown = true; };
    this.focus = () => { this.focused = true; };
    this.close = () => { this.events.closed?.(); };
  };
  BrowserWindow.calls = [];
  const Original = BrowserWindow;
  const Wrapped = function Wrapped(options) {
    const window = new Original(options);
    BrowserWindow.calls.push(window);
    Wrapped.last = window;
    return window;
  };
  Wrapped.calls = BrowserWindow.calls;
  return { BrowserWindow: Wrapped, session };
}

test('opens ChatGPT in an isolated persistent session', async () => {
  const { BrowserWindow, session } = createDoubles();
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  await controller.open();
  assert.equal(session.fromPartitionCalls[0], CHATGPT_PARTITION);
  assert.equal(BrowserWindow.calls[0].options.webPreferences.nodeIntegration, false);
  assert.equal(BrowserWindow.calls[0].options.webPreferences.contextIsolation, true);
  assert.equal(BrowserWindow.calls[0].options.webPreferences.sandbox, true);
  assert.equal(BrowserWindow.calls[0].options.webPreferences.preload, undefined);
});

test('blocks untrusted navigation, permission, download and popup targets', async () => {
  const { BrowserWindow, session } = createDoubles();
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  await controller.open();
  const window = BrowserWindow.last;
  let prevented = false;
  window.webContents.events['will-navigate']({ preventDefault: () => { prevented = true; } }, 'https://evil.example/');
  assert.equal(prevented, true);
  assert.deepEqual(window.popupAllowed('https://evil.example/'), { action: 'deny' });
  let permissionResult;
  session.handlers.permission(null, 'notifications', (granted) => { permissionResult = granted; });
  assert.equal(permissionResult, false);
  let downloadPrevented = false;
  session.handlers['will-download']({}, { cancel: () => { downloadPrevented = true; } });
  assert.equal(downloadPrevented, true);
});

test('blocks untrusted server redirects and replays allowed redirects through the guard', async () => {
  const { BrowserWindow, session } = createDoubles();
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  await controller.open();
  const window = BrowserWindow.last;
  let prevented = false;
  window.webContents.events['will-redirect'](
    { preventDefault: () => { prevented = true; } },
    'https://evil.example/redirect',
  );
  assert.equal(prevented, true);
  assert.deepEqual(window.webContents.loadCalls, []);

  window.webContents.events['will-redirect'](
    { preventDefault: () => { prevented = true; } },
    'https://chatgpt.com/auth/callback',
  );
  assert.deepEqual(window.webContents.loadCalls, ['https://chatgpt.com/auth/callback']);
});

test('denies allowed popup targets so they cannot navigate without guards', async () => {
  const { BrowserWindow, session } = createDoubles();
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  await controller.open();
  assert.deepEqual(BrowserWindow.last.popupAllowed('https://accounts.google.com/'), { action: 'deny' });
});

test('prevents a malicious navigation during an allowed navigation load', async () => {
  const { BrowserWindow, session } = createDoubles({ deferredLoad: true });
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  const opening = controller.open();
  const window = BrowserWindow.last;
  let trustedPrevented = false;
  window.webContents.events['will-navigate'](
    { preventDefault: () => { trustedPrevented = true; } },
    'https://chatgpt.com/c/trusted',
  );
  let maliciousPrevented = false;
  window.webContents.events['will-navigate'](
    { preventDefault: () => { maliciousPrevented = true; } },
    'https://evil.example/',
  );
  assert.equal(trustedPrevented, true);
  assert.equal(maliciousPrevented, true);
  assert.deepEqual(window.webContents.loadCalls, ['https://chatgpt.com/c/trusted']);
  void opening;
});

test('allows only HTTPS ChatGPT and login hosts', () => {
  assert.equal(isAllowedChatGptUrl('https://chatgpt.com/c/abc'), true);
  assert.equal(isAllowedChatGptUrl('https://sub.openai.com/auth'), true);
  assert.equal(isAllowedChatGptUrl('http://chatgpt.com/'), false);
  assert.equal(isAllowedChatGptUrl('https://evil.example/'), false);
  assert.equal(isAllowedChatGptUrl('not a url'), false);
  assert.equal(isAllowedChatGptUrl('https://login.accounts.google.com/'), false);
  assert.equal(isAllowedChatGptUrl('https://foo.login.microsoftonline.com/'), false);
  assert.equal(isAllowedChatGptUrl('https://sub.appleid.apple.com/'), false);
});

test('clears only the dedicated ChatGPT session', async () => {
  const { BrowserWindow, session } = createDoubles();
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  await controller.clearSession();
  assert.deepEqual(session.clearStorageDataCalls[0].storages,
    ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']);
  assert.equal(session.clearCacheCalls, 1);
});

test('retains session-lifetime opened state after the window is closed', async () => {
  const { BrowserWindow, session } = createDoubles();
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  assert.deepEqual(controller.snapshot(), { open: false, opened: false });
  await controller.open();
  assert.deepEqual(controller.snapshot(), { open: true, opened: true });
  BrowserWindow.last.close();
  assert.deepEqual(controller.snapshot(), { open: false, opened: true });
});
