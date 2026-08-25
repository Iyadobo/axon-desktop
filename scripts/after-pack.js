// Package the platform-native Axon Terminal alongside Electron. Keeping this as
// an after-pack hook lets Windows and Linux build from their own native binaries
// without checking a 300 MB executable into the desktop repository.
const fs = require('fs');
const path = require('path');

exports.default = async function bundleAxonTerminal(context) {
  const platform = context.electronPlatformName;
  if (!['win32', 'linux'].includes(platform)) return;

  const executable = platform === 'win32' ? 'axon.exe' : 'axon';
  const source = path.join(context.packager.projectDir, 'axon-terminal', 'codex-rs', 'target', 'release', executable);
  if (!fs.existsSync(source)) {
    throw new Error(`Axon Terminal is missing: build axon-terminal/codex-rs first (expected ${source}).`);
  }

  const destinationDir = path.join(context.appOutDir, 'resources', 'axon-terminal');
  const destination = path.join(destinationDir, executable);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, destination);
  if (platform === 'linux') fs.chmodSync(destination, 0o755);
};
