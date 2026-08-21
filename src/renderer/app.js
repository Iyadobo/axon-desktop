// Minimal chat on the Claude Code harness, routed to the selected Ollama model.
// Style: "Relay" modernist (light/dark, sidebar, surface composer card). Features:
// slash-command autocomplete, system prompt + appearance settings, file attachments,
// folder-workspace projects, markdown rendering, copy, per-turn model labels.
const $ = (id) => document.getElementById(id);
const rid = () => Math.random().toString(36).slice(2);
// Keep all model output as text before the small markdown formatter reintroduces
// its intentionally limited markup. This used to be referenced but never
// defined, so the first streamed reply threw a ReferenceError and appeared as
// an empty assistant bubble.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

let conversations = [];   // [{id, sessionId, title, model, ts, projectId}]
let activeId = null;      // current conversation id (null = home/fresh)
let localConversationBackup = null;
// Many chats may generate at once. Keep their DOM + persistence context by
// request ID instead of one global "active" turn.
const activeTurns = new Map(); // requestId -> { conversationId, turnEl, ... }
let stopping = new Set();
const queuedMessages = new Map(); // conversationId -> pending user messages
const steering = new Set();
function currentTurn() { return activeId ? [...activeTurns.values()].find((turn) => turn.conversationId === activeId) : null; }

// ---- view switching --------------------------------------------------------
let activeView = 'chat';
function switchView(viewName) {
  if (viewName === 'settings') { openSettings(); return; }
  activeView = viewName;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === 'view-' + viewName);
  });
  document.querySelectorAll('.sidebar-view').forEach((view) => {
    view.classList.toggle('active', view.id === viewName + 'Sidebar');
  });
  if (viewName === 'projects') renderProjectsPage();
  if (viewName === 'models') renderModelsPage();
  saveState('oactiveView', viewName);
}

// ---- settings / appearance --------------------------------------------------
const THEME_PALETTES = {
  light: { accent: '#f45f96', background: '#ffffff', surface: '#f4f5f7', text: '#17131a' },
  dark: { accent: '#f45f96', background: '#141216', surface: '#1f1b20', text: '#f6f1f4' },
  midnight: { accent: '#f45f96', background: '#0c0d0f', surface: '#151316', text: '#f7f2f4' },
  paper: { accent: '#d95185', background: '#fbfaf7', surface: '#f3f0e9', text: '#25231f' },
};
const FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  humanist: '"Segoe UI", "Aptos", system-ui, sans-serif',
  mono: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
  serif: 'Georgia, "Times New Roman", serif',
};
const DEFAULT_SETTINGS = { systemPrompt: '', accent: '#f45f96', colors: { ...THEME_PALETTES.midnight }, theme: 'midnight', density: 'normal', motion: 'standard', font: 'system', harness: 'claude', codexModel: '', opencodeModel: '', permissionMode: 'auto' };
let settings = { ...DEFAULT_SETTINGS };
const ACCENTS = ['#2a4bd6', '#007d5a', '#b03060', '#8a3df0', '#c2410c', '#111827'];
const persisted = {};
function loadSettings() {
  try {
    const saved = persisted.osettings || {};
    settings = { ...DEFAULT_SETTINGS, ...saved, colors: { ...THEME_PALETTES[saved.theme] || THEME_PALETTES.midnight, ...(saved.colors || {}) } };
    // The old stock blue was Axon's default, not a deliberate brand choice.
    if (!saved.colors && (!saved.accent || saved.accent.toLowerCase() === '#2a4bd6')) settings.colors.accent = DEFAULT_SETTINGS.accent;
    else if (!saved.colors && saved.accent) settings.colors.accent = saved.accent;
    settings.accent = settings.colors.accent;
  } catch {}
}
function saveState(key, value) { persisted[key] = value; window.ollama.saveState({ [key]: value }).catch(() => {}); }
function saveSettings() { saveState('osettings', settings); }
function applyAppearance() {
  const r = document.documentElement;
  const colors = settings.colors || THEME_PALETTES.midnight;
  r.style.setProperty('--color-accent', colors.accent);
  r.style.setProperty('--color-bg', colors.background);
  r.style.setProperty('--color-surface', colors.surface);
  r.style.setProperty('--color-surface-2', `color-mix(in srgb, ${colors.surface} 72%, ${colors.background})`);
  r.style.setProperty('--color-text', colors.text);
  r.style.setProperty('--color-divider', `color-mix(in srgb, ${colors.text} 14%, ${colors.background})`);
  r.style.setProperty('--color-neutral', `color-mix(in srgb, ${colors.text} 58%, ${colors.background})`);
  r.style.setProperty('--font-body', FONT_STACKS[settings.font] || FONT_STACKS.system);
  r.dataset.theme = settings.theme;
  r.classList.remove('density-compact', 'density-comfortable', 'motion-calm');
  if (settings.density === 'compact') r.classList.add('density-compact');
  else if (settings.density === 'comfortable') r.classList.add('density-comfortable');
  if (settings.motion === 'calm') r.classList.add('motion-calm');
  refreshGridColor();
}
function renderSwatches() {
  const box = $('swatches'); box.innerHTML = '';
  for (const c of ACCENTS) {
    const s = document.createElement('span');
    s.className = 'sw' + (c.toLowerCase() === settings.colors.accent.toLowerCase() ? ' sel' : '');
    s.style.background = c; s.title = c;
    s.onclick = () => { settings.colors.accent = c; settings.accent = c; saveSettings(); applyAppearance(); renderSwatches(); syncPaletteInputs(); };
    box.appendChild(s);
  }
  const ci = document.createElement('input');
  ci.type = 'color'; ci.value = settings.colors.accent;
  ci.title = 'Custom color';
  ci.oninput = () => { settings.colors.accent = ci.value; settings.accent = ci.value; saveSettings(); applyAppearance(); renderSwatches(); syncPaletteInputs(); };
  box.appendChild(ci);
}
function syncPaletteInputs() {
  const colors = settings.colors;
  $('accentColor').value = colors.accent; $('backgroundColor').value = colors.background;
  $('surfaceColor').value = colors.surface; $('textColor').value = colors.text;
}
function openSettings() {
  $('sysPrompt').value = settings.systemPrompt;
  $('themeSel').value = settings.theme;
  $('densitySel').value = settings.density;
  $('motionSel').value = settings.motion;
  $('fontSel').value = settings.font;
  $('harnessSel').value = settings.harness;
  $('codexModel').value = settings.codexModel;
  $('opencodeModel').value = settings.opencodeModel;
  $('runtimeSel').value = ['exo', 'llamacpp'].includes(persisted.oRuntime) ? persisted.oRuntime : 'ollama';
  $('exoUrl').value = persisted.oExoUrl || 'http://127.0.0.1:52415';
  syncRuntimeFields();
  if ($('runtimeSel').value === 'llamacpp') refreshLlamaCppStatus();
  syncHarnessFields();
  syncModes();
  syncPaletteInputs(); renderSwatches(); renderProjects(); renderCloudCatalogueInfo();
  $('settings').classList.add('show');
}
function closeSettings() { $('settings').classList.remove('show'); }
function syncRuntimeFields() {
  const kind = $('runtimeSel').value; const exo = kind === 'exo'; const llamaCpp = kind === 'llamacpp';
  $('exoUrl').parentElement.style.display = exo ? '' : 'none'; $('exoCheck').style.display = exo ? '' : 'none';
  $('exoStatus').textContent = exo
    ? 'Exo is an optional cluster runtime. Axon connects to its coordinator API; it does not install or emulate a cluster.'
    : 'Local Ollama runs on this device.';
  $('llamaCppFields').style.display = llamaCpp ? '' : 'none';
  if (llamaCpp) syncLlamaCppRoleFields();
}
async function selectRuntime() {
  const kind = $('runtimeSel').value; const url = $('exoUrl').value.trim();
  $('exoStatus').textContent = kind === 'exo' ? 'Connecting to Exo…' : kind === 'llamacpp' ? '' : 'Switching to local Ollama…';
  const result = await window.ollama.setRuntime({ kind, url });
  if (result?.error) { $('exoStatus').textContent = 'Exo connection failed: ' + result.error; $('runtimeSel').value = ['exo', 'llamacpp'].includes(persisted.oRuntime) ? persisted.oRuntime : 'ollama'; syncRuntimeFields(); return; }
  saveState('oRuntime', result.kind); saveState('oExoUrl', result.url || '');
  $('exoStatus').textContent = result.kind === 'exo' ? 'Exo connected — ' + (result.url || url) + '.' : result.kind === 'llamacpp' ? '' : 'Using local Ollama.';
  if (result.kind === 'llamacpp') await refreshLlamaCppStatus();
  await loadModels();
}
async function testExo() {
  $('exoStatus').textContent = 'Testing Exo coordinator…';
  const result = await window.ollama.checkExo($('exoUrl').value.trim());
  $('exoStatus').textContent = result?.ok ? `Exo ready — ${result.models} model${result.models === 1 ? '' : 's'} exposed.` : 'Exo check failed: ' + (result?.error || 'unknown error');
}

// ---- llama.cpp RPC runtime (two-PC VRAM pool) ------------------------------
// Axon manages the local half only: install the CUDA binaries, spawn either
// llama-server (Host, using --rpc to reach a remote GPU) or rpc-server (Worker,
// exposing this PC's GPU). The other PC needs the same setup done there by hand
// -- Axon cannot reach across the isolated link to configure it.
let llamaCppInstalling = false;
function syncLlamaCppRoleFields() {
  const host = $('llamaCppRole').value !== 'worker';
  $('llamaCppHostFields').style.display = host ? '' : 'none';
  $('llamaCppHostFields2').style.display = host ? '' : 'none';
  $('llamaCppWorkerFields').style.display = host ? 'none' : '';
}
async function refreshLlamaCppStatus() {
  const status = await window.ollama.llamaCppStatus();
  if (!status) return;
  const cfg = status.config || {};
  $('llamaCppRole').value = cfg.role === 'worker' ? 'worker' : 'host';
  $('llamaCppModelPath').value = cfg.modelPath || '';
  $('llamaCppRpcPeers').value = cfg.rpcPeers || '';
  $('llamaCppContextSize').value = cfg.contextSize || '';
  $('llamaCppRpcPort').value = cfg.rpcPort || 50052;
  const bindSel = $('llamaCppBindIp'); bindSel.innerHTML = '';
  for (const ip of status.ips || []) { const o = document.createElement('option'); o.value = ip; o.textContent = ip; bindSel.appendChild(o); }
  if (cfg.bindIp && [...bindSel.options].some((o) => o.value === cfg.bindIp)) bindSel.value = cfg.bindIp;
  syncLlamaCppRoleFields();
  $('llamaCppInstallStatus').textContent = status.installed ? `llama.cpp CUDA runtime installed at ${status.dir}.` : 'llama.cpp CUDA runtime is not installed yet (download is ~640 MB from the official GitHub release).';
  $('llamaCppInstallBtn').disabled = llamaCppInstalling;
  const running = status.hostRunning || status.workerRunning;
  $('llamaCppStartBtn').disabled = running || !status.installed;
  $('llamaCppStopBtn').disabled = !running;
  $('llamaCppStatus').textContent = status.hostRunning ? 'Host running — llama-server is loading/serving the model.' : status.workerRunning ? 'Worker running — this GPU is exposed to the isolated link.' : 'Stopped.';
}
async function saveLlamaCppConfigFromFields() {
  await window.ollama.llamaCppSetConfig({
    role: $('llamaCppRole').value,
    modelPath: $('llamaCppModelPath').value.trim(),
    rpcPeers: $('llamaCppRpcPeers').value.trim(),
    contextSize: Number($('llamaCppContextSize').value) || 0,
    bindIp: $('llamaCppBindIp').value,
    rpcPort: Number($('llamaCppRpcPort').value) || 50052,
  });
}
async function installLlamaCppRuntime() {
  if (llamaCppInstalling) return;
  llamaCppInstalling = true; $('llamaCppInstallBtn').disabled = true;
  $('llamaCppInstallStatus').textContent = 'Downloading llama.cpp CUDA runtime (~640 MB)…';
  try {
    const result = await window.ollama.llamaCppInstall();
    $('llamaCppInstallStatus').textContent = result?.error ? 'Install failed: ' + result.error : 'llama.cpp CUDA runtime installed at ' + result.status.dir + '.';
  } finally { llamaCppInstalling = false; await refreshLlamaCppStatus(); }
}
async function pickLlamaCppModel() {
  const picked = await window.ollama.llamaCppPickModel();
  if (!picked) return;
  $('llamaCppModelPath').value = picked;
  await saveLlamaCppConfigFromFields();
}
async function testLlamaCppPeer() {
  await saveLlamaCppConfigFromFields();
  const peer = $('llamaCppRpcPeers').value.trim().split(',')[0]?.trim();
  if (!peer) { $('llamaCppStatus').textContent = 'Enter the remote PC\'s rpc-server address first, e.g. 192.168.50.2:50052.'; return; }
  $('llamaCppStatus').textContent = 'Testing ' + peer + '…';
  const result = await window.ollama.llamaCppCheckPeer(peer);
  $('llamaCppStatus').textContent = result?.ok ? peer + ' is reachable.' : peer + ' is not reachable: ' + (result?.error || 'unknown error') + '. Confirm the other PC is running Axon as a Worker on its isolated-Ethernet IP.';
}
async function startLlamaCppRuntime() {
  await saveLlamaCppConfigFromFields();
  $('llamaCppStatus').textContent = 'Starting…';
  const result = await window.ollama.llamaCppStart();
  $('llamaCppStatus').textContent = result?.error ? 'Could not start: ' + result.error : 'Starting…';
  await refreshLlamaCppStatus();
  if (!result?.error) await loadModels();
}
async function stopLlamaCppRuntime() { await window.ollama.llamaCppStop(); await refreshLlamaCppStatus(); }

