const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHATGPT_PARTITION,
  createChatGptWindowController,
  isAllowedChatGptUrl,
} = require('../electron/chatgpt-window.cjs');

function createDoubles() {
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
      on: (name, handler) => { this.webContents.events[name] = handler; },
      setWindowOpenHandler: (handler) => { this.popupAllowed = handler; },
      loadURL: async (url) => { this.loadedURL = url; },
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

test('allows only HTTPS ChatGPT and login hosts', () => {
  assert.equal(isAllowedChatGptUrl('https://chatgpt.com/c/abc'), true);
  assert.equal(isAllowedChatGptUrl('https://sub.openai.com/auth'), true);
  assert.equal(isAllowedChatGptUrl('http://chatgpt.com/'), false);
  assert.equal(isAllowedChatGptUrl('https://evil.example/'), false);
  assert.equal(isAllowedChatGptUrl('not a url'), false);
});

test('clears only the dedicated ChatGPT session', async () => {
  const { BrowserWindow, session } = createDoubles();
  const controller = createChatGptWindowController({ BrowserWindow, session, logger: {} });
  await controller.clearSession();
  assert.deepEqual(session.clearStorageDataCalls[0].storages,
    ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']);
  assert.equal(session.clearCacheCalls, 1);
});
