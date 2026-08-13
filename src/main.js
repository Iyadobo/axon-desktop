// Electron main: tray + window + ollama serve lifecycle + chat via the Claude Code harness.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const { parseEvent } = require('./cc');
const { maybeExpandSlash, listCommands } = require('./commands');
const lan = require('./lan');
const { createConfigStore } = require('./config');

// ponytail: set once so the window groups under its own taskbar entry (pinnable) instead of Electron's.
// Keep the legacy ID so the renamed app upgrades in place and retains its
// existing Windows taskbar identity instead of creating a second slot.
try { app.setAppUserModelId('com.iyad.axion'); } catch {}
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

let tray = null, win = null, ollamaProc = null, browserPanel = null;
let trayLabel = 'Axon: starting…';
// Each conversation gets its own holder. A slow or unavailable model must never
// own the whole window (or somebody else's Stop button).
const localHolders = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve a directly executable Claude launch command. `where claude` can
// return an extensionless npm shim on Windows, which spawn(..., shell:false)
// cannot execute. Prefer an .exe; otherwise run the npm shim's JS entry via
// node, preserving shell:false so prompts/settings never become shell input.
function whereFirst(command) {
  try {
    return execSync(`where.exe ${command}`, { encoding: 'utf8', windowsHide: true })
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
  return { command: 'claude', prefix: [] };
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
  const [ollama, node, claude] = await Promise.all([
    runQuiet(whereFirst('ollama.exe') || 'ollama', ['--version']),
    runQuiet(whereFirst('node.exe') || 'node', ['--version']),
    runQuiet(findClaude().command, [...findClaude().prefix, '--version']),
  ]);
  return { ollama, node, claude };
}
let CLAUDE_LAUNCH = null;
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Axon is a normal desktop app: the window close button means fully quit,
  // not a surprise background tray process.
  win.on('closed', () => { win = null; });
}
// Electron has no `localAppData` getPath key; use the Windows environment
// location directly so the CLI remains user-local and works in packaged builds.
function cliDirectory() { return path.join(process.env.LOCALAPPDATA || path.dirname(app.getPath('appData')), 'Axon', 'bin'); }
function ensureCliCommand() {
  const dir = cliDirectory(); fs.mkdirSync(dir, { recursive: true });
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
// systemPrompt -> `--append-system-prompt` (headless supports it); cwd -> spawn working dir.
function isVisionRejection(value) {
  const text = String(value || '');
  return /(?:image|vision|screenshot).{0,100}(?:not supported|unsupported|cannot|can't|does not support|not capable)|(?:400).{0,100}(?:image|vision|screenshot)/i.test(text);
}
function runChat(model, prompt, sessionId, send, systemPrompt, cwd, holder, images = [], recovered = false) {
  holder = holder || {};
  return new Promise((resolve) => {
    const newSession = !sessionId;
    const sid = sessionId || crypto.randomUUID();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model,
      '--allowedTools', ...ALLOWED_TOOLS, newSession ? '--session-id' : '--resume', sid];
    if (systemPrompt && systemPrompt.trim()) args.push('--append-system-prompt', systemPrompt);
    const child = spawn(CLAUDE_LAUNCH.command, [...CLAUDE_LAUNCH.prefix, ...args], {
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
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const ev = parseEvent(line);
        if (!ev) continue;
        if (ev.deltas) for (const d of ev.deltas) send('chat-delta', d);
        if (ev.steps) for (const s of ev.steps) send('chat-step', s);
        if (ev.done) {
          if (ev.is_error) { visionRejected ||= isVisionRejection(ev.result); if (!visionRejected) send('chat-error', ev.result); }
          if (ev.session_id) resultSid = ev.session_id;
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
        return runChat(model, prompt, null, send, systemPrompt, cwd, holder, [], true).then(resolve);
      }
      if (code && !stderrBuf.includes('connectors')) send('chat-error', `claude exited ${code}${stderrBuf ? ': ' + stderrBuf.trim().slice(0, 300) : ''}`);
      send('chat-done', { sessionId: resultSid, ok: !code });
      resolve();
    });
    child.on('error', (e) => { if (holder.child === child) holder.child = null; send('chat-error', `failed to launch claude: ${e.message}`); send('chat-done', { sessionId: resultSid, ok: false }); resolve(); });
  });
}

// ---- IPC ------------------------------------------------------------------
ipcMain.handle('list-models', async () => lanClientConnected && remoteModels ? { models: remoteModels, remote: true } : (await ollama('/api/tags')));
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
ipcMain.handle('chat', async (_e, { model, prompt, sessionId, systemPrompt, cwd, images, requestId }) => {
  if (!requestId || typeof requestId !== 'string') return { ok: false, error: 'Missing chat request ID.' };
  const expanded = maybeExpandSlash(prompt);
  const safe = safeImages(images);
  const send = (channel, value) => win?.webContents.send(channel, { requestId, ...(channel === 'chat-delta' ? { text: value } : channel === 'chat-step' ? { step: value } : channel === 'chat-error' ? { message: value } : value) });
  // ponytail: client mode forwards to the LAN server (cwd dropped -- the client's
  // project path is on the client device and doesn't map to the server's filesystem).
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'chat', requestId, model, prompt: expanded, sessionId, systemPrompt, images: safe, cwd: null }); return { ok: true }; }
  let usableImages = safe;
  if (safe.length && await modelSupportsVision(model) === false) {
    usableImages = [];
    send('chat-step', { type: 'tool_result', result: `Images were not sent: ${model} does not advertise vision support.` });
  }
  const holder = {}; localHolders.set(requestId, holder);
  runChat(model, expanded, sessionId, send, systemPrompt, cwd, holder, usableImages)
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
const lanInstanceId = crypto.randomUUID();
let hostInstaller = null;
const pendingUpdateRequests = new Map();
const pendingUpdateOffers = new Map();
let inboundUpdate = null;
function lanStatus(obj) { win?.webContents.send('lan-status', obj); }
function updateEvent(channel, value) { win?.webContents.send(channel, value); }
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
  const picked = await dialog.showOpenDialog(win, { title: 'Choose the newer Axon installer', properties: ['openFile'], filters: [{ name: 'Axon installer', extensions: ['exe'] }] });
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

