// Electron main: tray + window + Ollama lifecycle + native Calcium chat and terminal modes.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, WebContentsView, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const lan = require('./lan');
const { createConfigStore } = require('./config');
const llamacppRuntime = require('./llamacpp-runtime');
const { modelCapabilityReport, capabilityInstruction } = require('./capabilities');
const { updateRepository, updatePackageLabel, installerExtensions, releaseInstallerNames } = require('./update-policy');
const { runOllamaCloudAgent } = require('./ollama-cloud-agent');
const { resolveRoute, migrateProvider, normalizeEngine, normalizeProviderKind, scopeInfo, scopeFromLegacy, ENGINE_ORDER, engineInfo, isMissingHarnessSession } = require('./engines');
const { openCodeLaunchConfig } = require('./opencode-adapter');
const { migrateNocliHome, prepareHarnessContext } = require('./nocli-home');

// Set once so the window groups under its own taskbar entry (pinnable) instead of Electron's.
try { app.setAppUserModelId('ai.nocli.desktop'); } catch {}
// A stable display name also stabilizes Electron's userData folder across dev
// and packaged launches (Windows otherwise kept both `nocli` and `NoCLI.ai`).
try { app.setName('Calcium'); } catch {}
// Keep the established data directory for the first Calcium release so saved
// projects, chats, connections, and official-harness context are not stranded.
// A supplied user-data directory is intentionally left alone for source previews
// and visual tests, which need their own single-instance scope.
if (!app.commandLine.getSwitchValue('user-data-dir')) {
  try { app.setPath('userData', path.join(app.getPath('appData'), 'NoCLI.ai')); } catch {}
}

function migrateLegacyUserData(targetDirectory) {
  const targetSettings = path.join(targetDirectory, 'settings.json');
  if (fs.existsSync(targetSettings)) return;
  const parent = path.dirname(targetDirectory);
  const legacyNames = ['A' + 'xon', 'a' + 'xon', 'ollama-desktop-harness'];
  for (const name of legacyNames) {
    const sourceDirectory = path.join(parent, name);
    if (!fs.existsSync(path.join(sourceDirectory, 'settings.json'))) continue;
    try {
      fs.mkdirSync(targetDirectory, { recursive: true });
      for (const file of ['settings.json', 'settings.backup.json', 'provider-secrets.json']) {
        const source = path.join(sourceDirectory, file);
        const target = path.join(targetDirectory, file);
        if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
      }
      return;
    } catch {}
  }
}
// Keep a launch click focused on the existing NoCLI.ai window instead of opening
// another Electron group (which also keeps the taskbar pleasantly tidy).
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
});

const LOCAL_OLLAMA_URL = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
let runtimeKind = 'ollama', exoBase = '';
let llamaCppConfig = { role: 'host', modelPath: '', bindIp: '', rpcPeers: '', apiPort: 8090, rpcPort: 50052, contextSize: 0 };
let llamaCppHostProc = null, llamaCppWorkerProc = null;
const activeOllamaUrl = () => runtimeKind === 'exo' ? exoBase + '/ollama' : LOCAL_OLLAMA_URL;
const runtimeEndpoint = (pathname) => new URL(String(pathname || '').replace(/^\//, ''), activeOllamaUrl().replace(/\/?$/, '/'));
// Vendored/downloaded runtimes live at <repo>/runtimes in dev (matches the
// existing runtimes/exo convention) and under userData once packaged, since
// the packaged app's own directory is a read-only asar archive.
function runtimeRoot() { return app.isPackaged ? path.join(app.getPath('userData'), 'runtimes') : path.join(__dirname, '..', 'runtimes'); }
function normalizeLlamaCppConfig(value) {
  const v = value || {};
  const port = (x, d) => { const n = Number(x); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
  return {
    role: v.role === 'worker' ? 'worker' : 'host',
    modelPath: typeof v.modelPath === 'string' ? v.modelPath : '',
    bindIp: typeof v.bindIp === 'string' ? v.bindIp : '',
    rpcPeers: typeof v.rpcPeers === 'string' ? v.rpcPeers : '',
    apiPort: port(v.apiPort, 8090),
    rpcPort: port(v.rpcPort, 50052),
    contextSize: Number.isInteger(Number(v.contextSize)) && Number(v.contextSize) > 0 ? Number(v.contextSize) : 0,
  };
}
async function listActiveModels() {
  if (runtimeKind === 'llamacpp') {
    if (!llamaCppConfig.modelPath) return { models: [] };
    let size = 0; try { size = fs.statSync(llamaCppConfig.modelPath).size; } catch {}
    return { models: [{ name: path.basename(llamaCppConfig.modelPath), size, details: {} }] };
  }
  return await ollama('/api/tags');
}
// Release feeds stay platform-specific so a Linux client never mistakes the
// Windows installer for its update. NOCLI_UPDATE_REPOSITORY remains a useful
// single-feed override for forks and local testing.
const UPDATE_REPOSITORY = updateRepository(process.platform);

let tray = null, win = null, ollamaProc = null, browserPanel = null, browserBridge = null, browserBridgeEndpoint = '', browserBridgeToken = '', isQuitting = false;
let updateCheckTimer = null, announcedUpdateVersion = null;
let trayLabel = 'Calcium: starting…';
// Each conversation gets its own holder. A slow or unavailable model must never
// own the whole window (or somebody else's Stop button).
const localHolders = new Map();
let availableRelease = null, updateCheckInFlight = null, cachedUpdateStatus = null, cachedUpdateAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve an executable through the host platform's PATH without a shell.
function whereFirst(command) {
  try {
    const probe = process.platform === 'win32' ? `where.exe ${command}` : `command -v ${command}`;
    return execSync(probe, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' ? undefined : '/bin/sh' })
      .split(/\r?\n/).map((s) => s.trim()).find((p) => p && fs.existsSync(p)) || null;
  } catch { return null; }
}
function findOfficialCodexCli() {
  try {
    const probe = process.platform === 'win32' ? 'where.exe codex' : 'command -v codex';
    const candidates = execSync(probe, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' ? undefined : '/bin/sh' })
      .split(/\r?\n/).map((item) => item.trim()).filter((item) => item && fs.existsSync(item));
    const preferred = candidates.find((item) => /\.exe$/i.test(item)) || candidates.find((item) => /\.cmd$/i.test(item)) || candidates[0];
    return preferred ? { command: preferred, prefix: [] } : null;
  } catch {
    const fallback = whereFirst('codex');
    return fallback ? { command: fallback, prefix: [] } : null;
  }
}
function findClaudeCli() {
  const resolved = whereFirst('claude');
  return resolved ? { command: resolved, prefix: [] } : null;
}
function findQwenCli() {
  const resolved = whereFirst(process.platform === 'win32' ? 'qwen.cmd' : 'qwen') || whereFirst('qwen');
  return resolved ? { command: resolved, prefix: [] } : null;
}
function findKimiCli() {
  if (process.platform !== 'win32') {
    const resolved = whereFirst('kimi');
    return resolved ? { command: resolved, prefix: [] } : null;
  }
  try {
    const candidates = execSync('where.exe kimi', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((item) => item.trim()).filter((item) => item && fs.existsSync(item));
    const native = candidates.find((item) => /\.exe$/i.test(item));
    if (native) return { command: native, prefix: [] };
    // npm's .cmd shim cannot be spawned with shell:false on Windows. Launch
    // the package entry through Node so arguments stay unquoted and no shell
    // is introduced into a workspace-writing engine.
    for (const shim of candidates.filter((item) => /\.cmd$/i.test(item))) {
      const entry = path.join(path.dirname(shim), 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
      const node = whereFirst('node.exe');
      if (node && fs.existsSync(entry)) return { command: node, prefix: [entry] };
    }
  } catch {}
  return null;
}
function findOpenCodeCli() {
  if (process.platform !== 'win32') {
    const resolved = whereFirst('opencode');
    return resolved ? { command: resolved, prefix: [] } : null;
  }
  try {
    const candidates = execSync('where.exe opencode', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((item) => item.trim()).filter((item) => item && fs.existsSync(item));
    const native = candidates.find((item) => /\.exe$/i.test(item));
    if (native) return { command: native, prefix: [] };
    for (const shim of candidates) {
      const entry = path.join(path.dirname(shim), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      if (fs.existsSync(entry)) return { command: entry, prefix: [] };
    }
  } catch {}
  return null;
}
// One lookup per engine id so the picker can report what is actually installed
// instead of failing at spawn time.
const ENGINE_LAUNCHERS = { codex: findOfficialCodexCli, claude: findClaudeCli, qwen: findQwenCli, kimi: findKimiCli, opencode: findOpenCodeCli, none: () => ({ command: null, prefix: [] }) };
function findEngineCli(engineId) { return (ENGINE_LAUNCHERS[normalizeEngine(engineId)] || (() => null))(); }
function runQuiet(command, args, timeout = 15000) {
  return new Promise((resolve) => {
    let out = ''; let child;
    try { child = spawn(command, args, { windowsHide: true, shell: false }); } catch { return resolve(null); }
    const done = () => resolve(out.trim() || null);
    child.stdout?.on('data', (d) => { out += d; }); child.stderr?.on('data', (d) => { out += d; }); child.on('error', () => resolve(null)); child.on('exit', done);
    setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeout).unref();
  });
}
function runOpenCodeGoTest(model) {
  const chosen = String(model || '').trim();
  if (!chosen.startsWith('opencode-go/')) return Promise.resolve({ ok: false, error: 'Choose an OpenCode Go model before testing.' });
  const launch = findOpenCodeCli();
  if (!launch) return Promise.resolve({ ok: false, error: 'OpenCode is not installed or not on PATH.' });
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(launch.command, [...launch.prefix, 'run', '--format', 'json', '--pure', '--model', chosen, 'Reply with exactly: NOCLI_GO_OK'], {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { return finish({ ok: false, error: `Could not start OpenCode: ${error.message}` }); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, error: 'OpenCode Go did not respond within 45 seconds.' }); }, 45000);
    const append = (target, chunk) => (target + String(chunk || '')).slice(-24000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, error: `Could not run OpenCode: ${error.message}` }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code) return finish({ ok: false, error: `OpenCode exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}` });
      let text = '';
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'error') return finish({ ok: false, error: event.error?.message || event.message || 'OpenCode reported an error.' });
          if (event.type === 'text' && event.part?.text) text += event.part.text;
        } catch {}
      }
      return finish({ ok: true, model: chosen, route: 'Native OpenCode Go sign-in', response: text.trim().slice(0, 160) || 'Connected successfully.' });
    });
  });
}
async function dependencyStatus() {
  const codexLaunch = findOfficialCodexCli();
  const claudeLaunch = findClaudeCli();
  const qwenLaunch = findQwenCli();
  const kimiLaunch = findKimiCli();
  const openCodeLaunch = findOpenCodeCli();
  const [ollama, node, codex, claude, qwen, kimi, opencode] = await Promise.all([
    runQuiet(whereFirst(process.platform === 'win32' ? 'ollama.exe' : 'ollama') || 'ollama', ['--version']),
    runQuiet(whereFirst(process.platform === 'win32' ? 'node.exe' : 'node') || 'node', ['--version']),
    codexLaunch ? runQuiet(codexLaunch.command, [...codexLaunch.prefix, '--version']) : Promise.resolve(null),
    claudeLaunch ? runQuiet(claudeLaunch.command, [...claudeLaunch.prefix, '--version']) : Promise.resolve(null),
    qwenLaunch ? runQuiet(qwenLaunch.command, [...qwenLaunch.prefix, '--version']) : Promise.resolve(null),
    kimiLaunch ? runQuiet(kimiLaunch.command, [...kimiLaunch.prefix, '--version']) : Promise.resolve(null),
    openCodeLaunch ? runQuiet(openCodeLaunch.command, [...openCodeLaunch.prefix, '--version']) : Promise.resolve(null),
  ]);
  return { ollama, node, codex, claude, qwen, kimi, opencode };
}
// The engine picker asks for this so an unavailable harness is greyed out with
// a reason instead of spawning and failing.
async function engineAvailability() {
  const entries = await Promise.all(ENGINE_ORDER.map(async (id) => {
    const info = engineInfo(id);
    if (!info.binary) return [id, { installed: true, version: null }];
    const launch = findEngineCli(id);
    if (!launch?.command) return [id, { installed: false, version: null }];
    const version = await runQuiet(launch.command, [...launch.prefix, '--version']);
    return [id, { installed: true, version: version ? version.split(/\r?\n/)[0].slice(0, 40) : null }];
  }));
  return Object.fromEntries(entries);
}
let config = null;
let nocliConfigHome = null;
const visionCapability = new Map();
const reasoningCapability = new Map();
function providerSecretsPath() { return path.join(nocliConfigHome || app.getPath('userData'), 'provider-secrets.json'); }
function loadProviderSecrets() {
  try { return JSON.parse(fs.readFileSync(providerSecretsPath(), 'utf8')); } catch { return {}; }
}
function saveProviderSecret(id, value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.');
  const secrets = loadProviderSecrets();
  secrets[id] = safeStorage.encryptString(String(value)).toString('base64');
  fs.writeFileSync(providerSecretsPath(), JSON.stringify(secrets), { encoding: 'utf8', mode: 0o600 });
}
function readProviderSecret(id) {
  if (!id || !safeStorage.isEncryptionAvailable()) return null;
  try { const value = loadProviderSecrets()[id]; return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : null; } catch { return null; }
}

