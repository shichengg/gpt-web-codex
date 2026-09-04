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
  assert.deepEqual(await preferences.read(), { language: 'en', theme: 'dark', guideDismissedSteps: [2, 5] });

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
  assert.equal(guide[1].status, 'complete');
  assert.equal(guide[2].status, 'unavailable');
  assert.notEqual(guide[3].status, 'complete');
});

test('preferences IPC validates a full payload before routing it', async () => {
  const handlers = new Map();
  const sender = { getURL: () => rendererEntryUrl };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const calls = [];
  const value = { language: 'en', theme: 'light', guideDismissedSteps: [3] };
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