function connectLanClient(host) {
  if (lanClient) { try { lanClient.end(); } catch {} lanClient = null; lanClientConnected = false; }
  const [h, p] = String(host || '').split(':');
  if (!h || !h.trim()) return false;
  lanClient = lan.connectClient(h.trim(), p ? parseInt(p, 10) || lan.PORT : lan.PORT, {
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
    onStatus: (state) => { lanClientConnected = (state === 'connected'); if (!lanClientConnected) remoteModels = null; lanStatus({ client: state }); },
  });
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
ipcMain.handle('update-open-installer', (_e, file) => {
  const dir = path.join(app.getPath('userData'), 'updates'); const resolved = path.resolve(String(file || ''));
  if (!resolved.startsWith(path.resolve(dir) + path.sep) || path.extname(resolved).toLowerCase() !== '.exe' || !fs.existsSync(resolved)) return { error: 'Verified installer not found.' };
  try {
    const installer = spawn(resolved, [], { detached: true, stdio: 'ignore', windowsHide: false });
    installer.unref();
    return { ok: true };
  } catch (e) { return { error: 'Could not open the verified installer: ' + e.message }; }
});
ipcMain.handle('app-info', async () => ({ version: app.getVersion(), dependencies: await dependencyStatus() }));
ipcMain.handle('install-dependencies', async () => {
  const before = await dependencyStatus(); const steps = [];
  const run = async (command, args, label) => { const output = await runQuiet(command, args, 10 * 60 * 1000); steps.push(label + (output ? ': ' + output.split(/\r?\n/).pop() : ' started')); };
  if (!before.ollama) await run('winget.exe', ['install', '--id', 'Ollama.Ollama', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Ollama');
  if (!before.node) { await run('winget.exe', ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Node.js'); steps.push('Restart Axon, then run this once more to install Claude Code.'); }
  else if (!before.claude) await run('cmd.exe', ['/d', '/s', '/c', 'npm install -g @anthropic-ai/claude-code'], 'Claude Code');
  return { ok: true, steps, status: await dependencyStatus() };
});
ipcMain.handle('cleanup-legacy-axion', async () => { await shell.openExternal('ms-settings:appsfeatures'); return { ok: true }; });

// Fetch the real Claude Code slash-command list (the same menu Claude shows on `/`).
// Source: the `system/init` stream-json event fires at session start with a
// `slash_commands` array (built-ins + plugins + skills + custom). We spawn a throwaway
// `claude -p`, read only that event, then kill the child — no model call, ~2-3s, cached.
let cachedCommands = null;
function fetchCommands(model) {
  return new Promise((resolve) => {
    if (cachedCommands) return resolve(cachedCommands);
    const child = spawn(CLAUDE_LAUNCH.command, [...CLAUDE_LAUNCH.prefix, '-p', '.', '--output-format', 'stream-json', '--verbose', '--model', model || 'qwen2.5:1.5b', '--allowedTools', 'Read'], {
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
    path.join(parent, 'axion', 'settings.json'),
    path.join(parent, 'Axion', 'settings.json'),
    path.join(parent, 'axon', 'settings.json'),
    path.join(parent, 'ollama-desktop-harness', 'settings.json'),
  ];
  const merged = {};
  for (const file of candidates) {
    if (path.resolve(file) === path.join(userDataPath, 'settings.json')) continue;
    try { Object.assign(merged, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  config.save({ ...merged, ...state });
  CLAUDE_LAUNCH = findClaude();
  ensureCliCommand();
  createTray();
  createWindow();
  startLanDiscovery();
  await ensureOllama();
});
app.on('before-quit', () => { if (ollamaProc && !ollamaProc.killed) ollamaProc.kill(); if (lanServer) lanServer.stop(); if (lanClient) { try { lanClient.end(); } catch {} } lanDiscovery?.stop(); });
app.on('window-all-closed', () => app.quit());
