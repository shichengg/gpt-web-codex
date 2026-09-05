'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const asar = require('@electron/asar');
const { build: buildConfig } = require('../package.json');

const SMOKE_TIMEOUT_MS = 30_000;
const CORE_RUNTIME_PACKAGES = Object.freeze(['@modelcontextprotocol/sdk', 'zod']);

async function smokePackage({ artifactsDir = path.join(__dirname, '..', 'artifacts') } = {}) {
  const executable = await resolvePackagedExecutable({ artifactsDir, productName: buildConfig.productName });
  await assertPackagedCoreAssets(path.dirname(executable));
  await assertPackagedChatGptWindowController(path.dirname(executable));
  await runDiagnosticMode(executable);
  return executable;
}

async function assertPackagedChatGptWindowController(appOutDir) {
  const archive = path.join(appOutDir, 'resources', 'app.asar');
  const stat = await fs.stat(archive).catch(() => undefined);
  if (!stat?.isFile()) throw new Error('Packaged ASAR archive is missing.');
  let files;
  try {
    files = asar.listPackage(archive);
  } catch {
    throw new Error('Packaged ASAR archive could not be inspected.');
  }
  const normalizedFiles = files.map((file) => file.replaceAll('\\', '/').replace(/^\//, ''));
  if (!normalizedFiles.includes('electron/chatgpt-window.cjs')) {
    throw new Error('Packaged ChatGPT window controller is missing from the ASAR archive.');
  }
}

async function assertPackagedCoreAssets(appOutDir) {
  const coreDirectory = path.join(appOutDir, 'resources', 'core');
  await assertFile(path.join(coreDirectory, 'index.js'), 'Packaged core runtime entrypoint is missing.');
  await assertFile(path.join(coreDirectory, 'package.json'), 'Packaged core runtime manifest is missing.');
  for (const packageName of CORE_RUNTIME_PACKAGES) {
    await assertFile(
      path.join(coreDirectory, 'node_modules', packageName, 'package.json'),
      `Packaged core runtime dependency is missing: ${packageName}.`,
    );
  }
}

async function assertFile(filePath, message) {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(message);
}

async function resolvePackagedExecutable({ artifactsDir, productName }) {
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true });
  const installers = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => path.join(artifactsDir, entry.name));
  if (installers.length !== 1) {
    throw new Error('Expected exactly one packaged Windows executable in launcher/artifacts');
  }
  if (typeof productName !== 'string' || !productName) {
    throw new Error('Packaged application is missing its product name.');
  }
  const executable = path.join(artifactsDir, 'win-unpacked', `${productName}.exe`);
  const stat = await fs.stat(executable).catch(() => undefined);
  if (!stat?.isFile()) {
    throw new Error('Expected the unpacked Windows application beside the NSIS installer.');
  }
  return executable;
}

function runDiagnosticMode(executable) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    for (const name of ['CODEX_CONNECTOR_TOKEN', 'OPENAI_API_KEY', 'OPENAI_API_TOKEN']) delete environment[name];
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    let child;
    try {
      child = spawn(executable, ['--smoke-diagnostics'], {
        env: environment,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      finish(new Error('Unable to start the packaged diagnostic executable.'));
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(new Error('Packaged diagnostic executable did not exit in time.'));
    }, SMOKE_TIMEOUT_MS);
    child.once('error', () => finish(new Error('Unable to start the packaged diagnostic executable.')));
    child.once('exit', (code) => {
      finish(code === 0 ? undefined : new Error('Packaged diagnostic executable exited with an error.'));
    });
  });
}

if (require.main === module) {
  smokePackage().then(
    (executable) => console.log(`Packaged diagnostic smoke test passed: ${path.basename(executable)}`),
    (error) => {
      console.error(error instanceof Error ? error.message : 'Packaged diagnostic smoke test failed');
      process.exitCode = 1;
    },
  );
}

module.exports = {
  assertPackagedChatGptWindowController,
  assertPackagedCoreAssets,
  resolvePackagedExecutable,
  runDiagnosticMode,
  smokePackage,
};
