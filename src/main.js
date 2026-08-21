// Electron main: tray + window + ollama serve lifecycle + chat via the Claude Code harness.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const { parseEvent } = require('./cc');
const { parseOpencodeEvent, newOpencodeState } = require('./oc');
const { maybeExpandSlash, listCommands } = require('./commands');
const lan = require('./lan');
const { createConfigStore } = require('./config');

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

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_BASE = OLLAMA_URL.replace(/\/$/, ''); // claude talks to Ollama's native /v1/messages here
// ponytail: scoped auto-approve instead of blanket --dangerously-skip-permissions; user wanted auto-run.
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch'];
// The official release feed. Maintainers can point a fork at its own feed.
const UPDATE_REPOSITORY = process.env.AXON_UPDATE_REPOSITORY || 'Iyadobo/Axon';

let tray = null, win = null, ollamaProc = null, browserPanel = null, isQuitting = false;
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
function npmShimLaunch(shim) {
  try {
    const body = fs.readFileSync(shim, 'utf8');
    const match = body.match(/node_modules[\\/]([^"\r\n]+?\.js)/i);
    if (!match) return null;
    const entry = path.join(path.dirname(shim), 'node_modules', ...match[1].split(/[\\/]+/));
    if (!fs.existsSync(entry)) return null;
    return { command: whereFirst('node.exe') || 'node', prefix: [entry] };
  } catch { return null; }
}
function findClaude() {
  if (process.platform !== 'win32') {
    const home = os.homedir();
    const direct = [whereFirst('claude'), path.join(home, '.local', 'bin', 'claude')].find((candidate) => candidate && fs.existsSync(candidate));
    return direct ? { command: direct, prefix: [] } : null;
  }
  // Windows Start Menu launches can inherit an older PATH than an interactive
  // terminal. Claude's native installer uses ~/.local/bin, so probe it directly
  // instead of falling through to the non-existent bare `claude` command.
  const direct = [
    whereFirst('claude.exe'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Claude', 'claude.exe'),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (direct) return { command: direct, prefix: [] };
  const bare = whereFirst('claude');
  if (bare && /\.exe$/i.test(bare)) return { command: bare, prefix: [] };
  const shims = [whereFirst('claude.cmd'), process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'claude.cmd')].filter(Boolean);
  for (const shim of shims) { const launch = npmShimLaunch(shim); if (launch) return launch; }
  return null;
}
function findCodex() {
  if (process.platform !== 'win32') {
    const home = os.homedir();
    const direct = [whereFirst('codex'), path.join(home, '.local', 'bin', 'codex')].find((candidate) => candidate && fs.existsSync(candidate));
    return direct ? { command: direct, prefix: [] } : null;
  }
  const direct = [
    whereFirst('codex.exe'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'codex.cmd'),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  return direct ? { command: direct, prefix: [] } : null;
}
function findOpencode() {
  const home = os.homedir();
  if (process.platform !== 'win32') {
    const direct = [whereFirst('opencode'), path.join(home, '.opencode', 'bin', 'opencode'), path.join(home, '.local', 'bin', 'opencode')]
      .find((candidate) => candidate && fs.existsSync(candidate));
    return direct ? { command: direct, prefix: [] } : null;
  }
  // The npm package ships a platform binary and puts only a .cmd shim on PATH.
  // A .cmd cannot be spawned without a shell, and opencode.exe itself is not on
  // PATH, so probe inside the package rather than trusting `where`.
  const direct = [
    whereFirst('opencode.exe'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(home, '.opencode', 'bin', 'opencode.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'opencode', 'opencode.exe'),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  return direct ? { command: direct, prefix: [] } : null;
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
  const claudeLaunch = findClaude(), codexLaunch = findCodex(), opencodeLaunch = findOpencode();
  const [ollama, node, claude] = await Promise.all([
    runQuiet(whereFirst(process.platform === 'win32' ? 'ollama.exe' : 'ollama') || 'ollama', ['--version']),
    runQuiet(whereFirst(process.platform === 'win32' ? 'node.exe' : 'node') || 'node', ['--version']),
    claudeLaunch ? runQuiet(claudeLaunch.command, [...claudeLaunch.prefix, '--version']) : Promise.resolve(null),
  ]);
  const codexVersion = codexLaunch ? await runQuiet(codexLaunch.command, [...codexLaunch.prefix, '--version']) : null;
  const codexLogin = codexLaunch ? await runQuiet(codexLaunch.command, [...codexLaunch.prefix, 'login', 'status']) : null;
  const codex = codexVersion ? `${codexVersion}${/logged in/i.test(codexLogin || '') && !/not logged in/i.test(codexLogin || '') ? '' : ' (not logged in)'}` : null;
  const opencode = opencodeLaunch ? await runQuiet(opencodeLaunch.command, [...opencodeLaunch.prefix, '--version']) : null;
  return { ollama, node, claude, codex, opencode };
}
let config = null;
const visionCapability = new Map();

// ---- ollama serve lifecycle ----------------------------------------------
async function isOllamaUp() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_URL}/api/tags`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}
async function ensureOllama() {
  if (await isOllamaUp()) return setTray('Axon: running');
  ollamaProc = spawn('ollama', ['serve'], { windowsHide: true, shell: false });
  ollamaProc.on('exit', () => { ollamaProc = null; setTray('Axon: stopped'); });
  ollamaProc.stderr?.on('data', () => {});
  for (let i = 0; i < 40; i++) { await sleep(500); if (await isOllamaUp()) return setTray('Ollama: running'); }
  setTray('Axon: failed to start');
}

function ollama(pathname) {
  return new Promise((resolve, reject) => {
    const u = new URL(OLLAMA_URL); u.pathname = pathname;
    http.get(u, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); })
      .on('error', reject);
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
          const models = Array.isArray(parsed.models) ? parsed.models.filter((model) => model && typeof model.name === 'string').slice(0, 200) : [];
          resolve({ models, fetchedAt: new Date().toISOString() });
        } catch { reject(new Error('Ollama Cloud returned an invalid catalogue.')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Ollama Cloud catalogue timed out.')));
  });
}
async function modelSupportsVision(model) {
  if (visionCapability.has(model)) return visionCapability.get(model);
  try {
    const tag = (await ollama('/api/tags')).models?.find((item) => item.name === model);
    if (Array.isArray(tag?.capabilities)) {
      const supported = tag.capabilities.includes('vision'); visionCapability.set(model, supported); return supported;
    }
    const u = new URL(OLLAMA_URL); u.pathname = '/api/show';
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

// ---- custom slash-command discovery --------------------------------------
// Claude Code does NOT expand custom slash commands in headless -p mode (verified:
// /relaytest was sent to the model literally, never the command body), so we expand
// ~/.claude/commands/*.md ourselves (src/commands.js, testable). Built-in REPL commands
// (/clear, /model, /help, /compact) are intercepted in the renderer; everything else
// /foo is expanded if a file exists, otherwise passed through to the model as-is.

// ---- chat via the Claude Code harness -------------------------------------
// sessionId: null -> start a new Claude Code session; otherwise --resume <sessionId>.
// Axon adds its identity and the user's instructions to Claude Code's tool prompt;
// the harness remains available without being mistaken for the model's identity.
const AXON_IDENTITY_PROMPT = [
  'You are the language model operating inside Axon, a local desktop agent workspace.',
  'Claude Code is the harness that provides your tools and session runtime; it is not your identity.',
  'Do not introduce yourself as Claude Code. When asked who you are, say you are the assistant running in Axon and, if useful, explain that Claude Code is the underlying harness.',
  'The Axon instructions below are direct requirements for your behaviour, tone, and constraints.',
].join('\n');

// ---- permission modes -------------------------------------------------------
// Three tiers, mapped onto whatever each harness actually enforces:
//   approve — read-only by default. Anything that writes, deletes or runs a
//             command is refused by the harness, and Axon surfaces the refusal
//             as an Allow control in the transcript.
//   auto    — the curated tool set runs without asking (the long-standing
//             behaviour, and still the default).
//   full    — nothing is withheld.
// Claude Code's own flags do the enforcing, so a model cannot talk its way past
// this the way it could past a system-prompt rule.
const PERMISSION_MODES = new Set(['approve', 'auto', 'full']);
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch'];
const normalizeMode = (value) => (PERMISSION_MODES.has(value) ? value : 'auto');
// Tool names Axon will let the user grant from the transcript. Anything outside
// this list is not offerable, so a hostile tool name cannot smuggle extra
// arguments into the CLI's --allowedTools list.
const GRANTABLE_TOOLS = new Set([...ALLOWED_TOOLS, ...READ_ONLY_TOOLS]);
function sanitizeGrants(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((tool) => GRANTABLE_TOOLS.has(tool)))];
}
// The hesitation contract. Strongest in approve mode (where a refusal is
// expected and the model should plan rather than flail), still present in full
// mode, where nothing but the model's own judgement is left.
function permissionPrompt(mode, grants) {
  const lines = ['[Execution policy]'];
  if (mode === 'approve') {
    lines.push(
      'You are in APPROVE mode. Only read-only tools are granted' + (grants.length ? `, plus these the user has approved this session: ${grants.join(', ')}.` : '.'),
      'Before any action that writes, deletes, installs or runs a shell command: say what you intend to do and why, in one or two sentences, and then attempt it.',
      'If the harness refuses the action, do not retry it and do not look for a way around it. Explain what you needed and stop; the user gets an Allow button and decides.',
    );
  } else if (mode === 'full') {
    lines.push(
      'You are in FULL mode. No permission checks will stop you, so your own judgement is the only safeguard.',
      'Before anything destructive or hard to undo — deleting files, force-pushing, rewriting history, dropping data, mass edits — state what you are about to do and pause for the user to confirm in their next message.',
      'Prefer the reversible version of an action when one exists.',
    );
  } else {
    lines.push(
      'You are in AUTO mode. Reading, writing, editing and ordinary shell commands run without asking.',
      'Say what you are doing as you go. Before anything destructive or hard to undo — deleting files, force-pushing, rewriting history, dropping data, mass edits — stop and ask first rather than proceeding.',
    );
  }
  lines.push('Never work around a refused permission by reaching for a different tool that achieves the same effect.');
  return lines.join('\n');
}
function axonSystemPrompt(userInstructions, mode = 'auto', grants = []) {
  const user = String(userInstructions || '').trim();
  const base = `${AXON_IDENTITY_PROMPT}\n\n${permissionPrompt(normalizeMode(mode), grants)}`;
  return user ? `${base}\n\n[Axon instructions]\n${user}` : base;
}
function isVisionRejection(value) {
  const text = String(value || '');
  return /(?:image|vision|screenshot).{0,100}(?:not supported|unsupported|cannot|can't|does not support|not capable)|(?:400).{0,100}(?:image|vision|screenshot)/i.test(text);
}
// A refused action comes back as a normal tool_result carrying is_error, not as
// a crash or a hang — verified against Claude Code in --permission-mode manual.
// The renderer turns anything matching this into an Allow control.
function permissionDenial(text) {
  const value = String(text || '');
  const claude = value.match(/requested permissions to (.+?), but you haven'?t granted it yet/i);
  if (claude) return { what: claude[1].trim() };
  if (/permission for this action was denied|Blocked by classifier/i.test(value)) return { what: 'this action' };
  if (/permission denied by the user|rejected the tool/i.test(value)) return { what: 'this action' };
  return null;
}
function runChat(model, prompt, sessionId, send, systemPrompt, cwd, holder, images = [], recovered = false, mode = 'auto', grants = []) {
  holder = holder || {};
  return new Promise((resolve) => {
    const launch = findClaude();
    if (!launch) {
      send('chat-error', 'Claude Code is not installed. Select Codex CLI in Settings, or use Download missing dependencies to install Claude Code.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    const newSession = !sessionId;
    const sid = sessionId || crypto.randomUUID();
    const permission = normalizeMode(mode);
    const granted = sanitizeGrants(grants);
    // approve: read-only plus whatever the user has explicitly allowed this
    // conversation. full: withhold nothing. auto: the curated set.
    const tools = permission === 'approve' ? [...new Set([...READ_ONLY_TOOLS, ...granted])] : ALLOWED_TOOLS;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model];
    if (permission !== 'full') args.push('--allowedTools', ...tools);
    // `manual` makes a withheld tool come back as a refusal instead of running.
    // `bypassPermissions` is the flag that actually works here — plain
    // --dangerously-skip-permissions is gated behind an auto-mode classifier.
    if (permission === 'approve') args.push('--permission-mode', 'manual');
    else if (permission === 'full') args.push('--permission-mode', 'bypassPermissions');
    args.push(newSession ? '--session-id' : '--resume', sid);
    args.push('--append-system-prompt', axonSystemPrompt(systemPrompt, permission, granted));
    const child = spawn(launch.command, [...launch.prefix, ...args], {
      env: { ...process.env, ANTHROPIC_BASE_URL: OLLAMA_BASE, ANTHROPIC_AUTH_TOKEN: 'ollama' },
      cwd: cwd || undefined,
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Claude Code's stream-json input preserves Anthropic content blocks. Ollama
    // vision models receive real base64 image blocks; text-only models can still
    // explain that they cannot inspect an image.
    const content = [{ type: 'text', text: prompt }];
    for (const image of images) content.push({ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    holder.child = child;
    let buf = '';
    let resultSid = sid;
    let visionRejected = false;
    const toolNames = new Map(); // tool_use id -> tool name, to label a refusal
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const ev = parseEvent(line);
        if (!ev || !ev.flow) continue;
        for (const f of ev.flow) {
          // Tag a refused action so the renderer can offer to grant it. Only
          // tools Axon is willing to grant become offers; the rest stay plain
          // errors, so nothing unexpected can end up in --allowedTools.
          if (f.act === 'step' && f.step?.type === 'tool_call' && f.step.id) toolNames.set(f.step.id, f.step.fn);
          if (f.act === 'step' && f.step?.type === 'tool_result' && f.step.is_error !== false) {
            const denial = permissionDenial(f.step.result);
            if (denial) {
              const tool = toolNames.get(f.step.id);
              f.step.denied = { what: denial.what, tool: GRANTABLE_TOOLS.has(tool) ? tool : null };
              f.step.is_error = true;
            }
          }
          if (f.act === 'delta') send('chat-delta', f.text);
          else if (f.act === 'step') send('chat-step', f.step);
          else if (f.act === 'done') {
            if (f.is_error) { visionRejected ||= isVisionRejection(f.result); if (!visionRejected) send('chat-error', f.result); }
            if (f.session_id) resultSid = f.session_id;
          }
        }
      }
    });
    let stderrBuf = '';
    child.stderr.on('data', (c) => { stderrBuf += c; });
    child.on('exit', (code) => {
      if (holder.child === child) holder.child = null;
      if (holder.steer) { holder.steer = false; send('chat-done', { sessionId: resultSid, ok: false, steered: true }); return resolve(); }
      // A rejected image can become part of Claude's resumed session. Restart
      // once with a clean session and no image blocks so later text messages do
      // not keep receiving the same 400 from a non-vision model.
      if (visionRejected && !recovered) {
        send('chat-step', { type: 'tool_result', result: 'This model rejected an image/screenshot. Retrying this request in a clean text-only session.' });
        return runChat(model, prompt, null, send, systemPrompt, cwd, holder, [], true, permission, granted).then(resolve);
      }
      if (code && !stderrBuf.includes('connectors')) send('chat-error', `claude exited ${code}${stderrBuf ? ': ' + stderrBuf.trim().slice(0, 300) : ''}`);
      send('chat-done', { sessionId: resultSid, ok: !code });
      resolve();
    });
    child.on('error', (e) => { if (holder.child === child) holder.child = null; send('chat-error', `failed to launch claude: ${e.message}`); send('chat-done', { sessionId: resultSid, ok: false }); resolve(); });
  });
}

// Codex's supported noninteractive interface emits JSONL events. We map the
// useful parts into Axon's existing streaming/text/tool-step protocol.
function runCodex(model, prompt, sessionId, send, systemPrompt, cwd, holder, images = [], mode = 'auto') {
  holder = holder || {};
  return new Promise((resolve) => {
    const launch = findCodex();
    if (!launch) {
      send('chat-error', 'Codex CLI is not installed. Install the Codex desktop app or `@openai/codex`, then restart Axon.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    if (images.length) send('chat-step', { type: 'tool_result', result: 'Images are not yet supported by Axon’s Codex CLI bridge; this turn was sent as text only.' });
    const root = cwd || ensureDefaultWorkspace();
    // Codex enforces the same three tiers through its own sandbox setting.
    const sandbox = { approve: 'read-only', auto: 'workspace-write', full: 'danger-full-access' }[normalizeMode(mode)];
    const common = ['--json', '--color', 'never', '--skip-git-repo-check', '--sandbox', sandbox, '-C', root];
    if (model) common.push('--model', model);
    const instruction = (systemPrompt?.trim() ? systemPrompt.trim() + '\n\n' : '') + prompt;
    const args = sessionId ? ['exec', 'resume', sessionId, ...common, instruction] : ['exec', ...common, instruction];
    const child = spawn(launch.command, [...launch.prefix, ...args], { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    holder.child = child;
    let buffer = '', resultSid = sessionId || null, stderr = '', failed = false;
    const finish = (ok) => { if (holder.child === child) holder.child = null; send('chat-done', { sessionId: resultSid, ok }); resolve(); };
    child.stdout.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'thread.started' && event.thread_id) resultSid = event.thread_id;
        if (event.type === 'item.started' && event.item?.type === 'command_execution') send('chat-step', { type: 'tool_call', fn: 'Codex', args: { command: event.item.command || 'Running tool' } });
        if (event.type === 'item.completed' && event.item?.type === 'command_execution') send('chat-step', { type: 'tool_result', result: event.item.aggregated_output || event.item.status || 'Command completed' });
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) send('chat-delta', event.item.text);
        if (event.type === 'turn.failed' || event.type === 'error') { failed = true; send('chat-error', event.error?.message || event.message || 'Codex failed to complete this turn.'); }
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

// opencode's `run --format json` prints one JSON object per line. Unlike Claude
// Code it emits whole parts rather than token deltas, and a tool event arrives
// already completed — input and output together — so each one becomes a
// tool_call + tool_result pair keyed by callID. Events are deduped by part id
// because a future opencode may stream a part cumulatively rather than once.
function runOpencode(model, prompt, sessionId, send, systemPrompt, cwd, holder, images = [], mode = 'auto') {
  holder = holder || {};
  return new Promise((resolve) => {
    const launch = findOpencode();
    if (!launch) {
      send('chat-error', 'opencode is not installed. Install it with `npm i -g opencode-ai` (or from opencode.ai), then restart Axon.');
      send('chat-done', { sessionId, ok: false });
      return resolve();
    }
    if (images.length) send('chat-step', { type: 'tool_result', result: 'Images are not yet supported by Axon’s opencode bridge; this turn was sent as text only.' });
    const root = cwd || ensureDefaultWorkspace();
    const instruction = (systemPrompt?.trim() ? systemPrompt.trim() + '\n\n' : '') + prompt;
    const args = ['run', '--format', 'json', '--thinking', '--dir', root];
    // opencode only exposes one lever here: --auto blanket-approves anything not
    // explicitly denied, so it maps to full and nothing else.
    if (normalizeMode(mode) === 'full') args.push('--auto');
    if (model) args.push('--model', model);
    if (sessionId) args.push('--session', sessionId);
    args.push(instruction);
    const child = spawn(launch.command, [...launch.prefix, ...args], { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    holder.child = child;
    let buffer = '', resultSid = sessionId || null, stderr = '', failed = false;
    const state = newOpencodeState();
    child.stdout.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const ev = parseOpencodeEvent(line, state);
        if (!ev) continue;
        if (ev.sessionId) resultSid = ev.sessionId;
        for (const f of ev.flow) {
          if (f.act === 'delta') send('chat-delta', f.text);
          else if (f.act === 'step') send('chat-step', f.step);
          else if (f.act === 'error') { failed = true; send('chat-error', f.message); }
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (holder.child === child) holder.child = null;
      if (holder.steer) { holder.steer = false; send('chat-done', { sessionId: resultSid, ok: false, steered: true }); return resolve(); }
      if (code && !failed) send('chat-error', `opencode exited ${code}${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`);
      send('chat-done', { sessionId: resultSid, ok: !code && !failed });
      resolve();
    });
    child.on('error', (error) => {
      if (holder.child === child) holder.child = null;
      send('chat-error', `Could not start opencode: ${error.message}`);
      send('chat-done', { sessionId: resultSid, ok: false });
      resolve();
    });
  });
}

// ---- IPC ------------------------------------------------------------------
ipcMain.handle('list-models', async () => lanClientConnected && remoteModels ? { models: remoteModels, remote: true } : (await ollama('/api/tags')));
ipcMain.handle('refresh-cloud-models', async () => fetchCloudCatalogue());
ipcMain.handle('list-commands', () => listCommands());
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
ipcMain.handle('chat', async (_e, { model, prompt, sessionId, systemPrompt, cwd, images, requestId, harness, mode, grants }) => {
  if (!requestId || typeof requestId !== 'string') return { ok: false, error: 'Missing chat request ID.' };
  const expanded = maybeExpandSlash(prompt);
  const safe = safeImages(images);
  const send = (channel, value) => win?.webContents.send(channel, { requestId, ...(channel === 'chat-delta' ? { text: value } : channel === 'chat-step' ? { step: value } : channel === 'chat-error' ? { message: value } : value) });
  // ponytail: client mode forwards to the LAN server (cwd dropped -- the client's
  // project path is on the client device and doesn't map to the server's filesystem).
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'chat', requestId, model, prompt: expanded, sessionId, systemPrompt, images: safe, cwd: null }); return { ok: true }; }
  const permission = normalizeMode(mode);
  if (harness === 'codex' || harness === 'opencode') {
    const holder = {}; localHolders.set(requestId, holder);
    const run = harness === 'opencode' ? runOpencode : runCodex;
    run(model, expanded, sessionId, send, systemPrompt, cwd, holder, safe, permission)
      .catch((error) => send('chat-error', error.message))
      .finally(() => localHolders.delete(requestId));
    return { ok: true };
  }
  let usableImages = safe;
  if (safe.length && await modelSupportsVision(model) === false) {
    usableImages = [];
    send('chat-step', { type: 'tool_result', result: `Images were not sent: ${model} does not advertise vision support.` });
  }
  const holder = {}; localHolders.set(requestId, holder);
  runChat(model, expanded, sessionId, send, systemPrompt, cwd, holder, usableImages, false, permission, sanitizeGrants(grants))
    .catch((e) => send('chat-error', e.message))
    .finally(() => localHolders.delete(requestId));
  return { ok: true };
});
ipcMain.handle('chat-stop', (_e, requestId) => {
  if (!requestId) return false;
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'stop', requestId }); return true; }
  const holder = localHolders.get(requestId);
  if (holder?.child && !holder.child.killed) holder.child.kill();
  return true;
});
ipcMain.handle('chat-steer', (_e, requestId) => {
  if (!requestId) return false;
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'steer', requestId }); return true; }
  const holder = localHolders.get(requestId);
  if (holder?.child && !holder.child.killed) { holder.steer = true; holder.child.kill(); return true; }
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

// ---- LAN: same-WiFi link, one instance as server ----------------------------
// ponytail: raw TCP + NDJSON (src/lan.js). Server runs claude locally and streams
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
  if (process.platform === 'linux') return [`Axon-${version}.AppImage`, `Axon_${version}_amd64.deb`];
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
        try { models = (await ollama('/api/tags')).models || []; } catch {}
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
          const usableImages = images.length && await modelSupportsVision(msg.model) === false ? [] : images;
          if (images.length && !usableImages.length) send('chat-step', { type: 'tool_result', result: `Images were not sent: ${msg.model} does not advertise vision support.` });
          return runChat(msg.model, msg.prompt, msg.sessionId, send, msg.systemPrompt, null, holder, usableImages);
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
  if (process.platform !== 'win32') return { ok: true, steps: ['Install Ollama and Node.js through your Linux distribution, then install Claude Code with: npm install -g @anthropic-ai/claude-code'], status: before };
  const run = async (command, args, label) => { const output = await runQuiet(command, args, 10 * 60 * 1000); steps.push(label + (output ? ': ' + output.split(/\r?\n/).pop() : ' started')); };
  if (!before.ollama) await run('winget.exe', ['install', '--id', 'Ollama.Ollama', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Ollama');
  if (!before.node) { await run('winget.exe', ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Node.js'); steps.push('Restart Axon, then run this once more to install Claude Code.'); }
  else if (!before.claude) await run('cmd.exe', ['/d', '/s', '/c', 'npm install -g @anthropic-ai/claude-code'], 'Claude Code');
  return { ok: true, steps, status: await dependencyStatus() };
});

// Fetch the real Claude Code slash-command list (the same menu Claude shows on `/`).
// Source: the `system/init` stream-json event fires at session start with a
// `slash_commands` array (built-ins + plugins + skills + custom). We spawn a throwaway
// `claude -p`, read only that event, then kill the child — no model call, ~2-3s, cached.
let cachedCommands = null;
function fetchCommands(model) {
  return new Promise((resolve) => {
    if (cachedCommands) return resolve(cachedCommands);
    const launch = findClaude();
    if (!launch) return resolve([]);
    const child = spawn(launch.command, [...launch.prefix, '-p', '.', '--output-format', 'stream-json', '--verbose', '--model', model || 'qwen2.5:1.5b', '--allowedTools', 'Read'], {
      env: { ...process.env, ANTHROPIC_BASE_URL: OLLAMA_BASE, ANTHROPIC_AUTH_TOKEN: 'ollama' },
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '', done = false;
    const finish = (v) => { if (done) return; done = true; try { if (!child.killed) child.kill(); } catch {} resolve(v); };
    child.stdout.on('data', (c) => {
      if (done) return;
      buf += c; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') { cachedCommands = ev.slash_commands || []; finish(cachedCommands); }
      }
    });
    child.on('exit', () => finish(cachedCommands || []));
    child.on('error', () => finish([]));
    setTimeout(() => finish(cachedCommands || []), 30000); // give up -> renderer falls back to custom-only
  });
}
ipcMain.handle('fetch-commands', (_e, model) => fetchCommands(model));
ipcMain.handle('refresh-commands', (_e, model) => { cachedCommands = null; return fetchCommands(model); });

// ---- app lifecycle --------------------------------------------------------
app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  config = createConfigStore(userDataPath);
  // Preserve all known predecessors. Merge only missing keys so the canonical
  // Axon folder wins while a dev/package casing change cannot lose history.
  const state = config.load(); const parent = path.dirname(userDataPath);
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
  ensureCliCommand();
  createTray();
  createWindow();
  // Keeps visual/test launches from opening Windows' firewall prompt. Normal
  // packaged launches retain discovery unless the flag is explicitly set.
  if (process.env.AXON_DISABLE_LAN_DISCOVERY !== '1') startLanDiscovery();
  await ensureOllama();
});
app.on('before-quit', () => { isQuitting = true; if (ollamaProc && !ollamaProc.killed) ollamaProc.kill(); if (lanServer) lanServer.stop(); if (lanClient) { try { lanClient.end(); } catch {} } lanDiscovery?.stop(); });
app.on('window-all-closed', () => app.quit());
