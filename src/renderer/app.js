// Axon's desktop workspace: direct chat plus Axon Terminal-backed Code and Agent modes.
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
let swarmSessions = [];   // Dedicated Sentry sessions; never mixed into normal chat history.
let activeSwarmId = null;
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
let swarmMode = false, swarmLaunching = false;
function switchView(viewName) {
  if (viewName === 'settings') { openSettings(); return; }
  activeView = viewName;
  document.querySelectorAll('[data-view]').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === 'view-' + viewName);
  });
  $('chatSidebar')?.classList.add('active');
  if (viewName === 'projects') renderProjectsPage();
  if (viewName === 'models') renderModelsPage();
  saveState('oactiveView', viewName);
}
function workspaceGroup(mode = settings?.productMode) { return mode === 'agent' ? 'work' : mode === 'code' ? 'code' : 'chat'; }
function syncWorkspaceShell() {
  const workspace = workspaceGroup();
  const tabs = { chat: $('chatWorkspace'), code: $('codeWorkspace'), work: $('workWorkspace') };
  if (!tabs.chat || !tabs.code || !tabs.work) return;
  for (const [name, tab] of Object.entries(tabs)) { const active = name === workspace; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); }
  $('side')?.classList.toggle('workspace-work', workspace === 'work');
  $('workspaceNote').textContent = workspace === 'work'
    ? 'Autonomous tasks · browser and delegation'
    : workspace === 'code' ? 'Repository work · Axon Terminal tools' : 'Direct conversation · no tools';
  $('newChatLabel').textContent = workspace === 'work' ? 'New task' : workspace === 'code' ? 'New code session' : 'New chat';
  $('recents-label').textContent = workspace === 'work' ? 'Recent work' : workspace === 'code' ? 'Recent code' : 'Recent chats';
  $('main')?.setAttribute('data-workspace', workspace);
  const copy = workspace === 'work'
    ? { greet: 'What should Axon take on?', sub: 'Describe the outcome. Axon can plan, browse, and carry the task through.' }
    : workspace === 'code'
      ? { greet: 'What are we building?', sub: 'Work directly in a repository with Axon Terminal at your side.' }
      : { greet: 'Good afternoon.', sub: 'What are we working on?' };
  if ($('greet')) $('greet').textContent = copy.greet;
  document.querySelector('#home .sub')?.replaceChildren(copy.sub);
  const hint = document.querySelector('.home-hint');
  if (hint) hint.textContent = workspace === 'work'
    ? 'Work plans multi-step tasks, opens the browser when it is useful, and can delegate focused sub-tasks.'
    : workspace === 'code'
      ? 'Code works in the selected repository through Axon Terminal. Browser research stays focused on the task.'
      : 'Chat is a direct conversation. It does not reach into a workspace, browser, or automated task.';
  const chips = [...document.querySelectorAll('#chips .chip')];
  const labels = workspace === 'work' ? ['Research a topic', 'Plan a task', 'Compare options', 'Run a workflow']
    : workspace === 'code' ? ['Explain code', 'Debug an error', 'Review changes', 'Write tests']
      : ['Ask anything', 'Brainstorm', 'Write something', 'Learn a topic'];
  chips.forEach((chip, index) => { chip.textContent = labels[index] || chip.textContent; });
}
function setWorkspace(group) {
  swarmMode = false; $('main')?.removeAttribute('data-swarm'); $('swarmControls').hidden = true; $('swarmLimitInfo').hidden = true; $('swarmStatus').hidden = true; $('swarmLaunch')?.classList.remove('active');
  settings.productMode = group === 'work' ? 'agent' : group === 'code' ? 'code' : 'chat';
  syncProductMode();
  const remembered = settings.activeConversationIds?.[group];
  activeId = conversations.some((chat) => chat.id === remembered && workspaceGroup(chat.productMode || 'chat') === group) ? remembered : null;
  saveSettings(); renderRecents();
  if (activeView !== 'chat') switchView('chat');
  if (activeId) openConv(activeId); else newChat();
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
const DEFAULT_PROVIDER = { id: 'ollama-local', name: 'Ollama on this device', kind: 'ollama', endpoint: '', model: '', credentialId: '' };
const DEFAULT_SETTINGS = { systemPrompt: '', accent: '#f45f96', colors: { ...THEME_PALETTES.midnight }, theme: 'midnight', density: 'normal', motion: 'standard', font: 'system', productMode: 'chat', permissionMode: 'auto', providerProfiles: [DEFAULT_PROVIDER], activeProviderProfileId: 'ollama-local', activeConversationIds: {} };
let settings = { ...DEFAULT_SETTINGS };
const persisted = {};
let localProfile = null;
function normalizeLocalProfile(value) {
  const name = typeof value?.name === 'string' ? value.name.trim().replace(/\s+/g, ' ').slice(0, 48) : '';
  return name ? { name } : null;
}
function renderLocalProfile() {
  const name = localProfile?.name || 'Set up local profile';
  $('localProfileName').textContent = name;
  $('localProfileInitial').textContent = localProfile ? name.slice(0, 1).toUpperCase() : '?';
  $('localProfileNote').textContent = localProfile ? 'Local only · click to edit' : 'Stored only on this device';
  $('localProfile').setAttribute('aria-label', localProfile ? 'Edit local profile' : 'Set up local profile');
}
function openLocalProfile() {
  $('localProfileInput').value = localProfile?.name || '';
  $('localProfileModal').classList.add('show');
  setTimeout(() => $('localProfileInput').focus(), 0);
}
function closeLocalProfile() { $('localProfileModal').classList.remove('show'); }
function saveLocalProfile() {
  const name = String($('localProfileInput').value || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  if (!name) { $('localProfileInput').focus(); return; }
  localProfile = { name }; saveState('ouserProfile', localProfile); renderLocalProfile(); closeLocalProfile();
}
function swarmProviderLimit() { return (currentProviderProfile()?.kind || 'ollama') === 'ollama' ? 3 : null; }
function swarmSelectableModels() {
  const provider = currentProviderProfile();
  const configured = String(provider?.model || '').trim();
  // API profiles expose the configured model as their route. Keeping one choice
  // here prevents a Sentry/worker pairing the backend cannot actually serve.
  if (provider && provider.kind !== 'ollama' && configured) return [configured];
  return [...new Set([configured, $('model')?.value, ...[...($('model')?.options || [])].map((option) => option.value)].filter(Boolean))];
}
function fillSwarmModelSelect(select, models, preferred) {
  if (!select) return;
  const current = models.includes(preferred) ? preferred : models[0] || '';
  select.replaceChildren(...models.map((model) => { const option = document.createElement('option'); option.value = model; option.textContent = model; return option; }));
  select.value = current;
  select.disabled = models.length <= 1;
}
function syncSwarmRoles() {
  const models = swarmSelectableModels();
  const sentry = $('swarmSentryModel'); const workers = $('swarmWorkerModel');
  const oldSentry = sentry?.value || $('model')?.value;
  const oldWorkers = workers?.value || $('model')?.value;
  fillSwarmModelSelect(sentry, models, oldSentry);
  fillSwarmModelSelect(workers, models, oldWorkers);
  const notice = $('swarmRoleNotice');
  if (models.length <= 1) notice.textContent = `${models[0] || 'The selected'} model is the only model exposed by this provider, so the Sentry and every worker reuse it.`;
  else notice.textContent = 'Pick the Sentry that should arbitrate the result; workers share one model so their parallel findings stay comparable.';
  syncSwarmLimit();
}
function syncSwarmLimit() {
  const limit = swarmProviderLimit(); const input = $('swarmCount');
  if (limit) { input.max = String(limit); if (Number(input.value) > limit) input.value = String(limit); $('swarmLimitInfo').textContent = 'Ollama routes allow up to 3 concurrent workers.'; }
  else { input.removeAttribute('max'); $('swarmLimitInfo').textContent = 'This provider has no Axon concurrency cap; its API limits still apply.'; }
}
function openSwarm(create = false) {
  if (!create && swarmSessions.length) { activeSwarmId ||= swarmSessionOrder()[0]?.id || null; showSentryConsole(); return; }
  swarmMode = true; activeId = null; $('main').setAttribute('data-swarm', 'true'); $('swarmControls').hidden = false; $('swarmLimitInfo').hidden = false; $('swarmStatus').hidden = false; $('swarmStatus').textContent = ''; $('swarmLaunch').classList.add('active');
  showHomeView(); $('greet').textContent = 'What should the swarm take on?'; document.querySelector('#home .sub')?.replaceChildren('Give Axon one outcome. Independent workers will investigate it in parallel.'); document.querySelector('.home-hint')?.replaceChildren('Choose a model and attach the relevant files, then launch the swarm with the normal composer. Workers are read-only so they cannot collide in your workspace.');
  const chips = [...document.querySelectorAll('#chips .chip')]; ['Explore approaches', 'Review a codebase', 'Research a topic', 'Compare options'].forEach((label, index) => { if (chips[index]) chips[index].textContent = label; });
  syncSwarmRoles(); $('prompt').focus();
}
async function launchSwarm(entry) {
  swarmLaunching = true; syncComposerState(); $('swarmStatus').textContent = 'Launching workers…';
  try {
    const provider = currentProviderProfile();
    const selectable = swarmSelectableModels();
    const sentryModel = $('swarmSentryModel').value || entry.model;
    const workerModel = selectable.length <= 1 ? sentryModel : ($('swarmWorkerModel').value || entry.model);
    const result = await window.ollama.swarmStart({ sentryModel, workerModel, prompt: entry.combined, images: entry.images, workers: Number($('swarmCount').value), systemPrompt: projectSystemPrompt(), cwd: projectCwd(), provider, mode: settings.permissionMode });
    if (!result?.ok) throw new Error(result?.error || 'Could not launch the swarm.');
    $('swarmStatus').textContent = result.capped ? `Ollama limited this swarm to ${result.count} workers.` : `${result.count} worker${result.count === 1 ? '' : 's'} launched.`;
    activeSwarmId = result.swarmId;
    const existing = swarmSessions.find((session) => session.id === result.swarmId);
    const session = normalizeSwarmSession({ id: result.swarmId, title: entry.combined.replace(/\s+/g, ' ').slice(0, 120), sentryModel, workerModel, providerName: provider?.name || 'Current provider', mode: settings.permissionMode, status: 'launching', ts: Date.now(), updatedAt: Date.now(), agents: existing?.agents || [] });
    if (existing) Object.assign(existing, session); else swarmSessions.unshift(session);
    saveSwarmSessions(); showSentryConsole();
  } catch (error) { $('swarmStatus').textContent = error.message || 'Could not launch the swarm.'; }
  finally { swarmLaunching = false; syncComposerState(); }
}
function loadSettings() {
  try {
    const saved = persisted.osettings || {};
    settings = { ...DEFAULT_SETTINGS, ...saved, colors: { ...THEME_PALETTES[saved.theme] || THEME_PALETTES.midnight, ...(saved.colors || {}) } };
    // The old stock blue was Axon's default, not a deliberate brand choice.
    if (!saved.colors && (!saved.accent || saved.accent.toLowerCase() === '#2a4bd6')) settings.colors.accent = DEFAULT_SETTINGS.accent;
    else if (!saved.colors && saved.accent) settings.colors.accent = saved.accent;
    settings.accent = settings.colors.accent;
    settings.providerProfiles = Array.isArray(saved.providerProfiles) && saved.providerProfiles.length ? saved.providerProfiles.map((profile) => ({ ...DEFAULT_PROVIDER, ...profile, credentialId: profile.credentialId || '' })) : [{ ...DEFAULT_PROVIDER }];
    settings.activeConversationIds = saved.activeConversationIds && typeof saved.activeConversationIds === 'object' ? saved.activeConversationIds : {};
    if (!settings.providerProfiles.some((profile) => profile.id === settings.activeProviderProfileId)) settings.activeProviderProfileId = settings.providerProfiles[0].id;
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
  r.style.setProperty('--color-neutral', `color-mix(in srgb, ${colors.text} 70%, ${colors.background})`);
  r.style.setProperty('--font-body', FONT_STACKS[settings.font] || FONT_STACKS.system);
  r.dataset.theme = settings.theme;
  r.classList.remove('density-compact', 'density-comfortable', 'motion-calm');
  if (settings.density === 'compact') r.classList.add('density-compact');
  else if (settings.density === 'comfortable') r.classList.add('density-comfortable');
  if (settings.motion === 'calm') r.classList.add('motion-calm');
  refreshGridColor();
}
function normalHex(value) { const hex = String(value || '').trim().replace(/^#/, ''); return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : null; }
function rgbFromHex(hex) { const value = normalHex(hex); return value ? [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16) / 255) : [0, 0, 0]; }
function luminance(hex) { return rgbFromHex(hex).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0); }
function contrastRatio(one, two) { const a = luminance(one); const b = luminance(two); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
function updateAccentContrast() { const chip = $('accentContrast'); if (!chip) return; const ratio = contrastRatio(settings.colors.accent, settings.colors.background); chip.textContent = ratio.toFixed(1) + ':1 against background'; chip.classList.toggle('warning', ratio < 3); }
function setThemeColor(colorKey, value) { const hex = normalHex(value); if (!hex) return false; settings.colors[colorKey] = hex; if (colorKey === 'accent') settings.accent = hex; saveSettings(); applyAppearance(); syncPaletteInputs(); return true; }
function syncPaletteInputs() {
  const colors = settings.colors;
  const fields = [['accent', 'accentColor', 'accentHex'], ['background', 'backgroundColor', 'backgroundHex'], ['surface', 'surfaceColor', 'surfaceHex'], ['text', 'textColor', 'textHex']];
  for (const [key, colorInput, hexInput] of fields) { if ($(colorInput)) $(colorInput).value = colors[key]; if ($(hexInput)) $(hexInput).value = colors[key].replace('#', '').toUpperCase(); }
  updateAccentContrast();
}
function openSettings() {
  $('sysPrompt').value = settings.systemPrompt;
  $('themeSel').value = settings.theme;
  $('densitySel').value = settings.density;
  $('motionSel').value = settings.motion;
  $('fontSel').value = settings.font;
  $('productModeSel').value = settings.productMode;
  $('runtimeSel').value = ['exo', 'llamacpp'].includes(persisted.oRuntime) ? persisted.oRuntime : 'ollama';
  $('exoUrl').value = persisted.oExoUrl || 'http://127.0.0.1:52415';
  syncRuntimeFields();
  renderProviderProfiles();
  if ($('runtimeSel').value === 'llamacpp') refreshLlamaCppStatus();
  syncProductMode();
  syncModes();
  syncPaletteInputs(); renderProjects(); renderCloudCatalogueInfo();
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
    box.innerHTML = '<div class="empty-state">No projects yet. Create one to organize chats by folder and keep its instructions close.</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'ops-grid project-grid';
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'ops-card project-card';
    const count = conversations.filter((c) => c.projectId === p.id).length;
    card.innerHTML = '<h3 class="ops-card-title">' + esc(p.name) + '</h3>'
      + '<div class="ops-card-path" title="' + esc(p.path) + '">' + esc(p.path) + '</div>'
      + (p.instructions ? '<div class="ops-card-note">' + esc(p.instructions.slice(0, 120)) + '</div>' : '')
      + '<div class="ops-card-footer">'
      + '<span>' + count + ' chat' + (count === 1 ? '' : 's') + '</span>'
      + '<button class="pdel ops-danger">Delete</button>'
      + '</div>';
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
  box.innerHTML = '<div class="empty-state">Loading local model inventory…</div>';
  let models = modelCatalogue;
  if (!models.length) {
    try { await loadModels(); } catch {}
    models = modelCatalogue;
  }
  box.innerHTML = '';
  // Installed models
  const installed = document.createElement('section'); installed.className = 'ops-section';
  installed.innerHTML = '<div class="ops-section-head"><h3>Installed models</h3><p>Available to the active runtime.</p></div>';
  if (!models.length) {
    installed.innerHTML += '<div class="empty-state">No models installed. Pull one with <code>ollama pull &lt;name&gt;</code> or check the recommendations below.</div>';
  } else {
    const list = document.createElement('div'); list.className = 'ops-list';
    for (const m of models) {
      const row = document.createElement('div'); row.className = 'model-row';
      const family = familyOf(m.name);
      const isVision = modelSupportsVision(m.name);
      const size = m.size ? prettyBytes(m.size) : '';
      const params = m.details?.parameter_size || '';
      row.innerHTML = '<div class="model-name">' + esc(m.name) + '</div>'
        + '<div class="model-meta">' + esc([params, size].filter(Boolean).join(' · ')) + '</div>'
        + (isVision ? '<span class="ops-tag vision">Vision</span>' : '<span></span>')
        + '<span class="ops-tag">' + esc(family.name) + '</span>';
      list.appendChild(row);
    }
    installed.appendChild(list);
  }
  box.appendChild(installed);
  // Recommended models
  const rec = document.createElement('section'); rec.className = 'ops-section';
  rec.innerHTML = '<div class="ops-section-head"><div><h3>Recommended for Axon</h3><p>Local picks calibrated for Chat, Code, and Work.</p></div></div>';
  const recList = document.createElement('div'); recList.className = 'ops-grid project-grid';
  for (const m of RECOMMENDED_MODELS) {
    const isInstalled = models.some((x) => x.name === m.name || x.name.startsWith(m.name + ':'));
    const card = document.createElement('div'); card.className = 'ops-card';
    card.innerHTML = '<h3 class="ops-card-title">' + esc(m.name) + '</h3>'
      + '<div class="ops-card-note">' + esc(m.tag) + '</div>'
      + '<div class="ops-card-footer"><span class="ops-tag ' + (isInstalled ? 'installed' : '') + '">' + (isInstalled ? 'Installed' : 'Available') + '</span></div>';
    recList.appendChild(card);
  }
  rec.appendChild(recList);
  box.appendChild(rec);
  // Vision models section
  const vis = document.createElement('section'); vis.className = 'ops-section';
  vis.innerHTML = '<div class="ops-section-head"><div><h3>Vision checked</h3><p>Only verified vision-capable models receive screenshots.</p></div></div>';
  const visionModels = models.filter((m) => modelSupportsVision(m.name));
  if (visionModels.length) {
    const vList = document.createElement('div'); vList.className = 'ops-list';
    for (const m of visionModels) {
      const tag = document.createElement('span'); tag.className = 'ops-tag vision';
      tag.textContent = m.name;
      vList.appendChild(tag);
    }
    vis.appendChild(vList);
  } else {
    vis.innerHTML += '<div class="empty-state">No verified vision models found. Pull one with <code>ollama pull llava</code> or similar.</div>';
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
  const dot = $('dot');
  const statusText = $('statustext');
  if (dot) dot.className = 'dot' + (ok ? ' on' : text ? ' bad' : '');
  if (statusText) statusText.textContent = text;
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
    const localModels = data.models || [];
    localModelCatalogue = localModels.map((model) => ({ ...model, source: 'local' }));
    applyProviderModelChoices();
    setStatus(true, localModels.length ? 'ready' : 'no models');
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
let localModelCatalogue = [];
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
  refreshModelCapabilityBadge();
}
async function refreshModelCapabilityBadge() {
  const badge = $('modelCapabilityBadge'); const model = $('model').value;
  if (!badge || !model) { if (badge) badge.hidden = true; return; }
  try {
    const report = await window.ollama.modelCapabilities(model, settings.productMode, currentProviderProfile());
    if ($('model').value !== model) return;
    badge.hidden = false;
    badge.textContent = report.vision ? 'Vision checked' : 'Text-only';
    badge.className = 'model-capability ' + (report.vision ? 'vision' : 'text-only');
    $('modelBtn').title = model + ' · ' + (report.vision ? 'vision checked' : 'text-only; screenshots disabled');
  } catch { badge.hidden = true; }
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
function normalizeSwarmSession(value) {
  if (!value || typeof value !== 'object' || !value.id) return null;
  const agents = Array.isArray(value.agents) ? value.agents.filter((agent) => agent && agent.id).slice(-16).map((agent) => ({
    id: String(agent.id), task: String(agent.task || 'Agent task').slice(0, 240), model: String(agent.model || '').slice(0, 160), status: String(agent.status || 'working').slice(0, 40), result: String(agent.result || '').slice(0, 24000), startedAt: Number(agent.startedAt) || 0, finishedAt: Number(agent.finishedAt) || 0,
  })) : [];
  return { id: String(value.id), title: String(value.title || 'Untitled swarm').slice(0, 120), sentryModel: String(value.sentryModel || '').slice(0, 160), workerModel: String(value.workerModel || '').slice(0, 160), providerName: String(value.providerName || '').slice(0, 80), mode: String(value.mode || 'auto'), status: String(value.status || 'working'), ts: Number(value.ts) || Date.now(), updatedAt: Number(value.updatedAt) || Number(value.ts) || Date.now(), agents };
}
function loadSwarmSessions() {
  try { swarmSessions = (Array.isArray(persisted.oswarmSessions) ? persisted.oswarmSessions : []).map(normalizeSwarmSession).filter(Boolean); }
  catch { swarmSessions = []; }
}
function saveSwarmSessions() { saveState('oswarmSessions', swarmSessions.slice(0, 40).map((session) => ({ ...session, agents: session.agents.slice(-16) }))); }
function swarmSessionOrder() { return [...swarmSessions].sort((a, b) => Number(b.updatedAt || b.ts) - Number(a.updatedAt || a.ts)); }
function activeSwarmSession() { return swarmSessions.find((session) => session.id === activeSwarmId) || null; }
function renderSentryConsole() {
  const sessions = swarmSessionOrder(); const rail = $('sentrySessions'); if (!rail) return;
  $('sentrySessionCount').textContent = String(sessions.length);
  rail.innerHTML = '';
  if (!sessions.length) rail.innerHTML = '<div class="sentry-empty">No Swarm sessions yet.</div>';
  for (const session of sessions) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sentry-session' + (session.id === activeSwarmId ? ' active' : '');
    button.innerHTML = '<strong>' + esc(session.title) + '</strong><small>' + esc(session.sentryModel || 'Sentry') + ' · ' + esc(session.status || 'working') + '</small>';
    button.onclick = () => { activeSwarmId = session.id; showSentryConsole(); }; rail.appendChild(button);
  }
  const session = activeSwarmSession(); const lead = $('sentryLead'); const grid = $('sentryAgentGrid');
  if (!session) { lead.innerHTML = '<span class="sentry-kicker">Sentry</span><h3>Awaiting a session</h3><p>The Sentry will consolidate each worker\'s findings here.</p>'; grid.innerHTML = '<div class="sentry-empty">Launch a Swarm to begin a dedicated Sentry session.</div>'; $('sentryAgentSummary').textContent = 'No active agents'; return; }
  const agents = session.agents || []; const sentry = agents.find((agent) => /^Sentry\b/.test(agent.task)); const workers = agents.filter((agent) => agent.id !== session.id && agent !== sentry);
  lead.innerHTML = '<span class="sentry-kicker">Sentry · ' + esc(sentry?.status || session.status || 'waiting') + '</span><h3>' + esc(sentry?.task || session.sentryModel || 'Sentry preparing the brief') + '</h3><p>' + esc(sentry?.result || 'Workers are investigating. Their reports will arrive here for synthesis.') + '</p>';
  const running = workers.filter((agent) => !['completed', 'failed'].includes(agent.status)).length;
  $('sentryAgentSummary').textContent = workers.length ? `${running ? running + ' active · ' : ''}${workers.length} worker${workers.length === 1 ? '' : 's'}` : 'Waiting for workers';
  grid.innerHTML = '';
  if (!workers.length) { grid.innerHTML = '<div class="sentry-empty">Worker lanes will appear as soon as the swarm starts.</div>'; return; }
  for (const agent of workers) {
    const card = document.createElement('article'); card.className = 'sentry-agent'; card.dataset.status = agent.status || 'working';
    card.innerHTML = '<div class="sentry-agent-head"><strong>' + esc(agent.task) + '</strong><span class="sentry-agent-status">' + esc(agent.status || 'working') + '</span></div><div class="sentry-agent-meta">' + esc(agent.model || session.workerModel || 'selected model') + '</div><div class="sentry-agent-result">' + esc(agent.result || 'Investigating the workspace…') + '</div>';
    grid.appendChild(card);
  }
}
function showSentryConsole() {
  $('home').style.display = 'none'; $('chat').classList.remove('show'); $('sentryConsole').hidden = false; renderSentryConsole();
}
function upsertSwarmAgent(agent) {
  if (!agent?.swarmId) return;
  let session = swarmSessions.find((item) => item.id === agent.swarmId);
  if (!session) { session = normalizeSwarmSession({ id: agent.swarmId, title: 'Recovered swarm session', ts: Date.now(), agents: [] }); swarmSessions.unshift(session); }
  const index = session.agents.findIndex((item) => item.id === agent.id);
  const next = { ...(index >= 0 ? session.agents[index] : {}), ...agent, id: String(agent.id || agent.swarmId), task: String(agent.task || '').slice(0, 240), model: String(agent.model || '').slice(0, 160), status: String(agent.status || 'working'), result: String(agent.result || '').slice(0, 24000) };
  if (index >= 0) session.agents[index] = next; else session.agents.push(next);
  if (agent.id === agent.swarmId) session.status = next.status;
  session.updatedAt = Date.now(); saveSwarmSessions(); if (activeSwarmId === session.id) renderSentryConsole();
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
  const workspace = workspaceGroup();
  const scoped = conversations.filter((chat) => workspaceGroup(chat.productMode || 'chat') === workspace);
  const workspaceLabel = workspace === 'work' ? 'Recent work' : workspace === 'code' ? 'Recent code' : 'Recent chats';
  box.innerHTML = '<div class="recent-popover-head"><span>' + workspaceLabel + '</span><span>' + scoped.length + '</span></div>';
  const recent = conversationOrder(scoped).slice(0, 18);
  if (!recent.length) { box.innerHTML += '<div class="sidebar-empty">' + (workspace === 'work' ? 'No work sessions yet.' : workspace === 'code' ? 'No code sessions yet.' : 'No chats yet.') + '</div>'; return; }
  for (const chat of recent) {
    const row = document.createElement('div'); row.className = 'recent-popover-item' + (chat.id === activeId ? ' active' : '');
    row.tabIndex = 0; row.setAttribute('role', 'button');
    row.innerHTML = '<span class="recent-popover-title">' + esc(chat.title || '(empty)') + '</span><span class="recent-popover-meta">'
      + esc(chat.projectId ? (projects.find((p) => p.id === chat.projectId)?.name || 'Project') : 'All chats') + ' · ' + esc(chat.model || chat.productMode || 'Axon') + '</span>';
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
  const workspace = workspaceGroup();
  const workspaceConversations = conversations.filter((chat) => workspaceGroup(chat.productMode || 'chat') === workspace);
  const visible = (lanServerOn || lanClientConnected || !activeProjectId) ? workspaceConversations : workspaceConversations.filter((c) => c.projectId === activeProjectId);
  if (!visible.length) {
    const e = document.createElement('div'); e.style.cssText = 'font-size:12px;opacity:.4;padding:7px 8px';
    e.textContent = activeProjectId ? (workspace === 'work' ? 'No work sessions in this workspace yet.' : workspace === 'code' ? 'No code sessions in this project yet.' : 'No chats in this project yet.') : (workspace === 'work' ? 'No work sessions yet.' : workspace === 'code' ? 'No code sessions yet.' : 'No chats yet.'); box.appendChild(e);
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
  settings.activeConversationIds[workspaceGroup(conv.productMode || 'chat')] = id; saveSettings();
  const convMode = ['chat', 'code', 'agent'].includes(conv.productMode) ? conv.productMode : 'chat';
  if (settings.productMode !== convMode) { settings.productMode = convMode; syncProductMode(); saveSettings(); }
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
  $('sentryConsole').hidden = true;
  $('home').querySelector('.wrap').insertBefore($('composerCard'), $('chips'));
  $('prompt').focus();
}
function showChatView() {
  $('home').style.display = 'none';
  $('chat').classList.add('show');
  $('sentryConsole').hidden = true;
  $('composerSlot').appendChild($('composerCard'));
}
function newChat() { activeId = null; settings.activeConversationIds[workspaceGroup()] = null; saveSettings(); $('log').innerHTML = ''; showHomeView(); renderRecents(); syncComposerState(); switchView('chat'); }

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
// Axon Terminal tools may use snake_case or camelCase arguments, so accept both.
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
  const browser = window.ollama.browserInvocation(s.fn, s.args);
  if (!turn.replaying && browser?.type === 'navigate') openBrowserAt(browser.url);
}
function currentProviderProfile() {
  return settings.providerProfiles.find((profile) => profile.id === settings.activeProviderProfileId) || settings.providerProfiles[0];
}
function providerModelChoices() {
  const profile = currentProviderProfile();
  if (profile?.kind === 'ollama') return localModelCatalogue;
  const name = String(profile?.model || '').trim();
  return name ? [{ name, source: 'api', details: { parameter_size: profile.kind === 'responses' ? 'Responses API' : 'API route' } }] : [];
}
function applyProviderModelChoices() {
  const profile = currentProviderProfile(); const sel = $('model'); if (!sel) return;
  const models = providerModelChoices(); const prior = sel.value;
  modelCatalogue = models;
  sel.replaceChildren(...models.map((model) => { const option = document.createElement('option'); option.value = model.name; option.textContent = model.name + (model.source === 'api' ? ' · API' : (model.details?.parameter_size ? ' · ' + model.details.parameter_size : '')); return option; }));
  const preferred = profile?.kind === 'ollama' ? persisted.omodel : profile?.model;
  if (models.some((model) => model.name === preferred)) sel.value = preferred;
  else if (models.some((model) => model.name === prior)) sel.value = prior;
  syncModelButton();
  if ($('modelPicker').classList.contains('show')) renderPicker();
  const sidebar = $('modelsSidebarList'); if (!sidebar) return;
  sidebar.innerHTML = '';
  if (!models.length) { sidebar.textContent = profile?.kind === 'ollama' ? 'No local models installed' : 'Set this profile\'s default model in Settings'; return; }
  for (const model of models.slice(0, 10)) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'sidebar-model-choice'; item.textContent = model.name;
    item.onclick = () => { sel.value = model.name; if (profile?.kind === 'ollama') saveState('omodel', model.name); syncModelButton(); if (swarmMode) syncSwarmRoles(); };
    sidebar.appendChild(item);
  }
}
function renderProviderProfiles() {
  const select = $('providerProfileSel'); select.innerHTML = '';
  for (const profile of settings.providerProfiles) {
    const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name || 'Unnamed provider'; select.appendChild(option);
  }
  const profile = currentProviderProfile();
  select.value = profile.id; $('providerName').value = profile.name; $('providerKind').value = profile.kind; $('providerEndpoint').value = profile.endpoint; $('providerModel').value = profile.model;
  $('providerApiKey').value = '';
  $('providerStatus').textContent = profile.kind === 'ollama'
    ? 'Ollama uses the current local runtime. Cloud models also work in Code and Work after you sign in with Ollama; no Axon API key is needed.'
    : (profile.credentialId ? 'API key saved in the OS credential store.' : 'Add an API key to use this profile. It will not be written to normal settings.');
}
const PROVIDER_PRESETS = {
  custom: { name: 'Custom API', kind: 'openai-compatible', endpoint: '', model: '' },
  openai: { name: 'OpenAI', kind: 'responses', endpoint: 'https://api.openai.com/v1', model: '' },
  openrouter: { name: 'OpenRouter', kind: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1', model: '' },
};
function fillProviderFields(profile) {
  $('providerName').value = profile.name || '';
  $('providerKind').value = profile.kind || 'openai-compatible';
  $('providerEndpoint').value = profile.endpoint || '';
  $('providerModel').value = profile.model || '';
}
function applyProviderPreset() {
  const preset = PROVIDER_PRESETS[$('providerPreset').value] || PROVIDER_PRESETS.custom;
  fillProviderFields(preset);
  $('providerImportStatus').textContent = 'Preset applied. Add a model ID and API key, then save the profile.';
}
function openCodeProviderEntry(config) {
  const candidates = config?.provider || config?.providers || config;
  if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) throw new Error('No provider entry found. Paste the provider object or a full OpenCode config.');
  const entry = Object.entries(candidates).find(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && (value.options || value.settings || value.models || value.npm || value.package));
  if (!entry) throw new Error('No OpenCode provider with connection settings was found.');
  return entry;
}
function importOpenCodeProviderConfig() {
  try {
    const raw = $('providerImport').value.trim();
    if (!raw) throw new Error('Paste a provider entry or config first.');
    const [id, source] = openCodeProviderEntry(JSON.parse(raw));
    const packageName = String(source.npm || source.package || '');
    const modelNames = source.models && typeof source.models === 'object' ? Object.keys(source.models) : [];
    const endpoint = String(source.options?.baseURL || source.settings?.baseURL || source.baseURL || '').replace(/\/$/, '');
    fillProviderFields({
      name: source.name || id,
      kind: packageName === '@ai-sdk/openai' ? 'responses' : 'openai-compatible',
      endpoint,
      model: modelNames[0] || '',
    });
    $('providerImportStatus').textContent = `Imported ${source.name || id}. Add its API key in Axon, then save the profile.`;
  } catch (error) { $('providerImportStatus').textContent = error.message || 'Could not import that OpenCode config.'; }
}
async function saveProviderProfile() {
  const existing = currentProviderProfile();
  const profile = {
    id: existing?.id || rid(),
    name: $('providerName').value.trim() || 'Unnamed provider',
    kind: $('providerKind').value,
    endpoint: $('providerEndpoint').value.trim().replace(/\/$/, ''),
    model: $('providerModel').value.trim(),
    credentialId: existing?.credentialId || '',
  };
  if (profile.kind !== 'ollama' && !/^https?:\/\//i.test(profile.endpoint)) { $('providerStatus').textContent = 'Enter a full http:// or https:// API endpoint.'; return; }
  try {
    const saved = await window.ollama.providerSave(profile, $('providerApiKey').value);
    const index = settings.providerProfiles.findIndex((item) => item.id === saved.id);
    if (index >= 0) settings.providerProfiles[index] = saved; else settings.providerProfiles.push(saved);
    settings.activeProviderProfileId = saved.id; saveSettings(); renderProviderProfiles(); applyProviderModelChoices(); if (swarmMode) syncSwarmRoles();
  } catch (error) { $('providerStatus').textContent = 'Could not save provider: ' + error.message; }
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
  const lines = [
    'Axon commands',
    '  /new · /clear  — start a fresh chat',
    '  /model <name>  — switch model (prefix match)',
    '  /help          — this list',
    '  /compact       — start a fresh context (use /clear)',
    '',
    'Modes:',
    '  Chat  — direct model conversation',
    '  Code  — workspace work through Axon Terminal',
    '  Agent — can delegate scoped work through Axon Terminal',
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
  const b = !!running || swarmLaunching;
  $('send').textContent = running ? '■' : swarmLaunching ? '…' : '→';
  $('send').className = running ? 'stop' : '';
  $('send').title = running ? 'Stop this chat' : swarmLaunching ? 'Launching swarm' : swarmMode ? 'Launch swarm' : 'Send';
  $('send').disabled = swarmLaunching;
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
  const provider = currentProviderProfile();
  const entry = { text, combined: inlineAttachments(text), images, productMode: settings.productMode, providerProfileId: provider?.id, model: provider?.model || $('model').value };
  clearInput(); clearAttachments(); return entry;
}

async function send() {
  const running = currentTurn();
  const text = $('prompt').value.trim();
  if (running) { const entry = takeComposerEntry(); if (entry) queueMessage(activeId, entry); return; }
  if (!text && !attachments.length) return;
  if (swarmMode) { const entry = takeComposerEntry(); if (entry) await launchSwarm(entry); return; }

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
  // Modes have intentionally different runtimes and system boundaries. Never
  // silently run a Code/Agent request through a prior Chat conversation (or
  // vice versa); mode changes begin a fresh conversation automatically.
  let conv = activeId ? conversations.find((c) => c.id === activeId) : null;
  if (conv && (conv.productMode || 'chat') !== entry.productMode) conv = null;
  if (!conv) {
    conv = { id: rid(), sessionId: null, title: text.replace(/\s+/g, ' ').slice(0, 48) || '(attachment)', model, productMode: entry.productMode, providerProfileId: entry.providerProfileId, ts: Date.now(), updatedAt: Date.now(), projectId: activeProjectId, turns: [] };
    conversations.unshift(conv); activeId = conv.id; settings.activeConversationIds[workspaceGroup(conv.productMode)] = conv.id; saveSettings(); renderRecents();
  }
  conv.updatedAt = Date.now(); saveConvs();
  const systemPrompt = projectSystemPrompt();
  const fingerprint = instructionFingerprint(conv.productMode || entry.productMode, systemPrompt);
  // Terminal sessions preserve their initial instruction context, so a changed
  // Axon/project instruction set must start a clean session to apply.
  if (conv.instructionFingerprint !== fingerprint) { conv.sessionId = null; conv.instructionFingerprint = fingerprint; saveConvs(); }
  showChatView();
  addUserTurn(text, images);
  const requestId = rid() + rid();
  const turn = newAiTurn(model || 'Axon');
  turn.conversationId = conv.id;
  activeTurns.set(requestId, turn);
  renderRecents(); syncComposerState();
  const provider = settings.providerProfiles.find((profile) => profile.id === (conv.providerProfileId || entry.providerProfileId)) || currentProviderProfile();
  const history = (conv.turns || []).filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string').slice(-40).map((turn) => ({ role: turn.role, content: turn.content }));
  const result = await window.ollama.chat(conv.model, combined, conv.sessionId, { systemPrompt, cwd: projectCwd(), images, requestId, productMode: conv.productMode || entry.productMode, provider, mode: settings.permissionMode, grants: conv.grants || [], history });
  if (!result?.ok) {
    const failed = activeTurns.get(requestId);
    if (failed) { failed.turnEl.classList.add('error'); failed.streamEl.innerHTML = '<div class="block text">[error] ' + esc(result?.error || 'Could not start this chat.') + '</div>'; activeTurns.delete(requestId); renderRecents(); syncComposerState(); }
  }
}

// ---- slash-command autocomplete -------------------------------------------
const CORE_COMMANDS = [
  { name: 'new', description: 'Start a fresh chat', tag: 'Axon' },
  { name: 'clear', description: 'Start a fresh chat', tag: 'Axon' },
  { name: 'model', description: 'Switch the active model', tag: 'Axon' },
  { name: 'help', description: 'Show commands and shortcuts', tag: 'Axon' },
  { name: 'compact', description: 'Start fresh (headless fallback)', tag: 'Axon' },
];
let allCommands = CORE_COMMANDS;
let cmdOpen = false, cmdItems = [], cmdSel = 0;
function showCoreCommands(prefix) {
  const matches = CORE_COMMANDS.filter((c) => c.name.startsWith(prefix));
  if (!matches.length) return closeCmdList();
  cmdItems = matches; cmdSel = 0;
  const box = $('cmdlist');
  box.innerHTML = '<div class="cmdhead">Axon commands</div>' + matches.map((c, i) =>
    '<div class="cmditem' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '"><span class="cmdname">/' + c.name + '</span><span class="cmddesc">' + c.description + '</span><span class="cmdtag">' + c.tag + '</span></div>'
  ).join('');
  box.classList.add('show'); cmdOpen = true;
  box.querySelectorAll('.cmditem').forEach((el) => { el.onmousedown = (ev) => { ev.preventDefault(); chooseCmd(+el.dataset.i); }; });
}

async function openCmdList() {
  const m = $('prompt').value.match(/^\/([A-Za-z0-9_:.\-]*)$/);
  if (!m) { closeCmdList(); return; }
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
$('model').onchange = () => { saveState('omodel', $('model').value); syncModelButton(); if (swarmMode) syncSwarmRoles(); };
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
let subagentsOpen = false; const subagents = new Map();
function renderSubagents() { const list = $('subagentsList'); list.innerHTML = ''; if (!subagents.size) { list.textContent = 'No delegated tasks yet.'; return; } for (const a of subagents.values()) { const card = document.createElement('div'); card.className = 'subagent-card'; card.innerHTML = '<strong>' + esc(a.task || 'Subagent task') + '</strong><div class="subagent-meta">' + esc(a.model || 'selected model') + ' · ' + esc(a.status || 'working') + '</div>' + (a.result ? '<div class="subagent-result">' + esc(a.result) + '</div>' : ''); list.appendChild(card); } }
function setSubagentsOpen(open) { subagentsOpen = open; $('subagentsPanel').classList.toggle('show', open); $('subagentsToggle').classList.toggle('active', open); $('subagentsToggle').setAttribute('aria-expanded', String(open)); if (open) renderSubagents(); }
function syncBrowserBounds() {
  if (!browserOpen) return;
  const r = $('browserSlot').getBoundingClientRect();
  window.ollama.browserShow({ x: r.x, y: r.y, width: r.width, height: r.height });
}
function setBrowserOpen(open) {
  browserOpen = open; $('browserPanel').classList.toggle('show', open); $('browserToggle').classList.toggle('active', open);
  $('browserToggle').setAttribute('aria-expanded', String(open));
  $('browserToggle').title = open ? 'Close agent browser' : 'Open agent browser';
  const label = document.querySelector('.browser-toggle-label'); if (label) label.textContent = open ? 'Browser open' : 'Browser';
  if (open) requestAnimationFrame(syncBrowserBounds); else window.ollama.browserHide();
}
function openBrowserAt(url) {
  setBrowserOpen(true); $('browserUrl').value = url; window.ollama.browserNavigate(url);
}
$('browserToggle').onclick = () => setBrowserOpen(!browserOpen);
$('subagentsToggle').onclick = () => setSubagentsOpen(!subagentsOpen); $('subagentsClose').onclick = () => setSubagentsOpen(false);
$('sentryNewSwarm').onclick = () => openSwarm(true);
$('sentryBackToChat').onclick = () => { swarmMode = false; $('main').removeAttribute('data-swarm'); $('swarmLaunch').classList.remove('active'); newChat(); };
$('windowMinimize').onclick = () => window.ollama.windowControl('minimize');
$('windowMaximize').onclick = () => window.ollama.windowControl('maximize');
$('windowClose').onclick = () => window.ollama.windowControl('close');
$('browserClose').onclick = () => setBrowserOpen(false);
$('browserBack').onclick = () => window.ollama.browserAction('back');
$('browserForward').onclick = () => window.ollama.browserAction('forward');
$('browserReload').onclick = () => window.ollama.browserAction('reload');
$('browserUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') openBrowserAt($('browserUrl').value.trim()); });
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && browserOpen) { event.preventDefault(); $('browserUrl').focus(); $('browserUrl').select(); }
  if (event.key === 'Escape' && browserOpen && document.activeElement === $('browserUrl')) { $('browserUrl').blur(); }
});
window.addEventListener('resize', () => requestAnimationFrame(syncBrowserBounds));
window.ollama.on('browser-status', (s) => { if (s.url) $('browserUrl').value = s.url; if (s.title) $('browserPageTitle').textContent = s.title; $('browserBack').disabled = !s.canBack; $('browserForward').disabled = !s.canForward; });
window.ollama.on('browser-invoked', (s) => { setBrowserOpen(true); if (s?.url) $('browserUrl').value = s.url; });
window.ollama.on('subagent-update', (agent) => {
  if (agent?.swarmId) { upsertSwarmAgent(agent); if (!activeSwarmId) activeSwarmId = agent.swarmId; if (activeSwarmId === agent.swarmId) showSentryConsole(); return; }
  const prior = subagents.get(agent.id) || {}; subagents.set(agent.id, { ...prior, ...agent }); setSubagentsOpen(true); renderSubagents();
});

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
for (const btn of document.querySelectorAll('.top-nav-btn[data-view]')) {
  btn.onclick = () => switchView(btn.dataset.view);
}
$('projectsPageAdd').onclick = () => { openSettings(); setTimeout(() => $('projName').focus(), 0); };
$('settingsClose').onclick = closeSettings;
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
$('sysPrompt').addEventListener('input', () => { settings.systemPrompt = $('sysPrompt').value; saveSettings(); });
$('themeSel').onchange = () => { settings.theme = $('themeSel').value; settings.colors = { ...THEME_PALETTES[settings.theme] }; settings.accent = settings.colors.accent; saveSettings(); applyAppearance(); syncPaletteInputs(); };
$('densitySel').onchange = () => { settings.density = $('densitySel').value; saveSettings(); applyAppearance(); };
$('motionSel').onchange = () => { settings.motion = $('motionSel').value; saveSettings(); applyAppearance(); };
$('fontSel').onchange = () => { settings.font = $('fontSel').value; saveSettings(); applyAppearance(); };
function syncProductMode() {
  const mode = ['chat', 'code', 'agent'].includes(settings.productMode) ? settings.productMode : 'chat';
  settings.productMode = mode;
  const labels = { chat: 'Chat', code: 'Code', agent: 'Work' };
  const descriptions = {
    chat: 'Chat sends a direct conversation to the selected provider. No workspace tools are exposed.',
    code: 'Code works directly in the selected repository through Axon Terminal. It can use the browser for focused research, but does not delegate.',
    agent: 'Work executes multi-step tasks toward an outcome. It can browse, use the selected workspace, and delegate concrete independent work.',
  };
  $('productModeSel').value = mode;
  const modeButton = $('productModeButton');
  if (modeButton) { modeButton.textContent = labels[mode]; modeButton.title = descriptions[mode]; }
  $('productModeInfo').textContent = descriptions[mode];
  syncWorkspaceShell();
  refreshModelCapabilityBadge();
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
$('productModeSel').onchange = () => { settings.productMode = $('productModeSel').value; syncProductMode(); saveSettings(); };
if ($('productModeButton')) $('productModeButton').onclick = () => { const modes = ['chat', 'code', 'agent']; settings.productMode = modes[(modes.indexOf(settings.productMode) + 1) % modes.length]; syncProductMode(); saveSettings(); };
$('providerProfileSel').onchange = () => { settings.activeProviderProfileId = $('providerProfileSel').value; saveSettings(); renderProviderProfiles(); applyProviderModelChoices(); if (swarmMode) syncSwarmRoles(); };
$('providerNew').onclick = () => { const profile = { ...DEFAULT_PROVIDER, id: rid(), name: 'New provider', kind: 'openai-compatible', endpoint: '', model: '', credentialId: '' }; settings.providerProfiles.push(profile); settings.activeProviderProfileId = profile.id; renderProviderProfiles(); };
$('providerApplyPreset').onclick = applyProviderPreset;
$('providerImportOpenCode').onclick = importOpenCodeProviderConfig;
$('providerSave').onclick = saveProviderProfile;
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
for (const [colorKey, colorInput, hexInput] of [['accent', 'accentColor', 'accentHex'], ['background', 'backgroundColor', 'backgroundHex'], ['surface', 'surfaceColor', 'surfaceHex'], ['text', 'textColor', 'textHex']]) {
  $(colorInput).oninput = () => setThemeColor(colorKey, $(colorInput).value);
  $(hexInput).onchange = () => { if (!setThemeColor(colorKey, $(hexInput).value)) syncPaletteInputs(); };
  $(hexInput).onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); $(hexInput).blur(); } };
}
$('paletteReset').onclick = () => { settings.colors = { ...THEME_PALETTES[settings.theme] || THEME_PALETTES.midnight }; settings.accent = settings.colors.accent; saveSettings(); applyAppearance(); syncPaletteInputs(); };
$('chatWorkspace').onclick = () => setWorkspace('chat');
$('codeWorkspace').onclick = () => setWorkspace('code');
$('workWorkspace').onclick = () => setWorkspace('work');
$('recents-label').onclick = openSettings;
$('recentPopupToggle').onclick = (event) => { event.stopPropagation(); toggleRecentPopup(); };
document.addEventListener('click', (event) => { const popup = $('recentPopup'); if (popup?.classList.contains('show') && !popup.contains(event.target) && event.target !== $('recentPopupToggle')) closeRecentPopup(); });
$('localProfile').onclick = openLocalProfile;
$('localProfileClose').onclick = closeLocalProfile;
$('localProfileModal').onclick = (event) => { if (event.target === $('localProfileModal')) closeLocalProfile(); };
$('localProfileSave').onclick = saveLocalProfile;
$('localProfileInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); saveLocalProfile(); } });
$('swarmLaunch').onclick = openSwarm;
$('swarmCount').oninput = syncSwarmLimit;
$('swarmSentryModel').onchange = () => { if (swarmSelectableModels().length <= 1) $('swarmWorkerModel').value = $('swarmSentryModel').value; };
$('swarmWorkerModel').onchange = () => { if (swarmSelectableModels().length <= 1) $('swarmSentryModel').value = $('swarmWorkerModel').value; };
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
  $('versionInfo').textContent = 'Axon v' + info.version + ' · ' + [describeDependency('Ollama', info.dependencies.ollama), describeDependency('Axon Terminal', info.dependencies.axon), describeDependency('Node', info.dependencies.node)].join(' · ');
}
let availableAppUpdate = null;
function showUpdateToast(update) {
  availableAppUpdate = update;
  $('profileUpdateBadge').hidden = false;
  $('updateToastTitle').textContent = 'Axon ' + update.version + ' is ready';
  $('updateToastBody').textContent = 'A verified update is ready to download.';
  $('updateToast').classList.add('show');
}
function showAvailableUpdate(update) {
  availableAppUpdate = update;
  $('profileUpdateBadge').hidden = false;
  $('maintenanceInfo').textContent = 'Axon v' + update.version + ' is ready to download.';
  showUpdateDialog('Axon ' + update.version + ' is ready', 'Download the verified Windows installer now? Axon checks its SHA-256 before it can open.', [
    { label: 'Later', run: () => {} },
    { label: 'Download and install', primary: true, onStart: () => { $('updateBody').textContent = 'Downloading Axon ' + update.version + '…\n\nThis can take a minute. The installer is verified before Windows is allowed to open it.'; }, run: async () => { const file = await window.ollama.downloadAppUpdate(); if (file?.error) return file; return window.ollama.openUpdateInstaller(file.path); } },
  ]);
}
async function checkAppUpdate({ manual = false } = {}) {
  const button = $('appUpdateBtn'); if (manual) { button.disabled = true; $('maintenanceInfo').textContent = 'Checking for an Axon update…'; }
  try {
    const update = await window.ollama.checkAppUpdate();
    if (update?.error) { $('maintenanceInfo').textContent = 'Update check failed: ' + update.error; return; }
    if (!update.available) { $('maintenanceInfo').textContent = 'Axon is up to date (v' + update.current + ').'; return; }
    showUpdateToast(update); if (manual) showAvailableUpdate(update);
  } catch (error) { $('maintenanceInfo').textContent = 'Update check failed: ' + (error?.message || 'Unknown error'); }
  finally { if (manual) button.disabled = false; }
}
$('appUpdateBtn').onclick = () => checkAppUpdate({ manual: true });
window.ollama.on('app-update-available', (update) => { if (update?.available) showUpdateToast(update); });
$('updateToastAction').onclick = () => { $('updateToast').classList.remove('show'); if (availableAppUpdate) showAvailableUpdate(availableAppUpdate); };
$('updateToastDismiss').onclick = () => $('updateToast').classList.remove('show');
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
  if (!badge) return;
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
    for (const key of ['osettings', 'oprojects', 'oconvs', 'oswarmSessions', 'omodel', 'oRuntime', 'oExoUrl', 'olanHost', 'olanHostEnabled', 'oactiveProject', 'odraft', 'oworkspace', 'ocloudModels', 'ouserProfile']) {
      if (persisted[key] === undefined) {
        const oldValue = localStorage.getItem(key);
        if (oldValue === null) continue;
        try { persisted[key] = ['osettings', 'oprojects', 'oconvs', 'oswarmSessions', 'ocloudModels'].includes(key) ? JSON.parse(oldValue) : oldValue; }
        catch { continue; }
      }
    }
    window.ollama.saveState(persisted).catch(() => {});
  } catch {}
  loadSettings();
  localProfile = normalizeLocalProfile(persisted.ouserProfile); renderLocalProfile();
  loadProjects();
  defaultWorkspace = await window.ollama.ensureWorkspace();
  if (persisted.oworkspace !== defaultWorkspace) saveState('oworkspace', defaultWorkspace);
  $('workspacePath').value = defaultWorkspace;
  loadConvs();
  loadSwarmSessions();
  activeProjectId = projects.some((p) => p.id === persisted.oactiveProject) ? persisted.oactiveProject : null;
  $('lanHost').value = persisted.olanHost || '';
  $('lanServerChk').checked = persisted.olanHostEnabled === true;
  $('prompt').value = typeof persisted.odraft === 'string' ? persisted.odraft : '';
  autosize();
  applyAppearance();
  renderRecents();
  updateProjectLabel();
  refreshAppInfo().catch(() => { $('versionInfo').textContent = 'Version information unavailable.'; });
  if ($('lanServerChk').checked) window.ollama.lanServer(true);
  // Restore last active view
  const savedView = persisted.oactiveView || 'chat';
  if (savedView !== 'chat') switchView(savedView);
  setLoading('Ready', true);
  if (!localProfile) setTimeout(openLocalProfile, 260);
  // Open the workspace first. LAN discovery and local model inventory can be
  // slow on first launch, so let them hydrate without blocking the UI.
  setTimeout(async () => {
    try { renderLanDevices(await window.ollama.lanRefresh()); } catch {}
    try { await loadModels(); } catch {}
  }, 0);
})();
