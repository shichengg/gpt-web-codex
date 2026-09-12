'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLauncherState, DEFAULT_UI_PREFERENCES } = require('../electron/launcher-state.cjs');
const { guideStateFrom, registerIpcHandlers, rendererEntryUrl } = require('../electron/main.cjs');

async function createPreferences() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-preferences-'));
  return {
    directory,
    preferences: createLauncherState(path.join(directory, 'launcher-state.json')).preferences,
  };
}

test('defaults UI preferences to Simplified Chinese and system theme', async (t) => {
  const { directory, preferences } = await createPreferences();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await preferences.read(), DEFAULT_UI_PREFERENCES);
});

test('migrates legacy preferences to safe proxy and service defaults', async (t) => {
  const { directory, preferences } = await createPreferences();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'launcher-state.json'), JSON.stringify({
    language: 'zh-CN', theme: 'system', guideDismissedSteps: [],
  }));

  assert.deepEqual(await preferences.read(), {
    language: 'zh-CN', theme: 'system', guideDismissedSteps: [],
    proxyMode: 'auto', proxyUrl: '', startAtLogin: false,
    autoStartServices: true, keepRunningOnClose: true,
  });
});

test('rejects unknown themes and sensitive guide payloads', async (t) => {
  const { directory, preferences } = await createPreferences();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await assert.rejects(() => preferences.write({ language: 'zh-CN', theme: 'neon', guideDismissedSteps: [] }));
  await assert.rejects(() => preferences.write({ language: 'zh-CN', theme: 'dark', guideDismissedSteps: [], runtimeKey: 'secret' }));
  await assert.rejects(() => preferences.write({ language: 'zh-CN', theme: 'dark', guideDismissedSteps: [1, 1] }));
});

test('restores valid preferences and safely defaults after corrupt state', async (t) => {
  const { directory, preferences } = await createPreferences();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await preferences.write({ language: 'en', theme: 'dark', guideDismissedSteps: [5, 2] });
  assert.deepEqual(await preferences.read(), {
    language: 'en', theme: 'dark', guideDismissedSteps: [2, 5],
    proxyMode: 'auto', proxyUrl: '', startAtLogin: false,
    autoStartServices: true, keepRunningOnClose: true,
  });

  await fs.writeFile(path.join(directory, 'launcher-state.json'), '{ invalid json');
  assert.deepEqual(await preferences.read(), DEFAULT_UI_PREFERENCES);
});

test('guide state identifies profile and unavailable Tunnel setup without claiming pairing', () => {
  const unavailableTunnel = {
    checks: [{ id: 'tunnel', status: 'warning', message: 'OpenAI Tunnel client is unavailable in this launcher build.' }],
  };
  const guide = guideStateFrom({ snapshot: { workspace: '/work', paired: false }, profiles: [], doctor: unavailableTunnel });

  assert.equal(guide.length, 5);
  assert.deepEqual(guide[0], { id: 1, status: 'needs-action', messageKey: 'guide.profile.required' });
  assert.equal(guide[1].status, 'needs-action');
  assert.equal(guide[2].status, 'unavailable');
  assert.notEqual(guide[3].status, 'complete');
});

test('guide state derives Skills and MCP completion from saved configuration', () => {
  const base = { snapshot: { paired: false }, profiles: [{ id: 'work' }], doctor: { checks: [] } };

  assert.equal(guideStateFrom({ ...base, skills: [], mcpRegistry: { servers: [] } })[1].status, 'needs-action');
  assert.equal(guideStateFrom({ ...base, skills: ['review'], mcpRegistry: { servers: [] } })[1].status, 'complete');
  assert.equal(guideStateFrom({ ...base, skills: [], mcpRegistry: { servers: [{ id: 'local' }] } })[1].status, 'complete');
});

test('guide state keeps an ordinary Tunnel error actionable', () => {
  const guide = guideStateFrom({
    snapshot: { paired: false },
    profiles: [{ id: 'work' }],
    skills: ['review'],
    doctor: { checks: [{ id: 'tunnel', status: 'error', message: 'OpenAI Tunnel client reported an error.' }] },
  });

  assert.equal(guide[2].status, 'needs-action');
});

test('guide step 4 remains an external ChatGPT connector action', () => {
  const base = { snapshot: { state: 'stopped', paired: false }, profiles: [{ id: 'work' }], skills: ['review'], mcpRegistry: { servers: [] }, doctor: { checks: [] } };
  assert.equal(guideStateFrom(base)[3].status, 'needs-action');
  assert.equal(guideStateFrom({ ...base, snapshot: { ...base.snapshot, chatGptOpened: true } })[3].status, 'needs-action');
});

test('preferences IPC validates a full payload before routing it', async () => {
  const handlers = new Map();
  const sender = { getURL: () => rendererEntryUrl };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const calls = [];
  const value = {
    language: 'en', theme: 'light', guideDismissedSteps: [3],
    proxyMode: 'auto', proxyUrl: '', startAtLogin: false,
    autoStartServices: true, keepRunningOnClose: true,
  };
  const controller = {
    preferences: async () => DEFAULT_UI_PREFERENCES,
    savePreferences: async (input) => { calls.push(input); return input; },
  };

  registerIpcHandlers(ipcMain, controller, () => sender);
  assert.deepEqual(await handlers.get('launcher:preferences')({ sender }), DEFAULT_UI_PREFERENCES);
  assert.deepEqual(await handlers.get('launcher:save-preferences')({ sender }, value), value);
  assert.deepEqual(calls, [value]);
  assert.throws(
    () => handlers.get('launcher:save-preferences')({ sender }, { ...value, cookie: 'secret' }),
    /preferences/i,
  );
});

