'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const asar = require('@electron/asar');

const packageJson = require('../package.json');
const { AUDITED_CORE_FILES, prepareCore } = require('../scripts/prepare-core.cjs');
const { Arch, Platform } = require('electron-builder');
const { PACKAGE_BUILD_OPTIONS, windowsTargets } = require('../scripts/package.cjs');
const {
  assertPackagedChatGptWindowController,
  assertPackagedCoreAssets,
  resolvePackagedExecutable,
} = require('../scripts/smoke-package.cjs');
const { verifyCoreRuntimeLoadability } = require('../electron/main.cjs');

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
    { from: '.package/core', to: 'core', filter: ['**/*', '!node_modules{,/**/*}'] },
    { from: '.package/core/node_modules', to: 'core/node_modules', filter: ['**/*'] },
  ]);
  assert.equal(packageJson.scripts['package:win'], 'node scripts/package.cjs');
  assert.equal(packageJson.scripts['smoke:package'], 'node scripts/smoke-package.cjs');
});

test('package keeps the ChatGPT window controller in ASAR and documents session isolation', async () => {
  const launcherDirectory = path.join(__dirname, '..');
  const repositoryDirectory = path.join(launcherDirectory, '..');
  const readme = await fs.readFile(path.join(repositoryDirectory, 'README.md'), 'utf8');
  const packagedFiles = packageJson.build.files;
  const packageConfig = JSON.stringify(packageJson.build);

  assert.equal(
    packagedFiles.some((pattern) => pattern === 'electron/*.cjs'),
    true,
    'The ASAR input must include electron/chatgpt-window.cjs.',
  );
  await fs.access(path.join(launcherDirectory, 'electron', 'chatgpt-window.cjs'));
  assert.equal(
    packageConfig.includes('chatgpt-session') || packageConfig.includes('chatgpt-session-data'),
    false,
    'ChatGPT session storage must never be an extra packaged resource.',
  );
  assert.match(readme, /独立 ChatGPT 窗口/);
  assert.match(readme, /清除 ChatGPT 登录状态/);
  assert.match(readme, /不读取、显示、导出.*Cookie/);
  assert.match(readme, /兼容 Tunnel 客户端/);
  assert.match(packageConfig, /asar/);
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

test('smoke package check requires the audited core entrypoint and runtime dependencies', async (t) => {
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-core-assets-'));
  t.after(() => fs.rm(artifacts, { recursive: true, force: true }));
  const core = path.join(artifacts, 'win-unpacked', 'resources', 'core');
  await fs.mkdir(path.join(core, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
  await fs.mkdir(path.join(core, 'node_modules', 'zod'), { recursive: true });
  await fs.writeFile(path.join(core, 'index.js'), 'export {};');
  await fs.writeFile(path.join(core, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(path.join(core, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
  await fs.writeFile(path.join(core, 'node_modules', 'zod', 'package.json'), '{}');

  await assertPackagedCoreAssets(path.join(artifacts, 'win-unpacked'));
  await fs.rm(path.join(core, 'node_modules', 'zod'), { recursive: true, force: true });
  await assert.rejects(() => assertPackagedCoreAssets(path.join(artifacts, 'win-unpacked')), /runtime dependency/i);
});

test('smoke package check requires the ChatGPT window controller in the packaged ASAR', async (t) => {
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-chatgpt-asar-'));
  t.after(() => fs.rm(artifacts, { recursive: true, force: true }));
  const source = path.join(artifacts, 'source');
  const appAsar = path.join(artifacts, 'win-unpacked', 'resources', 'app.asar');
  await fs.mkdir(path.join(source, 'electron'), { recursive: true });
  await fs.writeFile(path.join(source, 'electron', 'chatgpt-window.cjs'), 'module.exports = {};');
  await fs.mkdir(path.dirname(appAsar), { recursive: true });
  await asar.createPackage(source, appAsar);

  await assertPackagedChatGptWindowController(path.join(artifacts, 'win-unpacked'));
  await fs.rm(path.join(source, 'electron', 'chatgpt-window.cjs'));
  const emptyAppOut = path.join(artifacts, 'empty-app', 'resources');
  const emptyAsar = path.join(emptyAppOut, 'app.asar');
  await fs.mkdir(emptyAppOut, { recursive: true });
  await asar.createPackage(source, emptyAsar);
  await assert.rejects(
    () => assertPackagedChatGptWindowController(path.join(artifacts, 'empty-app')),
    /ChatGPT window controller/i,
  );
});

test('diagnostic core probe runs the packaged core without NODE_PATH fallback', async () => {
  const child = new (require('node:events'))();
  let invocation;
  const probe = verifyCoreRuntimeLoadability('C:\\package\\resources\\core\\index.js', {
    executable: 'C:\\package\\GPT Web Codex.exe',
    environment: {
      NODE_PATH: 'C:\\ambient\\node_modules',
      CODEX_CONNECTOR_TOKEN: 'must-not-be-forwarded',
      KEEP: 'allowed',
    },
    spawn: (...args) => {
      invocation = args;
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  });

  await probe;
  assert.deepEqual(invocation.slice(0, 2), [
    'C:\\package\\GPT Web Codex.exe',
    ['C:\\package\\resources\\core\\index.js', '--help'],
  ]);
  assert.equal(invocation[2].cwd, 'C:\\package\\resources\\core');
  assert.equal(invocation[2].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(invocation[2].env.NODE_PATH, undefined);
  assert.equal(invocation[2].env.CODEX_CONNECTOR_TOKEN, undefined);
  assert.equal(invocation[2].env.KEEP, 'allowed');
});

test('diagnostic core probe rejects a failed runtime import', async () => {
  const child = new (require('node:events'))();
  const probe = verifyCoreRuntimeLoadability('C:\\package\\resources\\core\\index.js', {
    spawn: () => {
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    },
  });

  await assert.rejects(probe, /core runtime could not be loaded/i);
});

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}
