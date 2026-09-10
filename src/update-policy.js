const DEFAULT_WINDOWS_REPOSITORY = 'Iyadobo/nocli.ai-releases';
const DEFAULT_DEBIAN_REPOSITORY = 'Iyadobo/nocli.ai-debian';

function updateRepository(platform, env = process.env) {
  return env.NOCLI_UPDATE_REPOSITORY
    || (platform === 'linux' ? (env.NOCLI_LINUX_UPDATE_REPOSITORY || DEFAULT_DEBIAN_REPOSITORY) : DEFAULT_WINDOWS_REPOSITORY);
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
  if (platform === 'linux') return [`nocli.ai_${version}_amd64.deb`];
  return [];
}

module.exports = { updateRepository, updatePackageLabel, installerExtensions, releaseInstallerNames };