test('renderer exposes Chinese preferences and the five-step setup guide', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

  assert.match(appSource, /简体中文/);
  assert.match(appSource, /浅色/);
  assert.match(appSource, /深色/);
  assert.doesNotMatch(appSource, /打开 ChatGPT|清除 ChatGPT 登录状态/);
  assert.match(appSource, /选择工作区[\s\S]*配置 Skills 与本地 MCP[\s\S]*检测本地运行时与兼容 Tunnel 客户端/);
});

test('renderer translates internal guide message keys instead of displaying them', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

  assert.match(appSource, /guide\.profile\.required/);
  assert.match(appSource, /guide\.runtime\.ready/);
  assert.doesNotMatch(appSource, /:\s*step\.messageKey/);
});

test('renderer maps runtime and diagnostic statuses through the localization dictionary', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

  assert.match(appSource, /runtimeStateLabels/);
  assert.match(appSource, /diagnosticStatusLabels/);
  assert.match(appSource, /diagnosticMessageKeys/);
  assert.doesNotMatch(appSource, /<span className=\{`status status-\$\{snapshot\.state\}`\}>\s*\{snapshot\.state\}/);
  assert.doesNotMatch(appSource, /<span>\{check\.message\}<\/span>/);
});

test('launcher responsive layout activates at the Electron minimum width', async () => {
  const styles = await fs.readFile(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

  assert.match(styles, /@media \(max-width: 900px\)/);
});

test('renderer follows the gpt-webcodex manager shell layout', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

  assert.match(appSource, /className="app-shell"/);
  assert.match(appSource, /className="topbar"/);
  assert.match(appSource, /className="content-viewport"/);
  assert.match(appSource, /className="nav-group-label"/);
  assert.match(appSource, /className="sidebar-runtime"/);
  assert.match(appSource, /className="hero-card"/);
  assert.match(appSource, /className="status-grid"/);
  assert.match(styles, /grid-template-columns:\s*220px/);
  assert.match(styles, /\.topbar\s*\{[\s\S]*height:\s*80px/);
  assert.match(styles, /\.content-viewport\s*\{[\s\S]*padding:\s*24px 30px/);
});

test('renderer mirrors the reference page internals before adding Skills and MCP', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

  for (const contract of [
    'manager-window-bar', 'workspace-bar', 'task-strip', 'node local',
    'flow-line', 'workspace-picker', 'choice-stack', 'build-console',
    'health-list', 'guide-layout', 'settings-section',
  ]) assert.match(appSource, new RegExp(contract));
  assert.match(appSource, /Skills 采用按需加载/);
  assert.match(appSource, /MCP 是可选项/);
  assert.match(styles, /grid-template-columns:\s*244px/);
  assert.match(styles, /\.workspace-bar/);
  assert.match(styles, /height:\s*calc\(100% - 34px\)/);
  assert.match(styles, /\.main-area\s*\{[^}]*height:\s*100%/s);
  assert.match(styles, /\.content-viewport\s*\{[^}]*overflow-y:\s*scroll/s);
  assert.match(styles, /\.page\s*\{[^}]*display:\s*block/s);
});

test('production renderer entry is the upstream static page with additive extensions', async () => {
  const index = await fs.readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = await fs.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const extensions = await fs.readFile(path.join(__dirname, '..', 'public', 'extensions.js'), 'utf8');
  assert.match(index, /class="app-shell"/);
  assert.match(index, /data-page="overview"/);
  assert.match(index, /data-page="settings"/);
  assert.match(index, /extensions\.js/);
  assert.match(app, /const api = window\.mcpAssistant/);
  assert.match(extensions, /data-page="skills"/);
  assert.match(extensions, /data-page="mcp"/);
  assert.match(index, /<title>GPT Web Codex<\/title>/);
});

test('MCP page provides a Stata GUI MCP preset with the fixed safe command and tools', async () => {
  const extensions = await fs.readFile(path.join(__dirname, '..', 'public', 'extensions.js'), 'utf8');
  assert.match(extensions, /Stata 预设/);
  assert.match(extensions, /Zotero 预设/);
  assert.match(extensions, /streamable-http/);
  assert.match(extensions, /测试连接/);
  assert.match(extensions, /allowedTools: names/);
  assert.match(extensions, /连接成功，已启用全部工具/);
  assert.match(extensions, /if \(!next\.id \|\| !commandOrUrl\) return/);
  assert.match(extensions, /stata-gui-mcp\.exe/);
  assert.match(extensions, /stata_run_dofile/);
  assert.match(extensions, /stata_get_data_schema/);
  assert.match(extensions, /timeoutMs: 120000/);
  assert.match(extensions, /filter\(\(item\) => item\.id !== next\.id\)/);
  assert.match(extensions, /已停用/);
  assert.match(extensions, /删除/);
});

test('renderer exposes the reference pages and keeps MCP optional', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

  assert.match(appSource, /connection: "连接设置"/);
  assert.match(appSource, /memory: "本地记忆"/);
  assert.match(appSource, /help: "帮助与诊断"/);
  assert.match(appSource, /本地 stdio MCP 注册表（可选）/);
  assert.match(appSource, /MCP 是可选项/);
});

test('renderer exposes the complete GPT-WebCodex management page registry', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  for (const page of ['overview', 'deploy', 'workspace', 'tasks', 'build', 'health', 'guide', 'logs', 'settings']) {
    assert.match(appSource, new RegExp(`\\"${page}\\"`));
  }
  assert.match(appSource, /重新部署/);
  assert.match(appSource, /构建验证/);
  assert.match(appSource, /日志筛选|log-filter|logFilter/);
});