// ---- projects (folder workspaces) -----------------------------------------
let projects = [];        // [{id, name, path, instructions}]
let activeProjectId = null;
let defaultWorkspace = null;
function loadProjects() { try { projects = Array.isArray(persisted.oprojects) ? persisted.oprojects : []; } catch {} }
function saveProjects() { saveState('oprojects', projects); }
function activeProject() { return projects.find((p) => p.id === activeProjectId) || null; }
function selectProject(id) {
  activeProjectId = id;
  saveState('oactiveProject', activeProjectId);
  renderProjects(); renderRecents(); updateProjectLabel();
}
function projectCwd() { return activeProject()?.path || defaultWorkspace || null; }
function projectSystemPrompt() {
  const p = activeProject();
  const base = settings.systemPrompt || '';
  if (!p || !p.instructions) return base;
  return (base ? base + '\n\n' : '') + '[Project: ' + p.name + ']\nWorking directory: ' + p.path + '\n\n' + p.instructions;
}
async function createProject() {
  let name = $('projName').value.trim();
  const path = await window.ollama.pickFolder();
  if (!path) return;
  if (!name) name = path.split(/[\\/]/).pop();
  const p = { id: rid(), name, path, instructions: '' };
  projects.push(p); activeProjectId = p.id; saveProjects(); saveState('oactiveProject', activeProjectId);
  $('projName').value = ''; $('projPathHint').textContent = '';
  renderProjects(); renderRecents(); updateProjectLabel();
}
function renderProjects() {
  const box = $('projList'); box.innerHTML = '';
  if (!projects.length) {
    const e = document.createElement('div'); e.style.cssText = 'font-size:12px;opacity:.5;padding:4px 0';
    e.textContent = 'No projects yet — name one above and pick a folder.'; box.appendChild(e);
  }
  for (const p of projects) {
    const d = document.createElement('div'); d.className = 'proj-item' + (p.id === activeProjectId ? ' active' : '');
    d.innerHTML = '<span class="pname">' + esc(p.name) + '</span><span class="ppath" title="' + esc(p.path) + '">' + esc(p.path) + '</span>';
    d.onclick = () => selectProject(p.id);
    const del = document.createElement('button'); del.className = 'pdel'; del.textContent = '✕'; del.title = 'Delete project (keeps chats)';
    del.onclick = (e) => { e.stopPropagation(); projects = projects.filter((x) => x.id !== p.id); if (activeProjectId === p.id) { activeProjectId = null; saveState('oactiveProject', null); } saveProjects(); renderProjects(); renderRecents(); updateProjectLabel(); };
    d.appendChild(del); box.appendChild(d);
  }
  renderSidebarProjects();
  const p = activeProject();
  const wrap = $('projInstrWrap');
  if (p) { wrap.style.display = ''; $('projInstrLabel').textContent = 'Instructions — ' + p.name; $('projInstr').value = p.instructions || ''; }
  else wrap.style.display = 'none';
}
function renderSidebarProjects() {
  const box = $('sidebarProjects'); if (!box) return;
  box.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'sidebar-project' + (!activeProjectId ? ' active' : '');
  all.type = 'button'; all.textContent = 'All chats';
  all.onclick = () => selectProject(null);
  box.appendChild(all);
  for (const project of projects) {
    const item = document.createElement('button');
    item.className = 'sidebar-project' + (project.id === activeProjectId ? ' active' : '');
    item.type = 'button'; item.title = project.path;
    const name = document.createElement('span'); name.textContent = project.name;
    const count = document.createElement('span'); count.className = 'project-count';
    count.textContent = String(conversations.filter((chat) => chat.projectId === project.id).length);
    const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'project-manage';
    manage.textContent = '•••'; manage.title = 'Manage project'; manage.setAttribute('aria-label', 'Manage ' + project.name);
    manage.onclick = (event) => { event.stopPropagation(); selectProject(project.id); openSettings(); setTimeout(() => $('projInstr').focus(), 0); };
    item.append(name, count, manage); item.onclick = () => selectProject(project.id); box.appendChild(item);
  }
}
// ---- projects page ---------------------------------------------------------
function renderProjectsPage() {
  const box = $('projectsPageContent'); if (!box) return;
  box.innerHTML = '';
  if (!projects.length) {
    box.innerHTML = '<div style="opacity:.5;font-size:var(--t-sm)">No projects yet. Create one to organize chats by folder.</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px';
  for (const p of projects) {
    const card = document.createElement('div');
    card.style.cssText = 'padding:16px;border:1px solid var(--elev-line);border-radius:12px;background:var(--elev-1);cursor:pointer;transition:background .16s ease,border-color .16s ease';
    card.onmouseenter = () => { card.style.background = 'var(--elev-2)'; card.style.borderColor = 'color-mix(in srgb, var(--color-accent) 40%, var(--elev-line))'; };
    card.onmouseleave = () => { card.style.background = 'var(--elev-1)'; card.style.borderColor = 'var(--elev-line)'; };
    const count = conversations.filter((c) => c.projectId === p.id).length;
    card.innerHTML = '<div style="font-weight:700;font-size:var(--t-body);margin-bottom:6px">' + esc(p.name) + '</div>'
      + '<div style="font-size:var(--t-xs);color:var(--color-neutral);margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(p.path) + '">' + esc(p.path) + '</div>'
      + (p.instructions ? '<div style="font-size:var(--t-xs);color:var(--color-neutral);opacity:.7;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + esc(p.instructions.slice(0, 120)) + '</div>' : '')
      + '<div style="display:flex;align-items:center;justify-content:space-between">'
      + '<span style="font-size:var(--t-xs);color:var(--color-neutral)">' + count + ' chat' + (count === 1 ? '' : 's') + '</span>'
      + '<button class="pdel" style="opacity:0;font-size:12px;padding:4px 8px;border:1px solid var(--elev-line);border-radius:6px;background:var(--color-bg);color:var(--color-bad);cursor:pointer">Delete</button>'
      + '</div>';
    card.querySelector('.pdel').onmouseenter = () => { card.querySelector('.pdel').style.opacity = '1'; };
    card.querySelector('.pdel').onmouseleave = (e) => { if (!e.relatedTarget?.classList?.contains('pdel')) card.querySelector('.pdel').style.opacity = '0'; };
    card.querySelector('.pdel').onclick = (e) => {
      e.stopPropagation();
      projects = projects.filter((x) => x.id !== p.id);
      if (activeProjectId === p.id) { activeProjectId = null; saveState('oactiveProject', null); }
      saveProjects(); renderProjects(); renderRecents(); updateProjectLabel(); renderProjectsPage();
    };
    card.onclick = () => { selectProject(p.id); switchView('chat'); };
    grid.appendChild(card);
  }
  box.appendChild(grid);
}

// ---- models page -----------------------------------------------------------
const RECOMMENDED_MODELS = [
  { name: 'qwen3-coder', tag: 'Best for coding', category: 'coding' },
  { name: 'qwen3:4b', tag: 'Good all-rounder', category: 'general' },
  { name: 'llama3.1:8b', tag: 'Solid general purpose', category: 'general' },
  { name: 'deepseek-coder-v2:16b', tag: 'Advanced coding', category: 'coding' },
  { name: 'mistral:7b', tag: 'Fast & capable', category: 'general' },
  { name: 'gemma2:9b', tag: 'Google quality', category: 'general' },
];
async function renderModelsPage() {
  const box = $('modelsPageContent'); if (!box) return;
  box.innerHTML = '<div style="opacity:.5;font-size:var(--t-sm)">Loading models…</div>';
  let models = modelCatalogue;
  if (!models.length) {
    try { await loadModels(); } catch {}
    models = modelCatalogue;
  }
  box.innerHTML = '';
  // Installed models
  const installed = document.createElement('div');
  installed.innerHTML = '<h3 style="font-size:var(--t-body);font-weight:700;margin:0 0 12px">Installed Models</h3>';
  if (!models.length) {
    installed.innerHTML += '<div style="opacity:.5;font-size:var(--t-sm)">No models installed. Pull one with <code>ollama pull &lt;name&gt;</code> or check the recommended list below.</div>';
  } else {
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    for (const m of models) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--elev-line);border-radius:10px;background:var(--elev-1)';
      const family = familyOf(m.name);
      const isVision = modelSupportsVision(m.name);
      const size = m.size ? prettyBytes(m.size) : '';
      const params = m.details?.parameter_size || '';
      row.innerHTML = '<div style="font-weight:600;font-size:var(--t-sm)">' + esc(m.name) + '</div>'
        + (params ? '<div style="font-size:var(--t-xs);color:var(--color-neutral)">' + esc(params) + '</div>' : '')
        + (size ? '<div style="font-size:var(--t-xs);color:var(--color-neutral)">' + size + '</div>' : '')
        + (isVision ? '<span style="font-size:10px;padding:2px 6px;border-radius:999px;border:1px solid color-mix(in srgb, #22c1c3 40%, var(--elev-line));color:#22c1c3;font-weight:600">VISION</span>' : '')
        + '<span style="font-size:10px;padding:2px 6px;border-radius:999px;border:1px solid var(--elev-line);color:var(--color-neutral);font-weight:600">' + esc(family.name) + '</span>';
      list.appendChild(row);
    }
    installed.appendChild(list);
  }
  box.appendChild(installed);
  // Recommended models
  const rec = document.createElement('div');
  rec.style.cssText = 'margin-top:28px';
  rec.innerHTML = '<h3 style="font-size:var(--t-body);font-weight:700;margin:0 0 4px">Recommended for Axon</h3>'
    + '<div style="font-size:var(--t-xs);color:var(--color-neutral);margin-bottom:12px">Curated picks that work well with the Claude Code harness. Small models (&lt;3B) struggle with tool use.</div>';
  const recList = document.createElement('div');
  recList.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px';
  for (const m of RECOMMENDED_MODELS) {
    const isInstalled = models.some((x) => x.name === m.name || x.name.startsWith(m.name + ':'));
    const card = document.createElement('div');
    card.style.cssText = 'padding:12px;border:1px solid var(--elev-line);border-radius:10px;background:var(--elev-1);display:flex;flex-direction:column;gap:4px';
    card.innerHTML = '<div style="font-weight:600;font-size:var(--t-sm)">' + esc(m.name) + '</div>'
      + '<div style="font-size:var(--t-xs);color:var(--color-neutral)">' + esc(m.tag) + '</div>'
      + '<div style="font-size:var(--t-xs);color:' + (isInstalled ? '#3fbf7f' : 'var(--color-neutral)') + '">' + (isInstalled ? '✓ Installed' : 'Not installed') + '</div>';
    recList.appendChild(card);
  }
  rec.appendChild(recList);
  box.appendChild(rec);
  // Vision models section
  const vis = document.createElement('div');
  vis.style.cssText = 'margin-top:28px';
  vis.innerHTML = '<h3 style="font-size:var(--t-body);font-weight:700;margin:0 0 4px">Vision Capable</h3>'
    + '<div style="font-size:var(--t-xs);color:var(--color-neutral);margin-bottom:12px">Models that can process images. Attach screenshots or photos in chat to use them.</div>';
  const visionModels = models.filter((m) => modelSupportsVision(m.name));
  if (visionModels.length) {
    const vList = document.createElement('div');
    vList.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    for (const m of visionModels) {
      const tag = document.createElement('span');
      tag.style.cssText = 'padding:6px 12px;border:1px solid color-mix(in srgb, #22c1c3 40%, var(--elev-line));border-radius:999px;font-size:var(--t-xs);color:#22c1c3';
      tag.textContent = m.name;
      vList.appendChild(tag);
    }
    vis.appendChild(vList);
  } else {
    vis.innerHTML += '<div style="opacity:.5;font-size:var(--t-sm)">No vision models detected. Pull one with <code>ollama pull llava</code> or similar.</div>';
  }
  box.appendChild(vis);
}
function modelSupportsVision(model) {
  return /llava|vision|bakllava|moondream/i.test(model);
}

function updateProjectLabel() {
  const label = $('recents-label'); const selected = activeProject();
  label.textContent = selected ? ('Recents · ' + selected.name) : 'All chats';
  label.title = selected ? (selected.name + ' — ' + selected.path) : 'All project and unassigned chats';
  return;
  const p = activeProject();
  const el = $('recents-label');
  el.textContent = p ? ('▾ ' + p.name) : 'Recents';
  el.title = p ? (p.name + ' — ' + p.path) : '';
}

// ---- attachments ------------------------------------------------------------
let attachments = [];     // text files are inlined; supported images become vision blocks
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(file);
  });
}
function instructionFingerprint(harness, prompt) {
  let hash = 2166136261; const value = String(harness || '') + '\n' + String(prompt || '');
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
async function readFile(file) {
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) return { name: file.name, binary: true, size: file.size, tooLarge: true };
    return { name: file.name, image: true, type: file.type, data: await fileToBase64(file), size: file.size };
  }
  const isText = !file.type || file.type.startsWith('text/') || /json|xml|javascript|csv|markdown/i.test(file.type)
    || /\.(md|txt|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|css|html|json|yaml|yml|toml|ini|sh|ps1|sql|xml|csv)$/i.test(file.name);
  if (!isText || file.size > 1.5 * 1024 * 1024)
    return { name: file.name, content: '', binary: true, size: file.size };
  const content = await file.text();
  return { name: file.name, content: content.slice(0, 512 * 1024), binary: false, size: file.size, truncated: content.length > 512 * 1024 };
}
async function addFiles(fileList) {
  for (const f of [...fileList]) attachments.push(await readFile(f));
  renderAttach();
}
function renderAttach() {
  const row = $('attachRow'); row.innerHTML = '';
  for (const a of attachments) {
    const c = document.createElement('span'); c.className = 'atch';
    if (a.image) { const preview = document.createElement('img'); preview.className = 'thumb'; preview.alt = ''; preview.src = 'data:' + a.type + ';base64,' + a.data; c.appendChild(preview); }
    const name = document.createElement('span'); name.className = 'nm'; name.textContent = a.name; c.appendChild(name);
    if (a.image || a.binary) { const kind = document.createElement('span'); kind.className = 'bin'; kind.textContent = a.image ? 'image' : (a.tooLarge ? 'too large' : 'binary'); c.appendChild(kind); }
    const remove = document.createElement('button'); remove.className = 'x'; remove.title = 'Remove'; remove.textContent = '×'; c.appendChild(remove);
    c.querySelector('.x').onclick = () => { attachments = attachments.filter((x) => x !== a); renderAttach(); };
    row.appendChild(c);
  }
}
function inlineAttachments(text) {
  if (!attachments.length) return text;
  let out = text;
  for (const a of attachments) {
    if (a.image) out += '\n\n[Attached image: ' + a.name + ' — inspect the image and answer the request.]';
    else if (a.binary) out += '\n\n[Attached file: ' + a.name + (a.tooLarge ? ' — over the 6 MB image limit' : ' — binary, not inlined') + ']';
    else out += '\n\n--- file: ' + a.name + ' ---\n' + a.content + (a.truncated ? '\n…(truncated)' : '') + '\n--- end ' + a.name + ' ---';
  }
  return out;
}
function clearAttachments() { attachments = []; renderAttach(); }

// ---- status ----------------------------------------------------------------
function setStatus(ok, text) {
  $('dot').className = 'dot' + (ok ? ' on' : text ? ' bad' : '');
  $('statustext').textContent = text;
}
function setLoading(text, done = false) {
  const splash = $('loading'); if (!splash) return;
  $('loadingText').textContent = text;
  if (done) { splash.classList.add('done'); setTimeout(() => splash.remove(), 220); }
}

