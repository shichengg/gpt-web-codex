'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// This list is the compiled closure of src/index.ts. Tests, source maps, and
// unreviewed build output are intentionally not copied into the installer.
const AUDITED_CORE_FILES = Object.freeze([
  'index.js',
  'config.js',
  'runtime.js',
  'server.js',
  'codex/runner.js',
  'codex/tasks.js',
  'mcp/registry.js',
  'mcp/transport.js',
  'security/paths.js',
  'skills/catalog.js',
  'tools/git.js',
  'tools/workspace.js',
]);

async function prepareCore({
  rootDir = path.resolve(__dirname, '..', '..'),
  stagingDir = path.resolve(__dirname, '..', '.package', 'core'),
} = {}) {
  const root = path.resolve(rootDir);
  const staging = path.resolve(stagingDir);
  if (!isStrictChild(root, staging)) {
    throw new Error('Core staging directory must be inside the repository root');
  }

  const packageJsonPath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('Core packaging requires an npm lockfile version 3');
  }

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await fs.copyFile(packageJsonPath, path.join(staging, 'package.json'));

  for (const file of AUDITED_CORE_FILES) {
    const source = path.join(root, 'dist', file);
    const destination = path.join(staging, file);
    await assertFile(source, `Audited core build output is missing: ${file}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }

  const productionPackages = Object.entries(lock.packages)
    .filter(([relativePath, metadata]) => relativePath.startsWith('node_modules/') && metadata?.dev !== true)
    .map(([relativePath]) => relativePath)
    .sort((left, right) => left.length - right.length || left.localeCompare(right));

  for (const relativePath of productionPackages) {
    const source = path.join(root, relativePath);
    const destination = path.join(staging, relativePath);
    await assertDirectory(source, `Production dependency is missing: ${relativePath}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
  }

  return Object.freeze({ coreDir: staging, files: [...AUDITED_CORE_FILES], productionPackages });
}

function isStrictChild(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function assertFile(filePath, message) {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(message);
}

async function assertDirectory(directoryPath, message) {
  const stat = await fs.stat(directoryPath).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(message);
}

if (require.main === module) {
  prepareCore().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Core packaging failed');
    process.exitCode = 1;
  });
}

module.exports = { AUDITED_CORE_FILES, prepareCore };
