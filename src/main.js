// Electron main: tray + window + Ollama lifecycle + native Axon chat and terminal modes.
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
const { runOllamaCloudAgent } = require('./ollama-cloud-agent');

// Set once so the window groups under its own taskbar entry (pinnable) instead of Electron's.
try { app.setAppUserModelId('io.axon.workspace'); } catch {}
// A stable display name also stabilizes Electron's userData folder across dev
// and packaged launches (Windows otherwise kept both `axon` and `Axon`).
try { app.setName('Axon'); } catch {}
// Keep a launch click focused on the existing Axon window instead of opening
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
// The official release feed. Maintainers can point a fork at its own feed.
const UPDATE_REPOSITORY = process.env.AXON_UPDATE_REPOSITORY || 'Iyadobo/Axon';

let tray = null, win = null, ollamaProc = null, browserPanel = null, browserBridge = null, browserBridgeEndpoint = '', browserBridgeToken = '', isQuitting = false;
let updateCheckTimer = null, announcedUpdateVersion = null;
let trayLabel = 'Axon: starting…';
// Each conversation gets its own holder. A slow or unavailable model must never
// own the whole window (or somebody else's Stop button).
const localHolders = new Map();
let availableRelease = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve an executable through the host platform's PATH without a shell.
function whereFirst(command) {
  try {
    const probe = process.platform === 'win32' ? `where.exe ${command}` : `command -v ${command}`;
    return execSync(probe, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' ? undefined : '/bin/sh' })
      .split(/\r?\n/).map((s) => s.trim()).find((p) => p && fs.existsSync(p)) || null;
  } catch { return null; }
}
function findAxonTerminal() {
  const executable = process.platform === 'win32' ? 'axon.exe' : 'axon';
  // A cleaned development checkout may deliberately omit Cargo's 15+ GB
  // release cache. On Windows, reuse the already-installed Axon terminal for
  // preview sessions instead of forcing an immediate cold Rust rebuild. This
  // path is dev-only; packaged releases still carry their own binary.
  const installedPreviewTerminal = !app.isPackaged && process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'Programs', 'Axon', 'resources', 'axon-terminal', executable)
    : null;
  const candidates = [
    // Development checkout: build this controlled fork locally.
    path.join(__dirname, '..', 'axon-terminal', 'codex-rs', 'target', 'release', executable),
    path.join(__dirname, '..', 'axon-terminal', 'codex-rs', 'target', 'debug', executable),
    // Packaged builds place the terminal next to the application resources.
    app.isPackaged && path.join(process.resourcesPath, 'axon-terminal', executable),
    installedPreviewTerminal,
    whereFirst(executable),
  ].filter(Boolean);
  const command = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  return command ? { command, prefix: [] } : null;
}
function runQuiet(command, args, timeout = 15000) {
  return new Promise((resolve) => {
    let out = ''; let child;
    try { child = spawn(command, args, { windowsHide: true, shell: false }); } catch { return resolve(null); }
    const done = () => resolve(out.trim() || null);
    child.stdout?.on('data', (d) => { out += d; }); child.stderr?.on('data', (d) => { out += d; }); child.on('error', () => resolve(null)); child.on('exit', done);
    setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeout).unref();
  });
}
async function dependencyStatus() {
  const axonLaunch = findAxonTerminal();
  const [ollama, node, axon] = await Promise.all([
    runQuiet(whereFirst(process.platform === 'win32' ? 'ollama.exe' : 'ollama') || 'ollama', ['--version']),
    runQuiet(whereFirst(process.platform === 'win32' ? 'node.exe' : 'node') || 'node', ['--version']),
    axonLaunch ? runQuiet(axonLaunch.command, [...axonLaunch.prefix, '--version']) : Promise.resolve(null),
  ]);
  return { ollama, node, axon };
}
let config = null;
const visionCapability = new Map();
function providerSecretsPath() { return path.join(app.getPath('userData'), 'provider-secrets.json'); }
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
async function ensureOllama() {
  if (runtimeKind === 'exo') return setTray('Axon: Exo runtime selected');
  if (runtimeKind === 'llamacpp') return setTray('Axon: llama.cpp RPC runtime');
  if (await isOllamaUp()) return setTray('Axon: running');
  ollamaProc = spawn('ollama', ['serve'], { windowsHide: true, shell: false });
  ollamaProc.on('exit', () => { ollamaProc = null; setTray('Axon: stopped'); });
  ollamaProc.stderr?.on('data', () => {});
  for (let i = 0; i < 40; i++) { await sleep(500); if (await isOllamaUp()) return setTray('Ollama: running'); }
  setTray('Axon: failed to start');
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
      headers: { 'User-Agent': `Axon/${app.getVersion()}`, Accept: 'application/json' },
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
async function resolveModelCapabilities(model, productMode, provider) {
  const isOllama = !provider?.kind || provider.kind === 'ollama';
  const advertisedVision = isOllama ? await modelSupportsVision(model) : null;
  return modelCapabilityReport({ model, productMode, providerKind: provider?.kind || 'ollama', advertisedVision });
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
    // Axon's renderer owns the title bar so the app has one coherent chrome
    // instead of a Windows-coloured frame sitting above the workspace.
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => startBackgroundUpdateChecks());
  // Frameless Electron windows do not reliably inherit Chromium's browser
  // zoom shortcuts. Keep this scoped to Axon's shell (not the agent browser).
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
  // Open maximized: Axon is a workspace, and the transcript plus the browser
  // pane both want room. Maximize before showing so there is no resize flash;
  // the width/height above stay as the restore-down size.
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // Axon is an agent host: closing the window keeps active work alive in the
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
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.dirname(app.getPath('appData')), 'Axon', 'bin');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'axon', 'bin');
}
function refreshShortcutIcons(iconPath) {
  // Pinned taskbar shortcuts cache an executable's first icon resource very aggressively.
  // Point them at a stable, transparent ICO instead.
  const appData = process.env.APPDATA;
  if (!appData || process.platform !== 'win32') return;
  const shortcuts = [
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Axon.lnk'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Axon.lnk'),
  ];
  const quote = (value) => String(value).replace(/'/g, "''");
  const list = shortcuts.map((shortcut) => `'${quote(shortcut)}'`).join(',');
  const ps = `$icon='${quote(iconPath)}';@(${list})|ForEach-Object { if(Test-Path -LiteralPath $_){$s=(New-Object -ComObject WScript.Shell).CreateShortcut($_);$s.IconLocation=\"$icon,0\";$s.Save()} }`;
  try { spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' }); } catch {}
}
function ensureCliCommand() {
  const dir = cliDirectory(); fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    const workspace = ensureDefaultWorkspace();
    const terminal = path.join(dir, 'axon-terminal');
    fs.writeFileSync(terminal, `#!/usr/bin/env bash\ncd ${JSON.stringify(workspace)}\nexec \"${process.env.SHELL || '/bin/bash'}\" -i\n`, { mode: 0o755 });
    try { fs.chmodSync(terminal, 0o755); } catch {}
    return dir;
  }
  const iconPath = path.join(path.dirname(dir), 'Axon.ico');
  try { fs.copyFileSync(path.join(__dirname, 'assets', 'icon.ico'), iconPath); refreshShortcutIcons(iconPath); } catch {}
  const workspace = ensureDefaultWorkspace();
  // Packaged Axon launches directly; the dev fallback remains useful to us while testing.
  const launch = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`;
  const terminal = [
    '@echo off', 'title Axon Terminal', 'color 0F', `cd /d "${workspace}"`, 'prompt AXON $P$G',
  ].join('\r\n');
  const command = ['@echo off', 'if /I "%~1"=="terminal" (', '  start "Axon Terminal" "%ComSpec%" /k "%~dp0axon-terminal.cmd"', '  exit /b 0', ')', `start "Axon" ${launch}`, 'exit /b 0', ''].join('\r\n');
  fs.writeFileSync(path.join(dir, 'axon-terminal.cmd'), terminal, 'utf8');
  fs.writeFileSync(path.join(dir, 'axon.cmd'), command, 'utf8');
  process.env.PATH = dir + ';' + (process.env.PATH || '');
  // Persist it for future Command Prompt / Windows Terminal sessions, without touching system PATH.
  const escapedDir = dir.replace(/'/g, "''");
  const ps = `$d='${escapedDir}';$p=[Environment]::GetEnvironmentVariable('Path','User');if(-not (($p -split ';') | Where-Object { $_ -eq $d })){[Environment]::SetEnvironmentVariable('Path',(($p.TrimEnd(';')+';'+$d).TrimStart(';')),'User')};Add-Type -Name AxonEnv -Namespace Native -MemberDefinition '[DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,IntPtr wParam,string lParam,uint flags,uint timeout,out IntPtr result);' -ErrorAction SilentlyContinue;$r=[IntPtr]::Zero;[Native.AxonEnv]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,1000,[ref]$r)|Out-Null`;
  try { spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' }); } catch {}
  return dir;
}
function openGenuineTerminal() {
  ensureCliCommand();
  if (process.platform !== 'win32') {
    const script = path.join(cliDirectory(), 'axon-terminal');
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
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start "Axon Terminal" "%ComSpec%" /k "' + path.join(cliDirectory(), 'axon-terminal.cmd') + '"'], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.unref(); return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}
function validBrowserURL(value) {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function ensureBrowserPanel() {
  if (browserPanel) return browserPanel;
  browserPanel = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.contentView.addChildView(browserPanel);
  browserPanel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const report = () => win?.webContents.send('browser-status', { url: browserPanel.webContents.getURL(), title: browserPanel.webContents.getTitle(), canBack: browserPanel.webContents.canGoBack(), canForward: browserPanel.webContents.canGoForward() });
  browserPanel.webContents.on('did-navigate', report);
  browserPanel.webContents.on('page-title-updated', report);
  browserPanel.webContents.loadURL('https://www.google.com/');
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
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
      .filter(visible).slice(0, 120).map((el, index) => {
        const id = el.dataset.axonBrowserId || ('axon-' + (index + 1)); el.dataset.axonBrowserId = id;
        return { id, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 180), href: el.href || undefined, type: el.type || undefined };
      });
    return { title: document.title, url: location.href, text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000), controls };
  })()`;
}
async function readBrowser() {
  const panel = ensureBrowserPanel();
  return panel.webContents.executeJavaScript(browserSnapshotScript(), true);
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
    if (request.method !== 'POST' || request.headers['x-axon-browser-token'] !== browserBridgeToken) return done(403, { error: 'Axon Browser access denied.' });
    let raw = ''; request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 128 * 1024) request.destroy(); });
    request.on('end', async () => {
      let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch { return done(400, { error: 'Invalid browser request.' }); }
      try {
        const action = request.url?.replace(/^\//, '');
        if (action === 'open') return done(200, revealBrowser(payload.url));
        // Any native browser tool invocation should reveal the sidecar. In
        // particular, agents commonly start with browser_read rather than
        // browser_open, and failed interactions should still be visible.
        win?.webContents.send('browser-invoked', {});
        if (action === 'read') return done(200, await readBrowser());
        const panel = ensureBrowserPanel();
        if (action === 'click' || action === 'type') {
          const id = String(payload.id || ''); if (!/^axon-\d+$/.test(id)) throw new Error('Use an element ID returned by browser_read.');
          const text = action === 'type' ? String(payload.text || '') : '';
          const result = await panel.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-axon-browser-id="${id}"]'); if (!el) return { error: 'That page element is no longer available. Read the page again.' }; if ('${action}' === 'click') { el.click(); return { ok: true }; } el.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; if (!setter) return { error: 'That element cannot accept typed text.' }; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`, true);
          if (result?.error) throw new Error(result.error); return done(200, result);
        }
        if (action === 'screenshot') {
          const image = await panel.webContents.capturePage();
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
function ensureAxonBrowserMcpConfig(provider = null) {
  const home = path.join(app.getPath('userData'), 'terminal'); fs.mkdirSync(home, { recursive: true });
  const quote = (value) => JSON.stringify(String(value));
  const mcpScript = app.isPackaged ? path.join(process.resourcesPath, 'axon-browser-mcp.js') : path.join(__dirname, 'axon-browser-mcp.js');
  let profile = `[mcp_servers.axon_browser]\ncommand = ${quote(process.execPath)}\nargs = [${quote(mcpScript)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`;
  if (provider?.kind === 'responses') {
    profile += `\nmodel_provider = "axon_custom"\n[model_providers.axon_custom]\nname = ${quote(provider.name || 'Axon API')}\nbase_url = ${quote(provider.endpoint)}\nenv_key = "AXON_PROVIDER_API_KEY"\nwire_api = "responses"\n`;
  }
  fs.writeFileSync(path.join(home, 'browser.config.toml'), profile, 'utf8');
  return home;
}

// ---- execution permissions -------------------------------------------------
// Axon Terminal enforces the sandbox; this only validates the renderer value.
const PERMISSION_MODES = new Set(['approve', 'auto', 'full']);
const normalizeMode = (value) => (PERMISSION_MODES.has(value) ? value : 'auto');
const isOllamaCloudModel = (model, provider) =>
  (!provider?.kind || provider.kind === 'ollama') && /(?:^|[:._-])cloud$/i.test(String(model || ''));

// Axon Chat deliberately avoids an agent harness. It is a fast, local-first
// conversation surface backed by the selected Ollama-compatible runtime.
const directChatSessions = new Map();
function apiEndpoint(base, pathName) {
  const baseUrl = new URL(String(base || '').replace(/\/$/, '') + '/');
  return new URL(pathName.replace(/^\//, ''), baseUrl.href.endsWith('/v1/') ? baseUrl : new URL('v1/', baseUrl));
}
function runApiChat(model, prompt, sessionId, send, systemPrompt, holder, provider, history, user) {
  return new Promise((resolve) => {
    const key = readProviderSecret(provider?.credentialId);
    if (!key) { send('chat-error', 'This provider profile has no saved API key. Add one in Settings.'); send('chat-done', { sessionId, ok: false }); return resolve(); }
    const sid = sessionId || crypto.randomUUID();
    const responses = provider.kind === 'responses';
    let target; try { target = apiEndpoint(provider.endpoint, responses ? 'responses' : 'chat/completions'); } catch { send('chat-error', 'This provider has an invalid endpoint.'); send('chat-done', { sessionId: sid, ok: false }); return resolve(); }
    const messages = systemPrompt?.trim() ? [{ role: 'system', content: systemPrompt.trim() }, ...history, user] : [...history, user];
    const body = responses ? { model, input: messages, stream: true } : { model, messages, stream: true };
    const client = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const request = client.request(target, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
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
          const text = responses ? (event.delta || event.text || '') : (event.choices?.[0]?.delta?.content || '');
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
    const request = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
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
    }, (response) => {
      if (response.statusCode !== 200) {
        let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => { send('chat-error', `Axon Chat could not reach ${target.origin}: ${body.slice(0, 300) || response.statusCode}`); send('chat-done', { sessionId: sid, ok: false }); resolve(); });
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
    request.on('error', (error) => { send('chat-error', `Axon Chat request failed: ${error.message}`); send('chat-done', { sessionId: sid, ok: false }); resolve(); });
    request.end(payload);
  });
}

function runAxonTerminal(model, prompt, sessionId, send, systemPrompt, cwd, holder, images = [], permissionMode = 'auto', productMode = 'code', provider = null, capabilities = null) {
  holder = holder || {};
  return new Promise((resolve) => {
    const launch = findAxonTerminal();
    if (!launch) {
      send('chat-error', 'Axon Terminal is not built yet. Build the bundled Axon Terminal before using Code or Agent mode.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    const root = cwd || ensureDefaultWorkspace();
    const sandbox = { approve: 'read-only', auto: 'workspace-write', full: 'danger-full-access' }[normalizeMode(permissionMode)];
    const instruction = [
      systemPrompt?.trim(),
      productMode === 'agent' ? 'You are Axon Work. Execute the requested multi-step task toward a finished outcome. Use the browser when research or website interaction is needed; delegate only concrete, independent workstreams when they materially help; keep all workers within the parent workspace and permission boundary.' : 'You are Axon Code. Work directly in the current repository, use the browser only for focused implementation research, verify your changes, and keep the user informed. Do not delegate or turn the task into an autonomous workstream.',
      prompt,
    ].filter(Boolean).join('\n\n');
    const providerKind = provider?.kind || 'ollama';
    const usingOllamaCloud = isOllamaCloudModel(model, provider);
    if (!['ollama', 'responses'].includes(providerKind)) {
      send('chat-error', 'This API profile supports Axon Chat, but Code and Agent require a Responses-compatible provider for tool calling.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    const axonHome = ensureAxonBrowserMcpConfig(provider);
    // Earlier Axon Terminal preview builds rejected --color. Keep to the
    // conservative flag subset so Code sessions start on both builds.
    const common = ['--json', '--skip-git-repo-check', '--profile', 'browser', '--sandbox', sandbox, '-C', root];
    if (providerKind === 'ollama') common.push('--oss', '--local-provider', 'ollama');
    if (model) common.push('--model', model);
    if (productMode === 'agent') common.push('--enable', 'multi_agent_v2');
    // `resume` has its own narrower option set. Put shared exec options before
    // the subcommand so profile, sandbox, and browser MCP setup apply to both
    // a new session and a resumed one.
    const args = sessionId
      ? ['exec', ...common, 'resume', sessionId, instruction]
      : ['exec', ...common, instruction];
    const env = {
      ...process.env,
      AXON_HOME: axonHome,
      AXON_BROWSER_ENDPOINT: browserBridgeEndpoint,
      AXON_BROWSER_TOKEN: browserBridgeToken,
      AXON_PROVIDER_API_KEY: providerKind === 'responses' ? (readProviderSecret(provider?.credentialId) || '') : '',
      // A screenshot is an image tool result. Do not feed one to an obviously
      // text-only worker; structured browser_read remains available to all.
      AXON_BROWSER_ALLOW_SCREENSHOT: capabilities?.browserScreenshot ? '1' : '0',
    };
    delete env.CODEX_HOME;
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
        if (event.type === 'item.started' && event.item?.type === 'command_execution') send('chat-step', { type: 'tool_call', fn: 'Axon Terminal', args: { command: event.item.command || 'Running tool' } });
        if (event.type === 'item.completed' && event.item?.type === 'command_execution') send('chat-step', { type: 'tool_result', result: event.item.aggregated_output || event.item.status || 'Command completed' });
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) send('chat-delta', event.item.text);
        if (event.type === 'turn.failed' || event.type === 'error') {
          failed = true;
          const message = event.error?.message || event.message || 'Axon Terminal failed to complete this turn.';
          // A few cloud models still reject one of the richer terminal tool
          // schemas. Keep the real cause in the UI, but make it actionable:
          // this is a per-model provider limitation, not a VRAM requirement.
          const schemaRejected = /(?:tools?\.\d+\.function.*name.*required|name.*required.*tools?\.\d+\.function|tool schema)/i.test(message);
          send('chat-error', usingOllamaCloud && schemaRejected
            ? "Ollama Cloud rejected an Axon Terminal custom tool before the model could run. This is a protocol mismatch, not a VRAM or API-key issue. Chat works; Cloud Code and Work need Axon's native-function compatibility bridge."
            : message);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (holder.steer) { holder.steer = false; send('chat-done', { sessionId: resultSid, ok: false, steered: true }); return resolve(); }
      if (code && !failed) send('chat-error', `Axon Terminal exited ${code}${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`);
      finish(!code && !failed);
    });
    child.on('error', (error) => { send('chat-error', `Could not start Axon Terminal: ${error.message}`); finish(false); });
  });
}

// Swarm is deliberately a fan-out of independent, read-only workers. Parallel
// writes in one checkout would be a race, so each worker investigates, plans,
// or reviews and reports back through the existing live Agents panel.
const activeSwarms = new Map();
function swarmLimit(provider) { return (provider?.kind || 'ollama') === 'ollama' ? 3 : Infinity; }
const SWARM_WORKER_LANES = [
  'Scout: map the problem, unknowns, relevant evidence, and constraints.',
  'Builder: develop a concrete implementation or execution approach.',
  'Skeptic: look for risks, counterexamples, and verification steps.',
];
async function runSwarm({ swarmId, sentryModel, workerModel, prompt, images = [], workers, systemPrompt, cwd, provider, permissionMode }) {
  const cap = swarmLimit(provider);
  const count = Math.min(workers, cap);
  const root = cwd || ensureDefaultWorkspace();
  const mode = normalizeMode(permissionMode);
  const workerBound = await capabilityBoundPrompt(systemPrompt, workerModel, 'agent', provider);
  const group = { holders: new Map() }; activeSwarms.set(swarmId, group);
  const emit = (update) => win?.webContents.send('subagent-update', { swarmId, ...update });
  const runWorker = async (index) => {
    const id = crypto.randomUUID(); const holder = {}; group.holders.set(id, holder);
    const lane = SWARM_WORKER_LANES[index % SWARM_WORKER_LANES.length];
    const task = `Axon Swarm worker ${index + 1} of ${count}. ${lane} Independently investigate this outcome. Use the workspace and browser tools available under Axon's selected permission mode to inspect the real context, then return concise actionable findings for the Sentry. Do not delegate. Parallel workers must not modify files; report a proposed change instead.\n\nOutcome:\n${prompt}`;
    let result = '', failure = '';
    emit({ id, status: 'working', task: `Worker ${index + 1} · ${lane.split(':')[0]}`, model: workerModel, startedAt: Date.now() });
    const send = (channel, value) => {
      if (channel === 'chat-delta') result = (result + String(value || '')).slice(-16000);
      if (channel === 'chat-error') failure = String(value || 'Worker failed.');
    };
    try {
      if (isOllamaCloudModel(workerModel, provider)) {
        await runOllamaCloudAgent({ endpoint: activeOllamaUrl(), model: workerModel, prompt: task, systemPrompt: workerBound.systemPrompt, cwd: root, permissionMode: mode, productMode: 'code', send, holder, browser: { open: revealBrowser, read: readBrowser }, allowDelegation: false });
      } else {
        await runAxonTerminal(workerModel, task, null, send, workerBound.systemPrompt, root, holder, images, mode, 'code', provider, workerBound.report);
      }
      const summary = failure || result || '(worker completed without a text summary)';
      emit({ id, status: failure ? 'failed' : 'completed', result: summary, finishedAt: Date.now() });
      return { lane, summary, failed: !!failure };
    } catch (error) {
      const summary = error.message; emit({ id, status: 'failed', result: summary, finishedAt: Date.now() }); return { lane, summary, failed: true };
    } finally { group.holders.delete(id); }
  };
  emit({ id: swarmId, status: 'launching', task: `Axon Swarm · Sentry + ${count} workers`, model: sentryModel, startedAt: Date.now() });
  const reports = await Promise.all(Array.from({ length: count }, (_, index) => runWorker(index)));
  const sentryId = crypto.randomUUID(); const sentryHolder = {}; group.holders.set(sentryId, sentryHolder);
  const sentryBound = await capabilityBoundPrompt(systemPrompt, sentryModel, 'agent', provider);
  const brief = reports.map((report, index) => `Worker ${index + 1} (${report.lane}):\n${report.summary.slice(0, 6000)}`).join('\n\n');
  const sentryTask = `You are the Axon Swarm Sentry. You manage the worker reports below. Reconcile disagreements, inspect the workspace when it would resolve uncertainty, identify the strongest evidence, state remaining uncertainty, and return one concise, decision-ready plan for the original outcome. Do not delegate or modify files.\n\nOriginal outcome:\n${prompt}\n\nWorker reports:\n${brief}`;
  let sentryResult = '', sentryFailure = '';
  emit({ id: sentryId, status: 'working', task: 'Sentry · synthesize worker reports', model: sentryModel, startedAt: Date.now() });
  const sentrySend = (channel, value) => { if (channel === 'chat-delta') sentryResult = (sentryResult + String(value || '')).slice(-24000); if (channel === 'chat-error') sentryFailure = String(value || 'Sentry failed.'); };
  try {
    if (isOllamaCloudModel(sentryModel, provider)) await runOllamaCloudAgent({ endpoint: activeOllamaUrl(), model: sentryModel, prompt: sentryTask, systemPrompt: sentryBound.systemPrompt, cwd: root, permissionMode: mode, productMode: 'code', send: sentrySend, holder: sentryHolder, browser: { open: revealBrowser, read: readBrowser }, allowDelegation: false });
    else await runAxonTerminal(sentryModel, sentryTask, null, sentrySend, sentryBound.systemPrompt, root, sentryHolder, [], mode, 'code', provider, sentryBound.report);
    emit({ id: sentryId, status: sentryFailure ? 'failed' : 'completed', result: sentryFailure || sentryResult || '(Sentry completed without a text summary)', finishedAt: Date.now() });
  } catch (error) { emit({ id: sentryId, status: 'failed', result: error.message, finishedAt: Date.now() }); }
  finally { group.holders.delete(sentryId); }
  emit({ id: swarmId, status: 'completed', result: `Sentry and ${count} worker${count === 1 ? '' : 's'} finished. Open Agents to review the synthesis.`, finishedAt: Date.now() });
  activeSwarms.delete(swarmId);
}

// ---- IPC ------------------------------------------------------------------
ipcMain.handle('list-models', async () => lanClientConnected && remoteModels ? { models: remoteModels, remote: true } : (await listActiveModels()));
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
    setTray(runtimeKind === 'exo' ? 'Axon: Exo runtime' : runtimeKind === 'llamacpp' ? 'Axon: llama.cpp RPC runtime' : 'Axon: local Ollama');
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
ipcMain.handle('chat', async (_e, { model, prompt, sessionId, systemPrompt, cwd, images, requestId, productMode, provider, mode, grants, history }) => {
  if (!requestId || typeof requestId !== 'string') return { ok: false, error: 'Missing chat request ID.' };
  const expanded = String(prompt || '').trim();
  if (!expanded) return { ok: false, error: 'Enter a message first.' };
  const safe = safeImages(images);
  const send = (channel, value) => win?.webContents.send(channel, { requestId, ...(channel === 'chat-delta' ? { text: value } : channel === 'chat-step' ? { step: value } : channel === 'chat-error' ? { message: value } : value) });
  // ponytail: client mode forwards to the LAN server (cwd dropped -- the client's
  // project path is on the client device and doesn't map to the server's filesystem).
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'chat', requestId, model, prompt: expanded, sessionId, systemPrompt, images: safe, cwd: null, productMode, provider, mode }); return { ok: true }; }
  const permission = normalizeMode(mode);
  const selectedMode = ['chat', 'code', 'agent'].includes(productMode) ? productMode : 'chat';
  const bound = await capabilityBoundPrompt(systemPrompt, model, selectedMode, provider);
  let usableImages = safe;
  if (selectedMode === 'chat' && safe.length && !bound.report.vision) {
    usableImages = [];
    send('chat-step', { type: 'tool_result', result: `Images were not sent: ${model} does not have verified vision support.` });
  }
  const holder = {}; localHolders.set(requestId, holder);
  const run = selectedMode === 'chat'
    ? runDirectChat(model, expanded, sessionId, send, bound.systemPrompt, holder, usableImages, provider)
    : isOllamaCloudModel(model, provider)
      ? runOllamaCloudAgent({ endpoint: activeOllamaUrl(), model, prompt: expanded, sessionId, history, systemPrompt: bound.systemPrompt, cwd: cwd || ensureDefaultWorkspace(), permissionMode: permission, productMode: selectedMode, send, holder, browser: { open: revealBrowser, read: readBrowser }, onSubagent: (agent) => win?.webContents.send('subagent-update', agent) })
        .then((cloudSessionId) => send('chat-done', { sessionId: cloudSessionId, ok: true }), (error) => { send('chat-error', error.message); send('chat-done', { sessionId: sessionId || null, ok: false }); })
    : runAxonTerminal(model, expanded, sessionId, send, bound.systemPrompt, cwd, holder, usableImages, permission, selectedMode, provider, bound.report);
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
    .catch((error) => win?.webContents.send('subagent-update', { id: swarmId, swarmId, status: 'failed', task: 'Axon Swarm', result: error.message, finishedAt: Date.now() }));
  return { ok: true, swarmId, requested, count, capped: count !== requested, cap: Number.isFinite(swarmLimit(provider)) ? swarmLimit(provider) : null };
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
// only Axon's own default is created automatically.
function ensureDefaultWorkspace() {
  const configured = config?.load()?.oworkspace;
  if (typeof configured === 'string' && configured && fs.existsSync(configured)) return configured;
  const workspace = path.join(app.getPath('documents'), 'Axon Workspace');
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
  return true;
});
ipcMain.handle('provider-save', (_e, profile, apiKey) => {
  const value = profile || {};
  const kind = ['ollama', 'openai-compatible', 'responses'].includes(value.kind) ? value.kind : 'ollama';
  const clean = {
    id: typeof value.id === 'string' && /^[a-z0-9_-]{4,80}$/i.test(value.id) ? value.id : crypto.randomUUID(),
    name: typeof value.name === 'string' ? value.name.trim().slice(0, 80) || 'Unnamed provider' : 'Unnamed provider',
    kind,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim().replace(/\/$/, '').slice(0, 500) : '',
    model: typeof value.model === 'string' ? value.model.trim().slice(0, 160) : '',
    credentialId: typeof value.credentialId === 'string' ? value.credentialId : '',
  };
  if (kind !== 'ollama') {
    try { const endpoint = new URL(clean.endpoint); if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error(); } catch { throw new Error('Use an http(s) endpoint with no embedded credentials.'); }
    if (typeof apiKey === 'string' && apiKey.trim()) {
      clean.credentialId = `provider-${clean.id}`; saveProviderSecret(clean.credentialId, apiKey.trim());
    }
  } else { clean.endpoint = ''; clean.credentialId = ''; }
  return clean;
});

// ---- LAN: same-WiFi link, one instance as server ----------------------------
// ponytail: raw TCP + NDJSON (src/lan.js). Server runs Axon locally and streams
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
    const req = https.get(url, { headers: { 'User-Agent': 'Axon-Updater', Accept: 'application/vnd.github+json' } }, (res) => {
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
async function checkForAppUpdate() {
  const current = app.getVersion();
  const body = await readHttpsText(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`);
  let release; try { release = JSON.parse(body); } catch { throw new Error('Update server sent invalid release metadata.'); }
  const version = String(release.tag_name || '').replace(/^v/i, '');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((asset) => releaseInstallerNames(version).includes(asset?.name));
  const checksum = installer && assets.find((asset) => asset?.name === `${installer.name}.sha256`);
  if (!version || !installer || !checksum) throw new Error('Latest Axon release is incomplete.');
  const available = compareVersions(version, current) > 0;
  availableRelease = available ? { version, installer: installer.browser_download_url, checksum: checksum.browser_download_url, name: installer.name, bytes: Number(installer.size) || 0 } : null;
  return { current, version, available, bytes: Number(installer.size) || 0 };
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
      const notice = new Notification({ title: 'Axon update ready', body: `Axon ${update.version} is ready to download.` });
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
  if (!release) throw new Error('Axon is already up to date.');
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
function installerExtensions() { return process.platform === 'win32' ? ['exe'] : process.platform === 'linux' ? ['AppImage', 'deb'] : []; }
function releaseInstallerNames(version) {
  if (process.platform === 'win32') return [`Axon-Setup-${version}.exe`];
  if (process.platform === 'linux') return [`Axon_${version}_amd64.deb`, `Axon-${version}.AppImage`];
  return [];
}
async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk)); stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
async function selectInstaller() {
  const extensions = installerExtensions();
  if (!extensions.length) throw new Error('Installer sharing is not supported on this platform yet.');
  const picked = await dialog.showOpenDialog(win, { title: 'Choose the newer Axon installer', properties: ['openFile'], filters: [{ name: 'Axon installer', extensions }] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const file = picked.filePaths[0]; const stat = await fs.promises.stat(file);
  if (stat.size < 1024 || stat.size > 750 * 1024 * 1024) throw new Error('Installer must be between 1 KB and 750 MB.');
  hostInstaller = { path: file, name: safeInstallerName(path.basename(file)), bytes: stat.size, sha256: await hashFile(file) };
  return { name: hostInstaller.name, bytes: hostInstaller.bytes, sha256: hostInstaller.sha256 };
}
function offerInstaller(sock) {
  if (!hostInstaller) throw new Error('Choose a newer Axon installer first.');
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
          const usableImages = images.length && !bound.report.vision ? [] : images;
          if (images.length && !usableImages.length) send('chat-step', { type: 'tool_result', result: `Images were not sent: ${msg.model} does not advertise vision support.` });
          return selectedMode === 'chat'
            ? runDirectChat(msg.model, msg.prompt, msg.sessionId, send, bound.systemPrompt, holder, usableImages, msg.provider)
            : runAxonTerminal(msg.model, msg.prompt, msg.sessionId, send, bound.systemPrompt, null, holder, usableImages, normalizeMode(msg.mode), selectedMode, msg.provider, bound.report);
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
  if (!host || !device?.available) return { error: 'That device is not accepting Axon links. Turn on Host mode there first.' };
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
  if (!resolved.startsWith(path.resolve(dir) + path.sep) || !installerExtensions().some((item) => item.toLowerCase() === extension.toLowerCase()) || !fs.existsSync(resolved)) return { error: 'Verified installer not found.' };
  try {
    if (process.platform === 'linux') {
      if (extension.toLowerCase() === 'appimage') fs.chmodSync(resolved, 0o755);
      const error = await shell.openPath(resolved); return error ? { error: 'Could not open the verified installer: ' + error } : { ok: true };
    }
    const installer = spawn(resolved, [], { detached: true, stdio: 'ignore', windowsHide: false });
    installer.unref();
    return { ok: true };
  } catch (e) { return { error: 'Could not open the verified installer: ' + e.message }; }
});
ipcMain.handle('app-update-check', async () => {
  try { return await checkForAppUpdate(); } catch (error) { return { error: error.message }; }
});
ipcMain.handle('app-update-download', async () => {
  try { return await downloadAppUpdate(); } catch (error) { return { error: error.message }; }
});
ipcMain.handle('app-info', async () => ({ version: app.getVersion(), dependencies: await dependencyStatus() }));
ipcMain.handle('install-dependencies', async () => {
  const before = await dependencyStatus(); const steps = [];
  if (process.platform !== 'win32') return { ok: true, steps: ['Install Ollama through your Linux distribution. Axon Terminal is bundled with Axon releases.'], status: before };
  const run = async (command, args, label) => { const output = await runQuiet(command, args, 10 * 60 * 1000); steps.push(label + (output ? ': ' + output.split(/\r?\n/).pop() : ' started')); };
  if (!before.ollama) await run('winget.exe', ['install', '--id', 'Ollama.Ollama', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Ollama');
  if (!before.node) await run('winget.exe', ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Node.js');
  return { ok: true, steps, status: await dependencyStatus() };
});

// ---- app lifecycle --------------------------------------------------------
app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  config = createConfigStore(userDataPath);
  // Preserve all known predecessors. Merge only missing keys so the canonical
  // Axon folder wins while a dev/package casing change cannot lose history.
  const state = config.load(); const parent = path.dirname(userDataPath);
  try {
    if (state.oRuntime === 'exo' && state.oExoUrl) { runtimeKind = 'exo'; exoBase = normalizeExoUrl(state.oExoUrl); }
    else if (state.oRuntime === 'llamacpp') runtimeKind = 'llamacpp';
  } catch { runtimeKind = 'ollama'; exoBase = ''; }
  if (state.oLlamaCpp) llamaCppConfig = normalizeLlamaCppConfig(state.oLlamaCpp);
  const candidates = [
    path.join(parent, 'axon', 'settings.json'),
    path.join(parent, 'ollama-desktop-harness', 'settings.json'),
  ];
  const merged = {};
  for (const file of candidates) {
    if (path.resolve(file) === path.join(userDataPath, 'settings.json')) continue;
    try { Object.assign(merged, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  config.save({ ...merged, ...state });
  await startBrowserBridge();
  ensureCliCommand();
  createTray();
  createWindow();
  // Keeps visual/test launches from opening Windows' firewall prompt. Normal
  // packaged launches retain discovery unless the flag is explicitly set.
  if (process.env.AXON_DISABLE_LAN_DISCOVERY !== '1') startLanDiscovery();
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