// ---- models ----------------------------------------------------------------
function cachedCloudCatalogue() {
  const cache = persisted.ocloudModels;
  return cache && Array.isArray(cache.models) ? cache : { models: [], fetchedAt: null };
}
function renderCloudCatalogueInfo() {
  const cache = cachedCloudCatalogue(); const info = $('cloudModelsInfo');
  if (!info) return;
  info.textContent = cache.models.length
    ? `${cache.models.length} Ollama models cached${cache.fetchedAt ? ' · refreshed ' + new Date(cache.fetchedAt).toLocaleString() : ''}`
    : 'No download list cached yet.';
}
async function refreshCloudCatalogue() {
  const button = $('cloudModelsRefresh'); button.disabled = true;
  $('cloudModelsInfo').textContent = 'Refreshing the official Ollama download list…';
  try {
    const cache = await window.ollama.refreshCloudModels();
    if (!Array.isArray(cache?.models) || !cache.models.length) throw new Error('No cloud models were returned.');
    saveState('ocloudModels', { models: cache.models, fetchedAt: cache.fetchedAt || new Date().toISOString() });
    await loadModels(); renderCloudCatalogueInfo();
    if ($('modelDownload').classList.contains('show')) await refreshModelDownloads();
  } catch (error) {
    $('cloudModelsInfo').textContent = 'Could not refresh: ' + (error?.message || 'network error') + '. Existing cache was kept.';
  } finally { button.disabled = false; }
}
function mergeModels(local, cloud) {
  const seen = new Set(); const merged = [];
  for (const model of local) {
    if (!model?.name || seen.has(model.name)) continue;
    seen.add(model.name); merged.push({ ...model, source: 'local' });
  }
  for (const model of cloud) {
    if (!model?.name || seen.has(model.name)) continue;
    seen.add(model.name); merged.push({ ...model, source: 'cloud' });
  }
  return merged;
}
async function loadModels() {
  setLoading('Checking local models…');
  try {
    const data = await window.ollama.listModels();
    const sel = $('model'); sel.innerHTML = '';
    const localModels = data.models || [];
    // Axon exposes only locally installed models as runnable choices. The
    // download catalogue is separate and filters these names out before pull.
    const models = localModels.map((model) => ({ ...model, source: 'local' }));
    if (!models.length) {
      modelCatalogue = []; syncModelButton();
      const sidebarList = $('modelsSidebarList'); if (sidebarList) sidebarList.textContent = 'No local models installed';
      return setStatus(false, 'no models');
    }
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = m.name + (m.source === 'cloud' ? ' · Cloud' : (m.details?.parameter_size ? ' · ' + m.details.parameter_size : ''));
      sel.appendChild(o);
    }
    modelCatalogue = models;
    const pref = persisted.omodel;
    if (pref && models.some((m) => m.name === pref)) sel.value = pref;
    syncModelButton();
    if ($('modelPicker').classList.contains('show')) renderPicker();
    setStatus(true, localModels.length ? 'ready' : 'no models');
    // Update models sidebar quick list
    const sidebarList = $('modelsSidebarList');
    if (sidebarList) {
      sidebarList.innerHTML = '';
      if (models.length) {
        for (const m of models.slice(0, 10)) {
          const item = document.createElement('div');
          item.style.cssText = 'padding:6px 8px;font-size:var(--t-xs);cursor:pointer;border-radius:6px;transition:background .12s';
          item.textContent = m.name;
          item.onmouseenter = () => { item.style.background = 'var(--elev-2)'; };
          item.onmouseleave = () => { item.style.background = 'transparent'; };
          item.onclick = () => { $('model').value = m.name; saveState('omodel', m.name); syncModelButton(); };
          sidebarList.appendChild(item);
        }
        if (models.length > 10) {
          const more = document.createElement('div');
          more.style.cssText = 'padding:6px 8px;font-size:var(--t-xs);opacity:.5';
          more.textContent = '+' + (models.length - 10) + ' more';
          sidebarList.appendChild(more);
        }
      } else {
        sidebarList.textContent = 'No models installed';
      }
    }
  } catch { setStatus(false, 'offline'); }
}
// ---- local model downloads --------------------------------------------------
let downloadCatalogue = [], downloadedModelNames = new Set(), downloadingModel = null, modelHardware = null, modelDownloadPage = 1;
const MODEL_DOWNLOAD_PAGE_SIZE = 24;
const canonicalModelName = (name) => String(name || '').trim().toLowerCase().replace(/:latest$/, '');
const gib = (bytes) => Number(bytes) > 0 ? (Number(bytes) / 1024 / 1024 / 1024).toFixed(Number(bytes) >= 10 * 1024 ** 3 ? 0 : 1) + ' GB' : 'unknown';
function bestGpu() { return [...(modelHardware?.gpus || [])].sort((a, b) => Number(b.vramBytes) - Number(a.vramBytes))[0] || null; }
function modelFit(model) {
  const diskBytes = Number(model?.size) || 0;
  const workingBytes = diskBytes * 1.2; // conservative model/runtime overhead; context length can still change the result.
  const gpu = bestGpu(); const ramBytes = Number(modelHardware?.ramBytes) || 0;
  if (gpu?.vramBytes >= workingBytes) return { level: 'good', label: 'GPU fit', detail: 'Estimated to fit in ' + gib(gpu.vramBytes) + ' VRAM' };
  if (ramBytes >= workingBytes * 1.35 && gpu?.vramBytes) return { level: 'warn', label: 'Hybrid fit', detail: 'Will likely spill beyond ' + gib(gpu.vramBytes) + ' VRAM' };
  if (ramBytes >= workingBytes * 1.35) return { level: 'warn', label: 'CPU fit', detail: 'Likely runs in system RAM; expect slower responses' };
  return { level: 'bad', label: 'Tight fit', detail: 'May exceed available memory once context is included' };
}
function renderModelHardware() {
  const box = $('modelHardware');
  if (!modelHardware) { box.textContent = 'Hardware scan unavailable — model fit estimates are hidden.'; return; }
  const gpu = bestGpu();
  box.innerHTML = '';
  const ram = document.createElement('span'); ram.innerHTML = '<strong>Memory</strong> ' + gib(modelHardware.ramBytes);
  const graphics = document.createElement('span'); graphics.innerHTML = '<strong>GPU</strong> ' + (gpu ? gpu.name + ' · ' + gib(gpu.vramBytes) + ' VRAM' : 'not detected');
  const note = document.createElement('span'); note.textContent = 'Fit labels reserve room for runtime overhead; they are not speed benchmarks.';
  box.append(ram, graphics, note);
}
function parameterCount(model) {
  const raw = String(model?.details?.parameter_size || '').trim().toUpperCase();
  const match = raw.match(/(\d+(?:\.\d+)?)\s*([KMBT])/); if (!match) return 0;
  return Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]] || 0);
}
function localDownloadCandidates() {
  const query = $('modelDownloadSearch').value.trim().toLowerCase();
  const filter = document.querySelector('#modelDownloadFilters .download-filter.on')?.dataset.filter || 'all';
  const sort = $('modelDownloadSort').value;
  const rows = downloadCatalogue.filter((model) => {
    const name = String(model?.name || '');
    if (!name || name.includes(':cloud') || Number(model.size) <= 0 || downloadedModelNames.has(canonicalModelName(name)) || (query && !name.toLowerCase().includes(query))) return false;
    if (filter === 'hardware') return ['good', 'warn'].includes(modelFit(model).level);
    if (filter === 'small') return Number(model.size) <= 8 * 1024 ** 3;
    return true;
  });
  return rows.sort((a, b) => {
    if (sort === 'params') return parameterCount(b) - parameterCount(a) || Number(a.size) - Number(b.size);
    if (sort === 'largest') return Number(b.size) - Number(a.size);
    if (sort === 'name') return String(a.name).localeCompare(String(b.name));
    return Number(a.size) - Number(b.size) || String(a.name).localeCompare(String(b.name));
  });
}
function renderModelDownloads() {
  const list = $('modelDownloadList'); const rows = localDownloadCandidates();
  const visible = rows.slice(0, modelDownloadPage * MODEL_DOWNLOAD_PAGE_SIZE);
  list.innerHTML = ''; $('modelDownloadCount').textContent = rows.length + (rows.length === 1 ? ' local model found' : ' local models found') + ' · showing ' + visible.length;
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'download-empty';
    empty.textContent = downloadCatalogue.length ? 'Everything in this view is already installed.' : 'No local Ollama models found.';
    list.appendChild(empty); return;
  }
  for (const model of visible) {
    const row = document.createElement('div'); row.className = 'download-row';
    const meta = document.createElement('div');
    const name = document.createElement('span'); name.className = 'download-name'; name.textContent = model.name;
    const details = document.createElement('span'); details.className = 'download-meta';
    details.textContent = [model.details?.parameter_size, formatBytes(Number(model.size))].filter(Boolean).join(' · ');
    const fit = modelFit(model); const fitLabel = document.createElement('span'); fitLabel.className = 'fit ' + fit.level; fitLabel.textContent = fit.label;
    const fitDetail = document.createElement('span'); fitDetail.className = 'download-meta'; fitDetail.textContent = fit.detail;
    meta.append(name, details, fitLabel, fitDetail);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = downloadingModel === model.name ? 'Installing…' : 'Install';
    button.disabled = !!downloadingModel; button.onclick = () => downloadModel(model.name);
    row.append(meta, button); list.appendChild(row);
  }
  if (visible.length < rows.length) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'download-more'; more.textContent = 'Show ' + Math.min(MODEL_DOWNLOAD_PAGE_SIZE, rows.length - visible.length) + ' more';
    more.onclick = () => { modelDownloadPage++; renderModelDownloads(); }; list.appendChild(more);
  }
}
async function refreshModelDownloads() {
  $('modelDownloadProgress').textContent = 'Scanning installed models and Ollama…';
  try {
    const [installed, catalogue, hardware] = await Promise.all([window.ollama.listModels(), window.ollama.downloadCatalogue(), window.ollama.hardwareProfile()]);
    downloadedModelNames = new Set((installed?.models || []).map((model) => canonicalModelName(model?.name)));
    downloadCatalogue = Array.isArray(catalogue?.models) ? catalogue.models : [];
    modelHardware = hardware || null; renderModelHardware();
    modelDownloadPage = 1; $('modelDownloadProgress').textContent = 'Local downloads only · installed models hidden · page by page';
    renderModelDownloads();
  } catch (error) {
    downloadCatalogue = []; $('modelDownloadProgress').textContent = 'Could not load the Ollama catalogue: ' + (error?.message || 'network error'); renderModelDownloads();
  }
}
async function downloadModel(name) {
  if (downloadingModel) return;
  downloadingModel = name; $('modelDownloadProgress').textContent = 'Starting ' + name + '…'; renderModelDownloads();
  try {
    const result = await window.ollama.pullModel(name);
    if (result?.error) throw new Error(result.error);
    downloadedModelNames.add(canonicalModelName(name));
    $('modelDownloadProgress').textContent = name + ' is ready locally.';
    await loadModels(); renderModelDownloads();
  } catch (error) {
    $('modelDownloadProgress').textContent = 'Download failed: ' + (error?.message || 'Unknown error');
  } finally { downloadingModel = null; renderModelDownloads(); }
}
function openModelDownloads() {
  $('modelDownload').classList.add('show'); $('modelDownloadSearch').value = ''; modelDownloadPage = 1; $('modelDownloadSearch').focus(); refreshModelDownloads();
}
function closeModelDownloads() { if (!downloadingModel) $('modelDownload').classList.remove('show'); }
window.ollama.on('model-pull-progress', (update) => {
  if (!update || update.model !== downloadingModel) return;
  const percent = update.total > 0 ? ' · ' + Math.min(100, Math.round(update.completed / update.total * 100)) + '%' : '';
  $('modelDownloadProgress').textContent = String(update.status || 'Downloading…') + percent;
});
// ---- model picker -----------------------------------------------------------
// The <select id="model"> stays the source of truth (slash commands, saved
// conversations and the send path all read it); this is a richer way to set it.
let modelCatalogue = [];
let pickerCursor = 0;
// Family marks. Where a vendor's mark is available under a free licence it is
// used (see model-logos.js); where it is not — Microsoft's Phi, IBM's Granite,
// OpenAI — the family keeps an Axon glyph rather than an imitation of theirs.
const MODEL_FAMILIES = [
  { test: /^llama|^codellama/i, name: 'Llama', brand: 'meta' },
  { test: /^qwen/i, name: 'Qwen', brand: 'qwen' },
  { test: /^deepseek/i, name: 'DeepSeek', brand: 'deepseek' },
  { test: /^mistral|^mixtral|^codestral|^devstral/i, name: 'Mistral', brand: 'mistral' },
  { test: /^gemma|^gemini/i, name: 'Gemma', brand: 'gemini' },
  { test: /^claude/i, name: 'Claude', brand: 'anthropic' },
  { test: /^phi/i, name: 'Phi', color: '#e26bd8', shape: '<circle cx="12" cy="12" r="7"/><path d="M12 3v18"/>' },
  { test: /^granite/i, name: 'Granite', color: '#8a94a6', shape: '<path d="M5 8h14v11H5Z"/><path d="M5 8l7-4 7 4"/>' },
  { test: /^gpt|^o[13]-|^oss/i, name: 'GPT', color: '#69b39b', shape: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/>' },
  { test: /^llava|^bakllava|vision/i, name: 'Vision', color: '#22c1c3', shape: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.4"/>' },
  { test: /^nomic|embed/i, name: 'Embedding', color: '#9aa0aa', shape: '<circle cx="6" cy="12" r="2.4"/><circle cx="12" cy="6" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M6 12 12 6l6 6"/>' },
];
// Anything unrecognised is still an Ollama-served model, so it gets Ollama's mark.
const DEFAULT_FAMILY = { name: 'Model', brand: 'ollama' };
const familyOf = (name) => MODEL_FAMILIES.find((f) => f.test.test(String(name || ''))) || DEFAULT_FAMILY;
// Several brand colours are near-black (Ollama, Anthropic) and would disappear
// on a dark surface, so very dark marks are blended toward the theme's text
// colour. Light themes keep the brand colour as-is.
function brandColor(hex) {
  const v = String(hex || '').replace('#', '');
  if (v.length !== 6) return 'var(--color-text)';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.22 ? `color-mix(in srgb, ${hex} 35%, var(--color-text))` : hex;
}
// Brand marks are single filled paths; Axon's own glyphs are stroked.
function familyMarkup(family) {
  const brand = family.brand && typeof BRAND_LOGOS !== 'undefined' ? BRAND_LOGOS[family.brand] : null;
  if (brand) {
    return {
      color: brandColor(brand.hex),
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="' + esc(brand.title) + '"><path d="' + brand.path + '"/></svg>',
    };
  }
  return {
    color: family.color || '#9aa0aa',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true">' + (family.shape || '') + '</svg>',
  };
}
// "8x7B" and "1.5B" both need to become a comparable number.
function paramCount(model) {
  const raw = String(model?.details?.parameter_size || '').trim();
  const m = raw.match(/^([\d.]+)\s*x\s*([\d.]+)\s*([BbMm])/) || raw.match(/^([\d.]+)\s*([BbMm])/);
  if (!m) return 0;
  const unit = (m[3] || m[2] || '').toLowerCase() === 'm' ? 1e6 : 1e9;
  return m[3] ? parseFloat(m[1]) * parseFloat(m[2]) * unit : parseFloat(m[1]) * unit;
}
const prettyParams = (n) => (!n ? '' : n >= 1e9 ? +(n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B' : Math.round(n / 1e6) + 'M');
const prettyBytes = (n) => (!n ? '' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');
function syncModelButton() {
  const name = $('model').value || '';
  const entry = modelCatalogue.find((m) => m.name === name);
  $('modelBtnName').textContent = name || 'Select a model';
  $('modelBtn').title = name ? name + (entry?.source === 'cloud' ? ' · cloud' : ' · local') : 'Choose a model';
  $('modelBtn').querySelector('.model-dot').className = 'model-dot ' + (entry?.source || '');
  const mark = $('modelBtnMark');
  if (name) { const m = familyMarkup(familyOf(name)); mark.style.color = m.color; mark.innerHTML = m.svg; }
  else mark.innerHTML = '';
}
function pickerRows() {
  const query = $('modelSearch').value.trim().toLowerCase();
  const filter = document.querySelector('#modelFilters .pfilter.on')?.dataset.filter || 'all';
  const sort = $('modelSort').value;
  let rows = modelCatalogue.filter((m) => (filter === 'all' || m.source === filter)
    && (!query || m.name.toLowerCase().includes(query) || familyOf(m.name).name.toLowerCase().includes(query)));
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (sort === 'params') rows.sort((a, b) => paramCount(b) - paramCount(a) || byName(a, b));
  else if (sort === 'disk') rows.sort((a, b) => (b.size || 0) - (a.size || 0) || byName(a, b));
  else if (sort === 'name') rows.sort(byName);
  else rows.sort((a, b) => (a.source === b.source ? byName(a, b) : a.source === 'local' ? -1 : 1));
  return rows;
}
function renderPicker() {
  const list = $('modelList'); list.innerHTML = '';
  const rows = pickerRows();
  const current = $('model').value;
  $('modelCount').textContent = rows.length + (rows.length === 1 ? ' model' : ' models');
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'picker-empty';
    empty.textContent = 'No models match. Pull one with `ollama pull <name>`, or cache the cloud catalogue in Settings.';
    list.appendChild(empty); return;
  }
  if (pickerCursor >= rows.length) pickerCursor = rows.length - 1;
  if (pickerCursor < 0) pickerCursor = 0;
  let lastGroup = null;
  const grouped = $('modelSort').value === 'source';
  rows.forEach((m, index) => {
    if (grouped && m.source !== lastGroup) {
      lastGroup = m.source;
      const head = document.createElement('div'); head.className = 'picker-group';
      head.textContent = m.source === 'local' ? 'On this machine' : 'Cloud';
      list.appendChild(head);
    }
    const family = familyOf(m.name);
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'mrow' + (m.name === current ? ' on' : '') + (index === pickerCursor ? ' cursor' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', m.name === current ? 'true' : 'false');
    const mark = familyMarkup(family);
    const logo = document.createElement('span'); logo.className = 'mlogo'; logo.style.color = mark.color;
    logo.innerHTML = mark.svg;
    const main = document.createElement('span'); main.className = 'mmain';
    const nameEl = document.createElement('span'); nameEl.className = 'mname'; nameEl.textContent = m.name;
    const meta = document.createElement('span'); meta.className = 'mmeta';
    meta.textContent = [family.name, prettyParams(paramCount(m)), prettyBytes(m.size), m.details?.quantization_level].filter(Boolean).join(' · ');
    main.append(nameEl, meta);
    const tag = document.createElement('span'); tag.className = 'mtag ' + m.source; tag.textContent = m.source;
    row.append(logo, main, tag);
    row.onclick = () => chooseModel(m.name);
    list.appendChild(row);
  });
}
function markCursor(scroll = true) {
  const rows = [...document.querySelectorAll('#modelList .mrow')];
  rows.forEach((r, i) => r.classList.toggle('cursor', i === pickerCursor));
  if (scroll) rows[pickerCursor]?.scrollIntoView({ block: 'nearest' });
}
function chooseModel(name) {
  const sel = $('model');
  if (![...sel.options].some((o) => o.value === name)) {
    const option = document.createElement('option'); option.value = name; option.textContent = name; sel.appendChild(option);
  }
  sel.value = name; saveState('omodel', name);
  syncModelButton(); closeModelPicker();
}
function openModelPicker() {
  $('modelPicker').classList.add('show');
  const rows = pickerRows();
  pickerCursor = Math.max(0, rows.findIndex((m) => m.name === $('model').value));
  renderPicker();
  $('modelSearch').value = ''; $('modelSearch').focus();
}
function closeModelPicker() { $('modelPicker').classList.remove('show'); }
function setModelByName(name) {
  const sel = $('model');
  const opt = [...sel.options].find((o) => o.value === name || o.value.startsWith(name));
  if (opt) { sel.value = opt.value; saveState('omodel', sel.value); syncModelButton(); showChatView(); addSysNote('Model set to ' + opt.value + '.'); }
  else { showChatView(); addSysNote('Model "' + name + '" not found. Available: ' + [...sel.options].map((o) => o.value).join(', ')); }
  scrollBottom();
}

// ---- conversations / recents ----------------------------------------------
function normalizeConversation(value) {
  if (!value || typeof value !== 'object' || !value.id) return null;
  return {
    ...value,
    id: String(value.id),
    title: typeof value.title === 'string' ? value.title : '(untitled chat)',
    model: typeof value.model === 'string' ? value.model : '',
    // Permissions the user granted in this chat. Also arrives over LAN sharing,
    // so it is coerced to plain strings here and re-checked in the main process.
    grants: Array.isArray(value.grants) ? [...new Set(value.grants.filter((t) => typeof t === 'string').map(String))].slice(0, 20) : [],
    turns: Array.isArray(value.turns) ? value.turns
      .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant'))
      .map((turn) => ({
        role: turn.role,
        content: typeof turn.content === 'string' ? turn.content : String(turn.content ?? ''),
        attachmentCount: Number.isSafeInteger(turn.attachmentCount) ? Math.max(0, turn.attachmentCount) : 0,
        ...(normalizeSteps(turn.steps).length ? { steps: normalizeSteps(turn.steps) } : {}),
      })) : [],
  };
}
// Saved transcripts are also received over LAN sharing, so treat every step as
// untrusted: keep the four known shapes, drop anything else.
function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const s of value) {
    if (!s || typeof s !== 'object') continue;
    if (s.k === 'text' || s.k === 'think') { const text = String(s.text ?? ''); if (text) out.push({ k: s.k, text }); }
    else if (s.k === 'tool') out.push({ k: 'tool', id: s.id ? String(s.id) : undefined, fn: String(s.fn ?? 'tool'), args: s.args ?? {} });
    else if (s.k === 'result') {
      const step = { k: 'result', id: s.id ? String(s.id) : undefined, is_error: !!s.is_error, result: String(s.result ?? '') };
      if (s.denied && typeof s.denied === 'object') {
        step.denied = { what: String(s.denied.what ?? 'this action'), tool: s.denied.tool ? String(s.denied.tool) : null };
      }
      out.push(step);
    }
  }
  return out;
}
function loadConvs() {
  try { conversations = (Array.isArray(persisted.oconvs) ? persisted.oconvs : []).map(normalizeConversation).filter(Boolean); }
  catch { conversations = []; }
}
function saveConvs() {
  // ponytail: keep readable history, never bulky base64 attachments or unlimited logs.
  const stored = conversations.slice(0, 50).map((c) => ({
    ...c,
    grants: c.grants || [],
    turns: (c.turns || []).slice(-80).map((t) => ({
      role: t.role,
      content: String(t.content || '').slice(0, 64000),
      attachmentCount: t.attachmentCount || 0,
      ...(t.steps?.length ? { steps: trimSteps(t.steps) } : {}),
    })),
  }));
  saveState('oconvs', stored);
}
// Tool output is unbounded (a Read of a large file, a long grep), and the whole
// conversation list lives in one settings blob — so clamp per field and per turn.
const STEP_CAP = 120, RESULT_CAP = 8000, ARGS_CAP = 4000, TEXT_CAP = 16000;
function trimSteps(steps) {
  return steps.slice(-STEP_CAP).map((s) => {
    if (s.k === 'text' || s.k === 'think') return { k: s.k, text: String(s.text || '').slice(0, TEXT_CAP) };
    if (s.k === 'result') return { k: 'result', id: s.id, is_error: !!s.is_error, result: String(s.result || '').slice(0, RESULT_CAP) };
    let args = s.args;
    try { if (JSON.stringify(args ?? {}).length > ARGS_CAP) args = { summary: toolSummary(s.fn, args).slice(0, ARGS_CAP) }; } catch { args = {}; }
    return { k: 'tool', id: s.id, fn: s.fn, args };
  });
}
function publishConversation(conv) {
  if (!conv || (!lanServerOn && !lanClientConnected)) return;
  conv.updatedAt = Date.now();
  window.ollama.workspaceUpsert(conv).catch(() => {});
}
function applySharedConversations(items) {
  if (!Array.isArray(items)) return;
  const incoming = new Map(items.map(normalizeConversation).filter(Boolean).map((item) => [item.id, item]));
  const merged = conversations.filter((item) => !incoming.has(item.id));
  for (const item of incoming.values()) merged.push(item);
  conversations = merged.sort((a, b) => (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0)).slice(0, 50);
  if (activeId && !conversations.some((item) => item.id === activeId)) activeId = null;
  renderRecents();
  if (activeId) openConv(activeId);
}
function conversationOrder(list) {
  return [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
    || Number(b.updatedAt || b.ts || 0) - Number(a.updatedAt || a.ts || 0));
}
function deleteConversation(id) {
  conversations = conversations.filter((chat) => chat.id !== id); saveConvs();
  if (activeId === id) newChat(); else renderRecents();
}
function toggleConversationPin(id) {
  const chat = conversations.find((item) => item.id === id); if (!chat) return;
  chat.pinned = !chat.pinned; saveConvs(); renderRecents();
}
function renderRecentPopup() {
  const box = $('recentPopup'); if (!box) return;
  box.innerHTML = '<div class="recent-popover-head"><span>Recent chats</span><span>' + conversations.length + '</span></div>';
  const recent = conversationOrder(conversations).slice(0, 18);
  if (!recent.length) { box.innerHTML += '<div class="sidebar-empty">No chats yet.</div>'; return; }
  for (const chat of recent) {
    const row = document.createElement('div'); row.className = 'recent-popover-item' + (chat.id === activeId ? ' active' : '');
    row.tabIndex = 0; row.setAttribute('role', 'button');
    row.innerHTML = '<span class="recent-popover-title">' + esc(chat.title || '(empty)') + '</span><span class="recent-popover-meta">'
      + esc(chat.projectId ? (projects.find((p) => p.id === chat.projectId)?.name || 'Project') : 'All chats') + ' · ' + esc(chat.model || chat.harness || 'Axon') + '</span>';
    row.onclick = () => { openConv(chat.id); closeRecentPopup(); };
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openConv(chat.id); closeRecentPopup(); } };
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'recent-popover-pin'; pin.textContent = chat.pinned ? '★' : '☆'; pin.title = chat.pinned ? 'Unpin chat' : 'Pin chat';
    pin.onclick = (event) => { event.stopPropagation(); toggleConversationPin(chat.id); };
    const del = document.createElement('button'); del.type = 'button'; del.className = 'recent-popover-delete'; del.textContent = '×'; del.title = 'Delete chat';
    del.onclick = (event) => { event.stopPropagation(); deleteConversation(chat.id); };
    row.append(pin, del); box.appendChild(row);
  }
}
function closeRecentPopup() { $('recentPopup')?.classList.remove('show'); $('recentPopupToggle')?.setAttribute('aria-expanded', 'false'); }
function toggleRecentPopup() { const box = $('recentPopup'); const open = box.classList.toggle('show'); $('recentPopupToggle').setAttribute('aria-expanded', String(open)); if (open) renderRecentPopup(); }
function renderRecents() {
  renderSidebarProjects();
  const box = $('recents'); box.innerHTML = '';
  const visible = (lanServerOn || lanClientConnected || !activeProjectId) ? conversations : conversations.filter((c) => c.projectId === activeProjectId);
  if (!visible.length) {
    const e = document.createElement('div'); e.style.cssText = 'font-size:12px;opacity:.4;padding:7px 8px';
    e.textContent = activeProjectId ? 'No chats in this project yet.' : 'No chats yet.'; box.appendChild(e);
  }
  for (const c of conversationOrder(visible)) {
    const d = document.createElement('div');
    d.className = 'recent' + (c.id === activeId ? ' active' : '') + (c.pinned ? ' pinned' : '');
    d.textContent = (c.title || '(empty)') + ([...activeTurns.values()].some((turn) => turn.conversationId === c.id) ? ' · running' : '');
    d.title = c.title || '';
    d.onclick = () => openConv(c.id);
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'rpin'; pin.textContent = c.pinned ? '★' : '☆'; pin.title = c.pinned ? 'Unpin chat' : 'Pin chat';
    pin.onclick = (e) => { e.stopPropagation(); toggleConversationPin(c.id); };
    const del = document.createElement('button'); del.type = 'button'; del.className = 'rdel'; del.textContent = '×'; del.title = 'Delete chat';
    del.onclick = (e) => { e.stopPropagation(); deleteConversation(c.id); };
    d.append(pin, del); box.appendChild(d);
  }
  renderRecentPopup();
}
function openConv(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  activeId = id;
  if (conv.model && [...$('model').options].some((o) => o.value === conv.model)) $('model').value = conv.model;
  showChatView();
  $('log').innerHTML = '';
  if (Array.isArray(conv.turns) && conv.turns.length) {
    let skipped = 0;
    for (const turn of conv.turns) {
      try {
        const content = typeof turn.content === 'string' ? turn.content : String(turn.content ?? '');
        if (turn.role === 'user') addUserTurn(content + (turn.attachmentCount ? '  +' + turn.attachmentCount + ' attachment' + (turn.attachmentCount === 1 ? '' : 's') : ''), [], false);
        else if (turn.role === 'assistant') addStoredAiTurn(content, conv.model, turn.steps);
      } catch { skipped++; }
    }
    if (skipped) addSysNote('Some damaged saved turns were skipped. You can keep chatting normally.');
  } else addSysNote('This older chat has no saved transcript. New turns are saved locally from now on.');
  const running = currentTurn();
  if (running) $('log').appendChild(running.turnEl);
  renderRecents();
  syncComposerState();
  scrollBottom();
  runNextQueued(id);
}

// ---- view toggle -----------------------------------------------------------
function showHomeView() {
  $('home').style.display = '';
  $('chat').classList.remove('show');
  $('home').querySelector('.wrap').insertBefore($('composerCard'), $('chips'));
  $('prompt').focus();
}
function showChatView() {
  $('home').style.display = 'none';
  $('chat').classList.add('show');
  $('composerSlot').appendChild($('composerCard'));
}
function newChat() { activeId = null; $('log').innerHTML = ''; showHomeView(); renderRecents(); syncComposerState(); switchView('chat'); }

// ---- log helpers -----------------------------------------------------------
function addUserTurn(text, images = [], persist = true) {
  const t = document.createElement('div'); t.className = 'turn user';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  t.appendChild(b); $('log').appendChild(t);
  if (images.length) {
    const gallery = document.createElement('div'); gallery.className = 'user-images';
    for (const image of images) { const pic = document.createElement('img'); pic.src = 'data:' + image.type + ';base64,' + image.data; pic.alt = image.name || 'Attached image'; gallery.appendChild(pic); }
    t.appendChild(gallery);
  }
  if (persist && activeId) {
    const conv = conversations.find((c) => c.id === activeId);
    if (conv) { conv.turns = conv.turns || []; conv.turns.push({ role: 'user', content: text, attachmentCount: images.length }); saveConvs(); publishConversation(conv); }
  }
}
// Replays a saved assistant turn. Chats saved before step recording (or trimmed
// down to fit the storage budget) have no steps, so fall back to prose only.
function addStoredAiTurn(text, model, steps) {
  const turn = newAiTurn(model);
  if (turn.think) { turn.think.remove(); turn.think = null; }
  turn.started = true;
  const prose = String(text || '');
  if (Array.isArray(steps) && steps.length) {
    turn.replaying = true; // suppress re-recording and side effects (browser pane, etc.)
    for (const s of steps) {
      if (s.k === 'text') appendText(turn, String(s.text || ''));
      else if (s.k === 'think') appendThink(turn, String(s.text || ''));
      else if (s.k === 'tool') addToolCall(turn, { id: s.id, fn: s.fn, args: s.args });
      else if (s.k === 'result') addToolResult(turn, { id: s.id, is_error: s.is_error, result: s.result });
    }
    turn.replaying = false;
    // Nothing is in flight on a replayed turn, and reasoning starts folded away.
    turn.blocks.forEach((b) => {
      b.el.classList.remove('active');
      if (b.kind === 'think') { b.el.classList.add('closed'); const c = b.el.querySelector('.caret'); if (c) c.textContent = '▸'; }
    });
  } else {
    const block = addBlock(turn, 'text'); block.raw = prose;
    renderMarkdown(block.el, block.raw);
  }
  addCopyBtn(turn.turnEl, prose);
}
function newAiTurn(model) {
  const t = document.createElement('div'); t.className = 'turn ai';
  const head = document.createElement('div'); head.className = 'turnhead';
  head.textContent = model || '';
  const stream = document.createElement('div'); stream.className = 'stream';
  const think = document.createElement('span'); think.className = 'dots'; think.innerHTML = '<i></i><i></i><i></i>';
  const generating = document.createElement('div'); generating.className = 'generating'; generating.textContent = 'Generating…';
  stream.appendChild(think);
  stream.appendChild(generating);
  if (head.textContent) t.appendChild(head);
  t.appendChild(stream); $('log').appendChild(t);
  scrollBottom();
  return { turnEl: t, streamEl: stream, think, generating, blocks: [], mode: null, tail: '', started: false, model };
}
// One ordered block in the transcript stream: text | think | tool | result.
// Ordered log of everything the turn produced, kept alongside the DOM so the
// transcript can be rebuilt when the chat is reopened. Consecutive prose and
// reasoning fragments merge so streaming deltas don't become thousands of entries.
function record(turn, entry) {
  if (turn.replaying) return;
  turn.record = turn.record || [];
  const last = turn.record[turn.record.length - 1];
  if ((entry.k === 'text' || entry.k === 'think') && last && last.k === entry.k) { last.text += entry.text; return; }
  turn.record.push(entry);
}
function addBlock(turn, kind) {
  const el = document.createElement('div'); el.className = 'block ' + kind;
  turn.streamEl.appendChild(el);
  const block = { kind, el, raw: '' };
  turn.blocks.push(block);
  return block;
}
// Concatenated assistant prose (text blocks only) — used for copy + saved transcript.
function turnText(turn) { return turn.blocks.filter((b) => b.kind === 'text').map((b) => b.raw).join('\n\n').trim(); }
// First real content clears the "Thinking…" dots placeholder.
function startContent(turn) {
  if (turn.started) return;
  turn.started = true;
  if (turn.think) { turn.think.remove(); turn.think = null; }
}
// Append assistant prose to the current text block, opening a new one after any
// tool/think block so prose that follows a tool call lands below it, not above.
function appendText(turn, text) {
  let block = turn.blocks[turn.blocks.length - 1];
  if (!block || block.kind !== 'text') block = addBlock(turn, 'text');
  block.raw += text;
  renderMarkdown(block.el, block.raw);
  record(turn, { k: 'text', text });
}
// Collapsible reasoning block. Body is plain text (escaped via textContent).
function appendThink(turn, text) {
  let block = turn.blocks[turn.blocks.length - 1];
  if (!block || block.kind !== 'think') {
    block = addBlock(turn, 'think');
    const head = document.createElement('button'); head.className = 'think-toggle'; head.type = 'button';
    head.innerHTML = '<span class="caret">▾</span> <span class="think-label">Thinking</span>';
    const body = document.createElement('div'); body.className = 'think-body';
    block.el.appendChild(head); block.el.appendChild(body);
    head.onclick = () => { block.el.classList.toggle('closed'); head.querySelector('.caret').textContent = block.el.classList.contains('closed') ? '▸' : '▾'; };
    block.body = body;
  }
  block.raw += text;
  block.body.textContent = block.raw;
  record(turn, { k: 'think', text });
}
// Streaming-aware splitter for models that inline reasoning as <think>…</think>
// inside the text stream (instead of emitting proper thinking content blocks).
// Emits completed text/think fragments to the transcript and buffers a partial
// tag at the boundary so a split `</th` + `ink>` doesn't leak raw markup.
function splitPartial(buf, tag) {
  for (let n = Math.min(buf.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(buf.slice(buf.length - n))) return buf.slice(0, buf.length - n);
  }
  return buf;
}
function feedText(turn, chunk) {
  let buf = turn.tail + chunk;
  turn.tail = '';
  while (buf) {
    if (turn.mode === 'think') {
      const close = buf.indexOf('</think>');
      if (close === -1) { const safe = splitPartial(buf, '</think>'); if (safe.length) appendThink(turn, safe); turn.tail = buf.slice(safe.length); return; }
      appendThink(turn, buf.slice(0, close));
      buf = buf.slice(close + 8);
      turn.mode = 'text';
    } else {
      const open = buf.indexOf('<think>');
      if (open === -1) { const safe = splitPartial(buf, '<think>'); if (safe.length) appendText(turn, safe); turn.tail = buf.slice(safe.length); return; }
      if (open > 0) appendText(turn, buf.slice(0, open));
      buf = buf.slice(open + 7);
      turn.mode = 'think';
    }
  }
}
function addSysNote(text) {
  const t = document.createElement('div'); t.className = 'turn sys';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  t.appendChild(b); $('log').appendChild(t);
}
// ---- tool calls -------------------------------------------------------------
// A raw JSON dump of the arguments is unreadable at a glance, so each tool gets a
// one-line human summary in the header and keeps the full arguments behind the
// expander. Unknown tools fall back to their first short string argument.
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return String(u || ''); } };
// Harnesses name the same tools differently — Claude Code uses `Read`/`Grep` with
// snake_case arguments, opencode uses `read`/`grep` with camelCase — so match the
// name case-insensitively and accept either argument spelling.
const pick = (a, ...keys) => { for (const k of keys) if (a[k] != null && a[k] !== '') return a[k]; return undefined; };
const TOOL_SUMMARY = {
  read: (a) => baseName(pick(a, 'file_path', 'filePath')) + (a.offset ? ' · from line ' + a.offset : ''),
  write: (a) => baseName(pick(a, 'file_path', 'filePath')),
  edit: (a) => baseName(pick(a, 'file_path', 'filePath')),
  patch: (a) => baseName(pick(a, 'file_path', 'filePath')),
  notebookedit: (a) => baseName(a.notebook_path),
  bash: (a) => a.description || a.command,
  grep: (a) => JSON.stringify(String(a.pattern ?? '')) + (a.glob ? ' in ' + a.glob : a.path ? ' in ' + baseName(a.path) : ''),
  glob: (a) => a.pattern + (a.path ? ' in ' + baseName(a.path) : ''),
  list: (a) => baseName(pick(a, 'path', 'dirPath')) || 'working directory',
  webfetch: (a) => hostOf(a.url),
  websearch: (a) => a.query,
  task: (a) => a.description || a.subagent_type || a.prompt,
  todowrite: (a) => (Array.isArray(a.todos) ? a.todos.length + ' items' : 'task list'),
};
function toolSummary(fn, args) {
  if (typeof args === 'string') return args;
  const a = args && typeof args === 'object' ? args : {};
  try { const made = TOOL_SUMMARY[String(fn || '').toLowerCase()]?.(a); if (made) return String(made).replace(/\s+/g, ' ').trim(); } catch { /* fall through */ }
  const first = Object.values(a).find((v) => typeof v === 'string' && v.trim());
  return first ? String(first).replace(/\s+/g, ' ').trim() : '';
}
function formatArgs(args) {
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args ?? {}, null, 2); } catch { return String(args); }
}
// Header + collapsed argument detail + an empty slot the matching result fills.
function addToolCall(turn, s) {
  const block = addBlock(turn, 'tool');
  block.el.classList.add('active', 'closed');
  const head = document.createElement('button'); head.className = 'tool-head'; head.type = 'button';
  const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▸';
  const fn = document.createElement('span'); fn.className = 'fn'; fn.textContent = s.fn || 'tool';
  const summary = document.createElement('span'); summary.className = 'summary'; summary.textContent = toolSummary(s.fn, s.args);
  head.append(caret, fn, summary);
  const detail = document.createElement('pre'); detail.className = 'tool-args'; detail.textContent = formatArgs(s.args);
  head.onclick = () => { const closed = block.el.classList.toggle('closed'); caret.textContent = closed ? '▸' : '▾'; };
  block.el.append(head, detail);
  // Several tools can run in one assistant message, so pair results by tool_use id
  // where the harness supplies one and fall back to "most recent call" where it does not.
  turn.tools = turn.tools || new Map();
  if (s.id) turn.tools.set(s.id, block);
  turn.pendingTool = block;
  record(turn, { k: 'tool', id: s.id, fn: s.fn, args: s.args });
  if (!turn.replaying && s.fn === 'WebFetch' && typeof s.args?.url === 'string') openBrowserAt(s.args.url);
}
// Results attach under the call that produced them so the pair reads as one unit.
// Long output is clipped to the first few lines behind an explicit expander.
const RESULT_LINES = 6;
function addToolResult(turn, s) {
  const full = String(s.result ?? '');
  let host = (s.id && turn.tools?.get(s.id)) || turn.pendingTool;
  if (s.id) turn.tools?.delete(s.id);
  if (host === turn.pendingTool) turn.pendingTool = null;
  if (!host || !host.el.isConnected) { host = addBlock(turn, 'tool'); host.el.classList.add('closed'); }
  const out = document.createElement('div'); out.className = 'tool-out';
  if (s.is_error) out.classList.add('err');
  const body = document.createElement('pre');
  const lines = full.split('\n');
  const clipped = lines.length > RESULT_LINES;
  body.textContent = clipped ? lines.slice(0, RESULT_LINES).join('\n') : full;
  out.appendChild(body);
  if (clipped) {
    const more = document.createElement('button'); more.className = 'tool-more'; more.type = 'button';
    const hidden = lines.length - RESULT_LINES;
    more.textContent = 'Show ' + hidden + ' more line' + (hidden === 1 ? '' : 's');
    let open = false;
    more.onclick = () => {
      open = !open;
      body.textContent = open ? full : lines.slice(0, RESULT_LINES).join('\n');
      more.textContent = open ? 'Show less' : 'Show ' + hidden + ' more line' + (hidden === 1 ? '' : 's');
    };
    out.appendChild(more);
  }
  // A refused action is not a failure to report — it is a decision to put in
  // front of the user, so it replaces the raw error text with an Allow control.
  if (s.denied) {
    out.innerHTML = '';
    out.classList.add('denied');
    const label = document.createElement('div'); label.className = 'denied-label';
    label.textContent = 'Blocked: ' + s.denied.what;
    out.appendChild(label);
    if (s.denied.tool && !turn.replaying) {
      const row = document.createElement('div'); row.className = 'denied-actions';
      const allow = document.createElement('button'); allow.type = 'button'; allow.className = 'allow-btn';
      allow.textContent = 'Allow ' + s.denied.tool + ' for this chat';
      const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'deny-btn';
      keep.textContent = 'Keep blocked';
      allow.onclick = () => { grantTool(turn.conversationId, s.denied.tool, row); };
      keep.onclick = () => { row.replaceWith(Object.assign(document.createElement('div'), { className: 'denied-label', textContent: 'Left blocked.' })); };
      row.append(allow, keep);
      out.appendChild(row);
    } else if (s.denied.tool) {
      const note = document.createElement('div'); note.className = 'denied-label';
      note.textContent = turn.grantedNote || '';
      if (note.textContent) out.appendChild(note);
    }
  }
  host.el.appendChild(out);
  host.el.classList.remove('active');
  record(turn, { k: 'result', id: s.id, is_error: !!s.is_error, result: full, denied: s.denied || undefined });
}
// Granting is per conversation and persists with it, so resuming the session
// later keeps the permission the user already gave.
function grantTool(conversationId, tool, row) {
  const conv = conversations.find((c) => c.id === conversationId);
  if (!conv) return;
  conv.grants = [...new Set([...(conv.grants || []), tool])];
  saveConvs();
  const done = document.createElement('div');
  done.className = 'denied-label granted';
  done.textContent = tool + ' allowed for this chat. Ask again to retry it.';
  row.replaceWith(done);
  syncComposerState();
}
function addStep(s, turn = currentTurn()) {
  if (!turn) return;
  startContent(turn);
  turn.blocks.forEach((b) => b.el.classList.remove('active'));
  if (s.type === 'thinking') { appendThink(turn, String(s.text || '')); scrollBottom(); return; }
  if (s.type === 'tool_call') { addToolCall(turn, s); scrollBottom(); return; }
  if (s.type === 'tool_result') { addToolResult(turn, s); scrollBottom(); return; }
}
function scrollBottom() { const s = $('scroller'); s.scrollTop = s.scrollHeight; }

