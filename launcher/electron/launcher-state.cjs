'use strict';

const { createJsonStateStore } = require('./state.cjs');

const DEFAULT_UI_PREFERENCES = Object.freeze({
  language: 'zh-CN',
  theme: 'system',
  proxyMode: 'auto',
  proxyUrl: '',
  startAtLogin: false,
  autoStartServices: true,
  keepRunningOnClose: true,
  guideDismissedSteps: Object.freeze([]),
});
const PREFERENCE_KEYS = new Set(['language', 'theme', 'proxyMode', 'proxyUrl', 'startAtLogin', 'autoStartServices', 'keepRunningOnClose', 'guideDismissedSteps']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePreferences(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !PREFERENCE_KEYS.has(key))) {
    throw new TypeError('Invalid UI preferences');
  }
  const merged = { ...DEFAULT_UI_PREFERENCES, ...value };
  if (!['zh-CN', 'en'].includes(merged.language) || !['system', 'light', 'dark'].includes(merged.theme) ||
      !['auto', 'system', 'manual', 'direct'].includes(merged.proxyMode) ||
      typeof merged.proxyUrl !== 'string' || merged.proxyUrl.length > 512 || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(merged.proxyUrl) ||
      ![merged.startAtLogin, merged.autoStartServices, merged.keepRunningOnClose].every((item) => typeof item === 'boolean')) {
    throw new TypeError('Invalid UI preference value');
  }
  const steps = merged.guideDismissedSteps;
  if (!Array.isArray(steps) || steps.length > 5 || new Set(steps).size !== steps.length ||
      steps.some((step) => !Number.isInteger(step) || step < 1 || step > 5)) {
    throw new TypeError('Invalid guide steps');
  }
  return Object.freeze({
    language: merged.language,
    theme: merged.theme,
    proxyMode: merged.proxyMode,
    proxyUrl: merged.proxyUrl,
    startAtLogin: merged.startAtLogin,
    autoStartServices: merged.autoStartServices,
    keepRunningOnClose: merged.keepRunningOnClose,
    guideDismissedSteps: Object.freeze([...steps].sort((left, right) => left - right)),
  });
}

function createLauncherState(filePath) {
  const store = createJsonStateStore(filePath);
  const preferences = Object.freeze({
    read: async () => validatePreferences(await store.read(DEFAULT_UI_PREFERENCES, validatePreferences)),
    write: async (value) => {
      const validated = validatePreferences(value);
      await store.write(validated);
      return validated;
    },
  });
  return Object.freeze({ preferences });
}

module.exports = { createLauncherState, DEFAULT_UI_PREFERENCES, validatePreferences };
