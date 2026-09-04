'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Small private JSON store. Callers own the schema; this module only makes
 * replacement writes durable enough that a partial file is never observed.
 */
function createJsonStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('State path must be a non-empty string');
  }

  async function read(fallback, validate = () => undefined) {
    await removeStaleTemporaryFiles();
    let source;
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return fallback;
      }
      throw error;
    }
    try {
      const value = JSON.parse(source);
      validate(value);
      return value;
    } catch {
      await quarantineCorruptState();
      return fallback;
    }
  }

  async function removeStaleTemporaryFiles() {
    const directory = path.dirname(filePath);
    const prefix = `.${path.basename(filePath)}.tmp-`;
    try {
      const entries = await fs.readdir(directory);
      await Promise.all(entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => fs.rm(path.join(directory, entry), { force: true })));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  async function quarantineCorruptState() {
    const backupPath = `${filePath}.corrupt-${randomUUID()}`;
    try {
      await fs.rename(filePath, backupPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  async function write(value) {
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.tmp-${randomUUID()}`);
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  return Object.freeze({ read, write });
}

module.exports = { createJsonStateStore };
