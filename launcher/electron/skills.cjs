'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SKILLS = 128;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_PREVIEW_BYTES = 4096;

/** Return renderer-safe metadata, never source paths or full Skill content. */
async function scanSkills(skillsRoot) {
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(skillsRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = await fs.readdir(canonicalRoot, { withFileTypes: true });
  const skills = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (skills.length === MAX_SKILLS) break;
    if (!entry.isDirectory() || !SKILL_ID.test(entry.name)) continue;
    const directory = path.join(canonicalRoot, entry.name);
    try {
      const directoryInfo = await fs.lstat(directory);
      const skillFile = path.join(directory, 'SKILL.md');
      const fileInfo = await fs.lstat(skillFile);
      if (directoryInfo.isSymbolicLink() || fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
      const document = await fs.readFile(skillFile, 'utf8');
      const metadata = parseMetadata(document);
      skills.push(Object.freeze({
        id: entry.name,
        name: metadata.name,
        description: metadata.description,
        preview: boundedPreview(metadata.body),
      }));
    } catch {
      // Inaccessible or malformed Skill packages are not part of the catalog.
    }
  }
  return skills;
}

async function saveSkillDefaults(profile, skillIds) {
  validateSkillIds(skillIds);
  const catalog = await scanSkills(profile.skillsRoot);
  const known = new Set(catalog.map((skill) => skill.id));
  for (const id of skillIds) {
    if (!known.has(id)) {
      throw new Error(`Unknown Skill: ${id}`);
    }
  }
  return [...skillIds];
}

async function openSkillFolder(skillsRoot, skillId, shell) {
  validateSkillIds([skillId]);
  const catalog = await scanSkills(skillsRoot);
  if (!catalog.some((skill) => skill.id === skillId)) {
    throw new Error(`Unknown Skill: ${skillId}`);
  }
  if (!shell || typeof shell.openPath !== 'function') {
    throw new TypeError('Shell does not support opening a local folder');
  }
  const root = await fs.realpath(skillsRoot);
  return shell.openPath(path.join(root, skillId));
}

function validateSkillIds(skillIds) {
  if (!Array.isArray(skillIds) || skillIds.length > MAX_SKILLS ||
      new Set(skillIds).size !== skillIds.length ||
      !skillIds.every((id) => typeof id === 'string' && SKILL_ID.test(id))) {
    throw new TypeError('Skill IDs must be a unique bounded list of valid IDs');
  }
}

function parseMetadata(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') throw new Error('Missing frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('Missing frontmatter terminator');
  const values = new Map();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, ''));
  }
  const name = values.get('name');
  const description = values.get('description');
  if (!name || !description || name.length > MAX_NAME_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error('Invalid Skill metadata');
  }
  return { name, description, body: lines.slice(end + 1).join('\n').replace(/^\n/, '') };
}

function boundedPreview(value) {
  return Buffer.from(value, 'utf8').subarray(0, MAX_PREVIEW_BYTES).toString('utf8');
}

module.exports = { MAX_PREVIEW_BYTES, openSkillFolder, saveSkillDefaults, scanSkills, validateSkillIds };
