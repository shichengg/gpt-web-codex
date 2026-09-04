'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { build: buildConfig } = require('../package.json');

const SMOKE_TIMEOUT_MS = 30_000;

async function smokePackage({ artifactsDir = path.join(__dirname, '..', 'artifacts') } = {}) {
  const executable = await resolvePackagedExecutable({ artifactsDir, productName: buildConfig.productName });
  await runDiagnosticMode(executable);
  return executable;
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

module.exports = { resolvePackagedExecutable, runDiagnosticMode, smokePackage };
