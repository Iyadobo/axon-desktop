// Electron main: tray + window + ollama serve lifecycle + chat via the Claude Code harness.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { parseEvent } = require('./cc');
const { maybeExpandSlash, listCommands } = require('./commands');
const lan = require('./lan');
const { createConfigStore } = require('./config');

// ponytail: set once so the window groups under its own taskbar entry (pinnable) instead of Electron's.
try { app.setAppUserModelId('com.iyad.axion'); } catch {}
// Keep a launch click focused on the existing Axion window instead of opening
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

let tray = null, win = null, ollamaProc = null;
let trayLabel = 'Axion: starting…';
const localHolder = { child: null };  // current local claude subprocess (remote LAN sockets track their own)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the real claude.exe path once (spawn with shell:false needs a full path on Windows).
function findClaude() {
  try {
    const out = execSync('where claude', { encoding: 'utf8' });
    const p = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (p) return p;
  } catch {}
  return 'claude'; // fallback (may need shell:true on other setups)
}
let CLAUDE_PATH = null;
let config = null;

// ---- ollama serve lifecycle ----------------------------------------------
async function isOllamaUp() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_URL}/api/tags`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}
async function ensureOllama() {
  if (await isOllamaUp()) return setTray('Axion: running');
  ollamaProc = spawn('ollama', ['serve'], { windowsHide: true, shell: false });
  ollamaProc.on('exit', () => { ollamaProc = null; setTray('Axion: stopped'); });
  ollamaProc.stderr?.on('data', () => {});
  for (let i = 0; i < 40; i++) { await sleep(500); if (await isOllamaUp()) return setTray('Ollama: running'); }
  setTray('Axion: failed to start');
}

function ollama(pathname) {
  return new Promise((resolve, reject) => {
    const u = new URL(OLLAMA_URL); u.pathname = pathname;
    http.get(u, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); })
      .on('error', reject);
  });
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
  win.on('close', (e) => { e.preventDefault(); win.hide(); }); // ponytail: hide-to-tray
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
function runChat(model, prompt, sessionId, send, systemPrompt, cwd, holder, images = []) {
  holder = holder || localHolder;
  return new Promise((resolve) => {
    const newSession = !sessionId;
    const sid = sessionId || crypto.randomUUID();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model,
      '--allowedTools', ...ALLOWED_TOOLS, newSession ? '--session-id' : '--resume', sid];
    if (systemPrompt && systemPrompt.trim()) args.push('--append-system-prompt', systemPrompt);
    const child = spawn(CLAUDE_PATH, args, {
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
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const ev = parseEvent(line);
        if (!ev) continue;
        if (ev.deltas) for (const d of ev.deltas) send('chat-delta', d);
        if (ev.steps) for (const s of ev.steps) send('chat-step', s);
        if (ev.done) { if (ev.is_error) send('chat-error', ev.result); if (ev.session_id) resultSid = ev.session_id; }
      }
    });
    let stderrBuf = '';
    child.stderr.on('data', (c) => { stderrBuf += c; });
    child.on('exit', (code) => {
      holder.child = null;
      if (code && !stderrBuf.includes('connectors')) send('chat-error', `claude exited ${code}${stderrBuf ? ': ' + stderrBuf.trim().slice(0, 300) : ''}`);
      send('chat-done', { sessionId: resultSid, ok: !code });
      resolve();
    });
    child.on('error', (e) => { holder.child = null; send('chat-error', `failed to launch claude: ${e.message}`); send('chat-done', { sessionId: resultSid, ok: false }); resolve(); });
  });
}

// ---- IPC ------------------------------------------------------------------
ipcMain.handle('list-models', async () => (await ollama('/api/tags')));
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
ipcMain.handle('chat', async (_e, { model, prompt, sessionId, systemPrompt, cwd, images }) => {
  const expanded = maybeExpandSlash(prompt);
  const safe = safeImages(images);
  const send = win.webContents.send.bind(win.webContents);
  // ponytail: client mode forwards to the LAN server (cwd dropped -- the client's
  // project path is on the client device and doesn't map to the server's filesystem).
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'chat', model, prompt: expanded, sessionId, systemPrompt, images: safe, cwd: null }); return { ok: true }; }
  try { await runChat(model, expanded, sessionId, send, systemPrompt, cwd, null, safe); return { ok: true }; }
  catch (e) { send('chat-error', e.message); return { ok: false, error: e.message }; }
});
ipcMain.handle('chat-stop', () => {
  if (lanClientConnected && lanClient) { lanClient.send({ type: 'stop' }); return true; }
  if (localHolder.child && !localHolder.child.killed) localHolder.child.kill();
  return true;
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('load-state', () => config?.load() || {});
ipcMain.handle('save-state', (_e, updates) => config?.save(updates) || {});
// 'clear' is retained for compatibility; the renderer now owns conversation state.
ipcMain.handle('clear', () => true);

// ---- LAN: same-WiFi link, one instance as server ----------------------------
// ponytail: raw TCP + NDJSON (src/lan.js). Server runs claude locally and streams
// events back over the socket; client forwards chats and maps events to the renderer,
// so the renderer UI is identical on either side. No HTTP, no web GUI.
let lanServer = null, lanClient = null, lanClientConnected = false;
function lanStatus(obj) { win?.webContents.send('lan-status', obj); }

ipcMain.handle('lan-server-toggle', (_e, enabled) => {
  if (enabled) {
    if (lanServer) return { on: true, ips: lan.lanIPs(), port: lan.PORT };
    lanServer = lan.startServer({
      onChat: (msg, sock, st) => {
        const send = (ch, v) => {
          if (ch === 'chat-delta') lan.sendTo(sock, { type: 'delta', text: v });
          else if (ch === 'chat-step') lan.sendTo(sock, { type: 'step', step: v });
          else if (ch === 'chat-error') lan.sendTo(sock, { type: 'error', msg: v });
          else if (ch === 'chat-done') lan.sendTo(sock, { type: 'done', sessionId: v.sessionId, ok: v.ok });
        };
        // server uses its own cwd; the client's project path doesn't map across devices.
        runChat(msg.model, msg.prompt, msg.sessionId, send, msg.systemPrompt, null, st, safeImages(msg.images)).catch(() => {});
      },
      onStatus: (state, info) => lanStatus({ server: state, ...info }),
    });
    return { on: true, ips: lan.lanIPs(), port: lan.PORT };
  }
  if (lanServer) { lanServer.stop(); lanServer = null; }
  lanStatus({ server: 'off' });
  return { on: false };
});

ipcMain.handle('lan-connect', (_e, host) => {
  if (lanClient) { try { lanClient.end(); } catch {} lanClient = null; lanClientConnected = false; }
  const [h, p] = String(host || '').split(':');
  if (!h || !h.trim()) return false;
  lanClient = lan.connectClient(h.trim(), p ? parseInt(p, 10) || lan.PORT : lan.PORT, {
    onMsg: (m) => {
      const send = win.webContents.send.bind(win.webContents);
      if (m.type === 'delta') send('chat-delta', m.text);
      else if (m.type === 'step') send('chat-step', m.step);
      else if (m.type === 'error') send('chat-error', m.msg);
      else if (m.type === 'done') send('chat-done', { sessionId: m.sessionId, ok: m.ok });
    },
    onStatus: (state) => { lanClientConnected = (state === 'connected'); lanStatus({ client: state }); },
  });
  return true;
});
ipcMain.handle('lan-disconnect', () => {
  if (lanClient) { try { lanClient.end(); } catch {} lanClient = null; }
  lanClientConnected = false; lanStatus({ client: 'disconnected' }); return true;
});

// Fetch the real Claude Code slash-command list (the same menu Claude shows on `/`).
// Source: the `system/init` stream-json event fires at session start with a
// `slash_commands` array (built-ins + plugins + skills + custom). We spawn a throwaway
// `claude -p`, read only that event, then kill the child — no model call, ~2-3s, cached.
let cachedCommands = null;
function fetchCommands(model) {
  return new Promise((resolve) => {
    if (cachedCommands) return resolve(cachedCommands);
    const child = spawn(CLAUDE_PATH, ['-p', '.', '--output-format', 'stream-json', '--verbose', '--model', model || 'qwen2.5:1.5b', '--allowedTools', 'Read'], {
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
  // Preserve settings created before the Axion package identity was introduced.
  if (!Object.keys(config.load()).length) {
    const legacyFile = path.join(path.dirname(userDataPath), 'ollama-desktop-harness', 'settings.json');
    try { if (fs.existsSync(legacyFile)) config.save(JSON.parse(fs.readFileSync(legacyFile, 'utf8'))); } catch {}
  }
  CLAUDE_PATH = findClaude();
  createTray();
  createWindow();
  await ensureOllama();
});
app.on('before-quit', () => { if (ollamaProc && !ollamaProc.killed) ollamaProc.kill(); if (lanServer) lanServer.stop(); if (lanClient) { try { lanClient.end(); } catch {} } });