// ---- ollama serve lifecycle ----------------------------------------------
async function isOllamaUp() {
  return new Promise((resolve) => {
    const req = http.get(runtimeEndpoint('/api/tags'), (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}
function notifyModelsChanged(payload = {}) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('models-changed', payload);
}
async function ensureOllama() {
  if (runtimeKind === 'exo') return setTray('Calcium: Exo runtime selected');
  if (runtimeKind === 'llamacpp') return setTray('Calcium: llama.cpp RPC runtime');
  if (await isOllamaUp()) { setTray('Calcium: running'); notifyModelsChanged({ runtime: 'ollama', ready: true }); return true; }
  let launchError = null;
  const child = spawn('ollama', ['serve'], { windowsHide: true, shell: false });
  ollamaProc = child;
  child.on('error', (error) => { launchError = error; if (ollamaProc === child) ollamaProc = null; setTray('Calcium: Ollama unavailable'); });
  child.on('exit', () => { if (ollamaProc === child) ollamaProc = null; setTray('Calcium: stopped'); });
  child.stderr?.on('data', () => {});
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await isOllamaUp()) { setTray('Ollama: running'); notifyModelsChanged({ runtime: 'ollama', ready: true }); return true; }
    if (launchError) break;
  }
  setTray('Calcium: failed to start');
  return false;
}

function ollama(pathname) {
  return new Promise((resolve, reject) => {
    const u = runtimeEndpoint(pathname);
    http.get(u, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); })
      .on('error', reject);
  });
}
function normalizeExoUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an Exo HTTP address such as http://192.168.50.1:52415.');
  return url.origin;
}
function checkExo(url) {
  return new Promise((resolve) => {
    let base;
    try { base = normalizeExoUrl(url); } catch (error) { return resolve({ error: error.message }); }
    const target = new URL('/v1/models', base); const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, { headers: { Accept: 'application/json' } }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `Exo returned ${res.statusCode}.` });
        try { const parsed = JSON.parse(body); resolve({ ok: true, base, models: Array.isArray(parsed.data) ? parsed.data.length : Array.isArray(parsed.models) ? parsed.models.length : 0 }); }
        catch { resolve({ error: 'Exo returned invalid model metadata.' }); }
      });
    });
    req.on('error', (error) => resolve({ error: error.message }));
    req.setTimeout(5000, () => req.destroy(new Error('Exo connection timed out.')));
  });
}
function fetchCloudCatalogue() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://ollama.com/api/tags', {
      headers: { 'User-Agent': `Calcium/${app.getVersion()}`, Accept: 'application/json' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Ollama Cloud returned ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error('Ollama Cloud catalogue was unexpectedly large.'));
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const models = Array.isArray(parsed.models) ? parsed.models.filter((model) => model && typeof model.name === 'string') : [];
          resolve({ models, fetchedAt: new Date().toISOString() });
        } catch { reject(new Error('Ollama Cloud returned an invalid catalogue.')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Ollama Cloud catalogue timed out.')));
  });
}
let activeModelPull = null;
function pullOllamaModel(value) {
  const model = String(value || '').trim();
  if (!/^[a-zA-Z0-9._:/-]{1,160}$/.test(model)) return Promise.reject(new Error('Invalid Ollama model name.'));
  if (activeModelPull) return Promise.reject(new Error(`${activeModelPull} is already downloading.`));
  activeModelPull = model;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; activeModelPull = null; error ? reject(error) : resolve({ ok: true, model }); };
    const body = JSON.stringify({ model, stream: true });
    const u = new URL(LOCAL_OLLAMA_URL); u.pathname = '/api/pull';
    const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let buffer = '', completed = false;
      if (res.statusCode !== 200) { let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => finish(new Error(`Ollama pull failed (${res.statusCode}): ${text.slice(0, 180)}`))); return; }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk; let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let update; try { update = JSON.parse(line); } catch { continue; }
          if (update.error) return req.destroy(new Error(String(update.error)));
          if (update.status === 'success') completed = true;
          win?.webContents.send('model-pull-progress', { model, status: String(update.status || 'Downloading…'), completed: Number(update.completed) || 0, total: Number(update.total) || 0 });
        }
      });
      res.on('end', () => completed ? finish() : finish(new Error('Ollama ended the download before it completed.')));
      res.on('error', finish);
    });
    req.on('error', finish);
    req.setTimeout(120000, () => req.destroy(new Error('Ollama stopped responding during the download.')));
    req.write(body); req.end();
  });
}
async function hardwareProfile() {
  const profile = {
    ramBytes: os.totalmem(),
    cpu: { name: os.cpus()?.[0]?.model || 'Unknown CPU', cores: os.cpus()?.length || 0 },
    gpus: [],
  };
  if (process.platform !== 'win32') return profile;
  try {
    const raw = await runQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"], 8000);
    const rows = raw ? JSON.parse(raw) : [];
    for (const row of (Array.isArray(rows) ? rows : [rows])) {
      const name = String(row?.Name || '').trim(); const vramBytes = Number(row?.AdapterRAM) || 0;
      if (name && !/virtual|parsec|iddcx/i.test(name)) profile.gpus.push({ name, vramBytes });
    }
  } catch {}
  try {
    const smi = whereFirst('nvidia-smi');
    const output = smi && await runQuiet(smi.command, [...smi.prefix, '--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 8000);
    for (const line of String(output || '').split(/\r?\n/)) {
      const match = line.match(/^(.+?),\s*(\d+(?:\.\d+)?)\s*$/); if (!match) continue;
      const name = match[1].trim(); const vramBytes = Math.round(Number(match[2]) * 1024 * 1024);
      const index = profile.gpus.findIndex((gpu) => gpu.name.toLowerCase().includes('nvidia') || name.toLowerCase().includes(gpu.name.toLowerCase()));
      if (index >= 0) profile.gpus[index] = { name, vramBytes }; else profile.gpus.push({ name, vramBytes });
    }
  } catch {}
  return profile;
}
async function modelSupportsVision(model) {
  if (runtimeKind === 'llamacpp') return null; // GGUF vision support isn't modeled here; the one-shot text recovery handles a rejection.
  if (visionCapability.has(model)) return visionCapability.get(model);
  try {
    const tag = (await ollama('/api/tags')).models?.find((item) => item.name === model);
    if (Array.isArray(tag?.capabilities)) {
      const supported = tag.capabilities.includes('vision'); visionCapability.set(model, supported); return supported;
    }
    const u = runtimeEndpoint('/api/show');
    const body = JSON.stringify({ model });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = ''; res.on('data', (chunk) => (text += chunk)); res.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid model metadata')); } });
      });
      req.on('error', reject); req.setTimeout(5000, () => { req.destroy(); reject(new Error('Model metadata timeout')); }); req.end(body);
    });
    const supported = Array.isArray(result.capabilities) ? result.capabilities.includes('vision') : null;
    visionCapability.set(model, supported); return supported;
  } catch { return null; } // unknown: let the one-shot recovery handle nonstandard servers
}
async function modelSupportsReasoning(model) {
  if (reasoningCapability.has(model)) return reasoningCapability.get(model);
  try {
    const u = runtimeEndpoint('/api/show'); const body = JSON.stringify({ model });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { let text = ''; res.on('data', (chunk) => (text += chunk)); res.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid model metadata')); } }); });
      req.on('error', reject); req.setTimeout(5000, () => { req.destroy(); reject(new Error('Model metadata timeout')); }); req.end(body);
    });
    const supported = Array.isArray(result.capabilities) ? result.capabilities.includes('thinking') || result.capabilities.includes('reasoning') : null;
    reasoningCapability.set(model, supported); return supported;
  } catch { return null; }
}
// Non-Ollama routes expose no capability metadata, so infer from the model name.
// true = vision, false = explicitly text-only, null = unknown. Unknown now
// *allows* images instead of denying them, so vision models are never told they
// cannot see.
function modelNameVision(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (/(vision|multimodal|[\s/_.-]vl[\s/_.-]?|omni|llava|bakllava|moondream|pixtral|internvl|minicpm-?v|molmo|qwen[\w.-]*vl|glm-?4v|glm-4\.\d+v|deepseek[\w.-]*(vl|vision)|gemini|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt|claude-3|claude-4|claude-[\w.-]*(sonnet|opus|haiku)|grok-[2-9]|grok-4|phi-[\w.-]*vision|llama[\w.-]*3\.2[\w.-]*vision|nemotron[\w.-]*vl|kimi[\w.-]*(vl|vision)|step-1v|internlm-xcomposer|ernie[\w.-]*vl|yi-[\w.-]*vision)/.test(m)) return true;
  if (/(^|[\s/_.-])(text-?embedding|embed|rerank|whisper|tts|codex-mini)([\s/_.-]|$)/.test(m)) return false;
  return null;
}
async function resolveModelCapabilities(model, productMode, provider) {
  const isOllama = !provider?.kind || provider.kind === 'ollama';
  const advertisedVision = isOllama ? await modelSupportsVision(model) : modelNameVision(model);
  const advertisedReasoning = isOllama ? await modelSupportsReasoning(model) : null;
  return modelCapabilityReport({ model, productMode, providerKind: provider?.kind || 'ollama', advertisedVision, advertisedReasoning });
}
async function capabilityBoundPrompt(systemPrompt, model, productMode, provider) {
  const report = await resolveModelCapabilities(model, productMode, provider);
  return { report, systemPrompt: [systemPrompt?.trim(), capabilityInstruction(report)].filter(Boolean).join('\n\n') };
}

