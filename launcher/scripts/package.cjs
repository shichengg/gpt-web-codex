'use strict';

const { Arch, build, Platform } = require('electron-builder');
const path = require('node:path');
const { build: buildRenderer } = require('vite');
const { prepareCore } = require('./prepare-core.cjs');

const PACKAGE_BUILD_OPTIONS = Object.freeze({ publish: 'never' });

async function packageWindows() {
  // Packaging never discovers or uses a local signing identity implicitly.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  await buildRenderer({ root: path.resolve(__dirname, '..') });
  await prepareCore();
  await build({
    targets: windowsTargets(),
    ...PACKAGE_BUILD_OPTIONS,
  });
}

function windowsTargets() {
  return Platform.WINDOWS.createTarget(['nsis'], Arch.x64);
}

if (require.main === module) {
  packageWindows().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Windows packaging failed');
    process.exitCode = 1;
  });
}

module.exports = { PACKAGE_BUILD_OPTIONS, packageWindows, windowsTargets };