// ---- minimal markdown -> sanitized HTML ------------------------------------
// ponytail: hand-rolled, ~35 lines. Fenced code blocks are tokenized before
// escaping so their contents stay literal; everything else is escaped first,
// then a few safe inline patterns are re-applied. No raw HTML passes through.
function mdToHtml(src) {
  const codes = [];
  src = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, body) => {
    codes.push('<pre class="code"><div class="codebar"><span>' + (esc(lang.trim()) || 'code') + '</span><button class="copycode">copy</button></div><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>');
    return '\n~~C' + (codes.length - 1) + '~~\n';
  });
  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = esc(src).split('\n');
  let out = '', inUl = false, inOl = false, para = [];
  // Wrapped prose arrives as several source lines. Buffer them and emit ONE
  // paragraph per blank-line-separated run, instead of a <p> per line.
  const flushPara = () => { if (para.length) { out += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const closeLists = () => { if (inUl) { out += '</ul>'; inUl = false; } if (inOl) { out += '</ol>'; inOl = false; } };
  for (const ln of lines) {
    const cm = ln.match(/^~~C(\d+)~~$/);
    if (cm) { flushPara(); closeLists(); out += codes[+cm[1]] + '\n'; continue; }
    if (/^\s*[-*]\s+/.test(ln)) { flushPara(); if (!inUl) { closeLists(); out += '<ul>'; inUl = true; } out += '<li>' + inline(ln.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { flushPara(); if (!inOl) { closeLists(); out += '<ol>'; inOl = true; } out += '<li>' + inline(ln.replace(/^\s*\d+\.\s+/, '')) + '</li>'; continue; }
    if (/^\s*>\s?/.test(ln)) { flushPara(); closeLists(); out += '<blockquote>' + inline(ln.replace(/^\s*>\s?/, '')) + '</blockquote>'; continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(ln)) { flushPara(); closeLists(); out += '<hr />'; continue; }
    if (/^#{1,4}\s+/.test(ln)) {
      flushPara(); closeLists();
      const level = ln.match(/^#+/)[0].length;
      const tag = level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4';
      out += '<' + tag + '>' + inline(ln.replace(/^#{1,4}\s+/, '')) + '</' + tag + '>';
      continue;
    }
    if (ln.trim() === '') { flushPara(); closeLists(); continue; }
    para.push(ln.trim());
  }
  flushPara();
  closeLists();
  return out;
}
function renderMarkdown(el, text) {
  el.innerHTML = mdToHtml(text);
  el.querySelectorAll('pre.code .copycode').forEach((b) => {
    b.onclick = () => { navigator.clipboard.writeText(b.parentElement.nextElementSibling.textContent); b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200); };
  });
}

// ---- stream events ---------------------------------------------------------
window.ollama.on('chat-delta', ({ requestId, text }) => {
  const turn = activeTurns.get(requestId); if (!turn) return;
  startContent(turn);
  feedText(turn, text);
  if (turn.conversationId === activeId) scrollBottom();
});
window.ollama.on('chat-step', ({ requestId, step }) => addStep(step, activeTurns.get(requestId)));
window.ollama.on('chat-error', ({ requestId, message }) => {
  const turn = activeTurns.get(requestId); if (!turn || stopping.has(requestId)) return;
  if (turn.think) { turn.think.remove(); turn.think = null; }
  turn.turnEl.classList.add('error');
  turn.streamEl.innerHTML = '<div class="block text">[error] ' + esc(message) + '</div>';
});
window.ollama.on('chat-done', ({ requestId, sessionId, steered } = {}) => {
  const turn = activeTurns.get(requestId); if (!turn) return;
  if (turn.think) { turn.think.remove(); turn.think = null; }
  if (turn.generating) { turn.generating.remove(); turn.generating = null; }
  turn.blocks.forEach((b) => b.el.classList.remove('active'));
  const text = turnText(turn);
  if (steered || steering.has(requestId)) {
    turn.turnEl.classList.add('error'); turn.streamEl.innerHTML = '<div class="block text">(steered — continuing with your new instruction)</div>';
  } else if (stopping.has(requestId)) {
    turn.turnEl.classList.add('error'); turn.streamEl.innerHTML = '<div class="block text">(stopped)</div>';
  } else if (!turn.started && !turn.turnEl.classList.contains('error')) {
    turn.streamEl.innerHTML = '<div class="block text">(no response)</div>';
  } else if (turn.started && !turn.turnEl.classList.contains('error')) { addCopyBtn(turn.turnEl, text); }
  if (turn.started && text) {
    const conv = conversations.find((c) => c.id === turn.conversationId);
    if (conv) { conv.turns = conv.turns || []; conv.turns.push({ role: 'assistant', content: text, steps: turn.record || [] }); conv.updatedAt = Date.now(); saveConvs(); publishConversation(conv); }
  }
  if (sessionId) {
    const conv = conversations.find((c) => c.id === turn.conversationId);
    if (conv && !conv.sessionId) { conv.sessionId = sessionId; saveConvs(); }
  }
  activeTurns.delete(requestId); stopping.delete(requestId); steering.delete(requestId);
  renderRecents(); syncComposerState();
  if (turn.conversationId === activeId) scrollBottom();
  runNextQueued(turn.conversationId);
});
function addCopyBtn(turnEl, text) {
  const b = document.createElement('button'); b.className = 'copymsg'; b.textContent = 'copy'; b.title = 'Copy response';
  b.onclick = () => { navigator.clipboard.writeText(text); b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200); };
  turnEl.appendChild(b);
}

// ---- help ------------------------------------------------------------------
async function showHelp() {
  showChatView();
  let cmds = [];
  try { cmds = await window.ollama.listCommands(); } catch {}
  const lines = [
    'Commands',
    '  /new · /clear  — start a fresh chat',
    '  /model <name>  — switch model (prefix match)',
    '  /help          — this list',
    '  /compact       — unavailable in headless mode (use /clear)',
    '',
    'Custom commands (~/.claude/commands/*.md):',
    ...(cmds.length ? cmds.map((c) => '  /' + c.name + (c.description ? ' — ' + c.description : '')) : ['  (none — add markdown files to ~/.claude/commands)']),
    '',
    'Anything else /foo is sent to the model verbatim. Attach files with the paperclip or drag-drop.',
  ];
  addSysNote(lines.join('\n'));
  scrollBottom();
}

// ---- send / commands -------------------------------------------------------
function saveDraft() { saveState('odraft', $('prompt').value.slice(0, 20000)); }
function clearInput() { $('prompt').value = ''; saveDraft(); autosize(); }
function syncComposerState() {
  const running = currentTurn();
  const b = !!running;
  $('send').textContent = b ? '■' : '→';
  $('send').className = running ? 'stop' : '';
  $('send').title = running ? 'Stop this chat' : 'Send';
  $('steer').hidden = !running;
  $('steer').disabled = !running;
}

function queueMessage(conversationId, entry, steers = false) {
  const queue = queuedMessages.get(conversationId) || [];
  if (steers) queue.unshift(entry); else queue.push(entry);
  queuedMessages.set(conversationId, queue);
  addSysNote((steers ? 'Steering next: ' : 'Queued: ') + (entry.text || '(attachment)').slice(0, 180));
  scrollBottom();
}
function runNextQueued(conversationId) {
  const queue = queuedMessages.get(conversationId); if (!queue?.length || currentTurn()) return;
  const entry = queue.shift(); if (!queue.length) queuedMessages.delete(conversationId);
  if (conversationId !== activeId) return;
  startMessage(entry);
}
function takeComposerEntry() {
  const text = $('prompt').value.trim();
  if (!text && !attachments.length) return null;
  const images = attachments.filter((a) => a.image).map((a) => ({ name: a.name, type: a.type, data: a.data }));
  // Claude Code routes to the selected local Ollama model; the external harnesses
  // pick their own model (blank = that CLI's account default).
  const harnessModel = { codex: settings.codexModel, opencode: settings.opencodeModel }[settings.harness];
  const entry = { text, combined: inlineAttachments(text), images, harness: settings.harness, model: harnessModel !== undefined ? harnessModel.trim() : $('model').value };
  clearInput(); clearAttachments(); return entry;
}

async function send() {
  const running = currentTurn();
  const text = $('prompt').value.trim();
  if (running) { const entry = takeComposerEntry(); if (entry) queueMessage(activeId, entry); return; }
  if (!text && !attachments.length) return;

  // built-in REPL commands (handled app-side; they don't exist in headless -p)
  if (text === '/clear' || text === '/new') { clearInput(); clearAttachments(); newChat(); addSysNote('Started a new chat.'); showChatView(); scrollBottom(); return; }
  if (text === '/help' || text.startsWith('/help ')) { clearInput(); showHelp(); return; }
  if (text === '/compact') { clearInput(); showChatView(); addSysNote('/compact isn’t available in headless mode — use /clear to start a fresh session.'); scrollBottom(); return; }
  if (text.startsWith('/model ')) { clearInput(); setModelByName(text.slice(7).trim()); return; }

  const entry = takeComposerEntry();
  startMessage(entry);
}
async function startMessage(entry) {
  const { text, combined, images, model } = entry;
  // create / reuse conversation
  let conv = activeId ? conversations.find((c) => c.id === activeId) : null;
  if (!conv) {
    conv = { id: rid(), sessionId: null, title: text.replace(/\s+/g, ' ').slice(0, 48) || '(attachment)', model, harness: entry.harness, ts: Date.now(), updatedAt: Date.now(), projectId: activeProjectId, turns: [] };
    conversations.unshift(conv); activeId = conv.id; renderRecents();
  }
  conv.updatedAt = Date.now(); saveConvs();
  const systemPrompt = projectSystemPrompt();
  const fingerprint = instructionFingerprint(conv.harness || entry.harness, systemPrompt);
  // Claude Code preserves a session's initial system context on --resume. A
  // changed Axon/project instruction set must start a clean session to apply.
  if (conv.instructionFingerprint !== fingerprint) { conv.sessionId = null; conv.instructionFingerprint = fingerprint; saveConvs(); }
  showChatView();
  addUserTurn(text, images);
  const requestId = rid() + rid();
  const turn = newAiTurn(model || 'Codex CLI');
  turn.conversationId = conv.id;
  activeTurns.set(requestId, turn);
  renderRecents(); syncComposerState();
  const result = await window.ollama.chat(conv.model, combined, conv.sessionId, { systemPrompt, cwd: projectCwd(), images, requestId, harness: conv.harness || entry.harness, mode: settings.permissionMode, grants: conv.grants || [] });
  if (!result?.ok) {
    const failed = activeTurns.get(requestId);
    if (failed) { failed.turnEl.classList.add('error'); failed.streamEl.innerHTML = '<div class="block text">[error] ' + esc(result?.error || 'Could not start this chat.') + '</div>'; activeTurns.delete(requestId); renderRecents(); syncComposerState(); }
  }
}

// ---- slash-command autocomplete -------------------------------------------
// ponytail: known app-side commands appear instantly while the CLI discovery
// fills the rest of the list in the background.
const CORE_COMMANDS = [
  { name: 'new', description: 'Start a fresh chat', tag: 'Axon' },
  { name: 'clear', description: 'Start a fresh chat', tag: 'Axon' },
  { name: 'model', description: 'Switch the active model', tag: 'Axon' },
  { name: 'help', description: 'Show commands and shortcuts', tag: 'Axon' },
  { name: 'compact', description: 'Start fresh (headless fallback)', tag: 'Axon' },
];
let allCommands = [];
let cmdOpen = false, cmdItems = [], cmdSel = 0, commandLoadStarted = false;

async function ensureCommands() {
  if (allCommands.length) return;
  const model = $('model').value || 'qwen2.5:1.5b';
  let names = []; let custom = [];
  try { names = await window.ollama.fetchCommands(model); } catch {}
  try { custom = await window.ollama.listCommands(); } catch {}
  const customMap = new Map(custom.map((c) => [c.name, c.description || '']));
  const customNames = new Set(custom.map((c) => c.name));
  const seen = new Set(), merged = [];
  for (const n of names) {
    if (seen.has(n)) continue; seen.add(n);
    merged.push({ name: n, description: customMap.get(n) || '', tag: customNames.has(n) ? 'custom' : (n.includes(':') ? 'plugin' : 'command') });
  }
  for (const c of custom) {
    if (!seen.has(c.name)) { seen.add(c.name); merged.push({ name: c.name, description: c.description || '', tag: 'custom' }); }
  }
  allCommands = merged;
}
function showCoreCommands(prefix) {
  const matches = CORE_COMMANDS.filter((c) => c.name.startsWith(prefix));
  if (!matches.length) return closeCmdList();
  cmdItems = matches; cmdSel = 0;
  const box = $('cmdlist');
  box.innerHTML = '<div class="cmdhead">Commands · loading more</div>' + matches.map((c, i) =>
    '<div class="cmditem' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '"><span class="cmdname">/' + c.name + '</span><span class="cmddesc">' + c.description + '</span><span class="cmdtag">' + c.tag + '</span></div>'
  ).join('');
  box.classList.add('show'); cmdOpen = true;
  box.querySelectorAll('.cmditem').forEach((el) => { el.onmousedown = (ev) => { ev.preventDefault(); chooseCmd(+el.dataset.i); }; });
}

async function openCmdList() {
  const m = $('prompt').value.match(/^\/([A-Za-z0-9_:.\-]*)$/);
  if (!m) { closeCmdList(); return; }
  if (!allCommands.length && !commandLoadStarted) {
    commandLoadStarted = true;
    showCoreCommands(m[1]);
    ensureCommands().then(() => { if ($('prompt').value.match(/^\/[A-Za-z0-9_:.\-]*$/)) openCmdList(); });
    return;
  }
  if (!allCommands.length) { showCoreCommands(m[1]); return; }
  const prefix = m[1];
  const matches = allCommands.filter((c) => c.name.startsWith(prefix)).slice(0, 50);
  if (!matches.length) { closeCmdList(); return; }
  cmdItems = matches; cmdSel = 0;
  const box = $('cmdlist');
  box.innerHTML = '<div class="cmdhead">Commands</div>' + matches.map((c, i) =>
    '<div class="cmditem' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '"><span class="cmdname">/' + esc(c.name) + '</span><span class="cmddesc">' + esc(c.description || '') + '</span><span class="cmdtag">' + c.tag + '</span></div>'
  ).join('');
  box.classList.add('show'); cmdOpen = true;
  box.querySelectorAll('.cmditem').forEach((el) => {
    el.onmousedown = (ev) => { ev.preventDefault(); chooseCmd(+el.dataset.i); };
  });
}
function closeCmdList() { $('cmdlist').classList.remove('show'); cmdOpen = false; cmdItems = []; }
function moveSel(d) {
  if (!cmdOpen) return;
  cmdSel = (cmdSel + d + cmdItems.length) % cmdItems.length;
  const items = $('cmdlist').querySelectorAll('.cmditem');
  items.forEach((el, i) => el.classList.toggle('sel', i === cmdSel));
  items[cmdSel]?.scrollIntoView({ block: 'nearest' });
}
function chooseCmd(i) {
  const c = cmdItems[i]; if (!c) return;
  $('prompt').value = '/' + c.name + ' ';
  closeCmdList(); autosize(); $('prompt').focus();
}

// ---- wiring ----------------------------------------------------------------
$('send').onclick = () => {
  const turn = currentTurn();
  if (!turn) return send();
  const requestId = [...activeTurns.entries()].find(([, value]) => value === turn)?.[0];
  if (requestId) { stopping.add(requestId); window.ollama.stop(requestId); }
};
$('steer').onclick = () => {
  const turn = currentTurn(); const entry = takeComposerEntry();
  if (!turn || !entry) return;
  const requestId = [...activeTurns.entries()].find(([, value]) => value === turn)?.[0];
  if (!requestId) return;
  queueMessage(activeId, entry, true); steering.add(requestId); window.ollama.steer(requestId);
};
$('newchat').onclick = () => newChat();
$('model').onchange = () => saveState('omodel', $('model').value);
$('prompt').addEventListener('keydown', (e) => {
  if (cmdOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseCmd(cmdSel); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeCmdList(); return; }
  } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
function autosize() { const t = $('prompt'); t.style.height = '44px'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; }
$('prompt').addEventListener('input', () => { autosize(); saveDraft(); openCmdList(); });
$('prompt').addEventListener('blur', () => setTimeout(closeCmdList, 150));
$('chips').addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) { $('prompt').value = e.target.textContent + ': '; autosize(); closeCmdList(); $('prompt').focus(); }
});

// ---- native agent browser --------------------------------------------------
let browserOpen = false;
function syncBrowserBounds() {
  if (!browserOpen) return;
  const r = $('browserSlot').getBoundingClientRect();
  window.ollama.browserShow({ x: r.x, y: r.y, width: r.width, height: r.height });
}
function setBrowserOpen(open) {
  browserOpen = open; $('browserPanel').classList.toggle('show', open); $('browserToggle').classList.toggle('active', open);
  if (open) requestAnimationFrame(syncBrowserBounds); else window.ollama.browserHide();
}
function openBrowserAt(url) {
  setBrowserOpen(true); $('browserUrl').value = url; window.ollama.browserNavigate(url);
}
$('browserToggle').onclick = () => setBrowserOpen(!browserOpen);
$('windowMinimize').onclick = () => window.ollama.windowControl('minimize');
$('windowMaximize').onclick = () => window.ollama.windowControl('maximize');
$('windowClose').onclick = () => window.ollama.windowControl('close');
$('browserClose').onclick = () => setBrowserOpen(false);
$('browserBack').onclick = () => window.ollama.browserAction('back');
$('browserForward').onclick = () => window.ollama.browserAction('forward');
$('browserReload').onclick = () => window.ollama.browserAction('reload');
$('browserUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') openBrowserAt($('browserUrl').value.trim()); });
window.addEventListener('resize', () => requestAnimationFrame(syncBrowserBounds));
window.ollama.on('browser-status', (s) => { if (s.url) $('browserUrl').value = s.url; });