// ---- Tray + window --------------------------------------------------------
function setTray(label) { trayLabel = label; if (tray) { tray.setToolTip(label); tray.setContextMenu(buildTrayMenu()); } }
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: trayLabel, enabled: false }, { type: 'separator' },
    { label: 'Open window', click: () => win?.show() }, { label: 'Quit', click: () => app.quit() },
  ]);
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(trayLabel);
  tray.on('click', () => (win ? win.show() : createWindow()));
  tray.setContextMenu(buildTrayMenu());
}
function createWindow() {
  win = new BrowserWindow({
    width: 820, height: 720, show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // NoCLI.ai's renderer owns the title bar so the app has one coherent chrome
    // instead of a Windows-coloured frame sitting above the workspace.
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const revealWindow = () => {
    if (!win || win.isDestroyed()) return;
    if (!win.isMaximized()) win.maximize();
    win.show(); win.focus();
  };
  // `ready-to-show` can be skipped on some Windows/GPU combinations even
  // though the local renderer finished normally. A loaded UI must always get
  // a visible, focused window rather than becoming a tray-only background app.
  win.webContents.once('did-finish-load', () => {
    startBackgroundUpdateChecks();
    setTimeout(revealWindow, 0);
  });
  // Treat visibility as a startup guarantee, not a renderer-side side effect.
  // In particular, a slow GPU or a failed first paint must never leave Calcium
  // running only in the tray with no way for the person who launched it to see
  // what happened.
  setTimeout(revealWindow, 1200);
  // Frameless Electron windows do not reliably inherit Chromium's browser
  // zoom shortcuts. Keep this scoped to NoCLI.ai's shell (not the agent browser).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const key = String(input.key || '').toLowerCase();
    const level = win.webContents.getZoomLevel();
    if (key === '+' || key === '=' || key === 'add') { event.preventDefault(); win.webContents.setZoomLevel(Math.min(5, level + 0.5)); }
    else if (key === '-' || key === '_' || key === 'subtract') { event.preventDefault(); win.webContents.setZoomLevel(Math.max(-5, level - 0.5)); }
    else if (key === '0' || key === 'num0') { event.preventDefault(); win.webContents.setZoomLevel(0); }
  });
  if (!app.isPackaged) {
    win.webContents.on('console-message', (_event, details) => {
      console.error(`[renderer:${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`);
    });
  }
  // Open maximized: NoCLI.ai is a workspace, and the transcript plus the browser
  // pane both want room. Maximize before showing so there is no resize flash;
  // the width/height above stay as the restore-down size.
  win.once('ready-to-show', revealWindow);
  // NoCLI.ai is an agent host: closing the window keeps active work alive in the
  // background. The tray's explicit Quit item remains the kill switch.
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault(); win.hide();
  });
  win.on('closed', () => { win = null; });
}
// Electron has no `localAppData` getPath key; use the Windows environment
// location directly so the CLI remains user-local and works in packaged builds.
function cliDirectory() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.dirname(app.getPath('appData')), 'NoCLI.ai', 'bin');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'nocli', 'bin');
}
function refreshShortcutIcons(iconPath) {
  // Pinned taskbar shortcuts cache an executable's first icon resource very aggressively.
  // Point them at a stable, transparent ICO instead.
  const appData = process.env.APPDATA;
  if (!appData || process.platform !== 'win32') return;
  const shortcuts = [
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'NoCLI.ai.lnk'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NoCLI.ai.lnk'),
  ];
  const quote = (value) => String(value).replace(/'/g, "''");
  const list = shortcuts.map((shortcut) => `'${quote(shortcut)}'`).join(',');
  const ps = `$icon='${quote(iconPath)}';@(${list})|ForEach-Object { if(Test-Path -LiteralPath $_){$s=(New-Object -ComObject WScript.Shell).CreateShortcut($_);$s.IconLocation=\"$icon,0\";$s.Save()} }`;
  // Updating the User PATH is best-effort maintenance, never startup-critical.
  // A blocked PowerShell profile/COM call must not prevent the desktop window
  // from being created on Windows.
  try {
    const updater = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' });
    updater.unref();
  } catch {}
}
function ensureCliCommand() {
  const dir = cliDirectory(); fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    const workspace = ensureDefaultWorkspace();
    const terminal = path.join(dir, 'nocli-terminal');
    fs.writeFileSync(terminal, `#!/usr/bin/env bash\ncd ${JSON.stringify(workspace)}\nexec \"${process.env.SHELL || '/bin/bash'}\" -i\n`, { mode: 0o755 });
    try { fs.chmodSync(terminal, 0o755); } catch {}
    return dir;
  }
  const iconPath = path.join(path.dirname(dir), 'NoCLI.ai.ico');
  try { fs.copyFileSync(path.join(__dirname, 'assets', 'icon.ico'), iconPath); refreshShortcutIcons(iconPath); } catch {}
  const workspace = ensureDefaultWorkspace();
  // Packaged NoCLI.ai launches directly; the dev fallback remains useful to us while testing.
  const launch = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`;
  const terminal = [
    '@echo off', 'title NoCLI.ai Terminal', 'color 0F', `cd /d "${workspace}"`, 'prompt NOCLI $P$G',
  ].join('\r\n');
  const command = ['@echo off', 'if /I "%~1"=="terminal" (', '  start "Calcium Terminal" "%ComSpec%" /k "%~dp0nocli-terminal.cmd"', '  exit /b 0', ')', `start "Calcium" ${launch}`, 'exit /b 0', ''].join('\r\n');
  fs.writeFileSync(path.join(dir, 'nocli-terminal.cmd'), terminal, 'utf8');
  fs.writeFileSync(path.join(dir, 'nocli.cmd'), command, 'utf8');
  process.env.PATH = dir + ';' + (process.env.PATH || '');
  // Persist it for future Command Prompt / Windows Terminal sessions, without touching system PATH.
  const escapedDir = dir.replace(/'/g, "''");
  const ps = `$d='${escapedDir}';$p=[Environment]::GetEnvironmentVariable('Path','User');if(-not (($p -split ';') | Where-Object { $_ -eq $d })){[Environment]::SetEnvironmentVariable('Path',(($p.TrimEnd(';')+';'+$d).TrimStart(';')),'User')};Add-Type -Name NoCLIEnv -Namespace Native -MemberDefinition '[DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,IntPtr wParam,string lParam,uint flags,uint timeout,out IntPtr result);' -ErrorAction SilentlyContinue;$r=[IntPtr]::Zero;[Native.NoCLIEnv]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,1000,[ref]$r)|Out-Null`;
  // Shortcut icon cache refresh is optional. Never synchronously wait for
  // PowerShell here: a stalled shell prevents Electron from painting its first
  // window and makes the app appear to launch invisibly.
  try {
    const refresher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' });
    refresher.unref();
  } catch {}
  return dir;
}
function openGenuineTerminal() {
  ensureCliCommand();
  if (process.platform !== 'win32') {
    const script = path.join(cliDirectory(), 'nocli-terminal');
    const terminals = [
      ['x-terminal-emulator', ['-e', script]], ['gnome-terminal', ['--', script]],
      ['konsole', ['-e', script]], ['xfce4-terminal', ['-x', script]], ['xterm', ['-e', script]],
    ];
    const choice = terminals.find(([command]) => whereFirst(command));
    if (!choice) return { ok: false, error: 'No supported terminal emulator was found. Open a terminal in your workspace manually.' };
    try { const child = spawn(choice[0], choice[1], { detached: true, stdio: 'ignore' }); child.unref(); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  }
  try {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start "NoCLI.ai Terminal" "%ComSpec%" /k "' + path.join(cliDirectory(), 'nocli-terminal.cmd') + '"'], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.unref(); return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}
function validBrowserURL(value) {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
// ---- OmniRoute (bundled local free-model gateway) --------------------------
// OmniRoute is an MIT local gateway that aggregates free/keyless providers behind
// one OpenAI-compatible endpoint. Its `auto` model routes and fails over with no
// key required, which is what the FREE MODEL tier uses.
const OMNIROUTE_ENDPOINT = 'http://127.0.0.1:20128/v1';
let omnirouteProc = null;
function omnirouteHealth(timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:20128/api/health', { timeout }, (res) => {
      let text = ''; res.on('data', (chunk) => (text += chunk));
      res.on('end', () => { try { resolve(JSON.parse(text)?.status === 'ok'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function omnirouteBin() {
  return whereFirst(process.platform === 'win32' ? 'omniroute.cmd' : 'omniroute') || whereFirst('omniroute');
}
// Starts the gateway if OmniRoute is installed but not already serving.
async function ensureOmniRoute() {
  if (await omnirouteHealth()) return { running: true, started: false, installed: true, endpoint: OMNIROUTE_ENDPOINT };
  const bin = omnirouteBin();
  if (!bin) return { running: false, installed: false, endpoint: OMNIROUTE_ENDPOINT };
  try {
    omnirouteProc = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
    omnirouteProc.unref();
  } catch { return { running: false, installed: true, endpoint: OMNIROUTE_ENDPOINT, error: 'Could not start OmniRoute.' }; }
  for (let i = 0; i < 16; i++) { await new Promise((r) => setTimeout(r, 2500)); if (await omnirouteHealth()) return { running: true, started: true, installed: true, endpoint: OMNIROUTE_ENDPOINT }; }
  return { running: false, installed: true, endpoint: OMNIROUTE_ENDPOINT, error: 'OmniRoute did not become ready in time.' };
}
function ensureBrowserPanel() {
  if (browserPanel) return browserPanel;
  // A persistent partition keeps browser logins (cookies, sessions) across
  // restarts, isolated from the app's own session.
  browserPanel = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:calcium-browser' } });
  win.contentView.addChildView(browserPanel);
  const wc = browserPanel.webContents;
  wc.setWindowOpenHandler(({ url }) => { try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch {} return { action: 'deny' }; });
  const report = (extra = {}) => {
    const url = wc.getURL() || '';
    let host = '', secure = false;
    try { const parsed = new URL(url); host = parsed.host; secure = parsed.protocol === 'https:'; } catch {}
    win?.webContents.send('browser-status', { url, title: wc.getTitle(), canBack: wc.canGoBack(), canForward: wc.canGoForward(), loading: wc.isLoading(), secure, host, ...extra });
  };
  wc.on('did-navigate', () => report());
  wc.on('did-navigate-in-page', () => report());
  wc.on('page-title-updated', () => report());
  wc.on('did-start-loading', () => report());
  wc.on('did-stop-loading', () => report());
  wc.on('page-favicon-updated', (_event, favicons) => report({ favicon: favicons?.[0] || '' }));
  wc.on('did-fail-load', (_event, code, desc, validatedURL, isMainFrame) => { if (isMainFrame && code !== -3) report({ failed: { code, desc, url: validatedURL } }); });
  wc.loadURL('https://www.google.com/');
  return browserPanel;
}
function setBrowserBounds(bounds) {
  const panel = ensureBrowserPanel();
  const x = Math.max(0, Math.floor(bounds?.x || 0)), y = Math.max(0, Math.floor(bounds?.y || 0));
  const width = Math.max(1, Math.floor(bounds?.width || 1)), height = Math.max(1, Math.floor(bounds?.height || 1));
  panel.setBounds({ x, y, width, height });
}
function browserSnapshotScript() {
  return `(() => {
    const seq = (window.__nocliSeq = window.__nocliSeq || 100000);
    const out = [];
    const seen = new Set();
    const attr = (el, n) => (el.getAttribute ? el.getAttribute(n) : '');
    const nameOf = (el) => {
      const aria = attr(el, 'aria-label'); if (aria) return String(aria).trim();
      const lb = attr(el, 'aria-labelledby');
      if (lb) { const root = el.getRootNode ? el.getRootNode() : document; const t = lb.split(/\\s+/).map((id) => { const n = root.getElementById ? root.getElementById(id) : (document.getElementById ? document.getElementById(id) : null); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ').trim(); if (t) return t; }
      if (el.labels && el.labels.length) { const t = [...el.labels].map((l) => l.innerText || l.textContent || '').join(' ').trim(); if (t) return t; }
      for (const a of ['placeholder', 'alt', 'title', 'name']) { const v = attr(el, a); if (v) return String(v).trim(); }
      return (el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    };
    const visible = (el) => {
      if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
    };
    const selector = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
    const push = (el) => {
      if (out.length >= 180 || seen.has(el) || !el.tagName || !visible(el)) return;
      seen.add(el);
      let id = el.dataset ? el.dataset.nocliBrowserId : '';
      if (!id) { id = 'nocli-' + (++window.__nocliSeq); try { el.dataset.nocliBrowserId = id; } catch {} }
      const r = el.getBoundingClientRect();
      const dialog = !!(el.closest && el.closest('dialog[open],[role="dialog"],[aria-modal="true"]'));
      out.push({ id, tag: el.tagName.toLowerCase(), role: attr(el, 'role') || undefined, name: nameOf(el), type: el.type || undefined, value: (el.value !== undefined && el.type !== 'password') ? String(el.value).slice(0, 100) : undefined, disabled: (el.disabled || attr(el, 'aria-disabled') === 'true') || undefined, checked: typeof el.checked === 'boolean' ? el.checked : undefined, dialog: dialog || undefined, inView: (r.top >= -2 && r.bottom <= innerHeight + 2) || undefined, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    };
    const walk = (root) => {
      let nodes; try { nodes = root.querySelectorAll(selector); } catch { return; }
      for (const el of nodes) push(el);
      let all; try { all = root.querySelectorAll('*'); } catch { return; }
      for (const el of all) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') { try { if (el.contentDocument) { for (const f of el.contentDocument.querySelectorAll(selector)) push(f); } } catch {} }
      }
    };
    walk(document);
    const dialogs = document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]').length;
    const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 12000);
    return { title: document.title, url: location.href, dialogCount: dialogs, text, controls: out, hint: out.some((c) => c.dialog) ? 'A dialog is open; its controls are marked dialog:true.' : undefined };
  })()`;
}
// Resolve a snapshot id to viewport coordinates (walking out of same-origin
// iframes) plus what the element is.
function browserResolveScript(id) {
  return `(() => {
    const el = document.querySelector('[data-nocli-browser-id="${id}"]');
    if (!el) return { error: 'That page element is no longer available. Read the page again.' };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    try { let w = window; while (w !== window.top) { const fe = w.frameElement; if (!fe) break; const fr = fe.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; } } catch {}
    return { ok: true, x: Math.round(x), y: Math.round(y), tag: el.tagName.toLowerCase(), editable: !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'), name: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
  })()`;
}
async function readBrowser() {
  const panel = ensureBrowserPanel();
  return panel.webContents.executeJavaScript(browserSnapshotScript(), true);
}
// A visible cursor the agent can drive, so clicks/typing/points are legible to
// the user and show up in screenshots. Built with CSSOM styles (not inline
// style attributes) so page CSP cannot strip it.
function browserCursorScript(id, pulse = false) {
  return `(() => {
    const el = document.querySelector('[data-nocli-browser-id="${id}"]');
    if (!el) return { error: 'That page element is no longer available. Read the page again.' };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const doc = document, mount = doc.body || doc.documentElement;
    let cursor = doc.getElementById('__nocli_cursor');
    if (!cursor) {
      cursor = doc.createElement('div');
      cursor.id = '__nocli_cursor';
      Object.assign(cursor.style, { position: 'fixed', left: '0px', top: '0px', width: '30px', height: '30px', zIndex: '2147483647', pointerEvents: 'none', transition: 'transform .2s cubic-bezier(.22,1,.36,1)', transform: 'translate(-300px,-300px)', willChange: 'transform' });
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '30'); svg.setAttribute('height', '30'); svg.setAttribute('viewBox', '0 0 24 24');
      svg.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,.55))';
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5 3l14 8-6 1.7L10 19 5 3z');
      path.setAttribute('fill', '#ffffff'); path.setAttribute('stroke', '#0d0d0d'); path.setAttribute('stroke-width', '1.2'); path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path); cursor.appendChild(svg);
      mount.appendChild(cursor);
    }
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    if (${pulse ? 'true' : 'false'}) {
      const halo = doc.createElement('div');
      Object.assign(halo.style, { position: 'fixed', left: (x - 10) + 'px', top: (y - 10) + 'px', width: '20px', height: '20px', border: '2px solid rgba(255,255,255,.95)', borderRadius: '50%', zIndex: '2147483647', pointerEvents: 'none', transition: 'transform .5s ease-out, opacity .5s ease-out', transform: 'scale(1)', opacity: '.95' });
      mount.appendChild(halo);
      requestAnimationFrame(() => { halo.style.transform = 'scale(3)'; halo.style.opacity = '0'; });
      setTimeout(() => { try { halo.remove(); } catch {} }, 560);
    }
    return { ok: true, x: x, y: y };
  })()`;
}
function revealBrowser(url) {
  const valid = validBrowserURL(url);
  if (!valid) throw new Error('Use a full http:// or https:// address.');
  const panel = ensureBrowserPanel();
  win?.webContents.send('browser-invoked', { url: valid });
  panel.webContents.loadURL(valid);
  return { url: valid };
}
function startBrowserBridge() {
  if (browserBridge) return Promise.resolve();
  browserBridgeToken = crypto.randomBytes(32).toString('hex');
  browserBridge = http.createServer((request, response) => {
    const done = (status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.method !== 'POST' || request.headers['x-nocli-browser-token'] !== browserBridgeToken) return done(403, { error: 'NoCLI.ai Browser access denied.' });
    let raw = ''; request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 128 * 1024) request.destroy(); });
    request.on('end', async () => {
      let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch { return done(400, { error: 'Invalid browser request.' }); }
      try {
        const action = request.url?.replace(/^\//, '');
        if (action === 'open') {
          const valid = validBrowserURL(payload.url);
          if (!valid) throw new Error('Use a full http:// or https:// address.');
          win?.webContents.send('browser-invoked', { url: valid });
          const target = ensureBrowserPanel().webContents;
          const loaded = new Promise((resolve) => { const timer = setTimeout(resolve, 12000); target.once('did-finish-load', () => { clearTimeout(timer); resolve(); }); });
          target.loadURL(valid);
          await loaded;
          return done(200, { url: valid });
        }
        // Any native browser tool invocation should reveal the sidecar. In
        // particular, agents commonly start with browser_read rather than
        // browser_open, and failed interactions should still be visible.
        win?.webContents.send('browser-invoked', {});
        if (action === 'read') return done(200, await readBrowser());
        const wc = ensureBrowserPanel().webContents;
        if (['click', 'type', 'point', 'press', 'scroll', 'find', 'dismiss', 'wait'].includes(action)) {
          const id = String(payload.id || '');
          const hasId = /^nocli-\d+$/.test(id);
          if (['click', 'type', 'point'].includes(action) && !hasId) throw new Error('Use an element ID returned by browser_read.');
          const target = hasId ? await wc.executeJavaScript(browserResolveScript(id), true) : null;
          if (target && target.error) throw new Error(target.error);
          if (action === 'point') { await wc.executeJavaScript(browserCursorScript(id, false), true); return done(200, { ok: true, x: target.x, y: target.y, name: target.name }); }
          if (action === 'click') {
            await wc.executeJavaScript(browserCursorScript(id, true), true);
            const { x, y } = target;
            wc.sendInputEvent({ type: 'mouseMove', x, y });
            wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
            return done(200, { ok: true, clicked: target.name, x, y });
          }
          if (action === 'type') {
            await wc.executeJavaScript(browserCursorScript(id, false), true);
            const focused = await wc.executeJavaScript(`(() => { const el = document.querySelector('[data-nocli-browser-id="${id}"]'); if (!el) return { error: 'That page element is no longer available. Read the page again.' }; el.focus(); try { if (el.select) el.select(); else { const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); s.addRange(r); } } catch {} return { ok: true }; })()`, true);
            if (focused?.error) throw new Error(focused.error);
            wc.insertText(String(payload.text || ''));
            await wc.executeJavaScript(`(() => { const el = document.querySelector('[data-nocli-browser-id="${id}"]'); if (el) el.dispatchEvent(new Event('change', { bubbles: true })); })()`, true);
            return done(200, { ok: true, typed: String(payload.text || '').slice(0, 80) });
          }
          if (action === 'press') { const key = String(payload.key || 'Enter'); wc.sendInputEvent({ type: 'keyDown', keyCode: key }); wc.sendInputEvent({ type: 'keyUp', keyCode: key }); return done(200, { ok: true, key }); }
          if (action === 'scroll') {
            const amount = Math.abs(Number(payload.amount) || 700);
            const delta = String(payload.direction || 'down') === 'up' ? -amount : amount;
            const res = await wc.executeJavaScript(`(() => { window.scrollBy(0, ${delta}); return { scrollY: Math.round(window.scrollY), height: document.body ? document.body.scrollHeight : 0 }; })()`, true);
            return done(200, res);
          }
          if (action === 'find') {
            const query = JSON.stringify(String(payload.text || '').toLowerCase());
            const res = await wc.executeJavaScript(`(() => { const q = ${query}; if (!q) return { matches: [] }; const hits = []; const list = document.querySelectorAll('a,button,input,textarea,select,summary,[role],h1,h2,h3,label,span,div,p,li'); for (const el of list) { if (hits.length >= 20) break; const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue; const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(); if (!t || t.toLowerCase().indexOf(q) < 0) continue; let id = el.dataset.nocliBrowserId; if (!id) { id = 'nocli-' + (++window.__nocliSeq); el.dataset.nocliBrowserId = id; } hits.push({ id, tag: el.tagName.toLowerCase(), text: t.slice(0, 120) }); } return { matches: hits }; })()`, true);
            return done(200, res);
          }
          if (action === 'dismiss') {
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            const res = await wc.executeJavaScript(`(() => { const btns = [...document.querySelectorAll('button,[role="button"],[aria-label]')].filter((el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; return /close|dismiss|cancel|later|skip|no thanks|not now|got it|accept|agree|allow|continue/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')); }); const el = btns[0]; if (!el) return { dismissed: null }; const label = (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40); el.click(); return { dismissed: label }; })()`, true);
            return done(200, res);
          }
          if (action === 'wait') {
            const query = JSON.stringify(String(payload.text || '').toLowerCase());
            const timeout = Math.min(Number(payload.timeout) || 8000, 20000);
            const start = Date.now(); let found = false;
            while (Date.now() - start < timeout) {
              const ok = await wc.executeJavaScript(`(() => { const q = ${query}; if (!q) return false; return ((document.body ? document.body.innerText : '').toLowerCase().indexOf(q) >= 0); })()`, true);
              if (ok) { found = true; break; }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            return done(200, { found, waitedMs: Date.now() - start });
          }
        }
        if (action === 'screenshot') {
          const image = await wc.capturePage();
          return done(200, { mimeType: 'image/png', data: image.toPNG().toString('base64') });
        }
        return done(404, { error: 'Unknown browser action.' });
      } catch (error) { return done(400, { error: error.message }); }
    });
  });
  return new Promise((resolve, reject) => {
    browserBridge.once('error', reject);
    browserBridge.listen(0, '127.0.0.1', () => {
      const address = browserBridge.address(); browserBridgeEndpoint = `http://127.0.0.1:${address.port}`; resolve();
    });
  });
}
function ensureNocliBrowserMcpConfig(provider = null) {
  const home = path.join(app.getPath('userData'), 'terminal'); fs.mkdirSync(home, { recursive: true });
  const quote = (value) => JSON.stringify(String(value));
  const mcpScript = app.isPackaged ? path.join(process.resourcesPath, 'nocli-browser-mcp.js') : path.join(__dirname, 'nocli-browser-mcp.js');
  let profile = `[mcp_servers.nocli_browser]\ncommand = ${quote(process.execPath)}\nargs = [${quote(mcpScript)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`;
  if (provider?.kind === 'responses') {
    profile += `\nmodel_provider = "nocli_custom"\n[model_providers.nocli_custom]\nname = ${quote(provider.name || 'NoCLI.ai API')}\nbase_url = ${quote(provider.endpoint)}\nenv_key = "NOCLI_PROVIDER_API_KEY"\nwire_api = "responses"\n`;
  }
  fs.writeFileSync(path.join(home, 'browser.config.toml'), profile, 'utf8');
  return home;
}
function browserMcpLaunch() {
  const script = app.isPackaged ? path.join(process.resourcesPath, 'nocli-browser-mcp.js') : path.join(__dirname, 'nocli-browser-mcp.js');
  return {
    command: process.execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1', NOCLI_BROWSER_ENDPOINT: browserBridgeEndpoint, NOCLI_BROWSER_TOKEN: browserBridgeToken, NOCLI_BROWSER_ALLOW_SCREENSHOT: '1' },
  };
}
function browserMcpJson() {
  const launch = browserMcpLaunch();
  return JSON.stringify({ mcpServers: { nocli_browser: launch } });
}

// ---- execution permissions -------------------------------------------------
// The official CLI enforces the sandbox; this only validates the renderer value.
const PERMISSION_MODES = new Set(['approve', 'auto', 'full']);
const normalizeMode = (value) => (PERMISSION_MODES.has(value) ? value : 'auto');
const isOllamaCloudModel = (model, provider) =>
  (!provider?.kind || provider.kind === 'ollama') && /(?:^|[:._-])cloud$/i.test(String(model || ''));

