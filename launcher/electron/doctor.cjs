'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');

/**
 * Report the local prerequisites without copying process output, paths, or
 * state objects into the renderer. Those sources may contain credentials.
 */
async function doctor(options = {}) {
  const which = options.which ?? findCodex;
  const [codexPath, activeProfile] = await Promise.all([
    safely(() => which('codex')),
    safely(() => options.getActiveProfile?.()),
  ]);
  const runtime = safelyNow(() => options.runtimeStatus?.());
  const tunnel = safelyNow(() => options.tunnelStatus?.());
  const connector = safelyNow(() => options.connectorSnapshot?.());
  const tunnelAvailable = options.tunnelAvailable === true;

  return Object.freeze({
    checks: Object.freeze([
      codexPath
        ? check('codex', 'ok', 'Codex CLI is available.')
        : check('codex', 'error', 'Codex CLI was not found on PATH.'),
      runtimeCheck(runtime, options.coreAssetsAvailable),
      activeProfile && typeof activeProfile === 'object'
        ? check('profile', 'ok', 'An active workspace profile is configured.')
        : check('profile', 'warning', 'No active workspace profile is configured.'),
      tunnelCheck(tunnel, tunnelAvailable),
      connector?.configured === true
        ? check('connector', 'ok', 'Connector identity is configured.')
        : check('connector', 'warning', 'Connector identity is not configured.'),
    ]),
  });
}

function runtimeCheck(runtime, coreAssetsAvailable) {
  if (coreAssetsAvailable === false) {
    return check('runtime', 'error', 'Packaged core runtime assets are unavailable.');
  }
  switch (runtime?.state) {
    case 'running': return check('runtime', 'ok', 'Managed local runtime is running.');
    case 'starting': return check('runtime', 'warning', 'Managed local runtime is starting.');
    case 'stopping': return check('runtime', 'warning', 'Managed local runtime is stopping.');
    case 'error': return check('runtime', 'error', 'Managed local runtime reported an error.');
    case 'stopped': return check('runtime', 'warning', 'Managed local runtime is stopped.');
    default: return check('runtime', 'warning', 'Managed local runtime has not been initialized.');
  }
}

function tunnelCheck(tunnel, tunnelAvailable) {
  // Task 6 deliberately injects an unavailable adapter. A future client must
  // set this flag only after its executable contract has been verified.
  if (!tunnelAvailable) {
    return check('tunnel', 'warning', 'OpenAI Tunnel client is unavailable in this launcher build.');
  }
  if (tunnel?.state === 'running' && tunnel?.paired === true) {
    return check('tunnel', 'ok', 'OpenAI Tunnel client is available and paired.');
  }
  if (tunnel?.state === 'error') {
    return check('tunnel', 'error', 'OpenAI Tunnel client reported an error.');
  }
  return check('tunnel', 'warning', 'OpenAI Tunnel client is available but not paired.');
}

function check(id, status, message) {
  return Object.freeze({ id, status, message });
}

async function openDiagnosticLogs(directory, shell) {
  if (typeof directory !== 'string' || !directory || !shell || typeof shell.openPath !== 'function') {
    throw new TypeError('Diagnostic logs require a private directory and Electron shell');
  }
  await fs.mkdir(directory, { recursive: true });
  const result = await shell.openPath(directory);
  if (result) throw new Error('Unable to open the diagnostic log directory.');
}

function findCodex(command) {
  return new Promise((resolve) => {
    const executable = process.platform === 'win32' ? 'where.exe' : 'which';
    let child;
    try {
      child = spawn(executable, [command], { shell: false, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code === 0 ? command : null));
  });
}

async function safely(operation) {
  try {
    return await operation();
  } catch {
    return null;
  }
}

function safelyNow(operation) {
  try {
    return operation() ?? null;
  } catch {
    return null;
  }
}

module.exports = { doctor, findCodex, openDiagnosticLogs };
