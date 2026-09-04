'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const { AUDITED_CORE_FILES, prepareCore } = require('../scripts/prepare-core.cjs');
const { Arch, Platform } = require('electron-builder');
const { PACKAGE_BUILD_OPTIONS, windowsTargets } = require('../scripts/package.cjs');
const { resolvePackagedExecutable } = require('../scripts/smoke-package.cjs');

test('Windows package targets a per-user NSIS installer and audited core resources', () => {
  assert.equal(packageJson.build.asar, true);
  assert.equal(packageJson.build.publish, undefined);
  assert.equal(PACKAGE_BUILD_OPTIONS.publish, 'never');
  assert.equal(packageJson.build.forceCodeSigning, false);
  assert.equal(packageJson.build.win.signAndEditExecutable, false);
  assert.equal(packageJson.build.win.signExecutable, false);
  assert.equal(packageJson.build.win.target.includes('nsis'), true);
  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.deepEqual(packageJson.build.extraResources, [
    { from: '.package/core', to: 'core', filter: ['**/*'] },
  ]);
  assert.equal(packageJson.scripts['package:win'], 'node scripts/package.cjs');
  assert.equal(packageJson.scripts['smoke:package'], 'node scripts/smoke-package.cjs');
});

test('package command passes NSIS and x64 in electron-builder API order', () => {
  const targets = windowsTargets();
  assert.deepEqual([...targets.get(Platform.WINDOWS).entries()], [[Arch.x64, ['nsis']]]);
});

test('core preparation stages only audited runtime files and production dependencies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-core-package-'));
  const staging = path.join(root, 'launcher', '.package', 'core');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { 'production-package': '1.0.0' } },
      'node_modules/production-package': { version: '1.0.0' },
      'node_modules/development-package': { version: '1.0.0', dev: true },
    },
  }));

  for (const file of AUDITED_CORE_FILES) {
    const destination = path.join(root, 'dist', file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `// ${file}`);
  }
  await fs.mkdir(path.join(root, 'node_modules', 'production-package'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'production-package', 'index.js'), 'module.exports = 1;');
  await fs.mkdir(path.join(root, 'node_modules', 'development-package'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'development-package', 'index.js'), 'module.exports = 2;');
  await fs.mkdir(path.join(root, 'dist', 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist', 'tests', 'secret.test.js'), 'not packaged');
  await fs.writeFile(path.join(root, 'dist', 'unreviewed.js'), 'not packaged');

  await prepareCore({ rootDir: root, stagingDir: staging });

  for (const file of AUDITED_CORE_FILES) {
    assert.equal(await exists(path.join(staging, file)), true, `${file} should be staged`);
  }
  assert.equal(await exists(path.join(staging, 'node_modules', 'production-package', 'index.js')), true);
  assert.equal(await exists(path.join(staging, 'node_modules', 'development-package', 'index.js')), false);
  assert.equal(await exists(path.join(staging, 'tests', 'secret.test.js')), false);
  assert.equal(await exists(path.join(staging, 'unreviewed.js')), false);
});

test('smoke command selects the unpacked application rather than the NSIS installer', async (t) => {
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-smoke-package-'));
  t.after(() => fs.rm(artifacts, { recursive: true, force: true }));
  await fs.writeFile(path.join(artifacts, 'GPT Web Codex Setup 0.1.0.exe'), 'installer');
  await fs.mkdir(path.join(artifacts, 'win-unpacked'));
  const executable = path.join(artifacts, 'win-unpacked', 'GPT Web Codex.exe');
  await fs.writeFile(executable, 'application');

  assert.equal(await resolvePackagedExecutable({ artifactsDir: artifacts, productName: 'GPT Web Codex' }), executable);
});

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}
