'use strict';

const CHATGPT_PARTITION = 'persist:gpt-web-codex-chatgpt';
const CHATGPT_HOME = 'https://chatgpt.com/';

const ALLOWED_CHATGPT_HOSTS = Object.freeze([
  'chatgpt.com',
  'openai.com',
  'auth.openai.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
]);

function isAllowedChatGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_CHATGPT_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function installChatGptGuards(chatWindow, chatSession, logger = {}) {
  const webContents = chatWindow.webContents;
  let replayingNavigation = false;

  webContents.on('will-navigate', (event, url) => {
    if (replayingNavigation) return;
    event.preventDefault();
    if (!isAllowedChatGptUrl(url)) return;
    replayingNavigation = true;
    Promise.resolve(webContents.loadURL(url))
      .catch(() => undefined)
      .finally(() => { replayingNavigation = false; });
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedChatGptUrl(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition: CHATGPT_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      },
    };
  });
  chatSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  chatSession.on('will-download', (_event, item) => item.cancel());

  // Keep diagnostics free of URLs, query strings, and authentication data.
  if (typeof logger.warn === 'function') {
    webContents.on('did-fail-load', (_event, _code, _description, _validatedURL) => {
      logger.warn('ChatGPT window navigation failed');
    });
  }
}

function createChatGptWindowController({ BrowserWindow, session, logger = {} }) {
  if (!BrowserWindow || !session?.fromPartition) {
    throw new TypeError('ChatGPT window controller requires BrowserWindow and session');
  }
  let chatWindow = null;
  const chatSession = session.fromPartition(CHATGPT_PARTITION);

  function open() {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
      return Promise.resolve({ open: true });
    }
    chatWindow = new BrowserWindow({
      width: 1240,
      height: 860,
      minWidth: 900,
      minHeight: 640,
      webPreferences: {
        partition: CHATGPT_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    installChatGptGuards(chatWindow, chatSession, logger);
    chatWindow.on('closed', () => { chatWindow = null; });
    return chatWindow.loadURL(CHATGPT_HOME).then(() => ({ open: true }));
  }

  async function clearSession() {
    await chatSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
    });
    await chatSession.clearCache();
  }

  return Object.freeze({
    open,
    clearSession,
    close: () => chatWindow?.close(),
    snapshot: () => ({ open: Boolean(chatWindow && !chatWindow.isDestroyed()) }),
  });
}

module.exports = {
  ALLOWED_CHATGPT_HOSTS,
  CHATGPT_HOME,
  CHATGPT_PARTITION,
  createChatGptWindowController,
  installChatGptGuards,
  isAllowedChatGptUrl,
};