// attachments
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { addFiles($('fileInput').files); $('fileInput').value = ''; };
const card = $('composerCard');
card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dragging'); });
card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('dragging'); });
card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('dragging'); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
$('prompt').addEventListener('paste', (e) => { const files = e.clipboardData?.files; if (files?.length) { e.preventDefault(); addFiles(files); } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (cmdOpen) closeCmdList(); else if ($('recentPopup')?.classList.contains('show')) closeRecentPopup(); else if ($('modelDownload')?.classList.contains('show')) closeModelDownloads(); else closeSettings(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); $('prompt').focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
});

// settings
for (const btn of document.querySelectorAll('#navBar .nav-item')) {
  btn.onclick = () => switchView(btn.dataset.view);
}
$('projectsSidebarAdd').onclick = () => { openSettings(); setTimeout(() => $('projName').focus(), 0); };
$('projectsPageAdd').onclick = () => { openSettings(); setTimeout(() => $('projName').focus(), 0); };
$('settingsClose').onclick = closeSettings;
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
$('sysPrompt').addEventListener('input', () => { settings.systemPrompt = $('sysPrompt').value; saveSettings(); });
$('themeSel').onchange = () => { settings.theme = $('themeSel').value; settings.colors = { ...THEME_PALETTES[settings.theme] }; settings.accent = settings.colors.accent; saveSettings(); applyAppearance(); renderSwatches(); syncPaletteInputs(); };
$('densitySel').onchange = () => { settings.density = $('densitySel').value; saveSettings(); applyAppearance(); };
$('motionSel').onchange = () => { settings.motion = $('motionSel').value; saveSettings(); applyAppearance(); };
$('fontSel').onchange = () => { settings.font = $('fontSel').value; saveSettings(); applyAppearance(); };
// Only the selected harness's model field is relevant; hide the other one so the
// row does not read as three unrelated inputs.
function syncHarnessFields() {
  $('codexModel').parentElement.style.display = settings.harness === 'codex' ? '' : 'none';
  $('opencodeModel').parentElement.style.display = settings.harness === 'opencode' ? '' : 'none';
}
// Permission mode: a segmented control rather than a <select>, because the
// difference between the three is the description, not the label.
function syncModes() {
  for (const btn of document.querySelectorAll('#modes .mode')) {
    const on = btn.dataset.mode === settings.permissionMode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  const badge = $('permissionModeButton');
  if (badge) {
    badge.textContent = { approve: 'Approve', auto: 'Auto', full: 'Full' }[settings.permissionMode] || 'Auto';
    badge.className = 'composer-mode mode-' + settings.permissionMode;
    badge.title = {
      approve: 'Approve mode — writes and commands are blocked until you allow them',
      auto: 'Auto mode — the standard tool set runs without asking',
      full: 'Full mode — nothing is withheld',
    }[settings.permissionMode] || '';
  }
}
for (const btn of document.querySelectorAll('#modes .mode')) {
  btn.onclick = () => { settings.permissionMode = btn.dataset.mode; syncModes(); saveSettings(); };
}
$('permissionModeButton').onclick = () => {
  const order = ['approve', 'auto', 'full'];
  settings.permissionMode = order[(order.indexOf(settings.permissionMode) + 1) % order.length];
  syncModes(); saveSettings();
};
$('harnessSel').onchange = () => { settings.harness = $('harnessSel').value; syncHarnessFields(); saveSettings(); };
$('runtimeSel').onchange = () => { syncRuntimeFields(); selectRuntime(); };
$('exoCheck').onclick = testExo;
$('llamaCppRole').onchange = () => { syncLlamaCppRoleFields(); saveLlamaCppConfigFromFields(); };
$('llamaCppInstallBtn').onclick = installLlamaCppRuntime;
$('llamaCppBrowseBtn').onclick = pickLlamaCppModel;
$('llamaCppRpcPeers').onchange = saveLlamaCppConfigFromFields;
$('llamaCppContextSize').onchange = saveLlamaCppConfigFromFields;
$('llamaCppBindIp').onchange = saveLlamaCppConfigFromFields;
$('llamaCppRpcPort').onchange = saveLlamaCppConfigFromFields;
$('llamaCppTestPeerBtn').onclick = testLlamaCppPeer;
$('llamaCppStartBtn').onclick = startLlamaCppRuntime;
$('llamaCppStopBtn').onclick = stopLlamaCppRuntime;
window.ollama.on('llamacpp-install-progress', (p) => {
  if (!p) return;
  if (p.phase === 'download') {
    const pct = p.total ? Math.round((p.received / p.total) * 100) + '%' : formatBytes(p.received);
    $('llamaCppInstallStatus').textContent = `Downloading ${p.label}… ${pct}`;
  } else if (p.phase === 'extract') $('llamaCppInstallStatus').textContent = 'Extracting…';
});
window.ollama.on('llamacpp-status-change', (update) => {
  if (!update) return;
  $('llamaCppStatus').textContent = `${update.role === 'worker' ? 'Worker' : 'Host'} stopped${update.code ? ' (exit ' + update.code + ')' : ''}.${update.tail ? ' ' + update.tail.trim().slice(-300) : ''}`;
  if ($('settings').classList.contains('show')) refreshLlamaCppStatus();
});
$('codexModel').oninput = () => { settings.codexModel = $('codexModel').value.trim(); saveSettings(); };
$('opencodeModel').oninput = () => { settings.opencodeModel = $('opencodeModel').value.trim(); saveSettings(); };
for (const [inputId, colorKey] of [['accentColor', 'accent'], ['backgroundColor', 'background'], ['surfaceColor', 'surface'], ['textColor', 'text']]) {
  $(inputId).oninput = () => { settings.colors[colorKey] = $(inputId).value; if (colorKey === 'accent') settings.accent = settings.colors.accent; saveSettings(); applyAppearance(); if (colorKey === 'accent') renderSwatches(); };
}
$('paletteReset').onclick = () => { settings.colors = { ...THEME_PALETTES[settings.theme] || THEME_PALETTES.midnight }; settings.accent = settings.colors.accent; saveSettings(); applyAppearance(); renderSwatches(); syncPaletteInputs(); };
$('recents-label').onclick = openSettings;
$('recentPopupToggle').onclick = (event) => { event.stopPropagation(); toggleRecentPopup(); };
document.addEventListener('click', (event) => { const popup = $('recentPopup'); if (popup?.classList.contains('show') && !popup.contains(event.target) && event.target !== $('recentPopupToggle')) closeRecentPopup(); });
$('sidebarUpdate').onclick = () => { openSettings(); $('appUpdateBtn').click(); };
$('modelsBrowse').onclick = openModelDownloads;
$('sidebarProjectsAdd').onclick = () => { openSettings(); setTimeout(() => $('projName').focus(), 0); };
$('projPick').onclick = createProject;
// model picker wiring
$('modelBtn').onclick = openModelPicker;
$('modelPickerClose').onclick = closeModelPicker;
$('modelPicker').onclick = (e) => { if (e.target === $('modelPicker')) closeModelPicker(); };
$('modelSearch').oninput = () => { pickerCursor = 0; renderPicker(); };
$('modelSort').onchange = renderPicker;
for (const btn of document.querySelectorAll('#modelFilters .pfilter')) {
  btn.onclick = () => {
    document.querySelectorAll('#modelFilters .pfilter').forEach((b) => b.classList.toggle('on', b === btn));
    pickerCursor = 0; renderPicker();
  };
}
$('modelPicker').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModelPicker(); return; }
  // Arrow keys inside the sort <select> belong to the select — otherwise one
  // press both changes the sort and moves the row cursor.
  if (e.target === $('modelSort')) return;
  const rows = pickerRows();
  if (!rows.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); pickerCursor = (pickerCursor + 1) % rows.length; markCursor(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pickerCursor = (pickerCursor - 1 + rows.length) % rows.length; markCursor(); }
  else if (e.key === 'Enter') { e.preventDefault(); chooseModel(rows[pickerCursor].name); }
});
$('modelDownloadClose').onclick = closeModelDownloads;
$('modelDownload').onclick = (e) => { if (e.target === $('modelDownload')) closeModelDownloads(); };
$('modelDownloadSearch').oninput = () => { modelDownloadPage = 1; renderModelDownloads(); };
$('modelDownloadSort').onchange = () => { modelDownloadPage = 1; renderModelDownloads(); };
for (const filter of document.querySelectorAll('#modelDownloadFilters .download-filter')) {
  filter.onclick = () => { document.querySelectorAll('#modelDownloadFilters .download-filter').forEach((item) => item.classList.toggle('on', item === filter)); modelDownloadPage = 1; renderModelDownloads(); };
}
$('cloudModelsRefresh').onclick = refreshCloudCatalogue;
$('workspacePick').onclick = async () => {
  const picked = await window.ollama.pickFolder();
  if (!picked) return;
  defaultWorkspace = picked;
  $('workspacePath').value = picked;
  saveState('oworkspace', picked);
};
$('projInstr').addEventListener('input', () => { const p = activeProject(); if (p) { p.instructions = $('projInstr').value; saveProjects(); } });
function describeDependency(name, value) { return name + ': ' + (value ? value.replace(/\s+/g, ' ').slice(0, 48) : 'missing'); }
async function refreshAppInfo() {
  const info = await window.ollama.appInfo();
  $('versionInfo').textContent = 'Axon v' + info.version + ' · ' + [describeDependency('Ollama', info.dependencies.ollama), describeDependency('Claude', info.dependencies.claude), describeDependency('Node', info.dependencies.node)].join(' · ');
}
$('appUpdateBtn').onclick = async () => {
  const button = $('appUpdateBtn'); button.disabled = true; $('maintenanceInfo').textContent = 'Checking for an Axon update…';
  try {
    const update = await window.ollama.checkAppUpdate();
    if (update?.error) { $('maintenanceInfo').textContent = 'Update check failed: ' + update.error; return; }
    if (!update.available) { $('maintenanceInfo').textContent = 'Axon is up to date (v' + update.current + ').'; return; }
    $('maintenanceInfo').textContent = 'Axon v' + update.version + ' is ready to download.';
    showUpdateDialog('Axon ' + update.version + ' is ready', 'Download the verified Windows installer now? Axon checks its SHA-256 before it can open.', [
      { label: 'Later', run: () => {} },
      { label: 'Download and install', primary: true, onStart: () => { $('updateBody').textContent = 'Downloading Axon ' + update.version + '…\n\nThis can take a minute. The installer is verified before Windows is allowed to open it.'; }, run: async () => { const file = await window.ollama.downloadAppUpdate(); if (file?.error) return file; return window.ollama.openUpdateInstaller(file.path); } },
    ]);
  } catch (error) { $('maintenanceInfo').textContent = 'Update check failed: ' + (error?.message || 'Unknown error'); }
  finally { button.disabled = false; }
};
window.ollama.on('app-update-progress', (p) => {
  const status = 'Downloading Axon update: ' + Math.min(100, Math.round(p.received / p.total * 100)) + '%';
  $('maintenanceInfo').textContent = status;
  if ($('updateModal').classList.contains('show')) $('updateBody').textContent = status + '\n\nVerifying the installer before Windows opens it.';
});
$('depsBtn').onclick = async () => {
  $('depsBtn').disabled = true; $('maintenanceInfo').textContent = 'Downloading missing dependencies…';
  try { const result = await window.ollama.installDependencies(); $('maintenanceInfo').textContent = result.steps.join(' · ') || 'Everything required is already installed.'; await refreshAppInfo(); }
  catch (e) { $('maintenanceInfo').textContent = 'Setup error: ' + e.message; }
  $('depsBtn').disabled = false;
};

