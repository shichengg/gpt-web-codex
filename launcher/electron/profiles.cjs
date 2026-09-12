'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createJsonStateStore } = require('./state.cjs');

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PATH_LENGTH = 4096;
// The core accepts at most 64 selected Skills. Keep profile persistence at
// that same contract so a valid saved profile can always start a runtime.
const MAX_ENABLED_SKILLS = 64;
const PROFILE_FIELDS = new Set(['id', 'workspaceRoot', 'skillsRoot', 'enabledSkillIds']);

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('Workspace profile must be an object');
  }
  for (const key of Object.keys(profile)) {
    if (!PROFILE_FIELDS.has(key)) {
      throw new TypeError(`Workspace profile contains an unknown field: ${key}`);
    }
  }
  if (typeof profile.id !== 'string' || !PROFILE_ID.test(profile.id) ||
      !isPathChoice(profile.workspaceRoot) || !isPathChoice(profile.skillsRoot) ||
      !Array.isArray(profile.enabledSkillIds) || profile.enabledSkillIds.length > MAX_ENABLED_SKILLS ||
      new Set(profile.enabledSkillIds).size !== profile.enabledSkillIds.length ||
      !profile.enabledSkillIds.every((id) => typeof id === 'string' && PROFILE_ID.test(id))) {
    throw new TypeError('Workspace profile contains invalid bounded fields');
  }
  // Return a fresh, exact-shape value so incidental runtime data cannot leak
  // into the private profile file or later reach the renderer.
  return Object.freeze({
    id: profile.id,
    workspaceRoot: profile.workspaceRoot,
    skillsRoot: profile.skillsRoot,
    enabledSkillIds: [...profile.enabledSkillIds],
  });
}

function isPathChoice(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes('\0');
}

function emptyState() {
  return { version: 1, activeProfileId: null, profiles: [] };
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 ||
      !Array.isArray(state.profiles) || state.profiles.length > 64 ||
      !(state.activeProfileId === null || (typeof state.activeProfileId === 'string' && PROFILE_ID.test(state.activeProfileId)))) {
    throw new Error('Profile state is invalid');
  }
  const profiles = state.profiles.map(validateProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length ||
      (state.activeProfileId !== null && !profiles.some((profile) => profile.id === state.activeProfileId))) {
    throw new Error('Profile state is invalid');
  }
  return { version: 1, activeProfileId: state.activeProfileId, profiles };
}

async function createProfileStore(filePath) {
  const state = createJsonStateStore(filePath);
  let current = validateState(await state.read(emptyState(), validateState));

  async function persist(next) {
    const validated = validateState(next);
    await state.write(validated);
    current = validated;
  }

  return Object.freeze({
    // The renderer receives only profile data, not internal state. Place the
    // active profile first so it can render its defaults without an extra
    // state-bearing IPC response.
    list: async () => [...current.profiles]
      .sort((left, right) => Number(right.id === current.activeProfileId) - Number(left.id === current.activeProfileId))
      .map(copyProfile),
    get: async (id) => {
      validateProfileId(id);
      const profile = current.profiles.find((candidate) => candidate.id === id);
      return profile ? copyProfile(profile) : null;
    },
    getActive: async () => current.activeProfileId === null
      ? null
      : copyProfile(current.profiles.find((profile) => profile.id === current.activeProfileId)),
    save: async (profile) => {
      const validated = await canonicalizeProfile(profile);
      const existing = current.profiles.find((candidate) => candidate.id === validated.id);
      const saved = existing
        ? { ...validated, enabledSkillIds: [...existing.enabledSkillIds] }
        : validated;
      const profiles = current.profiles.filter((candidate) => candidate.id !== saved.id);
      profiles.push(saved);
      await persist({ ...current, profiles });
      return copyProfile(saved);
    },
    setActive: async (id) => {
      validateProfileId(id);
      if (!current.profiles.some((profile) => profile.id === id)) {
        throw new Error(`Unknown workspace profile: ${id}`);
      }
      await persist({ ...current, activeProfileId: id });
      return copyProfile(current.profiles.find((profile) => profile.id === id));
    },
    saveDefaults: async (id, skillIds) => {
      validateProfileId(id);
      const existing = current.profiles.find((profile) => profile.id === id);
      if (!existing) {
        throw new Error(`Unknown workspace profile: ${id}`);
      }
      const updated = validateProfile({ ...existing, enabledSkillIds: skillIds });
      await persist({ ...current, profiles: current.profiles.map((profile) => profile.id === id ? updated : profile) });
      return copyProfile(updated);
    },
  });
}

/** Resolve profile roots on every filesystem operation, not just on save. */
async function resolveProfileRoots(profile) {
  const validated = validateProfile(profile);
  const workspaceRoot = await canonicalDirectory(validated.workspaceRoot, 'Workspace root');
  const configuredSkillsRoot = await canonicalDirectory(validated.skillsRoot, 'Skills root');
  const expectedSkillsRoot = path.join(workspaceRoot, '.codex', 'skills');
  const expectedInfo = await fs.lstat(expectedSkillsRoot).catch(() => undefined);
  if (!expectedInfo || !expectedInfo.isDirectory() || expectedInfo.isSymbolicLink()) {
    throw new Error('Skills root must be the workspace .codex/skills directory');
  }
  const canonicalSkillsRoot = await fs.realpath(expectedSkillsRoot);
  if (!isContained(workspaceRoot, canonicalSkillsRoot) || !isContainedOrSame(canonicalSkillsRoot, configuredSkillsRoot)) {
    throw new Error('Skills root must be contained in the workspace .codex/skills directory');
  }
  return { ...validated, workspaceRoot, skillsRoot: configuredSkillsRoot };
}

async function canonicalizeProfile(profile) {
  return resolveProfileRoots(profile);
}

async function canonicalDirectory(value, label) {
  try {
    const resolved = await fs.realpath(value);
    const info = await fs.stat(resolved);
    if (!info.isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch {
    throw new Error(`${label} must be an existing directory`);
  }
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isContainedOrSame(parent, child) {
  return samePath(parent, child) || isContained(parent, child);
}

function validateProfileId(id) {
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) {
    throw new TypeError('Workspace profile ID must be a bounded identifier');
  }
}

function copyProfile(profile) {
  return { ...profile, enabledSkillIds: [...profile.enabledSkillIds] };
}

module.exports = { MAX_ENABLED_SKILLS, PROFILE_ID, createProfileStore, resolveProfileRoots, validateProfile };
