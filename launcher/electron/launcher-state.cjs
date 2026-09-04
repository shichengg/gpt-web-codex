'use strict';

const { createJsonStateStore } = require('./state.cjs');

const DEFAULT_UI_PREFERENCES = Object.freeze({
  language: 'zh-CN',
  theme: 'system',
  guideDismissedSteps: Object.freeze([]),
});
const PREFERENCE_KEYS = new Set(['language', 'theme', 'guideDismissedSteps']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePreferences(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !PREFERENCE_KEYS.has(key))) {
    throw new TypeError('Invalid UI preferences');
  }
  if (!['zh-CN', 'en'].includes(value.language) || !['system', 'light', 'dark'].includes(value.theme)) {
    throw new TypeError('Invalid UI preference value');
  }
  const steps = value.guideDismissedSteps;
  if (!Array.isArray(steps) || steps.length > 5 || new Set(steps).size !== steps.length ||
      steps.some((step) => !Number.isInteger(step) || step < 1 || step > 5)) {
    throw new TypeError('Invalid guide steps');
  }
  return Object.freeze({
    language: value.language,
    theme: value.theme,
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