// ---- LAN: same-WiFi link (server / client) ---------------------------------
// ponytail: the renderer just toggles server / connects client and shows status;
// main does the TCP + NDJSON (src/lan.js). Client mode is reflected so the user
// knows chats route through the server.
let lanClientConnected = false;
let lanServerOn = false;
function setModeBadge() {
  const badge = $('lanModeBadge');
  badge.className = 'mode-badge' + (lanServerOn ? ' host' : (lanClientConnected ? ' client' : ''));
  badge.textContent = lanServerOn ? 'Host' : (lanClientConnected ? 'Client' : 'Local');
}
function setUpdateInfo(text) { $('updateInfo').textContent = text; }
function showUpdateDialog(title, body, actions) {
  $('updateTitle').textContent = title; $('updateBody').textContent = body;
  const buttons = $('updateButtons'); buttons.innerHTML = '';
  for (const action of actions) {
    const button = document.createElement('button'); button.textContent = action.label; if (action.primary) button.className = 'primary';
    button.onclick = async () => {
      const label = button.textContent;
      button.disabled = true;
      try { action.onStart?.(); } catch {}
      try {
        const result = await action.run();
        if (result?.error) { const message = 'Update failed: ' + result.error; setUpdateInfo(message); $('updateBody').textContent = message; button.textContent = label; button.disabled = false; return; }
        $('updateModal').classList.remove('show');
      } catch (e) { const message = 'Update failed: ' + (e?.message || 'Action failed.'); setUpdateInfo(message); $('updateBody').textContent = message; button.textContent = label; button.disabled = false; }
    };
    buttons.appendChild(button);
  }
  $('updateModal').classList.add('show');
}
function formatBytes(n) { return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
function updateLan(s) {
  if (s.server !== undefined) {
    const info = $('lanServerInfo'); const chk = $('lanServerChk'); const copy = $('lanCopyHost');
    if (s.server === 'listening') {
      const address = (s.ips || [])[0] ? (s.ips[0] + ':' + s.port) : '';
      const clients = Number(s.clients) || 0;
      const presence = clients ? clients + ' client' + (clients === 1 ? '' : 's') + ' linked.' : 'waiting for clients.';
      info.textContent = address ? 'Host ready — ' + presence + ' Clients can use ' + address + '.' : 'Host ready — ' + presence;
      copy.disabled = !address; copy.dataset.address = address;
    }
    else if (s.server === 'closed' || s.server === 'off') { info.textContent = ''; chk.checked = false; copy.disabled = true; copy.dataset.address = ''; }
    else if (s.server.startsWith('error')) { info.textContent = 'Host error: ' + s.server; chk.checked = false; copy.disabled = true; copy.dataset.address = ''; }
    else info.textContent = s.server;
    lanServerOn = s.server === 'listening';
    if (lanServerOn) window.ollama.workspaceSeed(conversations).catch(() => {});
    setModeBadge();
  }
  if (s.client !== undefined) {
    const info = $('lanClientInfo'); const btn = $('lanConnBtn');
    lanClientConnected = (s.client === 'connected');
    if (s.client === 'connected') {
      if (!localConversationBackup) localConversationBackup = conversations;
      info.textContent = 'Connected — Host models and shared chats are now active.'; btn.textContent = 'Disconnect'; btn.dataset.mode = 'disc';
      activeProjectId = null; updateProjectLabel();
    } else if (s.client === 'disconnected') {
      if (localConversationBackup) { conversations = localConversationBackup; localConversationBackup = null; renderRecents(); }
      info.textContent = ''; btn.textContent = 'Connect'; btn.dataset.mode = 'conn';
    } else if (s.client === 'connecting') {
      info.textContent = 'Connecting to Host…'; btn.textContent = 'Disconnect'; btn.dataset.mode = 'disc';
    } else if (s.client === 'reconnecting') {
      const seconds = Math.max(1, Math.ceil((Number(s.retryInMs) || 0) / 1000));
      info.textContent = 'Connection lost — retrying in ' + seconds + ' second' + (seconds === 1 ? '' : 's') + '. Disconnect to stop.';
      btn.textContent = 'Disconnect'; btn.dataset.mode = 'disc';
    }
    else if (s.client.startsWith('error')) { info.textContent = 'Connection failed: ' + s.client; btn.textContent = 'Connect'; btn.dataset.mode = 'conn'; }
    else { info.textContent = s.client; btn.textContent = 'Connect'; btn.dataset.mode = 'conn'; }
    setModeBadge();
  }
}
window.ollama.on('lan-status', updateLan);
window.ollama.on('models-changed', () => loadModels());
window.ollama.on('workspace-init', ({ host, conversations: shared }) => {
  $('lanWorkspaceInfo').textContent = 'Shared with ' + host + ': host models, shared chat history, and remote runs.';
  applySharedConversations(shared);
});
window.ollama.on('workspace-snapshot', ({ conversations: shared }) => applySharedConversations(shared));
function renderLanDevices(devices) {
  const box = $('lanDevices'); box.innerHTML = '';
  if (!devices?.length) { const empty = document.createElement('div'); empty.className = 'lan-info'; empty.textContent = 'No other Axon devices found yet. Open Axon on the other device and keep both on the same Wi-Fi.'; box.appendChild(empty); return; }
  for (const device of devices) {
    const row = document.createElement('div'); row.className = 'device-row';
    const meta = document.createElement('div'); meta.className = 'device-meta';
    const name = document.createElement('span'); name.className = 'device-name'; name.textContent = device.name + (device.available ? ' · ready' : ' · not hosting');
    const address = document.createElement('span'); address.className = 'device-address'; address.textContent = device.host + ':' + device.port;
    meta.append(name, address);
    const actions = document.createElement('div'); actions.className = 'update-actions';
    const connect = document.createElement('button'); connect.textContent = device.available ? 'Connect' : 'Needs Host'; connect.disabled = !device.available;
    connect.title = device.available ? 'Use this Host for models and shared chats' : 'Turn on Host mode on that device first';
    connect.onclick = async () => {
      const result = await window.ollama.lanConnectDevice(device);
      if (result?.ok) { $('lanHost').value = device.host + ':' + device.port; saveState('olanHost', $('lanHost').value); }
      setUpdateInfo(result?.error ? result.error : 'Connecting to ' + device.name + '…');
    };
    const request = document.createElement('button'); request.textContent = 'Request update'; request.disabled = !device.available;
    request.title = 'Ask this Host to share an Axon installer';
    request.onclick = async () => {
      const result = await window.ollama.lanRequestDeviceUpdate(device);
      setUpdateInfo(result?.error ? result.error : 'Request sent to ' + device.name + '. It will appear in that device\'s Axon window.');
    };
    actions.append(connect, request); row.append(meta, actions); box.appendChild(row);
  }
}
window.ollama.on('lan-devices', renderLanDevices);
$('lanServerChk').onchange = (e) => { saveState('olanHostEnabled', e.target.checked); window.ollama.lanServer(e.target.checked); };
$('lanCopyHost').onclick = async () => {
  const address = $('lanCopyHost').dataset.address;
  if (!address) return;
  try { await navigator.clipboard.writeText(address); $('lanCopyHost').textContent = 'Copied'; setTimeout(() => { $('lanCopyHost').textContent = 'Copy Host address'; }, 1200); }
  catch { setUpdateInfo('Could not copy the Host address — use ' + address + '.'); }
};
$('lanConnBtn').onclick = () => {
  if ($('lanConnBtn').dataset.mode === 'disc') window.ollama.lanDisconnect();
  else { const h = $('lanHost').value.trim(); if (h) { saveState('olanHost', h); window.ollama.lanConnect(h); } }
};
$('updatePickBtn').onclick = async () => {
  const result = await window.ollama.selectUpdateInstaller();
  setUpdateInfo(result?.error ? result.error : (result ? 'Ready to share ' + result.name + ' (' + formatBytes(result.bytes) + ').' : 'No installer selected.'));
};
$('updateOfferBtn').onclick = async () => {
  const result = await window.ollama.offerUpdate();
  setUpdateInfo(result?.error ? result.error : 'Offer sent to linked clients. They must accept before transfer starts.');
};
$('updateRequestBtn').onclick = async () => {
  const result = await window.ollama.requestUpdate();
  setUpdateInfo(result?.error ? result.error : 'Request sent. The Host must approve it first.');
};
window.ollama.on('lan-update-request', (request) => {
  const actions = [{ label: 'Decline', run: () => window.ollama.respondUpdateRequest(request.id, false) }];
  if (request.hasInstaller) actions.push({ label: 'Offer update', primary: true, run: () => window.ollama.respondUpdateRequest(request.id, true) });
  const requester = request.requester || 'A linked client';
  showUpdateDialog(requester + ' requested an update', request.hasInstaller ? requester + ' is asking for the installer you selected. Share it?' : requester + ' is asking for an update, but this Host has not selected an installer.', actions);
});
window.ollama.on('lan-update-offer', (offer) => {
  showUpdateDialog('Update available', 'The Host offers ' + offer.name + ' (' + formatBytes(offer.bytes) + ').\n\nAxon verifies its SHA-256 before the installer can open.', [
    { label: 'Decline', run: () => window.ollama.acceptUpdateOffer(offer.id, false) },
    { label: 'Download update', primary: true, run: () => window.ollama.acceptUpdateOffer(offer.id, true) },
  ]);
});
window.ollama.on('lan-update-progress', (p) => setUpdateInfo((p.role === 'host' ? 'Sending' : 'Receiving') + ' update: ' + Math.min(100, Math.round(p.received / p.total * 100)) + '%'));
window.ollama.on('lan-update-error', (e) => setUpdateInfo('Update error: ' + (e.message || 'Transfer failed.')));
window.ollama.on('lan-update-ready', (update) => {
  setUpdateInfo('Verified update ready: ' + update.name);
  showUpdateDialog('Verified update ready', update.name + ' passed its SHA-256 check. Open the installer now?', [
    { label: 'Later', run: () => {} },
    { label: 'Open installer', primary: true, run: () => window.ollama.openUpdateInstaller(update.path) },
  ]);
});

// greeting by time of day
(function () {
  const h = new Date().getHours();
  $('greet').textContent = (h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.');
})();

// cursor-proximity particle grid — subtle dots that brighten near the cursor.
// ponytail: one canvas, rAF-throttled; static base grid under reduced-motion;
// color follows the accent CSS var so theme/accent changes recolor it.
let gridRGB = [42, 75, 214];
function refreshGridColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
  const m = v.match(/#?([0-9a-f]{6})/i);
  if (m) gridRGB = [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}
(function () {
  const cv = $('grid'); if (!cv) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = cv.getContext('2d');
  const SP = 30, DPR = Math.min(2, window.devicePixelRatio || 1);
  let W = 0, H = 0, mx = -9999, my = -9999, raf = null;
  function resize() {
    W = cv.clientWidth = innerWidth; H = cv.clientHeight = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0); draw();
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const R = 130, R2 = R * R, r = gridRGB[0], g = gridRGB[1], b = gridRGB[2];
    for (let y = SP / 2; y < H; y += SP)
      for (let x = SP / 2; x < W; x += SP) {
        let a = 0.10, rad = 1.1;
        if (!reduce) {
          const dx = x - mx, dy = y - my, d2 = dx * dx + dy * dy;
          if (d2 < R2) { const t = 1 - d2 / R2; a = 0.10 + 0.45 * t; rad = 1.1 + 1.4 * t; }
        }
        ctx.beginPath(); ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')'; ctx.arc(x, y, rad, 0, 6.283); ctx.fill();
      }
  }
  function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = null; draw(); }); }
  addEventListener('resize', resize);
  if (!reduce) addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; schedule(); }, { passive: true });
  resize();
})();

