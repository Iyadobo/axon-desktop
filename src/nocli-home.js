// NoCLI Home is the one place owned by the desktop product. Official harness
// sign-ins remain with their respective tools; this directory holds NoCLI
// settings, encrypted-provider references, and non-secret launch context.
const fs = require('fs');
const path = require('path');

function nocliHome(userDataPath) { return path.join(userDataPath, 'NoCLI Home'); }

function migrateNocliHome(userDataPath) {
  const home = nocliHome(userDataPath);
  fs.mkdirSync(home, { recursive: true });
  for (const name of ['settings.json', 'settings.backup.json', 'provider-secrets.json']) {
    const source = path.join(userDataPath, name);
    const target = path.join(home, name);
    try { if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target); } catch {}
  }
  return home;
}

function safeSegment(value, fallback) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return clean || fallback;
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function prepareHarnessContext(home, details = {}) {
  const engine = safeSegment(details.engine, 'native');
  const directory = path.join(home, 'harnesses', engine);
  fs.mkdirSync(directory, { recursive: true });
  const profile = path.join(directory, 'current-turn.json');
  writeJson(profile, {
    schemaVersion: 1, product: 'NoCLI.ai', engine,
    providerKind: String(details.providerKind || 'ollama'),
    providerName: String(details.providerName || ''), model: String(details.model || ''),
    scope: String(details.scope || 'chat'), workspace: String(details.workspace || ''),
    updatedAt: new Date().toISOString(),
  });
  return { home, profile, env: { NOCLI_HOME: home, NOCLI_HARNESS_HOME: directory, NOCLI_TURN_PROFILE: profile } };
}

module.exports = { nocliHome, migrateNocliHome, prepareHarnessContext };