// NoCLI.ai Chat deliberately avoids an agent harness. It is a fast, local-first
// conversation surface backed by the selected Ollama-compatible runtime.
const directChatSessions = new Map();
function apiEndpoint(base, pathName) {
  const baseUrl = new URL(String(base || '').replace(/\/$/, '') + '/');
  return new URL(pathName.replace(/^\//, ''), baseUrl.href.endsWith('/v1/') ? baseUrl : new URL('v1/', baseUrl));
}
// Reuse connections across turns (and for the startup warm-up) so each request
// does not pay a fresh TCP/TLS handshake before the first token.
const keepAliveAgents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }) };
const agentFor = (target) => keepAliveAgents[target?.protocol];
function warmProvider(provider, model) {
  return new Promise((resolve) => {
    const name = String(model || provider?.model || '').trim();
    if (!provider || !provider.endpoint || !name) return resolve({ ok: false });
    let target; try { target = apiEndpoint(provider.endpoint, provider.kind === 'responses' ? 'responses' : 'chat/completions'); } catch { return resolve({ ok: false }); }
    const key = readProviderSecret(provider?.credentialId);
    const keylessLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(String(provider.endpoint || ''));
    if (!key && !keylessLocal) return resolve({ ok: false });
    const client = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(provider.kind === 'responses'
      ? { model: name, input: 'ping', max_output_tokens: 8, stream: false }
      : { model: name, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false });
    const req = client.request(target, { method: 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, agent: agentFor(target) }, (res) => {
      res.resume(); res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false }); });
    req.end(payload);
  });
}
// A single non-streaming completion, used for small side tasks like naming a chat.
async function completeOnce(provider, model, messages, maxTokens = 24) {
  return new Promise((resolve) => {
    const kind = provider?.kind || 'ollama';
    const responses = kind === 'responses';
    let base = provider?.endpoint;
    if (!base && kind === 'ollama') base = `${activeOllamaUrl().replace(/\/$/, '')}/v1`;
    let target; try { target = apiEndpoint(base, responses ? 'responses' : 'chat/completions'); } catch { return resolve(''); }
    const key = readProviderSecret(provider?.credentialId);
    const keylessLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(String(base || ''));
    if (!key && !keylessLocal && kind !== 'ollama') return resolve('');
    const client = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(responses
      ? { model, input: messages, max_output_tokens: maxTokens, stream: false }
      : { model, messages, max_tokens: maxTokens, temperature: 0.2, stream: false });
    const req = client.request(target, { method: 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, agent: agentFor(target) }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const text = responses ? (json.output_text || json.output?.[0]?.content?.[0]?.text || '') : (json.choices?.[0]?.message?.content || '');
          resolve(String(text || '').trim());
        } catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(30000, () => { req.destroy(); resolve(''); });
    req.end(payload);
  });
}
function runApiChat(model, prompt, sessionId, send, systemPrompt, holder, provider, history, user) {
  return new Promise((resolve) => {
    const key = readProviderSecret(provider?.credentialId);
    // Loopback gateways (OmniRoute and local bridges) are keyless by design.
    const keylessLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(String(provider?.endpoint || ''));
    if (!key && !keylessLocal) { send('chat-error', 'This provider profile has no saved API key. Add one in Settings.'); send('chat-done', { sessionId, ok: false }); return resolve(); }
    const sid = sessionId || crypto.randomUUID();
    const responses = provider.kind === 'responses';
    let target; try { target = apiEndpoint(provider.endpoint, responses ? 'responses' : 'chat/completions'); } catch { send('chat-error', 'This provider has an invalid endpoint.'); send('chat-done', { sessionId: sid, ok: false }); return resolve(); }
    const messages = systemPrompt?.trim() ? [{ role: 'system', content: systemPrompt.trim() }, ...history, user] : [...history, user];
    const body = responses ? { model, input: messages, stream: true } : { model, messages, stream: true };
    const client = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const request = client.request(target, { method: 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, agent: agentFor(target) }, (response) => {
      let buffer = '', assistant = '', completed = false;
      if (response.statusCode < 200 || response.statusCode >= 300) { response.setEncoding('utf8'); response.on('data', (chunk) => { buffer += chunk; }); response.on('end', () => { send('chat-error', `Provider request failed: ${buffer.slice(0, 300) || response.statusCode}`); send('chat-done', { sessionId: sid, ok: false }); resolve(); }); return; }
      const finish = () => { if (completed) return; completed = true; directChatSessions.set(sid, [...history, user, { role: 'assistant', content: assistant }].slice(-40)); send('chat-done', { sessionId: sid, ok: true }); resolve(); };
      response.setEncoding('utf8'); response.on('data', (chunk) => {
        buffer += chunk; let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (data === '[DONE]') { finish(); continue; }
          let event; try { event = JSON.parse(data); } catch { continue; }
          const delta = event.choices?.[0]?.delta || {};
          const reasoning = responses
            ? (typeof event.type === 'string' && event.type.includes('reasoning') && typeof event.delta === 'string' ? event.delta : '')
            : (delta.reasoning_content || delta.reasoning || '');
          if (typeof reasoning === 'string' && reasoning) send('chat-step', { type: 'thinking', text: reasoning });
          const text = responses
            ? (typeof event.type === 'string' && event.type.includes('reasoning') ? '' : (event.delta || event.text || ''))
            : (delta.content || '');
          if (typeof text === 'string' && text) { assistant += text; send('chat-delta', text); }
          if (event.type === 'response.completed') finish();
        }
      });
      response.on('end', finish); response.on('error', (error) => { send('chat-error', error.message); send('chat-done', { sessionId: sid, ok: false }); resolve(); });
    });
    holder.child = request; request.on('error', (error) => { send('chat-error', `Provider request failed: ${error.message}`); send('chat-done', { sessionId: sid, ok: false }); resolve(); }); request.end(payload);
  });
}
function runLlamaCppChat(model, history, user, sessionId, send, systemPrompt, holder) {
  return new Promise((resolve) => {
    const sid = sessionId || crypto.randomUUID();
    const messages = systemPrompt?.trim() ? [{ role: 'system', content: systemPrompt.trim() }, ...history, user] : [...history, user];
    const payload = JSON.stringify({ model, messages, stream: true });
    const target = new URL('/v1/chat/completions', `http://127.0.0.1:${llamaCppConfig.apiPort}`);
    const request = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, agent: agentFor(target) }, (response) => {
      let buffer = '', assistant = '', completed = false;
      const finish = (ok) => {
        if (completed) return; completed = true;
        if (assistant) directChatSessions.set(sid, [...history, user, { role: 'assistant', content: assistant }].slice(-40));
        send('chat-done', { sessionId: sid, ok }); resolve();
      };
      if (response.statusCode !== 200) {
        response.setEncoding('utf8'); response.on('data', (chunk) => { buffer += chunk; });
        response.on('end', () => { send('chat-error', `llama.cpp request failed: ${buffer.slice(0, 300) || response.statusCode}`); finish(false); });
        return;
      }
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk; let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const value = line.slice(5).trim(); if (value === '[DONE]') return finish(true);
          let event; try { event = JSON.parse(value); } catch { continue; }
          const text = event.choices?.[0]?.delta?.content;
          if (typeof text === 'string' && text) { assistant += text; send('chat-delta', text); }
        }
      });
      response.on('end', () => finish(!!assistant));
      response.on('error', (error) => { send('chat-error', error.message); finish(false); });
    });
    holder.child = request;
    request.on('error', (error) => { send('chat-error', `llama.cpp request failed: ${error.message}`); send('chat-done', { sessionId: sid, ok: false }); resolve(); });
    request.end(payload);
  });
}
function runDirectChat(model, prompt, sessionId, send, systemPrompt, holder, images = [], provider = null) {
  holder = holder || {};
  return new Promise((resolve) => {
    const sid = sessionId || crypto.randomUUID();
    const history = directChatSessions.get(sid) || [];
    const user = { role: 'user', content: prompt };
    if (images.length) user.images = images.map((image) => image.data);
    const messages = systemPrompt?.trim()
      ? [{ role: 'system', content: systemPrompt.trim() }, ...history, user]
      : [...history, user];
    if (provider?.kind && provider.kind !== 'ollama') return runApiChat(model, prompt, sid, send, systemPrompt, holder, provider, history, user).then(resolve);
    if (runtimeKind === 'llamacpp') return runLlamaCppChat(model, history, user, sid, send, systemPrompt, holder).then(resolve);
    const target = runtimeEndpoint('/api/chat');
    const client = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ model, messages, stream: true });
    const request = client.request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      agent: agentFor(target),
    }, (response) => {
      if (response.statusCode !== 200) {
        let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => { send('chat-error', `NoCLI.ai Chat could not reach ${target.origin}: ${body.slice(0, 300) || response.statusCode}`); send('chat-done', { sessionId: sid, ok: false }); resolve(); });
        return;
      }
      let buffer = '', assistant = '', completed = false;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk; let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event; try { event = JSON.parse(line); } catch { continue; }
          const text = event.message?.content;
          if (typeof text === 'string' && text) { assistant += text; send('chat-delta', text); }
          if (event.done) {
            completed = true;
            directChatSessions.set(sid, [...history, user, { role: 'assistant', content: assistant }].slice(-40));
            send('chat-done', { sessionId: sid, ok: true }); resolve();
          }
        }
      });
      response.on('end', () => {
        if (completed) return;
        if (assistant) directChatSessions.set(sid, [...history, user, { role: 'assistant', content: assistant }].slice(-40));
        send('chat-done', { sessionId: sid, ok: !!assistant }); resolve();
      });
      response.on('error', (error) => { send('chat-error', error.message); send('chat-done', { sessionId: sid, ok: false }); resolve(); });
    });
    holder.child = request;
    request.on('error', (error) => { send('chat-error', `NoCLI.ai Chat request failed: ${error.message}`); send('chat-done', { sessionId: sid, ok: false }); resolve(); });
    request.end(payload);
  });
}