(async function initialize() {
  try {
    Object.assign(persisted, await window.ollama.loadState());
    // One-time migration from the original renderer-only store.
    for (const key of ['osettings', 'oprojects', 'oconvs', 'omodel', 'oRuntime', 'oExoUrl', 'olanHost', 'olanHostEnabled', 'oactiveProject', 'odraft', 'oworkspace', 'ocloudModels']) {
      if (persisted[key] === undefined) {
        const oldValue = localStorage.getItem(key);
        if (oldValue === null) continue;
        try { persisted[key] = ['osettings', 'oprojects', 'oconvs', 'ocloudModels'].includes(key) ? JSON.parse(oldValue) : oldValue; }
        catch { continue; }
      }
    }
    window.ollama.saveState(persisted).catch(() => {});
  } catch {}
  loadSettings();
  loadProjects();
  defaultWorkspace = await window.ollama.ensureWorkspace();
  if (persisted.oworkspace !== defaultWorkspace) saveState('oworkspace', defaultWorkspace);
  $('workspacePath').value = defaultWorkspace;
  loadConvs();
  activeProjectId = projects.some((p) => p.id === persisted.oactiveProject) ? persisted.oactiveProject : null;
  $('lanHost').value = persisted.olanHost || '';
  $('lanServerChk').checked = persisted.olanHostEnabled === true;
  $('prompt').value = typeof persisted.odraft === 'string' ? persisted.odraft : '';
  autosize();
  applyAppearance();
  renderRecents();
  updateProjectLabel();
  refreshAppInfo().catch(() => { $('versionInfo').textContent = 'Version information unavailable.'; });
  try { renderLanDevices(await window.ollama.lanRefresh()); } catch {}
  if ($('lanServerChk').checked) window.ollama.lanServer(true);
  await loadModels();
  // Restore last active view
  const savedView = persisted.oactiveView || 'chat';
  if (savedView !== 'chat') switchView(savedView);
  setLoading('Ready', true);
})();
