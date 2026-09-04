const assert = require('node:assert/strict');
const test = require('node:test');

const { windowOptions, isAllowedExternalUrl } = require('../electron/main.cjs');

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
