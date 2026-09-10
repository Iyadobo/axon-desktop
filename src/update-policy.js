// Axon has moved. This bridge release only offers the verified NoCLI.ai installer.
const DEFAULT_WINDOWS_REPOSITORY = 'Iyadobo/nocli.ai-releases';
const DEFAULT_DEBIAN_REPOSITORY = 'Iyadobo/Axon-Debian';

function updateRepository(platform, env = process.env) {
  return platform === 'linux' ? (env.AXON_LINUX_UPDATE_REPOSITORY || DEFAULT_DEBIAN_REPOSITORY) : DEFAULT_WINDOWS_REPOSITORY;
}

function updatePackageLabel(platform) {
  return platform === 'linux' ? 'Debian package' : 'Windows installer';
}

function installerExtensions(platform) {
  if (platform === 'win32') return ['exe'];
  if (platform === 'linux') return ['deb'];
  return [];
}

function releaseInstallerNames(platform, version) {
  if (platform === 'win32') return [`nocli.ai-Setup-${version}.exe`];
  if (platform === 'linux') return [`Axon_${version}_amd64.deb`];
  return [];
}

module.exports = { updateRepository, updatePackageLabel, installerExtensions, releaseInstallerNames };