function runOfficialCodex(model, prompt, sessionId, send, systemPrompt, cwd, holder, images = [], permissionMode = 'auto', productMode = 'code', provider = null, capabilities = null) {
  holder = holder || {};
  return new Promise((resolve) => {
    const launch = findOfficialCodexCli();
    if (!launch) {
      send('chat-error', 'Codex CLI is not installed or not on PATH. Install and sign in with the official Codex CLI, then retry.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    const root = cwd || ensureDefaultWorkspace();
    const sandbox = { approve: 'read-only', auto: 'workspace-write', full: 'danger-full-access' }[normalizeMode(permissionMode)];
    const instruction = [
      systemPrompt?.trim(),
      productMode === 'agent' ? 'You are Calcium Work. Execute the requested multi-step task toward a finished outcome. Use the browser when research or website interaction is needed; delegate only concrete, independent workstreams when they materially help; keep all workers within the parent workspace and permission boundary.' : 'You are Calcium Code. Work directly in the current repository, use the browser only for focused implementation research, verify your changes, and keep the user informed. Do not delegate or turn the task into an autonomous workstream.',
      prompt,
    ].filter(Boolean).join('\n\n');
    const providerKind = provider?.kind || 'ollama';
    const usingOllamaCloud = isOllamaCloudModel(model, provider);
    if (!['ollama', 'responses'].includes(providerKind)) {
      send('chat-error', 'Codex CLI needs an Ollama or Responses-compatible route. Pick a different engine for this provider.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    // Keep the official CLI's own auth and config untouched. NoCLI only adds a
    // non-secret launch profile so every adapter has one inspectable home.
    const mcp = browserMcpLaunch();
    const toml = (value) => JSON.stringify(String(value));
    const common = ['--json', '--skip-git-repo-check', '--sandbox', sandbox, '-C', root,
      '-c', `mcp_servers.nocli_browser.command=${toml(mcp.command)}`,
      '-c', `mcp_servers.nocli_browser.args=[${mcp.args.map(toml).join(',')}]`,
      '-c', `mcp_servers.nocli_browser.env={${Object.entries(mcp.env).map(([key, value]) => `${key}=${toml(value)}`).join(',')}}`];
    if (providerKind === 'ollama') common.push('--oss', '--local-provider', 'ollama');
    if (model) common.push('--model', model);
    // `resume` has its own narrower option set. Put shared exec options before
    // the subcommand so profile, sandbox, and browser MCP setup apply to both
    // a new session and a resumed one.
    const args = sessionId
      ? ['exec', ...common, 'resume', sessionId, instruction]
      : ['exec', ...common, instruction];
    const context = prepareHarnessContext(nocliConfigHome, { engine: 'codex', providerKind, providerName: provider?.name, model, scope: productMode, workspace: root });
    const env = { ...process.env, ...context.env };
    const child = spawn(launch.command, [...launch.prefix, ...args], { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    holder.child = child;
    let buffer = '', resultSid = sessionId || null, stderr = '', failed = false;
    const finish = (ok) => { if (holder.child === child) holder.child = null; send('chat-done', { sessionId: resultSid, ok }); resolve(); };
    child.stdout.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'thread.started' && event.thread_id) resultSid = event.thread_id;
        if (event.type === 'item.started' && event.item?.type === 'command_execution') send('chat-step', { type: 'tool_call', fn: 'Codex CLI', args: { command: event.item.command || 'Running tool' } });
        if (event.type === 'item.completed' && event.item?.type === 'command_execution') send('chat-step', { type: 'tool_result', result: event.item.aggregated_output || event.item.status || 'Command completed' });
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) send('chat-delta', event.item.text);
        if (event.type === 'turn.failed' || event.type === 'error') {
          failed = true;
          const message = event.error?.message || event.message || 'Codex CLI failed to complete this turn.';
          // A few cloud models still reject one of the richer terminal tool
          // schemas. Keep the real cause in the UI, but make it actionable:
          // this is a per-model provider limitation, not a VRAM requirement.
          const schemaRejected = /(?:tools?\.\d+\.function.*name.*required|name.*required.*tools?\.\d+\.function|tool schema)/i.test(message);
          send('chat-error', usingOllamaCloud && schemaRejected
            ? "Ollama Cloud rejected an NoCLI.ai Terminal custom tool before the model could run. This is a protocol mismatch, not a VRAM or API-key issue. Chat works; Cloud Code and Work need NoCLI.ai's native-function compatibility bridge."
            : message);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (holder.steer) { holder.steer = false; send('chat-done', { sessionId: resultSid, ok: false, steered: true }); return resolve(); }
      if (code && !failed) send('chat-error', `Codex CLI exited ${code}${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`);
      finish(!code && !failed);
    });
    child.on('error', (error) => { send('chat-error', `Could not start Codex CLI: ${error.message}`); finish(false); });
  });
}

// Swarm is a Sentry-directed fan-out: the Sentry first reasons about the
// outcome and writes each worker's role and brief, workers then investigate
// under a technically-enforced read-only sandbox (not just a prompt
// instruction -- see runOfficialCodex's sandbox map and isMutatingCommand in
// ollama-cloud-agent.js), and finally the Sentry reconciles every worker's
// findings, including any code they propose, into one final result.
const activeSwarms = new Map();
function swarmLimit(provider) { return (provider?.kind || 'ollama') === 'ollama' ? 3 : Infinity; }
// Fallback only, used if the Sentry's planning call returns unusable JSON.
const SWARM_FALLBACK_LANES = [
  { role: 'Scout', brief: 'Map the problem, unknowns, relevant evidence, and constraints.' },
  { role: 'Builder', brief: 'Develop a concrete implementation or execution approach.' },
  { role: 'Skeptic', brief: 'Look for risks, counterexamples, and verification steps.' },
];
async function planSwarmRoles({ sentryModel, prompt, count, provider }) {
  const ask = `You are the NoCLI.ai Swarm Sentry. Before any worker runs, reason about how to best split the outcome below into ${count} independent, non-overlapping investigation roles that will each report back to you.\n\nOutcome:\n${prompt}\n\nFirst, in 2-4 sentences, explain your reasoning: what needs investigating, and how you're dividing it. Then on its own line write exactly ---ROLES--- and after that ONLY a JSON array of exactly ${count} objects: [{"role": "<2-4 word role name>", "brief": "<specific instructions for this worker, tailored to this outcome, 1-3 sentences>"}]. Nothing after the JSON.`;
  let text = '';
  const holder = {};
  const send = (channel, value) => { if (channel === 'chat-delta') text += String(value || ''); };
  const plannerPrompt = 'You plan Swarm worker roles. Explain your reasoning briefly, then the JSON plan after ---ROLES---.';
  try {
    // The Sentry only needs text back, so it plans over whichever engine the
    // profile selects and falls back to the direct route when none applies.
    const planner = ENGINE_RUNNERS[normalizeEngine(provider?.engine)];
    if (planner) await planner({ model: sentryModel, prompt: ask, sessionId: null, send, systemPrompt: plannerPrompt, cwd: ensureDefaultWorkspace(), holder, images: [], permission: 'approve', productMode: 'chat', provider, capabilities: null });
    else await runDirectChat(sentryModel, ask, null, send, plannerPrompt, holder, [], provider);
  } catch { /* fall through to fallback lanes */ }
  const split = text.split('---ROLES---');
  const reasoning = (split[0] || '').trim().slice(0, 2000);
  const jsonSource = split.length > 1 ? split.slice(1).join('---ROLES---') : text;
  let roles = [];
  const match = jsonSource.match(/\[[\s\S]*\]/);
  if (match) { try { roles = JSON.parse(match[0]); } catch { roles = []; } }
  roles = roles.filter((r) => r && typeof r.role === 'string' && typeof r.brief === 'string').map((r) => ({ role: r.role.slice(0, 60), brief: r.brief.slice(0, 800) })).slice(0, count);
  for (let i = roles.length; i < count; i++) roles.push(SWARM_FALLBACK_LANES[i % SWARM_FALLBACK_LANES.length]);
  return { roles, reasoning: reasoning || `Splitting this into ${count} roles: ${roles.map((r) => r.role).join(', ')}.` };
}
async function runSwarm({ swarmId, sentryModel, workerModel, prompt, images = [], workers, systemPrompt, cwd, provider, permissionMode }) {
  const cap = swarmLimit(provider);
  const count = Math.min(workers, cap);
  const root = cwd || ensureDefaultWorkspace();
  const mode = normalizeMode(permissionMode);
  // Cloud-routed workers still need run_command reachable to investigate at
  // all (Approve hard-blocks it in runOllamaCloudAgent), so give them Auto's
  // execution floor -- but readOnly:true below is what actually stops writes.
  const cloudExecMode = mode === 'approve' ? 'auto' : mode;
  // productMode is 'code' for the actual run below, so the bound system
  // prompt must claim 'code' capabilities too -- claiming 'agent' here
  // previously told the model about tools it was then never given.
  const workerBound = await capabilityBoundPrompt(systemPrompt, workerModel, 'code', provider);
  const group = { holders: new Map() }; activeSwarms.set(swarmId, group);
  const emit = (update) => win?.webContents.send('subagent-update', { swarmId, ...update });
  const sentryId = crypto.randomUUID(); const sentryHolder = {}; group.holders.set(sentryId, sentryHolder);
  emit({ id: swarmId, status: 'planning', task: 'Sentry · reasoning about the outcome', model: sentryModel, startedAt: Date.now() });
  emit({ id: sentryId, status: 'planning', task: 'Sentry · planning worker roles', model: sentryModel, startedAt: Date.now() });
  const { roles, reasoning } = await planSwarmRoles({ sentryModel, prompt, count, provider });
  emit({ id: sentryId, status: 'working', task: 'Sentry · planning worker roles', model: sentryModel, result: reasoning });
  const runWorker = async (index) => {
    const id = crypto.randomUUID(); const holder = {}; group.holders.set(id, holder);
    const { role, brief: roleBrief } = roles[index];
    const task = `NoCLI.ai Swarm worker ${index + 1} of ${count}. Role: ${role}. ${roleBrief} Independently investigate this outcome. Use the workspace and browser tools available to inspect the real context, then return concise actionable findings -- including any code, diffs, or commands you'd propose -- for the Sentry. Do not delegate. You are running read-only: you cannot modify files, so report a proposed change instead of applying it.\n\nOutcome:\n${prompt}`;
    let result = '', failure = ''; const steps = [];
    emit({ id, status: 'working', task: `Worker ${index + 1} · ${role}`, role, brief: roleBrief, model: workerModel, startedAt: Date.now() });
    const send = (channel, value) => {
      if (channel === 'chat-delta') result = (result + String(value || '')).slice(-16000);
      else if (channel === 'chat-error') failure = String(value || 'Worker failed.');
      else if (channel === 'chat-step') {
        const v = value || {};
        steps.push(v.type === 'tool_call' ? `-> ${v.fn || 'tool'}${v.args?.command ? ': ' + String(v.args.command).slice(0, 140) : ''}` : `<- ${String(v.result || '').slice(0, 140)}`);
        if (steps.length > 40) steps.shift();
        emit({ id, status: 'working', task: `Worker ${index + 1} · ${role}`, role, brief: roleBrief, model: workerModel, steps: steps.slice(-8) });
      }
    };
    try {
      if (isOllamaCloudModel(workerModel, provider)) {
        await runOllamaCloudAgent({ endpoint: activeOllamaUrl(), model: workerModel, prompt: task, systemPrompt: workerBound.systemPrompt, cwd: root, permissionMode: cloudExecMode, productMode: 'code', send, holder, browser: { open: revealBrowser, read: readBrowser }, allowDelegation: false, readOnly: true });
      } else {
        // 'approve' always maps to Codex CLI's read-only sandbox below --
        // workers get this regardless of the app's global permission mode,
        // so read-only is enforced here, not merely requested in the prompt.
        await runOfficialCli(workerModel, task, null, send, workerBound.systemPrompt, root, holder, images, 'approve', 'code', provider, workerBound.report);
      }
      const summary = failure || result || '(worker completed without a text summary)';
      emit({ id, status: failure ? 'failed' : 'completed', result: summary, finishedAt: Date.now() });
      return { role, brief: roleBrief, summary, failed: !!failure };
    } catch (error) {
      const summary = error.message; emit({ id, status: 'failed', result: summary, finishedAt: Date.now() }); return { role, brief: roleBrief, summary, failed: true };
    } finally { group.holders.delete(id); }
  };
  emit({ id: swarmId, status: 'launching', task: `NoCLI.ai Swarm · Sentry + ${count} workers`, model: sentryModel, startedAt: Date.now() });
  const reports = await Promise.all(Array.from({ length: count }, (_, index) => runWorker(index)));
  const sentryBound = await capabilityBoundPrompt(systemPrompt, sentryModel, 'code', provider);
  const brief = reports.map((report, index) => `Worker ${index + 1} -- ${report.role} (${report.brief}):\n${report.summary.slice(0, 6000)}`).join('\n\n');
  const sentryTask = `You are the NoCLI.ai Swarm Sentry. You planned the roles below and dispatched these workers; now reconcile their reports into one final result. Preserve and present any code, diffs, commands, or concrete artifacts a worker proposed -- don't summarize code away. Reconcile disagreements, identify the strongest evidence, state remaining uncertainty, and return one complete, decision-ready final result for the original outcome. Do not delegate or modify files.\n\nOriginal outcome:\n${prompt}\n\nWorker reports:\n${brief}`;
  let sentryResult = '', sentryFailure = '';
  emit({ id: sentryId, status: 'working', task: 'Sentry · synthesize worker reports', model: sentryModel, startedAt: Date.now() });
  const sentrySend = (channel, value) => { if (channel === 'chat-delta') sentryResult = (sentryResult + String(value || '')).slice(-24000); if (channel === 'chat-error') sentryFailure = String(value || 'Sentry failed.'); };
  try {
    if (isOllamaCloudModel(sentryModel, provider)) await runOllamaCloudAgent({ endpoint: activeOllamaUrl(), model: sentryModel, prompt: sentryTask, systemPrompt: sentryBound.systemPrompt, cwd: root, permissionMode: cloudExecMode, productMode: 'code', send: sentrySend, holder: sentryHolder, browser: { open: revealBrowser, read: readBrowser }, allowDelegation: false, readOnly: true });
    else await runOfficialCli(sentryModel, sentryTask, null, sentrySend, sentryBound.systemPrompt, root, sentryHolder, [], 'approve', 'code', provider, sentryBound.report);
    emit({ id: sentryId, status: sentryFailure ? 'failed' : 'completed', result: sentryFailure || sentryResult || '(Sentry completed without a text summary)', finishedAt: Date.now() });
  } catch (error) { emit({ id: sentryId, status: 'failed', result: error.message, finishedAt: Date.now() }); }
  finally { group.holders.delete(sentryId); }
  emit({ id: swarmId, status: 'completed', result: `Sentry and ${count} worker${count === 1 ? '' : 's'} finished. Open Agents to review the synthesis.`, finishedAt: Date.now() });
  activeSwarms.delete(swarmId);
}

// Re-runs exactly one Swarm worker (from the Sentry console's "Retry" action)
// under the same technically-enforced read-only sandbox as runSwarm (see
// there for why 'approve'/readOnly:true is forced regardless of the app's
// global permission mode). Updates stream back on the same agent id so the
// Sentry console's card refreshes in place instead of creating a new one.
async function runSwarmWorkerRetry({ swarmId, agentId, lane, workerModel, prompt, systemPrompt, cwd, provider, mode, images = [] }) {
  const root = cwd || ensureDefaultWorkspace();
  const cloudExecMode = normalizeMode(mode) === 'approve' ? 'auto' : normalizeMode(mode);
  const briefText = lane || SWARM_FALLBACK_LANES[0].brief;
  const workerBound = await capabilityBoundPrompt(systemPrompt, workerModel, 'code', provider);
  const task = `NoCLI.ai Swarm worker retry. ${briefText} Independently investigate this outcome. Use the workspace and browser tools available to inspect the real context, then return concise actionable findings -- including any code, diffs, or commands you'd propose -- for the Sentry. Do not delegate. You are running read-only: you cannot modify files, so report a proposed change instead of applying it.\n\nOutcome:\n${prompt}`;
  const holder = {};
  let result = '', failure = ''; const steps = [];
  const label = 'Retry';
  const send = (channel, value) => {
    if (channel === 'chat-delta') result = (result + String(value || '')).slice(-16000);
    else if (channel === 'chat-error') failure = String(value || 'Worker failed.');
    else if (channel === 'chat-step') {
      const v = value || {};
      steps.push(v.type === 'tool_call' ? `-> ${v.fn || 'tool'}${v.args?.command ? ': ' + String(v.args.command).slice(0, 140) : ''}` : `<- ${String(v.result || '').slice(0, 140)}`);
      if (steps.length > 40) steps.shift();
      win?.webContents.send('subagent-update', { swarmId, id: agentId, status: 'working', task: label, brief: briefText, model: workerModel, steps: steps.slice(-8) });
    }
  };
  win?.webContents.send('subagent-update', { swarmId, id: agentId, status: 'working', task: label, brief: briefText, model: workerModel, startedAt: Date.now() });
  try {
    if (isOllamaCloudModel(workerModel, provider)) {
      await runOllamaCloudAgent({ endpoint: activeOllamaUrl(), model: workerModel, prompt: task, systemPrompt: workerBound.systemPrompt, cwd: root, permissionMode: cloudExecMode, productMode: 'code', send, holder, browser: { open: revealBrowser, read: readBrowser }, allowDelegation: false, readOnly: true });
    } else {
      await runOfficialCli(workerModel, task, null, send, workerBound.systemPrompt, root, holder, images, 'approve', 'code', provider, workerBound.report);
    }
    const summary = failure || result || '(worker completed without a text summary)';
    win?.webContents.send('subagent-update', { swarmId, id: agentId, status: failure ? 'failed' : 'completed', task: label, brief: briefText, model: workerModel, result: summary, finishedAt: Date.now() });
  } catch (error) {
    win?.webContents.send('subagent-update', { swarmId, id: agentId, status: 'failed', task: label, brief: briefText, model: workerModel, result: error.message, finishedAt: Date.now() });
  }
}

// ---- IPC ------------------------------------------------------------------
ipcMain.handle('list-models', async () => lanClientConnected && remoteModels ? { models: remoteModels, remote: true } : (await listActiveModels()));
ipcMain.handle('opencode-models', async () => {
  const launch = findOpenCodeCli();
  if (!launch) return { models: [], error: 'OpenCode is not installed or not on PATH.' };
  const output = await runQuiet(launch.command, [...launch.prefix, 'models'], 30000);
  if (!output) return { models: [], error: 'OpenCode did not return a model list.' };
  const models = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(opencode|opencode-go)\//.test(line));
  return { models: [...new Set(models)].sort() };
});
// OpenRouter publishes its catalogue openly, so the free tier can be discovered
// without a key. `?max_price=0` returns only $0 models; we still verify both
// prompt and completion pricing so a "free in, paid out" endpoint cannot slip in.
let openRouterFreeCache = { at: 0, models: [] };
async function openRouterFreeModels() {
  if (openRouterFreeCache.models.length && Date.now() - openRouterFreeCache.at < 10 * 60 * 1000) return openRouterFreeCache.models;
  const text = await readHttpsText('https://openrouter.ai/api/v1/models?max_price=0');
  const data = JSON.parse(text);
  const models = (Array.isArray(data?.data) ? data.data : [])
    .filter((m) => m?.pricing && m.pricing.prompt === '0' && m.pricing.completion === '0')
    .map((m) => ({
      id: String(m.id || ''),
      name: String(m.name || m.id || ''),
      vision: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities.includes('image') : null,
      context: Number(m.context_length) || 0,
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  openRouterFreeCache = { at: Date.now(), models };
  return models;
}
ipcMain.handle('openrouter-free-models', async () => {
  try { return { models: await openRouterFreeModels() }; }
  catch (error) { return { models: [], error: error?.message || 'Could not reach OpenRouter.' }; }
});
ipcMain.handle('omniroute-status', async () => ({ running: await omnirouteHealth(), installed: !!omnirouteBin(), endpoint: OMNIROUTE_ENDPOINT }));
ipcMain.handle('omniroute-ensure', () => ensureOmniRoute());
ipcMain.handle('warm-provider', (_e, { provider, model } = {}) => warmProvider(migrateProvider(provider || {}), model));
ipcMain.handle('generate-title', (_e, { provider, model, prompt } = {}) => completeOnce(migrateProvider(provider || {}), model, [
  { role: 'system', content: 'You name chat conversations. Reply with only a 3 to 6 word title in Title Case. No quotes, no trailing punctuation, no explanation, no preamble.' },
  { role: 'user', content: String(prompt || '').slice(0, 2000) },
], 256));
ipcMain.handle('omniroute-install', async () => {
  if (omnirouteBin()) return ensureOmniRoute();
  const npm = whereFirst(process.platform === 'win32' ? 'npm.cmd' : 'npm') || 'npm';
  const output = await runQuiet(npm, ['install', '-g', 'omniroute'], 10 * 60 * 1000);
  if (!omnirouteBin()) return { running: false, installed: false, endpoint: OMNIROUTE_ENDPOINT, error: output || 'npm could not install OmniRoute.' };
  return ensureOmniRoute();
});
ipcMain.handle('model-capabilities', async (_e, { model, productMode, provider }) => resolveModelCapabilities(model, productMode, provider));
ipcMain.handle('check-exo', async (_e, url) => checkExo(url));
ipcMain.handle('set-runtime', async (_e, runtime) => {
  try {
    const next = runtime?.kind === 'exo' ? 'exo' : runtime?.kind === 'llamacpp' ? 'llamacpp' : 'ollama';
    const nextExo = next === 'exo' ? normalizeExoUrl(runtime?.url) : '';
    if (next === 'exo') {
      const check = await checkExo(nextExo); if (!check.ok) return check;
    }
    runtimeKind = next; exoBase = nextExo; config?.save({ oRuntime: runtimeKind, oExoUrl: exoBase });
    setTray(runtimeKind === 'exo' ? 'NoCLI.ai: Exo runtime' : runtimeKind === 'llamacpp' ? 'NoCLI.ai: llama.cpp RPC runtime' : 'NoCLI.ai: local Ollama');
    return { ok: true, kind: runtimeKind, url: exoBase };
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle('llamacpp-runtime-status', () => {
  const status = llamacppRuntime.runtimeStatus(runtimeRoot());
  return {
    ...status,
    hostRunning: !!(llamaCppHostProc && !llamaCppHostProc.killed),
    workerRunning: !!(llamaCppWorkerProc && !llamaCppWorkerProc.killed),
    ips: lan.lanIPs(),
    config: llamaCppConfig,
  };
});
ipcMain.handle('llamacpp-install', async () => {
  try {
    const status = await llamacppRuntime.installRuntime(runtimeRoot(), (progress) => win?.webContents.send('llamacpp-install-progress', progress));
    return { ok: true, status };
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle('llamacpp-pick-model', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'GGUF model', extensions: ['gguf'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('llamacpp-check-peer', async (_e, peer) => {
  try { const { host, port } = llamacppRuntime.validatePeer(String(peer || '').trim()); return await llamacppRuntime.checkPeerReachable(host, port); }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('llamacpp-set-config', (_e, next) => {
  llamaCppConfig = normalizeLlamaCppConfig({ ...llamaCppConfig, ...next });
  config?.save({ oLlamaCpp: llamaCppConfig });
  return llamaCppConfig;
});
ipcMain.handle('llamacpp-start', async () => {
  try {
    const status = llamacppRuntime.runtimeStatus(runtimeRoot());
    if (!status.installed) throw new Error('Install the llama.cpp CUDA runtime first.');
    if (llamaCppConfig.role === 'worker') {
      if (llamaCppWorkerProc && !llamaCppWorkerProc.killed) return { ok: true, already: true };
      if (!llamaCppConfig.bindIp) throw new Error('Choose this machine\'s isolated-Ethernet IP to bind rpc-server to.');
      llamaCppWorkerProc = llamacppRuntime.startWorker({
        rpcServerPath: status.rpcServer, bindIp: llamaCppConfig.bindIp, port: llamaCppConfig.rpcPort,
        onExit: (code, signal, tail) => { llamaCppWorkerProc = null; win?.webContents.send('llamacpp-status-change', { role: 'worker', running: false, code, tail }); },
      });
      return { ok: true };
    }
    if (llamaCppHostProc && !llamaCppHostProc.killed) return { ok: true, already: true };
    llamaCppHostProc = llamacppRuntime.startHost({
      llamaServerPath: status.llamaServer, modelPath: llamaCppConfig.modelPath, apiPort: llamaCppConfig.apiPort,
      rpcPeers: llamaCppConfig.rpcPeers, contextSize: llamaCppConfig.contextSize,
      onExit: (code, signal, tail) => { llamaCppHostProc = null; win?.webContents.send('llamacpp-status-change', { role: 'host', running: false, code, tail }); },
    });
    return { ok: true };
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle('llamacpp-stop', () => {
  if (llamaCppHostProc && !llamaCppHostProc.killed) llamaCppHostProc.kill();
  if (llamaCppWorkerProc && !llamaCppWorkerProc.killed) llamaCppWorkerProc.kill();
  return true;
});
ipcMain.handle('refresh-cloud-models', async () => fetchCloudCatalogue());
ipcMain.handle('model-download-catalogue', async () => fetchCloudCatalogue());
ipcMain.handle('hardware-profile', async () => hardwareProfile());
ipcMain.handle('pull-model', async (_e, model) => {
  try { return await pullOllamaModel(model); } catch (error) { return { error: error.message }; }
});
function safeImages(value) {
  if (!Array.isArray(value)) return [];
  const types = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const images = [];
  for (const image of value.slice(0, 4)) {
    if (!image || !types.has(image.type) || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length > 8 * 1024 * 1024) continue;
    images.push({ type: image.type, data: image.data });
  }
  return images;
}

// Claude Code and Qwen Code emit the same stream-json event schema:
// {type:'system',subtype:'init'}, {type:'assistant',message:{content:[...]}} with
// text/thinking/tool_use parts, {type:'user'} carrying tool_result, and a final
// {type:'result'}.  Only the argv and env differ, so one parser serves both and
// a third stream-json engine costs an entry in STREAM_JSON_ENGINES.
const STREAM_JSON_ENGINES = {
  claude: {
    label: 'Claude Code',
    find: findClaudeCli,
    // Claude Code reads an Anthropic-shaped endpoint; Ollama serves one at /v1/messages.
    env: () => ({}),
    args({ model, mode, sessionId, instruction, browserMcp }) {
      const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
        '--permission-mode', mode === 'approve' ? 'plan' : mode === 'auto' ? 'acceptEdits' : 'bypassPermissions'];
      if (mode === 'full') args.push('--dangerously-skip-permissions');
      if (model) args.push('--model', model);
      if (sessionId) args.push('--resume', sessionId);
      if (browserMcp) args.push('--mcp-config', browserMcp);
      args.push(instruction);
      return args;
    },
  },
  qwen: {
    label: 'Qwen Code',
    find: findQwenCli,
    env: () => ({}),
    // `--bare` skips implicit context discovery so a desktop turn is reproducible
    // and does not silently absorb unrelated files from the user's home.
    args({ model, mode, sessionId, systemPrompt, prompt, baseUrl, apiKey, browserMcp }) {
      const args = ['--bare', '--output-format', 'stream-json', '--include-partial-messages', '--channel', 'desktop',
        '--approval-mode', mode === 'approve' ? 'plan' : mode === 'auto' ? 'auto-edit' : 'yolo'];
      if (model) args.push('--model', model);
      if (baseUrl) args.push('--auth-type', 'openai', '--openai-base-url', baseUrl, '--openai-api-key', apiKey || 'ollama');
      if (systemPrompt) args.push('--system-prompt', systemPrompt);
      if (sessionId) args.push('--resume', sessionId);
      if (browserMcp) args.push('--mcp-config', browserMcp, '--allowed-mcp-server-names', 'nocli_browser');
      args.push(prompt);
      return args;
    },
  },
  kimi: {
    label: 'Kimi Code',
    find: findKimiCli,
    // KIMI_MODEL_* creates an in-memory provider for this process. It keeps
    // NoCLI.ai's selected route/model truthful without rewriting ~/.kimi-code.
    env: ({ model, baseUrl, apiKey }) => ({
      KIMI_MODEL_NAME: model,
      KIMI_MODEL_API_KEY: apiKey || 'ollama',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: baseUrl,
      KIMI_CODE_IDENTITY_NAME: 'NoCLI.ai',
      KIMI_CODE_IDENTITY_SLUG: 'nocli',
    }),
    args({ sessionId, instruction }) {
      const args = ['--prompt', instruction, '--output-format', 'stream-json'];
      if (sessionId) args.push('--session', sessionId);
      return args;
    },
  },
};

// Ollama's OpenAI-compatible surface is what Qwen Code talks to for a local model.
function openAiRouteFor(provider) {
  if (provider?.kind === 'openai-compatible' && provider.endpoint) {
    return { baseUrl: provider.endpoint.replace(/\/$/, ''), apiKey: provider.credentialId ? readProviderSecret(provider.credentialId) : null };
  }
  return { baseUrl: `${activeOllamaUrl().replace(/\/$/, '')}/v1`, apiKey: 'ollama' };
}

function runStreamJsonCli(engineId, { model, prompt, sessionId, send, systemPrompt, cwd, holder, permissionMode = 'auto', productMode = 'code', provider = null, retriedMissingSession = false }) {
  holder = holder || {};
  const spec = STREAM_JSON_ENGINES[engineId];
  return new Promise((resolve) => {
    const launch = spec.find();
    if (!launch) {
      send('chat-error', `${spec.label} is not installed or not on PATH. Install it, then retry.`);
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    const root = cwd || ensureDefaultWorkspace();
    const scopeLine = productMode === 'agent'
      ? 'You are in Calcium Work: coordinate a practical multi-step outcome across documents, research, browser work, and the workspace. Decide the smallest useful plan, execute it, and report the finished result plainly.'
      : productMode === 'chat'
        ? 'You are in Calcium Chat: have a focused conversation, explain clearly, and do not inspect or change the workspace.'
        : 'You are in Calcium Code: work directly in the current repository, make precise implementation changes, verify them, and report the result plainly.';
    const identity = [systemPrompt?.trim(), `You are Calcium, running through ${spec.label}. ${scopeLine}`].filter(Boolean).join('\n\n');
    const mode = normalizeMode(permissionMode);
    const route = openAiRouteFor(provider);
    const instruction = [identity, prompt].filter(Boolean).join('\n\n');
    const args = spec.args({ model, mode, sessionId, instruction, systemPrompt: identity, prompt, browserMcp: engineId === 'kimi' ? null : browserMcpJson(), ...route });
    const context = prepareHarnessContext(nocliConfigHome, { engine: engineId, providerKind: provider?.kind, providerName: provider?.name, model, scope: productMode, workspace: root });
    const child = spawn(launch.command, [...launch.prefix, ...args], {
      cwd: root, env: { ...process.env, ...context.env, ...spec.env({ model, ...route }) }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    holder.child = child;
    let buffer = '', resultSid = sessionId || null, stderr = '', failed = false, delivered = '', failureMessage = '';
    const finish = (ok) => { if (holder.child === child) holder.child = null; send('chat-done', { sessionId: resultSid, ok }); resolve(); };
    const emitText = (text) => {
      const value = String(text || '');
      if (!value || value === delivered) return;
      if (value.startsWith(delivered)) send('chat-delta', value.slice(delivered.length));
      else send('chat-delta', value);
      delivered = value;
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.session_id) resultSid = event.session_id;
        // Kimi Code emits OpenAI-shaped message lines plus meta records rather
        // than Claude's event envelope.
        if (event.role === 'assistant') {
          if (typeof event.content === 'string' && event.content) send('chat-delta', event.content);
          for (const call of event.tool_calls || []) {
            let args = call?.function?.arguments || {};
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { input: args }; } }
            send('chat-step', { type: 'tool_call', fn: call?.function?.name || 'tool', args });
          }
        }
        if (event.role === 'tool') {
          send('chat-step', { type: 'tool_result', result: String(event.content ?? '').slice(0, 4000), isError: false });
        }
        if (event.type === 'assistant') {
          const parts = event.message?.content || [];
          emitText(parts.filter((part) => part?.type === 'text').map((part) => part.text).join(''));
          for (const part of parts) {
            if (part?.type === 'tool_use') send('chat-step', { type: 'tool_call', fn: part.name || 'tool', args: part.input || {} });
          }
        }
        if (event.type === 'user') {
          for (const part of event.message?.content || []) {
            if (part?.type !== 'tool_result') continue;
            const body = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
            send('chat-step', { type: 'tool_result', result: String(body).slice(0, 4000), isError: part.is_error === true });
          }
        }
        if (event.type === 'result' && event.is_error) {
          failed = true; failureMessage = event.result || `${spec.label} failed to complete this turn.`;
          if (!isMissingHarnessSession(engineId, failureMessage)) send('chat-error', failureMessage);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (holder.steer) { holder.steer = false; send('chat-done', { sessionId: resultSid, ok: false, steered: true }); return resolve(); }
      const missingSession = !!sessionId && isMissingHarnessSession(engineId, `${failureMessage}\n${stderr}`);
      if (missingSession && !retriedMissingSession) {
        if (holder.child === child) holder.child = null;
        send('chat-step', { type: 'tool_result', result: `${spec.label} session expired. Retrying this turn in a fresh session.` });
        return runStreamJsonCli(engineId, { model, prompt, sessionId: null, send, systemPrompt, cwd: root, holder, permissionMode, productMode, provider, retriedMissingSession: true }).then(resolve);
      }
      if (code && !failed) send('chat-error', `${spec.label} exited ${code}${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`);
      finish(!code && !failed);
    });
    child.on('error', (error) => { send('chat-error', `Could not start ${spec.label}: ${error.message}`); finish(false); });
  });
}

function runOfficialClaude(model, prompt, sessionId, send, systemPrompt, cwd, holder, _images = [], permissionMode = 'auto', productMode = 'code', provider = null) {
  return runStreamJsonCli('claude', { model, prompt, sessionId, send, systemPrompt, cwd, holder, permissionMode, productMode, provider });
}
function runQwenCode(model, prompt, sessionId, send, systemPrompt, cwd, holder, _images = [], permissionMode = 'auto', productMode = 'code', provider = null) {
  return runStreamJsonCli('qwen', { model, prompt, sessionId, send, systemPrompt, cwd, holder, permissionMode, productMode, provider });
}
function runKimiCode(model, prompt, sessionId, send, systemPrompt, cwd, holder, _images = [], permissionMode = 'auto', productMode = 'code', provider = null) {
  return runStreamJsonCli('kimi', { model, prompt, sessionId, send, systemPrompt, cwd, holder, permissionMode, productMode, provider });
}
function runOpenCode(model, prompt, sessionId, send, systemPrompt, cwd, holder, _images = [], permissionMode = 'auto', productMode = 'code', provider = null) {
  holder = holder || {};
  return new Promise((resolve) => {
    const launch = findOpenCodeCli();
    if (!launch) {
      send('chat-error', 'OpenCode is not installed or not on PATH. Install the official OpenCode CLI, then retry.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    const root = cwd || ensureDefaultWorkspace();
    const scope = productMode === 'chat' ? 'chat' : productMode === 'agent' ? 'full' : normalizeMode(permissionMode) === 'approve' ? 'read' : 'edit';
    let route;
    try {
      route = openCodeLaunchConfig({
        provider: provider?.kind === 'ollama' ? { ...provider, endpoint: `${activeOllamaUrl().replace(/\/$/, '')}/v1` } : provider,
        model,
        scope,
        apiKey: provider?.credentialId ? readProviderSecret(provider.credentialId) : null,
      });
      route.config.mcp = { nocli_browser: { type: 'local', command: [browserMcpLaunch().command, ...browserMcpLaunch().args], environment: browserMcpLaunch().env, enabled: true } };
    } catch (error) {
      send('chat-error', error.message); send('chat-done', { sessionId, ok: false }); return resolve();
    }
    const scopeLine = scope === 'chat'
        ? 'Answer helpfully and concisely. Calcium has disabled every tool for this turn.'
      : scope === 'read'
        ? 'Inspect and explain the current workspace. Calcium has disabled edits, shell commands, delegation, and external paths.'
        : scope === 'full'
          ? 'Complete the requested multi-step task in the current workspace and report the finished result plainly.'
          : 'Work directly in the current workspace, verify changes, and report the result plainly. Do not delegate.';
    const instruction = [systemPrompt?.trim(), `You are Calcium, running through OpenCode. ${scopeLine}`, prompt].filter(Boolean).join('\n\n');
    const args = ['run', '--format', 'json', '--pure', '--agent', 'nocli', '--model', route.launchModel];
    if (sessionId) args.push('--session', sessionId);
    args.push(instruction);
    const context = prepareHarnessContext(nocliConfigHome, { engine: 'opencode', providerKind: provider?.kind, providerName: provider?.name, model, scope, workspace: root });
    const child = spawn(launch.command, [...launch.prefix, ...args], {
      cwd: root,
      env: { ...process.env, ...context.env, ...route.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(route.config) },
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    holder.child = child;
    let buffer = '', resultSid = sessionId || null, stderr = '', failed = false;
    const finish = (ok) => { if (holder.child === child) holder.child = null; send('chat-done', { sessionId: resultSid, ok }); resolve(); };
    child.stdout.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.sessionID) resultSid = event.sessionID;
        if (event.type === 'text' && event.part?.text) send('chat-delta', event.part.text);
        if (event.type === 'tool_use' && event.part) {
          const state = event.part.state || {};
          send('chat-step', { type: 'tool_call', id: event.part.callID, fn: event.part.tool || 'tool', args: state.input || {} });
          if (state.status === 'completed' || state.status === 'error') {
            send('chat-step', { type: 'tool_result', id: event.part.callID, result: String(state.output || state.error || '').slice(0, 4000), isError: state.status === 'error' });
          }
        }
        if (event.type === 'error') { failed = true; send('chat-error', event.error?.message || event.message || 'OpenCode failed to complete this turn.'); }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (holder.steer) { holder.steer = false; send('chat-done', { sessionId: resultSid, ok: false, steered: true }); return resolve(); }
      if (code && !failed) send('chat-error', `OpenCode exited ${code}${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`);
      finish(!code && !failed);
    });
    child.on('error', (error) => { send('chat-error', `Could not start OpenCode: ${error.message}`); finish(false); });
  });
}
// The adapter table.  Adding a spawn-and-stream engine is an entry here plus
// one in STREAM_JSON_ENGINES; nothing else in the routing has to know about it.
const ENGINE_RUNNERS = {
  kimi: (a) => runKimiCode(a.model, a.prompt, a.sessionId, a.send, a.systemPrompt, a.cwd, a.holder, a.images, a.permission, a.productMode, a.provider),
  opencode: (a) => runOpenCode(a.model, a.prompt, a.sessionId, a.send, a.systemPrompt, a.cwd, a.holder, a.images, a.permission, a.productMode, a.provider),
  qwen: (a) => runQwenCode(a.model, a.prompt, a.sessionId, a.send, a.systemPrompt, a.cwd, a.holder, a.images, a.permission, a.productMode, a.provider),
  claude: (a) => runOfficialClaude(a.model, a.prompt, a.sessionId, a.send, a.systemPrompt, a.cwd, a.holder, a.images, a.permission, a.productMode, a.provider),
  codex: (a) => runOfficialCodex(a.model, a.prompt, a.sessionId, a.send, a.systemPrompt, a.cwd, a.holder, a.images, a.permission, a.productMode, a.provider, a.capabilities),
};
// Learned the hard way: Ollama Cloud rejects Codex's freeform tool schema before
// inference, so refuse that pair up front rather than surfacing raw protocol JSON.
function engineModelRefusal(engineId, model, provider) {
  if (engineId === 'codex' && isOllamaCloudModel(model, provider)) {
    return 'Codex CLI cannot drive an Ollama Cloud model: Cloud rejects its freeform tool schema. Use Qwen Code or NoCLI.ai native for :cloud models.';
  }
  return null;
}
ipcMain.handle('chat', async (_e, { model, prompt, sessionId, systemPrompt, cwd, images, requestId, productMode, provider, mode, scope, grants, history }) => {
  if (!requestId || typeof requestId !== 'string') return { ok: false, error: 'Missing chat request ID.' };
  const expanded = String(prompt || '').trim();
  if (!expanded) return { ok: false, error: 'Enter a message first.' };
  const safe = safeImages(images);
  const send = (channel, value) => win?.webContents.send(channel, { requestId, ...(channel === 'chat-delta' ? { text: value } : channel === 'chat-step' ? { step: value } : channel === 'chat-error' ? { message: value } : value) });
  // ponytail: client mode forwards to the LAN server (cwd dropped -- the client's
  // project path is on the client device and doesn't map to the server's filesystem).
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'chat', requestId, model, prompt: expanded, sessionId, systemPrompt, images: safe, cwd: null, productMode, provider, mode, scope }); return { ok: true }; }
  // One scope control now owns what used to be productMode + permissionMode.
  // `scopeFromLegacy` keeps an older renderer or LAN client working unchanged.
  const active = scopeInfo(scope || scopeFromLegacy(productMode, mode));
  const permission = normalizeMode(active.permission);
  const selectedMode = active.productMode;
  const bound = await capabilityBoundPrompt(systemPrompt, model, selectedMode, provider);
  let usableImages = safe;
  if (selectedMode === 'chat' && safe.length && !bound.report.attachments) {
    usableImages = [];
    send('chat-step', { type: 'tool_result', result: `Images were not sent: ${model} does not support image input.` });
  }
  const decided = resolveRoute({ scope: active.id, engine: provider?.engine, providerKind: provider?.kind });
  const refusal = decided.reason
    || (decided.engine === 'kimi' && active.id === 'read' ? 'Kimi Code print mode cannot enforce a read-only workspace. Choose Qwen Code, Claude Code, Codex CLI, or NoCLI.ai native for Read scope.' : null)
    || (decided.runner === 'refused' ? 'Unsupported engine.' : engineModelRefusal(decided.engine, model, provider));
  if (refusal) { send('chat-error', refusal); send('chat-done', { sessionId: sessionId || null, ok: false }); return { ok: true }; }
  const holder = {}; localHolders.set(requestId, holder);
  const args = { model, prompt: expanded, sessionId, send, systemPrompt: bound.systemPrompt, cwd, holder, images: usableImages, permission, productMode: selectedMode, provider, capabilities: bound.report };
  const run = decided.runner === 'direct'
    ? runDirectChat(model, expanded, sessionId, send, bound.systemPrompt, holder, usableImages, provider)
    : decided.runner === 'native'
      ? runOllamaCloudAgent({ endpoint: activeOllamaUrl(), model, prompt: expanded, sessionId, history, systemPrompt: bound.systemPrompt, cwd: cwd || ensureDefaultWorkspace(), permissionMode: permission, productMode: selectedMode, send, holder, browser: { open: revealBrowser, read: readBrowser }, onSubagent: (agent) => win?.webContents.send('subagent-update', agent) })
        .then((cloudSessionId) => send('chat-done', { sessionId: cloudSessionId, ok: true }), (error) => { send('chat-error', error.message); send('chat-done', { sessionId: sessionId || null, ok: false }); })
      : ENGINE_RUNNERS[decided.runner](args);
  run
    .catch((e) => send('chat-error', e.message))
    .finally(() => localHolders.delete(requestId));
  return { ok: true };
});
ipcMain.handle('swarm-start', async (_e, { sentryModel, workerModel, prompt, images, workers, systemPrompt, cwd, provider, mode }) => {
  const outcome = String(prompt || '').trim();
  const requested = Number(workers);
  if (!outcome) return { ok: false, error: 'Describe the outcome for the swarm.' };
  if (!Number.isSafeInteger(requested) || requested < 1) return { ok: false, error: 'Choose at least one worker.' };
  const kind = provider?.kind || 'ollama';
  if (!['ollama', 'responses', 'openai-compatible'].includes(kind)) return { ok: false, error: 'Choose a supported provider profile before launching a swarm.' };
  const count = Math.min(requested, swarmLimit(provider));
  const swarmId = crypto.randomUUID();
  const fallbackModel = String(workerModel || sentryModel || '').slice(0, 160);
  runSwarm({ swarmId, sentryModel: String(sentryModel || fallbackModel).slice(0, 160), workerModel: fallbackModel, prompt: outcome.slice(0, 12000), images: safeImages(images), workers: count, systemPrompt, cwd, provider, permissionMode: mode })
    .catch((error) => win?.webContents.send('subagent-update', { id: swarmId, swarmId, status: 'failed', task: 'NoCLI.ai Swarm', result: error.message, finishedAt: Date.now() }));
  return { ok: true, swarmId, requested, count, capped: count !== requested, cap: Number.isFinite(swarmLimit(provider)) ? swarmLimit(provider) : null };
});
ipcMain.handle('swarm-retry-worker', async (_e, { swarmId, agentId, lane, model, prompt, systemPrompt, cwd, provider, mode, images }) => {
  const outcome = String(prompt || '').trim();
  if (!swarmId || !agentId) return { ok: false, error: 'Missing swarm/agent id.' };
  if (!outcome) return { ok: false, error: "This session's original task isn't available to retry -- launch a new swarm instead." };
  const workerModel = String(model || '').slice(0, 160);
  if (!workerModel) return { ok: false, error: 'Missing worker model.' };
  runSwarmWorkerRetry({ swarmId, agentId, lane: typeof lane === 'string' ? lane.slice(0, 800) : '', workerModel, prompt: outcome.slice(0, 12000), systemPrompt, cwd, provider, mode, images: safeImages(images) })
    .catch((error) => win?.webContents.send('subagent-update', { swarmId, id: agentId, status: 'failed', result: error.message, finishedAt: Date.now() }));
  return { ok: true };
});
ipcMain.handle('chat-stop', (_e, requestId) => {
  if (!requestId) return false;
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'stop', requestId }); return true; }
  const holder = localHolders.get(requestId);
  if (holder?.child) {
    if (typeof holder.child.kill === 'function' && !holder.child.killed) holder.child.kill();
    else if (typeof holder.child.destroy === 'function') holder.child.destroy();
  }
  return true;
});
ipcMain.handle('chat-steer', (_e, requestId) => {
  if (!requestId) return false;
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'steer', requestId }); return true; }
  const holder = localHolders.get(requestId);
  if (holder?.child) {
    holder.steer = true;
    if (typeof holder.child.kill === 'function' && !holder.child.killed) holder.child.kill();
    else if (typeof holder.child.destroy === 'function') holder.child.destroy();
    return true;
  }
  return false;
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Each installation gets a predictable writable home for chats that are not
// attached to a named Project. A user-selected workspace must already exist;
// only NoCLI.ai's own default is created automatically.
function ensureDefaultWorkspace() {
  const configured = config?.load()?.oworkspace;
  if (typeof configured === 'string' && configured && fs.existsSync(configured)) return configured;
  const workspace = path.join(app.getPath('documents'), 'NoCLI.ai Workspace');
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}
ipcMain.handle('ensure-workspace', () => ensureDefaultWorkspace());
ipcMain.handle('load-state', () => config?.load() || {});
ipcMain.handle('save-state', (_e, updates) => config?.save(updates) || {});
// 'clear' is retained for compatibility; the renderer now owns conversation state.
ipcMain.handle('clear', () => true);
ipcMain.handle('terminal-open', () => openGenuineTerminal());
ipcMain.handle('window-control', (_e, action) => {
  if (!win) return false;
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === 'close') win.close();
  return true;
});
ipcMain.handle('browser-show', (_e, bounds) => { setBrowserBounds(bounds); return true; });
ipcMain.handle('browser-hide', () => { if (browserPanel) browserPanel.setBounds({ x: 0, y: 0, width: 1, height: 1 }); return true; });
ipcMain.handle('browser-navigate', (_e, value) => {
  const url = validBrowserURL(value); if (!url) return { error: 'Enter a full http:// or https:// address.' };
  ensureBrowserPanel().webContents.loadURL(url); return { ok: true };
});
ipcMain.handle('browser-action', (_e, action) => {
  const view = ensureBrowserPanel().webContents;
  if (action === 'back' && view.canGoBack()) view.goBack();
  else if (action === 'forward' && view.canGoForward()) view.goForward();
  else if (action === 'reload') view.reload();
  else if (action === 'stop') view.stop();
  return true;
});
ipcMain.handle('browser-open-external', async (_e, url) => {
  const target = validBrowserURL(url) || browserPanel?.webContents.getURL() || '';
  if (!target) return { error: 'No page to open.' };
  try { await shell.openExternal(target); return { ok: true }; } catch (error) { return { error: error.message }; }
});
ipcMain.handle('provider-save', (_e, profile, apiKey) => {
  const value = profile || {};
  const migrated = migrateProvider(value);
  const kind = normalizeProviderKind(migrated.kind);
  const clean = {
    id: typeof value.id === 'string' && /^[a-z0-9_-]{4,80}$/i.test(value.id) ? value.id : crypto.randomUUID(),
    name: typeof value.name === 'string' ? value.name.trim().slice(0, 80) || 'Unnamed provider' : 'Unnamed provider',
    kind,
    engine: normalizeEngine(migrated.engine),
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim().replace(/\/$/, '').slice(0, 500) : '',
    model: typeof value.model === 'string' ? value.model.trim().slice(0, 160) : '',
    credentialId: typeof value.credentialId === 'string' ? value.credentialId : '',
  };
  if (['openai-compatible', 'responses'].includes(kind)) {
    try { const endpoint = new URL(clean.endpoint); if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error(); } catch { throw new Error('Use an http(s) endpoint with no embedded credentials.'); }
    if (typeof apiKey === 'string' && apiKey.trim()) {
      clean.credentialId = `provider-${clean.id}`; saveProviderSecret(clean.credentialId, apiKey.trim());
    }
  } else { clean.endpoint = ''; clean.credentialId = ''; }
  return clean;
});
ipcMain.handle('provider-test', async (_e, profile) => {
  const clean = migrateProvider(profile || {});
  if (normalizeProviderKind(clean.kind) !== 'opencode') return { ok: false, error: 'This live test is available for OpenCode Go profiles only.' };
  return runOpenCodeGoTest(clean.model);
});

// ---- LAN: same-WiFi link, one instance as server ----------------------------
// ponytail: raw TCP + NDJSON (src/lan.js). Server runs NoCLI.ai locally and streams
// events back over the socket; client forwards chats and maps events to the renderer,
// so the renderer UI is identical on either side. No HTTP, no web GUI.
let lanServer = null, lanClient = null, lanClientConnected = false, lanDiscovery = null;
let remoteModels = null;
let lanReconnectTimer = null, lanDesiredHost = null, lanReconnectAttempt = 0;
const lanInstanceId = crypto.randomUUID();
let hostInstaller = null;
const pendingUpdateRequests = new Map();
const pendingUpdateOffers = new Map();
let inboundUpdate = null;
function lanStatus(obj) { win?.webContents.send('lan-status', obj); }
function updateEvent(channel, value) { win?.webContents.send(channel, value); }
function clearLanReconnect() { if (lanReconnectTimer) clearTimeout(lanReconnectTimer); lanReconnectTimer = null; }
function scheduleLanReconnect() {
  if (!lanDesiredHost || lanReconnectTimer) return;
  const delay = Math.min(15000, 1000 * (2 ** Math.min(lanReconnectAttempt++, 4)));
  lanStatus({ client: 'reconnecting', retryInMs: delay });
  lanReconnectTimer = setTimeout(() => {
    lanReconnectTimer = null;
    if (lanDesiredHost) connectLanClient(lanDesiredHost, { remember: false });
  }, delay);
}
function compareVersions(left, right) {
  const parse = (version) => String(version || '').replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0);
  const a = parse(left), b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1; }
  return 0;
}
function fetchHttps(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many update download redirects.'));
    const req = https.get(url, { headers: { 'User-Agent': 'NoCLI.ai-Updater', Accept: 'application/vnd.github+json' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(fetchHttps(new URL(res.headers.location, url).href, redirects + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Update server returned ${res.statusCode}.`)); }
      resolve(res);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Update server timed out.'))); req.on('error', reject);
  });
}
async function readHttpsText(url) {
  const res = await fetchHttps(url); let text = '';
  for await (const chunk of res) { text += chunk; if (text.length > 1024 * 1024) throw new Error('Update metadata is unexpectedly large.'); }
  return text;
}
async function checkForAppUpdate({ force = false } = {}) {
  if (!force && cachedUpdateStatus && Date.now() - cachedUpdateAt < 5 * 60 * 1000) return cachedUpdateStatus;
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = (async () => {
  const current = app.getVersion();
  const body = await readHttpsText(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`);
  let release; try { release = JSON.parse(body); } catch { throw new Error('Update server sent invalid release metadata.'); }
  const version = String(release.tag_name || '').replace(/^v/i, '');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((asset) => releaseInstallerNames(process.platform, version).includes(asset?.name));
  const checksum = installer && assets.find((asset) => asset?.name === `${installer.name}.sha256`);
  if (!version || !installer || !checksum) throw new Error('Latest NoCLI.ai release is incomplete.');
  const available = compareVersions(version, current) > 0;
  availableRelease = available ? { version, installer: installer.browser_download_url, checksum: checksum.browser_download_url, name: installer.name, bytes: Number(installer.size) || 0 } : null;
  cachedUpdateStatus = { current, version, available, bytes: Number(installer.size) || 0, packageLabel: updatePackageLabel(process.platform), repository: UPDATE_REPOSITORY };
  cachedUpdateAt = Date.now();
  return cachedUpdateStatus;
  })();
  try { return await updateCheckInFlight; }
  finally { updateCheckInFlight = null; }
}
async function runBackgroundUpdateCheck() {
  try {
    const update = await checkForAppUpdate();
    win?.webContents.send('app-update-status', update);
    if (!update.available) return;
    win?.webContents.send('app-update-available', update);
    if (announcedUpdateVersion === update.version) return;
    announcedUpdateVersion = update.version;
    if (Notification.isSupported()) {
      const notice = new Notification({ title: 'NoCLI.ai update ready', body: `NoCLI.ai ${update.version} is ready to download.` });
      notice.on('click', () => { if (win) { win.show(); win.focus(); } });
      notice.show();
    }
  } catch {
    // Background checks should never interrupt work. Manual checks still show the error.
  }
}
function startBackgroundUpdateChecks() {
  if (updateCheckTimer) return;
  setTimeout(() => runBackgroundUpdateCheck(), 6000);
  updateCheckTimer = setInterval(runBackgroundUpdateCheck, 6 * 60 * 60 * 1000);
}
async function downloadAppUpdate() {
  const release = availableRelease || (await checkForAppUpdate(), availableRelease);
  if (!release) throw new Error('NoCLI.ai is already up to date.');
  const expected = (await readHttpsText(release.checksum)).match(/\b([a-f0-9]{64})\b/i)?.[1]?.toLowerCase();
  if (!expected) throw new Error('Release checksum is invalid.');
  const dir = path.join(app.getPath('userData'), 'updates'); fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, release.name), temp = final + '.part';
  try { fs.unlinkSync(temp); } catch {}
  const response = await fetchHttps(release.installer);
  const total = Number(response.headers['content-length']) || release.bytes;
  if (!Number.isSafeInteger(total) || total < 1024 || total > 750 * 1024 * 1024) { response.resume(); throw new Error('Update installer has an invalid size.'); }
  const hash = crypto.createHash('sha256'); let received = 0; const stream = fs.createWriteStream(temp);
  try {
    for await (const chunk of response) {
      received += chunk.length; if (received > total || received > 750 * 1024 * 1024) throw new Error('Update installer exceeded its declared size.');
      hash.update(chunk); if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
      updateEvent('app-update-progress', { received, total });
    }
    await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
    if (received !== total || hash.digest('hex') !== expected) throw new Error('Update verification failed; the download was discarded.');
    try { if (fs.existsSync(final)) fs.unlinkSync(final); fs.renameSync(temp, final); if (process.platform === 'linux' && path.extname(final).toLowerCase() === '.appimage') fs.chmodSync(final, 0o755); } catch (error) { throw new Error('Could not save verified update: ' + error.message); }
    return { path: final, name: release.name, bytes: received, version: release.version };
  } catch (error) { try { stream.destroy(); fs.unlinkSync(temp); } catch {} throw error; }
}
function sharedConversation(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  const turns = Array.isArray(value.turns) ? value.turns.slice(-80).flatMap((turn) => {
    if (!turn || !['user', 'assistant'].includes(turn.role)) return [];
    return [{ role: turn.role, content: String(turn.content || '').slice(0, 64000), attachmentCount: Number(turn.attachmentCount) || 0 }];
  }) : [];
  return {
    id: value.id.slice(0, 120), sessionId: typeof value.sessionId === 'string' ? value.sessionId.slice(0, 120) : null,
    title: String(value.title || '(empty)').slice(0, 120), model: String(value.model || '').slice(0, 160),
    ts: Number.isSafeInteger(value.ts) ? value.ts : Date.now(), updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : Date.now(),
    projectId: null, turns,
  };
}
function sharedSnapshot() { return Array.isArray(config?.load()?.osharedConvs) ? config.load().osharedConvs : []; }
function broadcastSharedConversations() {
  const conversations = sharedSnapshot();
  lanServer?.broadcast({ type: 'workspace-snapshot', conversations });
  win?.webContents.send('workspace-snapshot', { conversations });
}
function storeSharedConversation(value) {
  const next = sharedConversation(value); if (!next) return { error: 'Invalid shared conversation.' };
  const conversations = sharedSnapshot().filter((item) => item?.id !== next.id);
  conversations.unshift(next); conversations.sort((a, b) => (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0));
  config?.save({ osharedConvs: conversations.slice(0, 50) }); broadcastSharedConversations(); return { ok: true };
}
function startLanDiscovery() {
  if (lanDiscovery) return;
  lanDiscovery = lan.createDiscovery({
    id: lanInstanceId,
    name: os.hostname(),
    getAdvertisement: () => ({ port: lan.PORT, available: !!lanServer }),
    onDevices: (devices) => win?.webContents.send('lan-devices', devices),
  });
}
function safeInstallerName(name) { return path.basename(String(name || '')).replace(/[^a-zA-Z0-9._-]/g, '_'); }
async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk)); stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
async function selectInstaller() {
  const extensions = installerExtensions(process.platform);
  if (!extensions.length) throw new Error('Installer sharing is not supported on this platform yet.');
  const picked = await dialog.showOpenDialog(win, { title: 'Choose the newer NoCLI.ai installer', properties: ['openFile'], filters: [{ name: 'NoCLI.ai installer', extensions }] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const file = picked.filePaths[0]; const stat = await fs.promises.stat(file);
  if (stat.size < 1024 || stat.size > 750 * 1024 * 1024) throw new Error('Installer must be between 1 KB and 750 MB.');
  hostInstaller = { path: file, name: safeInstallerName(path.basename(file)), bytes: stat.size, sha256: await hashFile(file) };
  return { name: hostInstaller.name, bytes: hostInstaller.bytes, sha256: hostInstaller.sha256 };
}
function offerInstaller(sock) {
  if (!hostInstaller) throw new Error('Choose a newer NoCLI.ai installer first.');
  const id = crypto.randomUUID();
  const offer = { type: 'update-offer', id, name: hostInstaller.name, bytes: hostInstaller.bytes, sha256: hostInstaller.sha256 };
  if (sock) lan.sendTo(sock, offer); else lanServer?.broadcast(offer);
  return offer;
}
function sendInstaller(sock, id) {
  if (!hostInstaller || !sock) return;
  lan.sendTo(sock, { type: 'update-begin', id, name: hostInstaller.name, bytes: hostInstaller.bytes, sha256: hostInstaller.sha256 });
  let sent = 0; const stream = fs.createReadStream(hostInstaller.path, { highWaterMark: 48 * 1024 });
  stream.on('data', (chunk) => {
    stream.pause();
    sent += chunk.length;
    const resume = () => { updateEvent('lan-update-progress', { role: 'host', id, received: sent, total: hostInstaller.bytes }); stream.resume(); };
    try { if (sock.write(JSON.stringify({ type: 'update-chunk', id, data: chunk.toString('base64') }) + '\n')) resume(); else sock.once('drain', resume); } catch { stream.destroy(); }
  });
  stream.on('end', () => lan.sendTo(sock, { type: 'update-end', id }));
  stream.on('error', (e) => lan.sendTo(sock, { type: 'update-error', id, message: e.message }));
}
function beginInboundUpdate(msg) {
  const offer = pendingUpdateOffers.get(msg.id);
  if (!offer || offer.name !== msg.name || offer.bytes !== msg.bytes || offer.sha256 !== msg.sha256) throw new Error('Unapproved update transfer was refused.');
  if (!msg || !/^[a-f0-9]{64}$/i.test(msg.sha256) || !Number.isSafeInteger(msg.bytes) || msg.bytes < 1024 || msg.bytes > 750 * 1024 * 1024) throw new Error('Invalid update metadata.');
  const dir = path.join(app.getPath('userData'), 'updates'); fs.mkdirSync(dir, { recursive: true });
  const name = safeInstallerName(msg.name);
  const temp = path.join(dir, '.' + msg.id + '.part');
  inboundUpdate?.stream?.destroy();
  pendingUpdateOffers.delete(msg.id);
  inboundUpdate = { id: msg.id, name, bytes: msg.bytes, sha256: msg.sha256, received: 0, temp, final: path.join(dir, name), hash: crypto.createHash('sha256'), stream: fs.createWriteStream(temp) };
}
function writeInboundChunk(msg) {
  if (!inboundUpdate || msg.id !== inboundUpdate.id || typeof msg.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(msg.data)) return;
  const chunk = Buffer.from(msg.data, 'base64');
  if (!chunk.length || inboundUpdate.received + chunk.length > inboundUpdate.bytes) throw new Error('Invalid update chunk.');
  inboundUpdate.received += chunk.length; inboundUpdate.hash.update(chunk); inboundUpdate.stream.write(chunk);
  updateEvent('lan-update-progress', { role: 'client', id: msg.id, received: inboundUpdate.received, total: inboundUpdate.bytes });
}
function finishInboundUpdate(id) {
  if (!inboundUpdate || id !== inboundUpdate.id) return;
  const update = inboundUpdate; inboundUpdate = null;
  update.stream.end(() => {
    const valid = update.received === update.bytes && update.hash.digest('hex') === update.sha256;
    if (!valid) { try { fs.unlinkSync(update.temp); } catch {} updateEvent('lan-update-error', { message: 'Update verification failed; the installer was discarded.' }); return; }
    try { if (fs.existsSync(update.final)) fs.unlinkSync(update.final); fs.renameSync(update.temp, update.final); updateEvent('lan-update-ready', { path: update.final, name: update.name }); }
    catch (e) { updateEvent('lan-update-error', { message: e.message }); }
  });
}

ipcMain.handle('lan-server-toggle', (_e, enabled) => {
  if (enabled) {
    config?.save({ olanHostEnabled: true });
    if (lanServer) return { on: true, ips: lan.lanIPs(), port: lan.PORT };
    lanServer = lan.startServer({
      onConnect: async (sock) => {
        let models = [];
        try { models = (await listActiveModels()).models || []; } catch {}
        lan.sendTo(sock, { type: 'workspace-init', host: os.hostname(), models, conversations: sharedSnapshot() });
      },
      onMessage: (msg, sock, st) => {
        if (msg.type === 'stop') {
          const holder = st.holders?.get(msg.requestId);
          if (holder?.child && !holder.child.killed) holder.child.kill();
          return;
        }
        if (msg.type === 'steer') {
          const holder = st.holders?.get(msg.requestId);
          if (holder?.child && !holder.child.killed) { holder.steer = true; holder.child.kill(); }
          return;
        }
        if (msg.type === 'update-request') {
          const id = crypto.randomUUID(); pendingUpdateRequests.set(id, sock);
          updateEvent('lan-update-request', { id, requester: typeof msg.requester === 'string' ? msg.requester.slice(0, 80) : 'A linked client', hasInstaller: !!hostInstaller }); return;
        }
        if (msg.type === 'update-accept') { sendInstaller(sock, msg.id); return; }
        if (msg.type === 'workspace-upsert') { storeSharedConversation(msg.conversation); return; }
        if (msg.type !== 'chat') return;
        const send = (ch, v) => {
          if (ch === 'chat-delta') lan.sendTo(sock, { type: 'delta', requestId: msg.requestId, text: v });
          else if (ch === 'chat-step') lan.sendTo(sock, { type: 'step', requestId: msg.requestId, step: v });
          else if (ch === 'chat-error') lan.sendTo(sock, { type: 'error', requestId: msg.requestId, msg: v });
          else if (ch === 'chat-done') lan.sendTo(sock, { type: 'done', requestId: msg.requestId, sessionId: v.sessionId, ok: v.ok, steered: !!v.steered });
        };
        st.holders ||= new Map();
        const holder = {}; st.holders.set(msg.requestId, holder);
        // server uses its own cwd; the client's project path doesn't map across devices.
        (async () => {
          const images = safeImages(msg.images);
          const selectedMode = ['chat', 'code', 'agent'].includes(msg.productMode) ? msg.productMode : 'chat';
          const bound = await capabilityBoundPrompt(msg.systemPrompt, msg.model, selectedMode, msg.provider);
          const usableImages = images.length && !bound.report.attachments ? [] : images;
          if (images.length && !usableImages.length) send('chat-step', { type: 'tool_result', result: `Images were not sent: ${msg.model} does not support image input.` });
          return selectedMode === 'chat'
            ? runDirectChat(msg.model, msg.prompt, msg.sessionId, send, bound.systemPrompt, holder, usableImages, msg.provider)
            : runOfficialCli(msg.model, msg.prompt, msg.sessionId, send, bound.systemPrompt, null, holder, usableImages, normalizeMode(msg.mode), selectedMode, msg.provider, bound.report);
        })().catch(() => {}).finally(() => st.holders.delete(msg.requestId));
      },
      onStatus: (state, info) => lanStatus({ server: state, ...info }),
    });
    lanDiscovery?.refresh();
    return { on: true, ips: lan.lanIPs(), port: lan.PORT };
  }
  config?.save({ olanHostEnabled: false });
  if (lanServer) { lanServer.stop(); lanServer = null; }
  lanDiscovery?.refresh();
  lanStatus({ server: 'off' });
  return { on: false };
});

// Host owns the shared transcript. Clients may submit only one bounded
// conversation snapshot at a time; the Host persists and republishes it.
ipcMain.handle('workspace-upsert', (_e, conversation) => {
  if (lanServer) return storeSharedConversation(conversation);
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'workspace-upsert', conversation: sharedConversation(conversation) }); return { ok: true }; }
  return { ok: false, error: 'Turn on Host mode or connect to a Host to share chats.' };
});
ipcMain.handle('workspace-seed', (_e, conversations) => {
  if (!lanServer || !Array.isArray(conversations)) return { ok: false };
  for (const conversation of conversations.slice(0, 50)) storeSharedConversation(conversation);
  return { ok: true };
});

function connectLanClient(host, { remember = true } = {}) {
  const [h, p] = String(host || '').split(':');
  if (!h || !h.trim()) return false;
  const target = h.trim() + ':' + (p ? parseInt(p, 10) || lan.PORT : lan.PORT);
  if (remember) { clearLanReconnect(); lanDesiredHost = target; lanReconnectAttempt = 0; }
  const previous = lanClient;
  lanClient = null; lanClientConnected = false;
  try { previous?.end(); } catch {}
  const client = lan.connectClient(h.trim(), p ? parseInt(p, 10) || lan.PORT : lan.PORT, {
    onMsg: (m) => {
      const send = win.webContents.send.bind(win.webContents);
      if (m.type === 'delta') send('chat-delta', { requestId: m.requestId, text: m.text });
      else if (m.type === 'step') send('chat-step', { requestId: m.requestId, step: m.step });
      else if (m.type === 'error') send('chat-error', { requestId: m.requestId, message: m.msg });
      else if (m.type === 'done') send('chat-done', { requestId: m.requestId, sessionId: m.sessionId, ok: m.ok, steered: !!m.steered });
      else if (m.type === 'workspace-init') {
        remoteModels = Array.isArray(m.models) ? m.models : [];
        send('workspace-init', { host: m.host || 'Host', conversations: Array.isArray(m.conversations) ? m.conversations : [] });
        send('models-changed', { remote: true });
      }
      else if (m.type === 'workspace-snapshot') send('workspace-snapshot', { conversations: Array.isArray(m.conversations) ? m.conversations : [] });
      else if (m.type === 'update-offer') { pendingUpdateOffers.set(m.id, m); updateEvent('lan-update-offer', m); }
      else if (m.type === 'update-begin') { try { beginInboundUpdate(m); } catch (e) { updateEvent('lan-update-error', { message: e.message }); } }
      else if (m.type === 'update-chunk') { try { writeInboundChunk(m); } catch (e) { updateEvent('lan-update-error', { message: e.message }); } }
      else if (m.type === 'update-end') finishInboundUpdate(m.id);
      else if (m.type === 'update-error') updateEvent('lan-update-error', { message: m.message || 'Transfer failed.' });
    },
    onStatus: (state) => {
      if (lanClient !== client) return;
      lanClientConnected = (state === 'connected');
      if (lanClientConnected) { lanReconnectAttempt = 0; clearLanReconnect(); }
      else remoteModels = null;
      lanStatus({ client: state });
      if (state === 'disconnected' || state.startsWith('error:')) scheduleLanReconnect();
    },
  });
  lanClient = client;
  lanStatus({ client: 'connecting' });
  return true;
}
ipcMain.handle('lan-connect', (_e, host) => {
  return connectLanClient(host);
});
ipcMain.handle('lan-connect-device', (_e, device) => {
  const host = String(device?.host || '').trim(); const port = Number(device?.port) || lan.PORT;
  if (!host || !device?.available) return { error: 'That device is not accepting clients yet. Turn on Host mode there first.' };
  if (!connectLanClient(host + ':' + port)) return { error: 'Could not start the link.' };
  return { ok: true, target: host + ':' + port };
});
ipcMain.handle('lan-disconnect', () => {
  lanDesiredHost = null; lanReconnectAttempt = 0; clearLanReconnect();
  if (lanClient) { try { lanClient.end(); } catch {} lanClient = null; }
  lanClientConnected = false; lanStatus({ client: 'disconnected' }); return true;
});
ipcMain.handle('lan-discovery-refresh', () => { lanDiscovery?.refresh(); return lanDiscovery?.devices() || []; });
ipcMain.handle('lan-request-device-update', (_e, device) => {
  const host = String(device?.host || '').trim(); const port = Number(device?.port) || lan.PORT;
  if (!host || !device?.available) return { error: 'That device is not accepting NoCLI.ai links. Turn on Host mode there first.' };
  if (!connectLanClient(host + ':' + port)) return { error: 'Could not start a link to that device.' };
  lanClient.send({ type: 'update-request', requester: os.hostname() });
  return { ok: true, target: host + ':' + port };
});
ipcMain.handle('update-select-installer', async () => {
  try { return await selectInstaller(); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('update-offer', () => {
  try { if (!lanServer) throw new Error('Turn on Host mode first.'); return offerInstaller(); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('update-request', () => {
  if (!lanClientConnected || !lanClient) return { error: 'Connect to a Host first.' };
  lanClient.send({ type: 'update-request', requester: os.hostname() }); return { ok: true };
});
ipcMain.handle('update-respond-request', (_e, id, approved) => {
  const sock = pendingUpdateRequests.get(id); pendingUpdateRequests.delete(id);
  if (!sock) return { error: 'That request expired.' };
  if (!approved) { lan.sendTo(sock, { type: 'update-error', message: 'The Host declined the update request.' }); return { ok: true }; }
  try { return offerInstaller(sock); } catch (e) { lan.sendTo(sock, { type: 'update-error', message: e.message }); return { error: e.message }; }
});
ipcMain.handle('update-accept-offer', (_e, id, approved) => {
  if (!lanClientConnected || !lanClient) return { error: 'The Host is no longer connected.' };
  if (!pendingUpdateOffers.has(id)) return { error: 'That update offer expired.' };
  if (!approved) pendingUpdateOffers.delete(id);
  lanClient.send(approved ? { type: 'update-accept', id } : { type: 'update-error', id, message: 'The client declined the update offer.' }); return { ok: true };
});
ipcMain.handle('update-open-installer', async (_e, file) => {
  const dir = path.join(app.getPath('userData'), 'updates'); const resolved = path.resolve(String(file || ''));
  const extension = path.extname(resolved).replace(/^\./, '');
  if (!resolved.startsWith(path.resolve(dir) + path.sep) || !installerExtensions(process.platform).some((item) => item.toLowerCase() === extension.toLowerCase()) || !fs.existsSync(resolved)) return { error: 'Verified installer not found.' };
  try {
    if (process.platform === 'linux') { const error = await shell.openPath(resolved); return error ? { error: 'Could not open the verified Debian package: ' + error } : { ok: true }; }
    const installer = spawn(resolved, [], { detached: true, stdio: 'ignore', windowsHide: false });
    installer.unref();
    return { ok: true };
  } catch (e) { return { error: 'Could not open the verified installer: ' + e.message }; }
});
ipcMain.handle('app-update-check', async () => {
  try { return await checkForAppUpdate({ force: true }); } catch (error) { return { error: error.message }; }
});
ipcMain.handle('app-update-download', async () => {
  try { return await downloadAppUpdate(); } catch (error) { return { error: error.message }; }
});
ipcMain.handle('app-info', async () => ({ version: app.getVersion(), dependencies: await dependencyStatus() }));
ipcMain.handle('engine-availability', async () => engineAvailability());
ipcMain.handle('install-dependencies', async () => {
  const before = await dependencyStatus(); const steps = [];
  if (process.platform !== 'win32') return { ok: true, steps: ['Install Ollama through your Linux distribution. Install the official Codex CLI and Claude Code separately for Code and Work.'], status: before };
  const run = async (command, args, label) => { const output = await runQuiet(command, args, 10 * 60 * 1000); steps.push(label + (output ? ': ' + output.split(/\r?\n/).pop() : ' started')); };
  if (!before.ollama) await run('winget.exe', ['install', '--id', 'Ollama.Ollama', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Ollama');
  if (!before.node) await run('winget.exe', ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Node.js');
  if (!omnirouteBin()) await run('npm.cmd', ['install', '-g', 'omniroute'], 'OmniRoute');
  return { ok: true, steps, status: await dependencyStatus() };
});

// ---- app lifecycle --------------------------------------------------------
app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  migrateLegacyUserData(userDataPath);
  nocliConfigHome = migrateNocliHome(userDataPath);
  config = createConfigStore(nocliConfigHome);
  // Preserve all known predecessors. Merge only missing keys so the canonical
  // NoCLI.ai folder wins while a dev/package casing change cannot lose history.
  const state = config.load(); const parent = path.dirname(userDataPath);
  try {
    if (state.oRuntime === 'exo' && state.oExoUrl) { runtimeKind = 'exo'; exoBase = normalizeExoUrl(state.oExoUrl); }
    else if (state.oRuntime === 'llamacpp') runtimeKind = 'llamacpp';
  } catch { runtimeKind = 'ollama'; exoBase = ''; }
  if (state.oLlamaCpp) llamaCppConfig = normalizeLlamaCppConfig(state.oLlamaCpp);
  const candidates = [path.join(parent, 'ollama-desktop-harness', 'settings.json')];
  const merged = {};
  for (const file of candidates) {
    if (path.resolve(file) === path.join(nocliConfigHome, 'settings.json')) continue;
    try { Object.assign(merged, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  config.save({ ...merged, ...state });
  createTray();
  createWindow();
  // The workspace should be visible immediately. Browser MCP setup and the
  // optional terminal shim can finish after the first frame.
  startBrowserBridge().catch(() => { browserBridge = null; });
  ensureCliCommand();
  // Keeps visual/test launches from opening Windows' firewall prompt. Normal
  // packaged launches retain discovery unless the flag is explicitly set.
  if (process.env.NOCLI_DISABLE_LAN_DISCOVERY !== '1') startLanDiscovery();
  await ensureOllama();
});
app.on('before-quit', () => {
  isQuitting = true;
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (ollamaProc && !ollamaProc.killed) ollamaProc.kill();
  if (llamaCppHostProc && !llamaCppHostProc.killed) llamaCppHostProc.kill();
  if (llamaCppWorkerProc && !llamaCppWorkerProc.killed) llamaCppWorkerProc.kill();
  if (lanServer) lanServer.stop();
  if (lanClient) { try { lanClient.end(); } catch {} }
  lanDiscovery?.stop();
});
app.on('window-all-closed', () => app.quit());
