// NoCLI.ai's desktop workspace: direct chat plus official-CLI Code and Work modes.
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
// In-memory only (never persisted): what a swarm session needs to retry a
// single worker later -- the raw outcome prompt, cwd, provider and system
// prompt used at launch. Retry is unavailable for sessions recovered from a
// previous app run, since none of this was ever written to disk.
const swarmContext = new Map();
let sentryModalTarget = null; // { session, agent } for the currently open Sentry console modal
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
let automations = [];
let swarmMode = false, swarmLaunching = false, swarmLogOpen = false;
let settingsOpener = null;
function syncTopNav(viewName) {
  document.querySelectorAll('[data-view]').forEach((item) => {
    const active = item.dataset.view === viewName;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });
}
function switchView(viewName) {
  if (viewName === 'settings') { openSettings(); return; }
  if (!['chat', 'projects', 'models', 'automations'].includes(viewName)) viewName = 'chat';
  activeView = viewName;
  syncTopNav(viewName);
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === 'view-' + viewName);
  });
  $('chatSidebar')?.classList.add('active');
  if (viewName === 'projects') renderProjectsPage();
  if (viewName === 'models') renderModelsPage();
  if (viewName === 'automations') renderAutomations();
  const recentLabel = workspaceGroup() === 'work' ? 'Recent work' : workspaceGroup() === 'code' ? 'Recent code' : 'Recent chats';
  if ($('recentPopupToggle')) $('recentPopupToggle').textContent = recentLabel;
  saveState('oactiveView', viewName);
}

// One interface: every conversation lives in the same list regardless of the
// scope its turns ran at. Scope is a property of a turn, not a place to be.
function workspaceGroup() { return 'all'; }
function greetingForTime() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
}
function syncWorkspaceShell() {
  if ($('workspaceNote')) $('workspaceNote').textContent = 'One conversation \u00b7 scope is per turn';
  if ($('newChatLabel')) $('newChatLabel').textContent = 'New chat';
  $('newchat')?.setAttribute('aria-label', 'New chat');
  if ($('recents-label')) $('recents-label').textContent = 'Recents';
  if ($('recentPopupToggle')) $('recentPopupToggle').textContent = 'Recents';
  $('main')?.setAttribute('data-workspace', 'all');
  if ($('greet')) $('greet').textContent = 'What can we get done?';
  document.querySelector('#home .sub')?.replaceChildren('Start a conversation or pick a project to work in.');
  const hint = document.querySelector('.home-hint');
  if (hint) hint.textContent = scopeMeta().hint;
  const chips = [...document.querySelectorAll('#chips .chip')];
  const labels = ['Ask anything', 'Explain code', 'Debug an error', 'Plan a task'];
  chips.forEach((chip, index) => { chip.textContent = labels[index] || chip.textContent; });
}
// ---- settings / appearance --------------------------------------------------
const THEME_PALETTES = {
  light: { accent: '#FF3B30', background: '#FFFFFF', surface: '#F4F4F4', text: '#0A0A0A' },
  dark: { accent: '#FF3B30', background: '#0A0A0A', surface: '#141414', text: '#FFFFFF' },
  midnight: { accent: '#FF3B30', background: '#080808', surface: '#111111', text: '#FFFFFF' },
  paper: { accent: '#FF3B30', background: '#FFFFFF', surface: '#F4F4F4', text: '#0A0A0A' },
};
const FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  humanist: '"Segoe UI", "Aptos", system-ui, sans-serif',
  mono: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
  serif: 'Georgia, "Times New Roman", serif',
};
// Codex is the preferred workspace harness for the default Ollama route. Users
// can still choose another installed engine, while provider-specific profiles
// (OpenCode Go/Zen, API routes) keep their explicit engine selection.
const DEFAULT_PROVIDER = { id: 'ollama-local', name: 'Local runtime', kind: 'ollama', engine: 'codex', endpoint: '', model: '', credentialId: '' };
// Scope is the single control that replaced the Chat/Code/Work split and the
// separate permission selector. It still resolves to the productMode and
// permission the capability contract and the engines expect.
const SCOPE_ORDER = ['chat', 'read', 'edit', 'full'];
const SCOPE_META = {
  chat: { label: 'Just chat', productMode: 'chat', permission: 'approve', hint: 'A no-tools conversation. API routes stream directly; OpenCode sign-in stays inside its CLI.' },
  read: { label: 'Read', productMode: 'code', permission: 'approve', hint: 'NoCLI.ai can read the selected workspace and browse. Writes and commands are blocked.' },
  edit: { label: 'Edit', productMode: 'code', permission: 'auto', hint: 'NoCLI.ai can edit files and run ordinary commands in the selected workspace.' },
  full: { label: 'Full', productMode: 'agent', permission: 'full', hint: 'Nothing is withheld, and NoCLI.ai may delegate focused sub-tasks.' },
};
const ENGINE_META = {
  kimi: { label: 'Kimi Code', hint: 'Official Kimi Code CLI. NoCLI.ai supplies this connection and model for each turn without changing Kimi configuration.' },
  opencode: { label: 'OpenCode', hint: 'Official OpenCode CLI. Uses OpenCode Go or Zen sign-in, Ollama, or an OpenAI-compatible API such as OpenRouter.' },
  qwen: { label: 'Qwen Code', hint: 'Official Qwen Code CLI over any OpenAI-compatible route.' },
  claude: { label: 'Claude Code', hint: 'Official Claude Code CLI. Needs an Anthropic-compatible route.' },
  codex: { label: 'Codex CLI', hint: 'Official Codex CLI. Needs a Responses-compatible route.' },
  none: { label: 'NoCLI.ai native', hint: "NoCLI.ai's own tool loop over the selected local runtime. No external CLI." },
};
const ENGINE_ORDER = ['kimi', 'opencode', 'qwen', 'claude', 'codex', 'none'];
let engineAvailability = {};
function scopeMeta(value = settings?.scope) { return SCOPE_META[SCOPE_ORDER.includes(value) ? value : 'chat']; }
// Derived, not stored twice: the rest of the app and every engine still read
// productMode/permissionMode, so scope stays the only thing a user sets.
function applyScope() { const meta = scopeMeta(); settings.productMode = meta.productMode; settings.permissionMode = meta.permission; }
const PRODUCT_MODES = { chat: 'chat', work: 'full', code: 'edit' };
function activeProductMode() { return settings.productMode === 'agent' ? 'work' : settings.productMode === 'code' ? 'code' : 'chat'; }
function syncProductMode() {
  const active = activeProductMode();
  document.querySelectorAll('[data-product-mode]').forEach((button) => {
    const on = button.dataset.productMode === active;
    button.classList.toggle('active', on); button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function selectProductMode(mode) {
  if (!PRODUCT_MODES[mode]) return;
  settings.scope = PRODUCT_MODES[mode];
  syncScope(); saveSettings(); switchView('chat');
  if (activeId && conversations.find((chat) => chat.id === activeId)?.productMode !== settings.productMode) newChat();
  $('prompt')?.focus();
}
const DEFAULT_SETTINGS = { systemPrompt: '', accent: '#FF3B30', colors: { ...THEME_PALETTES.midnight }, theme: 'midnight', density: 'normal', motion: 'standard', font: 'system', productMode: 'chat', permissionMode: 'auto', reasoning: 'auto', scope: 'chat', providerProfiles: [DEFAULT_PROVIDER], activeProviderProfileId: 'ollama-local', activeConversationIds: {} };
let settings = { ...DEFAULT_SETTINGS };
const persisted = {};
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
  else { input.removeAttribute('max'); $('swarmLimitInfo').textContent = 'This provider has no NoCLI.ai concurrency cap; its API limits still apply.'; }
}
// Starts a fresh swarm config screen -- to reopen a past swarm, use the
// entry it gets in the sidebar's chat list instead (see openSwarmSession).
function openSwarm() {
  swarmMode = true; activeId = null; activeSwarmId = null; swarmLogOpen = false;
  $('main').setAttribute('data-swarm', 'true'); $('swarmControls').hidden = false; $('swarmLimitInfo').hidden = true; $('swarmStatus').hidden = false; $('swarmStatus').textContent = ''; $('swarmLaunch').classList.add('active');
  showHomeView(); $('greet').textContent = 'Give the swarm one outcome.'; document.querySelector('#home .sub')?.replaceChildren('NoCLI.ai splits the work and returns one answer.'); document.querySelector('.home-hint')?.replaceChildren('Describe the result you want. Swarm handles the rest.');
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
    const result = await window.nocli.swarmStart({ sentryModel, workerModel, prompt: entry.combined, images: entry.images, workers: Number($('swarmCount').value), systemPrompt: projectSystemPrompt(), cwd: projectCwd(), provider, mode: settings.permissionMode });
    if (!result?.ok) throw new Error(result?.error || 'Could not launch the swarm.');
    $('swarmStatus').textContent = result.capped ? `Ollama limited this swarm to ${result.count} workers.` : `${result.count} worker${result.count === 1 ? '' : 's'} launched.`;
    activeSwarmId = result.swarmId;
    const existing = swarmSessions.find((session) => session.id === result.swarmId);
    const session = normalizeSwarmSession({ id: result.swarmId, title: entry.combined.replace(/\s+/g, ' ').slice(0, 120), sentryModel, workerModel, providerName: provider?.name || 'Current provider', mode: settings.permissionMode, status: 'launching', ts: Date.now(), updatedAt: Date.now(), agents: existing?.agents || [] });
    if (existing) Object.assign(existing, session); else swarmSessions.unshift(session);
    swarmContext.set(result.swarmId, { outcome: entry.combined, images: entry.images || [], cwd: projectCwd(), systemPrompt: projectSystemPrompt(), provider, mode: settings.permissionMode });
    saveSwarmSessions();
    swarmLogOpen = true; activeId = null;
    showChatView(); $('log').innerHTML = ''; renderSwarmTurn(session); renderRecents();
  } catch (error) { $('swarmStatus').textContent = error.message || 'Could not launch the swarm.'; }
  finally { swarmLaunching = false; syncComposerState(); }
}
function loadSettings() {
  try {
    const saved = persisted.osettings || {};
    settings = { ...DEFAULT_SETTINGS, ...saved, colors: { ...THEME_PALETTES[saved.theme] || THEME_PALETTES.midnight, ...(saved.colors || {}) } };
    // Migrate the old blue/pink defaults to NoCLI.ai's red signal without
    // overwriting a deliberately customized palette.
    const legacyAccents = new Set(['#2a4bd6', '#4ea1ff', '#f45f96', '#d95185']);
    const savedAccent = String(saved.colors?.accent || saved.accent || '').toLowerCase();
    if (!savedAccent || legacyAccents.has(savedAccent)) {
      settings.theme = 'midnight';
      settings.colors = { ...THEME_PALETTES.midnight };
    }
    else if (!saved.colors && saved.accent) settings.colors.accent = saved.accent;
    settings.accent = settings.colors.accent;
    settings.providerProfiles = Array.isArray(saved.providerProfiles) && saved.providerProfiles.length ? saved.providerProfiles.map((profile) => ({ ...DEFAULT_PROVIDER, ...profile, credentialId: profile.credentialId || '' })) : [{ ...DEFAULT_PROVIDER }];
    settings.activeConversationIds = saved.activeConversationIds && typeof saved.activeConversationIds === 'object' ? saved.activeConversationIds : {};
    if (!SCOPE_ORDER.includes(settings.scope)) {
      settings.scope = saved.productMode === 'agent' ? 'full' : saved.productMode === 'code' ? (saved.permissionMode === 'approve' ? 'read' : 'edit') : 'chat';
    }
    settings.providerProfiles = (settings.providerProfiles || []).map((profile) => ({
      ...profile,
      engine: ENGINE_ORDER.includes(profile.engine) ? profile.engine : (profile.kind === 'claude-cli' ? 'claude' : profile.kind === 'codex-cli' ? 'codex' : profile.kind === 'ollama' ? 'codex' : 'kimi'),
      kind: ['ollama', 'openai-compatible', 'responses', 'opencode'].includes(profile.kind) ? profile.kind : 'ollama',
    }));
    applyScope();
    if (!settings.providerProfiles.some((profile) => profile.id === settings.activeProviderProfileId)) settings.activeProviderProfileId = settings.providerProfiles[0].id;
  } catch {}
}
function saveState(key, value) { persisted[key] = value; window.nocli.saveState({ [key]: value }).catch(() => {}); }
function saveSettings() { saveState('osettings', settings); }
function saveAutomations() { saveState('oautomations', automations); }
function cadenceMs(value) { return value === 'hourly' ? 3600000 : value === 'weekly' ? 604800000 : 86400000; }
function renderAutomations() {
  const list = $('automationList'); if (!list) return;
  if (!automations.length) { list.innerHTML = '<div class="ops-empty"><strong>No scheduled work yet</strong><span>Create a recurring prompt above. It will run while NOCLI is open.</span></div>'; return; }
  list.innerHTML = '';
  automations.forEach((automation) => {
    const row = document.createElement('article'); row.className = 'automation-row';
    row.innerHTML = `<div><strong>${esc(automation.name)}</strong><span>${esc(automation.cadence)} · next ${esc(new Date(automation.nextRunAt).toLocaleString())}</span><p>${esc(automation.prompt)}</p></div><div class="automation-actions"><button type="button" data-action="toggle">${automation.enabled ? 'Pause' : 'Resume'}</button><button type="button" data-action="run">Run now</button><button type="button" data-action="delete">Delete</button></div>`;
    row.querySelector('[data-action="toggle"]').onclick = () => { automation.enabled = !automation.enabled; if (automation.enabled) automation.nextRunAt = Date.now() + cadenceMs(automation.cadence); saveAutomations(); renderAutomations(); };
    row.querySelector('[data-action="run"]').onclick = () => runAutomation(automation);
    row.querySelector('[data-action="delete"]').onclick = () => { automations = automations.filter((item) => item.id !== automation.id); saveAutomations(); renderAutomations(); };
    list.appendChild(row);
  });
}
function runAutomation(automation) {
  const previousScope = settings.scope; settings.scope = automation.scope || 'full'; applyScope();
  activeId = null; switchView('chat');
  const provider = currentProviderProfile();
  startMessage({ text: automation.prompt, combined: automation.prompt, images: [], productMode: settings.productMode, providerProfileId: provider?.id, model: provider?.model || $('model').value });
  automation.lastRunAt = Date.now(); automation.nextRunAt = Date.now() + cadenceMs(automation.cadence); saveAutomations();
  settings.scope = previousScope; applyScope(); syncProductMode();
}
function checkAutomations() { automations.filter((item) => item.enabled && item.nextRunAt <= Date.now()).forEach(runAutomation); }
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
  settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('sysPrompt').value = settings.systemPrompt;
  $('themeSel').value = settings.theme;
  $('densitySel').value = settings.density;
  $('motionSel').value = settings.motion;
  $('fontSel').value = settings.font;
  syncScope();
  $('runtimeSel').value = ['exo', 'llamacpp'].includes(persisted.oRuntime) ? persisted.oRuntime : 'ollama';
  $('exoUrl').value = persisted.oExoUrl || 'http://127.0.0.1:52415';
  syncRuntimeFields();
  renderProviderProfiles();
  if (currentProviderProfile()?.kind === 'opencode') refreshOpenCodeModels();
  if ($('runtimeSel').value === 'llamacpp') refreshLlamaCppStatus();
  syncScope();
  loadEngineAvailability();
  syncPaletteInputs(); renderProjects(); renderCloudCatalogueInfo();
  $('settings').classList.add('show');
  $('settings').setAttribute('aria-hidden', 'false');
  syncTopNav('settings');
  requestAnimationFrame(() => $('settingsClose')?.focus());
}
function closeSettings() {
  if (!$('settings').classList.contains('show')) return;
  $('settings').classList.remove('show');
  $('settings').setAttribute('aria-hidden', 'true');
  syncTopNav(activeView);
  settingsOpener?.focus?.();
  settingsOpener = null;
}
function syncRuntimeFields() {
  const kind = $('runtimeSel').value; const exo = kind === 'exo'; const llamaCpp = kind === 'llamacpp';
  $('exoUrl').parentElement.style.display = exo ? '' : 'none'; $('exoCheck').style.display = exo ? '' : 'none';
  $('exoStatus').textContent = exo
    ? 'Exo is an optional cluster runtime. NoCLI.ai connects to its coordinator API; it does not install or emulate a cluster.'
    : 'Local Ollama runs on this device.';
  $('llamaCppFields').style.display = llamaCpp ? '' : 'none';
  if (llamaCpp) syncLlamaCppRoleFields();
}
async function selectRuntime() {
  const kind = $('runtimeSel').value; const url = $('exoUrl').value.trim();
  $('exoStatus').textContent = kind === 'exo' ? 'Connecting to Exo…' : kind === 'llamacpp' ? '' : 'Switching to local Ollama…';
  const result = await window.nocli.setRuntime({ kind, url });
  if (result?.error) { $('exoStatus').textContent = 'Exo connection failed: ' + result.error; $('runtimeSel').value = ['exo', 'llamacpp'].includes(persisted.oRuntime) ? persisted.oRuntime : 'ollama'; syncRuntimeFields(); return; }
  saveState('oRuntime', result.kind); saveState('oExoUrl', result.url || '');
  $('exoStatus').textContent = result.kind === 'exo' ? 'Exo connected — ' + (result.url || url) + '.' : result.kind === 'llamacpp' ? '' : 'Using local Ollama.';
  if (result.kind === 'llamacpp') await refreshLlamaCppStatus();
  await loadModels();
}
async function testExo() {
  $('exoStatus').textContent = 'Testing Exo coordinator…';
  const result = await window.nocli.checkExo($('exoUrl').value.trim());
  $('exoStatus').textContent = result?.ok ? `Exo ready — ${result.models} model${result.models === 1 ? '' : 's'} exposed.` : 'Exo check failed: ' + (result?.error || 'unknown error');
}

// ---- llama.cpp RPC runtime (two-PC VRAM pool) ------------------------------
// NoCLI.ai manages the local half only: install the CUDA binaries, spawn either
// llama-server (Host, using --rpc to reach a remote GPU) or rpc-server (Worker,
// exposing this PC's GPU). The other PC needs the same setup done there by hand
// -- NoCLI.ai cannot reach across the isolated link to configure it.
let llamaCppInstalling = false;
function syncLlamaCppRoleFields() {
  const host = $('llamaCppRole').value !== 'worker';
  $('llamaCppHostFields').style.display = host ? '' : 'none';
  $('llamaCppHostFields2').style.display = host ? '' : 'none';
  $('llamaCppWorkerFields').style.display = host ? 'none' : '';
}
async function refreshLlamaCppStatus() {
  const status = await window.nocli.llamaCppStatus();
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
  await window.nocli.llamaCppSetConfig({
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
    const result = await window.nocli.llamaCppInstall();
    $('llamaCppInstallStatus').textContent = result?.error ? 'Install failed: ' + result.error : 'llama.cpp CUDA runtime installed at ' + result.status.dir + '.';
  } finally { llamaCppInstalling = false; await refreshLlamaCppStatus(); }
}
async function pickLlamaCppModel() {
  const picked = await window.nocli.llamaCppPickModel();
  if (!picked) return;
  $('llamaCppModelPath').value = picked;
  await saveLlamaCppConfigFromFields();
}
async function testLlamaCppPeer() {
  await saveLlamaCppConfigFromFields();
  const peer = $('llamaCppRpcPeers').value.trim().split(',')[0]?.trim();
  if (!peer) { $('llamaCppStatus').textContent = 'Enter the remote PC\'s rpc-server address first, e.g. 192.168.50.2:50052.'; return; }
  $('llamaCppStatus').textContent = 'Testing ' + peer + '…';
  const result = await window.nocli.llamaCppCheckPeer(peer);
  $('llamaCppStatus').textContent = result?.ok ? peer + ' is reachable.' : peer + ' is not reachable: ' + (result?.error || 'unknown error') + '. Confirm the other PC is running NoCLI.ai as a Worker on its isolated-Ethernet IP.';
}
async function startLlamaCppRuntime() {
  await saveLlamaCppConfigFromFields();
  $('llamaCppStatus').textContent = 'Starting…';
  const result = await window.nocli.llamaCppStart();
  $('llamaCppStatus').textContent = result?.error ? 'Could not start: ' + result.error : 'Starting…';
  await refreshLlamaCppStatus();
  if (!result?.error) await loadModels();
}
async function stopLlamaCppRuntime() { await window.nocli.llamaCppStop(); await refreshLlamaCppStatus(); }

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
  const path = await window.nocli.pickFolder();
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
    box.innerHTML = '<div class="ops-empty"><span class="ops-empty-kicker">First workspace</span><h3>Give NoCLI.ai a place to work</h3><p>Connect a folder once, then keep its chats, instructions, and repository context together.</p><button id="projectsEmptyAdd" type="button">Create a project</button></div>';
    $('projectsEmptyAdd').onclick = () => { openSettings(); setTimeout(() => $('projName').focus(), 0); };
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'ops-grid project-grid';
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'ops-card project-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', 'Open project ' + p.name);
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
    card.onkeydown = (event) => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectProject(p.id); switchView('chat'); } };
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
  rec.innerHTML = '<div class="ops-section-head"><div><h3>Recommended for NoCLI.ai</h3><p>Local picks calibrated for Chat, Code, and Work.</p></div></div>';
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
    const cache = await window.nocli.refreshCloudModels();
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
function describeModelInventoryError(value) {
  const message = String(value || 'Ollama did not respond.');
  const missingStore = message.match(/mkdir\s+([A-Za-z]:\\[^:]+):\s+The system cannot find the path specified/i);
  if (missingStore) return `Ollama's model storage at ${missingStore[1]} is unavailable. Reconnect that drive or update OLLAMA_MODELS, then retry.`;
  return message;
}
async function loadModels(loader = () => window.nocli.listModels()) {
  modelInventoryState = 'loading';
  modelInventoryError = '';
  setLoading('Checking local models…');
  try {
    const data = await loader();
    if (data?.error) throw new Error(describeModelInventoryError(data.error));
    const localModels = Array.isArray(data?.models) ? data.models : [];
    localModelCatalogue = localModels.map((model) => ({
      ...model,
      source: model.remote_host || /:cloud$/i.test(String(model.name || '')) ? 'cloud' : 'local',
    }));
    modelInventoryState = localModels.length ? 'ready' : 'empty';
    applyProviderModelChoices();
    setStatus(true, localModels.length ? 'ready' : 'no models');
    return true;
  } catch (error) {
    modelInventoryState = 'error';
    modelInventoryError = describeModelInventoryError(error?.message);
    setStatus(false, 'offline');
    if ($('modelPicker')?.classList.contains('show')) renderPicker();
    return false;
  }
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
    const [installed, catalogue, hardware] = await Promise.all([window.nocli.listModels(), window.nocli.downloadCatalogue(), window.nocli.hardwareProfile()]);
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
    const result = await window.nocli.pullModel(name);
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
window.nocli.on('model-pull-progress', (update) => {
  if (!update || update.model !== downloadingModel) return;
  const percent = update.total > 0 ? ' · ' + Math.min(100, Math.round(update.completed / update.total * 100)) + '%' : '';
  $('modelDownloadProgress').textContent = String(update.status || 'Downloading…') + percent;
});
// ---- model picker -----------------------------------------------------------
// The <select id="model"> stays the source of truth (slash commands, saved
// conversations and the send path all read it); this is a richer way to set it.
let modelCatalogue = [];
let localModelCatalogue = [];
let openCodeModelCatalogue = [];
let modelInventoryState = 'loading';
let modelInventoryError = '';
let pickerCursor = 0;
// Family marks. Where a vendor's mark is available under a free licence it is
// used (see model-logos.js); where it is not — Microsoft's Phi, IBM's Granite,
// OpenAI — the family keeps an NoCLI.ai glyph rather than an imitation of theirs.
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
// Brand marks are single filled paths; NoCLI.ai's own glyphs are stroked.
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
const prettyBytes = (n) => (!n || n < 1e6 ? '' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');
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
    const report = await window.nocli.modelCapabilities(model, settings.productMode, currentProviderProfile());
    if ($('model').value !== model) return;
    badge.hidden = false;
    badge.textContent = report.vision ? 'Vision checked' : 'Text-only';
    badge.className = 'model-capability ' + (report.vision ? 'vision' : 'text-only');
    $('modelBtn').title = model + ' · ' + (report.vision ? 'vision checked' : 'text-only; screenshots disabled') + (report.reasoning ? ' · reasoning available' : '');
    const reasoning = $('reasoningSel'); if (reasoning) { reasoning.disabled = report.reasoningStatus === 'not-supported'; if (reasoning.disabled) reasoning.value = 'off'; }
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
    const message = document.createElement('p');
    message.textContent = modelCatalogue.length
      ? 'No models match this search.'
      : modelInventoryState === 'error'
        ? modelInventoryError
        : 'No Ollama models are available on this device yet.';
    empty.appendChild(message);
    if (!modelCatalogue.length) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry Ollama';
      retry.onclick = async () => { retry.disabled = true; retry.textContent = 'Checking…'; await loadModels(); if ($('modelPicker').classList.contains('show')) renderPicker(); };
      empty.appendChild(retry);
    }
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
  if (modelInventoryState === 'error' || modelInventoryState === 'empty') loadModels().then(() => { if ($('modelPicker').classList.contains('show')) renderPicker(); });
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
    role: String(agent.role || '').slice(0, 60), brief: String(agent.brief || '').slice(0, 800),
    steps: Array.isArray(agent.steps) ? agent.steps.slice(-8).map((s) => String(s).slice(0, 200)) : [],
  })) : [];
  return { id: String(value.id), title: String(value.title || 'Untitled swarm').slice(0, 120), sentryModel: String(value.sentryModel || '').slice(0, 160), workerModel: String(value.workerModel || '').slice(0, 160), providerName: String(value.providerName || '').slice(0, 80), mode: String(value.mode || 'auto'), status: String(value.status || 'working'), ts: Number(value.ts) || Date.now(), updatedAt: Number(value.updatedAt) || Number(value.ts) || Date.now(), agents };
}
function loadSwarmSessions() {
  try { swarmSessions = (Array.isArray(persisted.oswarmSessions) ? persisted.oswarmSessions : []).map(normalizeSwarmSession).filter(Boolean); }
  catch { swarmSessions = []; }
}
function saveSwarmSessions() { saveState('oswarmSessions', swarmSessions.slice(0, 40).map((session) => ({ ...session, agents: session.agents.slice(-16) }))); }
function swarmSessionOrder() { return [...swarmSessions].sort((a, b) => Number(b.updatedAt || b.ts) - Number(a.updatedAt || a.ts)); }
function copyToClipboard(text, btn) {
  navigator.clipboard?.writeText(String(text || '')).catch(() => {});
  if (btn) { const label = btn.textContent; btn.textContent = 'copied'; setTimeout(() => { btn.textContent = label === 'copied' ? 'copy' : label; }, 1200); }
}
async function retrySwarmWorker(session, agent) {
  if (!session || !agent) return;
  const ctx = swarmContext.get(session.id);
  if (!ctx) { agent.result = "This session's original task isn't available to retry (it predates this app session) -- launch a new swarm instead."; agent.status = 'failed'; renderSwarmTurn(session); return; }
  agent.status = 'working'; agent.result = 'Retrying…'; renderSwarmTurn(session);
  if (sentryModalTarget?.agent?.id === agent.id) openSentryModal({ kind: 'Worker', title: agent.task, meta: (agent.model || session.workerModel || '') + ' · working', text: agent.result, session, agent });
  const result = await window.nocli.swarmRetryWorker({ swarmId: session.id, agentId: agent.id, lane: agent.brief || agent.task, model: agent.model, prompt: ctx.outcome, systemPrompt: ctx.systemPrompt, cwd: ctx.cwd, provider: ctx.provider, mode: ctx.mode, images: ctx.images });
  if (!result?.ok) { agent.status = 'failed'; agent.result = result?.error || 'Could not retry this worker.'; renderSwarmTurn(session); }
}
function openSentryModal({ kind, title, meta, text, session, agent }) {
  sentryModalTarget = session && agent ? { session, agent } : null;
  $('sentryModalKicker').textContent = kind;
  $('sentryModalTitle').textContent = title || '(untitled)';
  $('sentryModalMeta').textContent = meta || '';
  $('sentryModalText').textContent = text || '(no report yet)';
  const canRetry = !!(sentryModalTarget && !/^Sentry\b/.test(agent?.task || '') && ['completed', 'failed'].includes(agent?.status));
  $('sentryModalRetry').hidden = !canRetry;
  $('sentryAgentModal').hidden = false;
}
function closeSentryModal() { $('sentryAgentModal').hidden = true; sentryModalTarget = null; }
// Swarm renders as a turn inside the normal chat log -- same window, same
// composer, same bubble styling as a regular message -- instead of a
// separate full-page console. One turn per session; re-running this just
// updates that turn's contents in place.
function renderSwarmTurn(session) {
  if (!session) return;
  let el = $('log').querySelector('.swarm-turn[data-swarm-id="' + session.id + '"]');
  if (!el) {
    el = document.createElement('div'); el.className = 'turn ai swarm-turn'; el.dataset.swarmId = session.id;
    const head = document.createElement('div'); head.className = 'turnhead'; head.textContent = 'NoCLI.ai Swarm · ' + (session.sentryModel || '');
    const bubble = document.createElement('div'); bubble.className = 'bubble swarm-bubble';
    el.append(head, bubble);
    $('log').appendChild(el);
  }
  const bubble = el.querySelector('.swarm-bubble');
  const agents = session.agents || [];
  const sentry = agents.find((agent) => /^Sentry\b/.test(agent.task));
  const workers = agents.filter((agent) => agent.id !== session.id && agent !== sentry);
  const sentryStatus = sentry?.status || session.status || 'planning';
  const sentryText = sentry?.result || 'Sentry is reasoning about your request…';
  bubble.innerHTML =
    '<div class="swarm-sentry-block"><div class="swarm-sentry-head"><strong>Sentry</strong><span class="swarm-status-pill" data-status="' + esc(sentryStatus) + '">' + esc(sentryStatus) + '</span></div><div class="swarm-sentry-text"></div></div>' +
    '<div class="swarm-workers-row"></div>';
  renderMarkdown(bubble.querySelector('.swarm-sentry-text'), sentryText);
  const sentryBlock = bubble.querySelector('.swarm-sentry-block');
  if (sentry?.result) { sentryBlock.classList.add('clickable'); sentryBlock.onclick = () => openSentryModal({ kind: 'Sentry', title: sentry.task || 'Synthesis', meta: (sentry.model || session.sentryModel || '') + ' · ' + (sentry.status || ''), text: sentry.result }); }
  const row = bubble.querySelector('.swarm-workers-row');
  for (const agent of workers) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'swarm-worker-chip'; chip.dataset.status = agent.status || 'working';
    const roleName = (agent.role || String(agent.task || '').split('·').pop() || 'Worker').trim();
    chip.innerHTML = '<span class="chip-role">' + esc(roleName) + '</span><span class="chip-status">' + esc(agent.status || 'working') + '</span>';
    if (agent.status === 'working' && agent.steps?.length) chip.title = agent.steps[agent.steps.length - 1];
    chip.onclick = () => openSentryModal({ kind: 'Worker', title: agent.task, meta: (agent.model || session.workerModel || '') + ' · ' + (agent.status || ''), text: agent.result || '(no report yet)', session, agent });
    row.appendChild(chip);
  }
  if (sentryModalTarget?.session?.id === session.id) {
    const fresh = sentryModalTarget.agent.id === sentry?.id ? sentry : workers.find((agent) => agent.id === sentryModalTarget.agent.id);
    if (fresh) openSentryModal({ kind: fresh === sentry ? 'Sentry' : 'Worker', title: fresh.task, meta: (fresh.model || session.workerModel || '') + ' · ' + (fresh.status || ''), text: fresh.result || '(no report yet)', session, agent: fresh });
  }
  scrollBottom();
}
// Reopens a past swarm session the same way openConv reopens a past chat.
function openSwarmSession(id) {
  const session = swarmSessions.find((item) => item.id === id);
  if (!session) return;
  activeSwarmId = id; activeId = null; swarmLogOpen = true;
  showChatView();
  $('log').innerHTML = '';
  renderSwarmTurn(session);
  renderRecents();
}
function deleteSwarmSession(id) {
  swarmSessions = swarmSessions.filter((session) => session.id !== id);
  swarmContext.delete(id);
  saveSwarmSessions();
  if (activeSwarmId === id) { activeSwarmId = null; swarmLogOpen = false; newChat(); }
  renderRecents();
}
function upsertSwarmAgent(agent) {
  if (!agent?.swarmId) return;
  let session = swarmSessions.find((item) => item.id === agent.swarmId);
  if (!session) { session = normalizeSwarmSession({ id: agent.swarmId, title: 'Recovered swarm session', ts: Date.now(), agents: [] }); swarmSessions.unshift(session); }
  const index = session.agents.findIndex((item) => item.id === agent.id);
  const next = { ...(index >= 0 ? session.agents[index] : {}), ...agent, id: String(agent.id || agent.swarmId), task: String(agent.task || '').slice(0, 240), model: String(agent.model || '').slice(0, 160), status: String(agent.status || 'working'), result: String(agent.result || '').slice(0, 24000) };
  if (index >= 0) session.agents[index] = next; else session.agents.push(next);
  if (agent.id === agent.swarmId) session.status = next.status;
  session.updatedAt = Date.now(); saveSwarmSessions();
  if (activeSwarmId === session.id && swarmLogOpen) renderSwarmTurn(session);
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
  window.nocli.workspaceUpsert(conv).catch(() => {});
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
      + esc(chat.projectId ? (projects.find((p) => p.id === chat.projectId)?.name || 'Project') : 'All chats') + ' · ' + esc(chat.model || chat.productMode || 'NoCLI.ai') + '</span>';
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
  const swarms = swarmSessionOrder();
  if (!visible.length && !swarms.length) {
    const e = document.createElement('div'); e.style.cssText = 'font-size:13px;color:var(--nocli-muted);padding:9px 8px';
    e.textContent = activeProjectId ? (workspace === 'work' ? 'No work sessions in this workspace yet.' : workspace === 'code' ? 'No code sessions in this project yet.' : 'No chats in this project yet.') : (workspace === 'work' ? 'No work sessions yet.' : workspace === 'code' ? 'No code sessions yet.' : 'No chats yet.'); box.appendChild(e);
  }
  for (const c of conversationOrder(visible)) {
    const d = document.createElement('div');
    d.className = 'recent' + (c.id === activeId ? ' active' : '') + (c.pinned ? ' pinned' : '');
    d.textContent = (c.title || '(empty)') + ([...activeTurns.values()].some((turn) => turn.conversationId === c.id) ? ' · running' : '');
    d.title = c.title || '';
    d.tabIndex = 0; d.setAttribute('role', 'button');
    d.onclick = () => openConv(c.id);
    d.onkeydown = (event) => { if (event.target === d && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openConv(c.id); } };
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'rpin'; pin.textContent = c.pinned ? '★' : '☆'; pin.title = c.pinned ? 'Unpin chat' : 'Pin chat';
    pin.onclick = (e) => { e.stopPropagation(); toggleConversationPin(c.id); };
    const del = document.createElement('button'); del.type = 'button'; del.className = 'rdel'; del.textContent = '×'; del.title = 'Delete chat';
    del.onclick = (e) => { e.stopPropagation(); deleteConversation(c.id); };
    d.append(pin, del); box.appendChild(d);
  }
  if (swarms.length) {
    const label = document.createElement('div'); label.className = 'recents-label'; label.textContent = 'Swarms'; box.appendChild(label);
    for (const s of swarms) {
      const d = document.createElement('div');
      d.className = 'recent swarm-recent' + (s.id === activeSwarmId && swarmLogOpen ? ' active' : '');
      d.textContent = s.title || '(untitled swarm)';
      d.title = s.title || '';
      d.tabIndex = 0; d.setAttribute('role', 'button');
      d.onclick = () => openSwarmSession(s.id);
      d.onkeydown = (event) => { if (event.target === d && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSwarmSession(s.id); } };
      const del = document.createElement('button'); del.type = 'button'; del.className = 'rdel'; del.textContent = '×'; del.title = 'Delete swarm session';
      del.onclick = (e) => { e.stopPropagation(); deleteSwarmSession(s.id); };
      d.appendChild(del); box.appendChild(d);
    }
  }
  renderRecentPopup();
}
function openConv(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  swarmLogOpen = false;
  activeId = id;
  settings.activeConversationIds[workspaceGroup(conv.productMode || 'chat')] = id; saveSettings();
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
  $('scroller').hidden = false;
  $('home').querySelector('.wrap').insertBefore($('composerCard'), $('chips'));
  $('prompt').focus();
}
function showChatView() {
  $('home').style.display = 'none';
  $('chat').classList.add('show');
  $('scroller').hidden = false;
  $('composerSlot').appendChild($('composerCard'));
}
function newChat() { activeId = null; swarmLogOpen = false; settings.activeConversationIds[workspaceGroup()] = null; saveSettings(); $('log').innerHTML = ''; showHomeView(); renderRecents(); syncComposerState(); switchView('chat'); }

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
  if (turn.generation) { turn.generation.remove(); turn.generation = null; }
  turn.turnEl.classList.remove('streaming');
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
  const t = document.createElement('div'); t.className = 'turn ai streaming';
  const head = document.createElement('div'); head.className = 'turnhead';
  head.textContent = model || '';
  const stream = document.createElement('div'); stream.className = 'stream';
  const generation = document.createElement('div'); generation.className = 'generation-state';
  generation.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="generation-label">Thinking</span>';
  stream.appendChild(generation);
  if (head.textContent) t.appendChild(head);
  t.appendChild(stream); $('log').appendChild(t);
  scrollBottom();
  return { turnEl: t, streamEl: stream, generation, blocks: [], mode: null, tail: '', started: false, model };
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
  if (turn.generation) { turn.generation.remove(); turn.generation = null; }
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
    block.el.classList.add('closed');
    const head = document.createElement('button'); head.className = 'think-toggle'; head.type = 'button';
    head.innerHTML = '<span class="caret">▸</span> <span class="think-label">Thinking process</span>';
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
// Cloud compatibility tools may use snake_case or camelCase arguments, so accept both.
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
  const browser = window.nocli.browserInvocation(s.fn, s.args);
  if (!turn.replaying && browser?.type === 'navigate') openBrowserAt(browser.url);
}
function currentProviderProfile() {
  return settings.providerProfiles.find((profile) => profile.id === settings.activeProviderProfileId) || settings.providerProfiles[0];
}
function providerModelChoices() {
  const profile = currentProviderProfile();
  if (profile?.kind === 'ollama') return localModelCatalogue;
  const name = String(profile?.model || '').trim();
  if (profile?.kind === 'opencode') {
    const models = openCodeModelCatalogue.map((model) => ({ name: model, source: 'api', details: { parameter_size: model.startsWith('opencode-go/') ? 'OpenCode Go' : 'OpenCode Zen' } }));
    if (name && !models.some((model) => model.name === name)) models.unshift({ name, source: 'api', details: { parameter_size: 'OpenCode' } });
    return models;
  }
  const source = profile?.kind === 'codex-cli' ? 'Codex CLI' : profile?.kind === 'claude-cli' ? 'Claude Code' : profile?.kind === 'responses' ? 'Responses API' : 'API route';
  return name ? [{ name, source: 'api', details: { parameter_size: source } }] : [];
}
async function refreshOpenCodeModels() {
  try {
    const data = await window.nocli.openCodeModels();
    openCodeModelCatalogue = Array.isArray(data?.models) ? data.models : [];
  } catch { openCodeModelCatalogue = []; }
  if (currentProviderProfile()?.kind === 'opencode') applyProviderModelChoices();
}
function applyProviderModelChoices() {
  const profile = currentProviderProfile(); const sel = $('model'); if (!sel) return;
  const models = providerModelChoices(); const prior = sel.value;
  modelCatalogue = models;
  sel.replaceChildren(...models.map((model) => { const option = document.createElement('option'); option.value = model.name; option.textContent = model.name + (model.details?.parameter_size ? ' · ' + model.details.parameter_size : model.source === 'api' ? ' · API' : ''); return option; }));
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
    item.onclick = () => { sel.value = model.name; if (profile?.kind === 'ollama') saveState('omodel', model.name); else if (profile?.kind === 'opencode') { profile.model = model.name; $('providerModel').value = model.name; saveSettings(); } syncModelButton(); if (swarmMode) syncSwarmRoles(); };
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
  syncProviderRouteFields();
  $('providerUseOllama')?.classList.toggle('active', profile.kind === 'ollama');
  $('providerNew')?.classList.toggle('active', profile.kind !== 'ollama');
  $('providerStatus').textContent = profile.kind === 'ollama'
    ? 'Using the local runtime. Ollama-compatible local models and signed-in cloud models are available without a NoCLI.ai API key.'
    : profile.kind === 'opencode'
      ? 'Using the OpenCode CLI credential store. Run opencode auth login for OpenCode Go or Zen; NoCLI.ai never copies that credential.'
    : profile.kind === 'codex-cli'
      ? 'Using your signed-in official Codex CLI. NoCLI.ai does not inject its own Codex config or tools.'
      : profile.kind === 'claude-cli'
        ? 'Using your signed-in official Claude Code. NoCLI.ai does not store a Claude API key.'
    : (profile.credentialId ? `${profile.name} is active. Its API key is stored securely.` : `${profile.name} is selected. Add its API key below to finish setup.`);
  if ($('providerApiSetup')) $('providerApiSetup').open = profile.kind !== 'ollama';
}
async function useLocalOllama() {
  let profile = settings.providerProfiles.find((item) => item.kind === 'ollama');
  if (!profile) { profile = { ...DEFAULT_PROVIDER }; settings.providerProfiles.unshift(profile); }
  settings.activeProviderProfileId = profile.id;
  saveSettings(); renderProviderProfiles(); applyProviderModelChoices();
  if ($('runtimeSel')?.value !== 'ollama') { $('runtimeSel').value = 'ollama'; await selectRuntime(); }
  $('providerStatus').textContent = 'Using the local runtime on this device.';
  if (swarmMode) syncSwarmRoles();
}
function startApiProviderSetup() {
  const current = currentProviderProfile();
  if (current?.kind !== 'ollama' && !current.endpoint && !current.model && !current.credentialId) {
    $('providerApiSetup').open = true;
    requestAnimationFrame(() => $('providerName').focus());
    return;
  }
  const profile = { ...DEFAULT_PROVIDER, id: rid(), name: 'New API', kind: 'openai-compatible', endpoint: '', model: '', credentialId: '' };
  settings.providerProfiles.push(profile); settings.activeProviderProfileId = profile.id; saveSettings(); renderProviderProfiles();
  $('providerApiSetup').open = true;
  requestAnimationFrame(() => $('providerName').focus());
}
const PROVIDER_PRESETS = {
  custom: { name: 'Custom API', kind: 'openai-compatible', endpoint: '', model: '' },
  openai: { name: 'OpenAI', kind: 'responses', endpoint: 'https://api.openai.com/v1', model: '' },
  openrouter: { name: 'OpenRouter', kind: 'openai-compatible', engine: 'opencode', endpoint: 'https://openrouter.ai/api/v1', model: '' },
  opencodeGo: { name: 'OpenCode Go', kind: 'opencode', engine: 'opencode', endpoint: '', model: 'opencode-go/kimi-k3' },
  opencodeZen: { name: 'OpenCode Zen', kind: 'opencode', engine: 'opencode', endpoint: '', model: '' },
  codex: { name: 'Codex CLI', kind: 'codex-cli', endpoint: '', model: '' },
  claude: { name: 'Claude Code', kind: 'claude-cli', endpoint: '', model: '' },
};
function fillProviderFields(profile) {
  $('providerName').value = profile.name || '';
  $('providerKind').value = profile.kind || 'openai-compatible';
  $('providerEndpoint').value = profile.endpoint || '';
  $('providerModel').value = profile.model || '';
  syncProviderRouteFields();
}
function syncProviderRouteFields() {
  const usesOpenCodeAuth = $('providerKind').value === 'opencode';
  $('providerEndpoint').disabled = usesOpenCodeAuth;
  $('providerApiKey').disabled = usesOpenCodeAuth;
  $('providerEndpoint').placeholder = usesOpenCodeAuth ? 'Managed by OpenCode' : 'https://api.example.com/v1';
  $('providerApiKey').placeholder = usesOpenCodeAuth ? 'Managed by opencode auth login' : 'Paste key';
}
function applyProviderPreset() {
  const preset = PROVIDER_PRESETS[$('providerPreset').value] || PROVIDER_PRESETS.custom;
  fillProviderFields(preset);
  const profile = currentProviderProfile();
  if (profile && preset.engine) { profile.engine = preset.engine; saveSettings(); syncEngineSelect(); }
  if (preset.kind === 'opencode') refreshOpenCodeModels();
  $('providerImportStatus').textContent = preset.kind === 'opencode'
    ? 'Preset applied. Choose an available Go or Zen model, then save. Authentication stays in OpenCode.'
    : 'Preset applied. Add a model ID and API key, then save the profile.';
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
    $('providerImportStatus').textContent = `Imported ${source.name || id}. Add its API key in NoCLI.ai, then save the profile.`;
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
    engine: $('providerKind').value === 'opencode' ? 'opencode' : (existing?.engine || 'kimi'),
  };
  if (['openai-compatible', 'responses'].includes(profile.kind) && !/^https?:\/\//i.test(profile.endpoint)) { $('providerStatus').textContent = 'Enter a full http:// or https:// API endpoint.'; return; }
  try {
    const saved = await window.nocli.providerSave(profile, $('providerApiKey').value);
    const index = settings.providerProfiles.findIndex((item) => item.id === saved.id);
    if (index >= 0) settings.providerProfiles[index] = saved; else settings.providerProfiles.push(saved);
    settings.activeProviderProfileId = saved.id; saveSettings(); renderProviderProfiles(); syncEngineSelect();
    if (saved.kind === 'opencode') await refreshOpenCodeModels(); else applyProviderModelChoices();
    if (swarmMode) syncSwarmRoles();
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
  if (s.type === 'thinking') { appendThink(turn, String(s.text || '')); scrollBottom(); return; }
  startContent(turn);
  turn.blocks.forEach((b) => b.el.classList.remove('active'));
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
window.nocli.on('chat-delta', ({ requestId, text }) => {
  const turn = activeTurns.get(requestId); if (!turn) return;
  startContent(turn);
  feedText(turn, text);
  if (turn.conversationId === activeId) scrollBottom();
});
window.nocli.on('chat-step', ({ requestId, step }) => addStep(step, activeTurns.get(requestId)));
window.nocli.on('chat-error', ({ requestId, message }) => {
  const turn = activeTurns.get(requestId); if (!turn || stopping.has(requestId)) return;
  if (turn.generation) { turn.generation.remove(); turn.generation = null; }
  turn.turnEl.classList.remove('streaming');
  turn.turnEl.classList.add('error');
  turn.streamEl.innerHTML = '<div class="block text">[error] ' + esc(message) + '</div>';
});
window.nocli.on('chat-done', ({ requestId, sessionId, steered } = {}) => {
  const turn = activeTurns.get(requestId); if (!turn) return;
  if (turn.generation) { turn.generation.remove(); turn.generation = null; }
  turn.turnEl.classList.remove('streaming');
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
    if (conv && conv.sessionId !== sessionId) { conv.sessionId = sessionId; saveConvs(); }
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
    'NoCLI.ai commands',
    ...CORE_COMMANDS.map((command) => `  /${command.name}${command.args ? ' ' + command.args : ''}  — ${command.description}`),
    '',
    'Modes:',
    '  Chat  — direct model conversation',
    '  Code  — workspace work through the official CLI',
    '  Agent — can delegate scoped work through the official CLI',
    '',
    'Commands marked Code/Work become explicit tasks for the selected harness. Attach files with the paperclip or drag-drop.',
  ];
  addSysNote(lines.join('\n'));
  scrollBottom();
}

// ---- send / commands -------------------------------------------------------
function saveDraft() { saveState('odraft', $('prompt').value.slice(0, 20000)); }
function clearInput() { $('prompt').value = ''; saveDraft(); autosize(); }
function syncComposerState() {
  const running = currentTurn();
  $('send').textContent = running ? '+' : swarmLaunching ? '…' : '→';
  $('send').className = running ? 'queue-send' : '';
  $('send').title = running ? 'Add to queue' : swarmLaunching ? 'Launching swarm' : swarmMode ? 'Launch swarm' : 'Send';
  $('send').disabled = swarmLaunching;
  $('steer').hidden = !running;
  $('steer').disabled = !running;
  $('stopRun').hidden = !running;
  renderRunQueue();
}
function renderRunQueue() {
  const host = $('runQueue'); if (!host) return;
  const queue = activeId ? (queuedMessages.get(activeId) || []) : [];
  host.hidden = !queue.length;
  host.innerHTML = queue.length ? `<span class="queue-label">UP NEXT · ${queue.length}</span>${queue.map((entry, index) => `<button type="button" data-queue-index="${index}" title="Remove from queue"><span>${index + 1}</span>${esc(entry.text || '(attachment)')}</button>`).join('')}` : '';
  host.querySelectorAll('[data-queue-index]').forEach((button) => { button.onclick = () => { queue.splice(Number(button.dataset.queueIndex), 1); if (!queue.length) queuedMessages.delete(activeId); renderRunQueue(); }; });
}

function queueMessage(conversationId, entry, steers = false) {
  const queue = queuedMessages.get(conversationId) || [];
  if (steers) queue.unshift(entry); else queue.push(entry);
  queuedMessages.set(conversationId, queue);
  renderRunQueue();
  scrollBottom();
}
function runNextQueued(conversationId) {
  const queue = queuedMessages.get(conversationId); if (!queue?.length || currentTurn()) return;
  const entry = queue.shift(); if (!queue.length) queuedMessages.delete(conversationId);
  renderRunQueue();
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
  if (runSlashCommand(text)) return;

  const entry = takeComposerEntry();
  startMessage(entry);
}
async function startMessage(entry) {
  const { text, combined, images, model } = entry;
  // Modes have intentionally different runtimes and system boundaries. Never
  // silently run a Code/Agent request through a prior Chat conversation (or
  // vice versa); mode changes begin a fresh conversation automatically.
  let conv = activeId ? conversations.find((c) => c.id === activeId) : null;
  if (!conv) {
    conv = { id: rid(), sessionId: null, title: text.replace(/\s+/g, ' ').slice(0, 48) || '(attachment)', model, productMode: entry.productMode, providerProfileId: entry.providerProfileId, ts: Date.now(), updatedAt: Date.now(), projectId: activeProjectId, turns: [] };
    conversations.unshift(conv); activeId = conv.id; settings.activeConversationIds[workspaceGroup(conv.productMode)] = conv.id; saveSettings(); renderRecents();
  }
  conv.updatedAt = Date.now(); saveConvs();
  const systemPrompt = projectSystemPrompt();
  const fingerprint = instructionFingerprint(conv.productMode || entry.productMode, systemPrompt);
  // Terminal sessions preserve their initial instruction context, so a changed
  // NoCLI.ai/project instruction set must start a clean session to apply.
  if (conv.instructionFingerprint !== fingerprint) { conv.sessionId = null; conv.instructionFingerprint = fingerprint; saveConvs(); }
  showChatView();
  addUserTurn(text, images);
  const requestId = rid() + rid();
  const turn = newAiTurn(model || 'NoCLI.ai');
  turn.conversationId = conv.id;
  activeTurns.set(requestId, turn);
  renderRecents(); syncComposerState();
  const provider = settings.providerProfiles.find((profile) => profile.id === (conv.providerProfileId || entry.providerProfileId)) || currentProviderProfile();
  const history = (conv.turns || []).filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string').slice(-40).map((turn) => ({ role: turn.role, content: turn.content }));
  const result = await window.nocli.chat(conv.model, combined, conv.sessionId, { systemPrompt, cwd: projectCwd(), images, requestId, productMode: conv.productMode || entry.productMode, provider, mode: settings.permissionMode, scope: settings.scope, grants: conv.grants || [], history });
  if (!result?.ok) {
    const failed = activeTurns.get(requestId);
    if (failed) { failed.turnEl.classList.add('error'); failed.streamEl.innerHTML = '<div class="block text">[error] ' + esc(result?.error || 'Could not start this chat.') + '</div>'; activeTurns.delete(requestId); renderRecents(); syncComposerState(); }
  }
}

// ---- slash-command autocomplete -------------------------------------------
const CORE_COMMANDS = [
  { name: 'model', args: '<name>', description: 'Choose a model', tag: 'Codex' },
  { name: 'permissions', description: 'Open execution permissions', tag: 'Codex' },
  { name: 'review', args: '[focus]', description: 'Review current changes for issues', tag: 'Code' },
  { name: 'diff', description: 'Show the current git diff', tag: 'Code' },
  { name: 'init', description: 'Create or update AGENTS.md instructions', tag: 'Code' },
  { name: 'plan', args: '[task]', description: 'Plan work before editing', tag: 'Work' },
  { name: 'goal', args: '[goal]', description: 'Set or view the task goal', tag: 'Work' },
  { name: 'skills', description: 'List relevant skills for this task', tag: 'Code' },
  { name: 'mcp', args: '[verbose]', description: 'List configured MCP tools', tag: 'Code' },
  { name: 'pwd', description: 'Show the current workspace path', tag: 'NoCLI.ai' },
  { name: 'cwd', description: 'Alias for /pwd', tag: 'NoCLI.ai' },
  { name: 'status', description: 'Show session, model, and permission status', tag: 'NoCLI.ai' },
  { name: 'compact', description: 'Start a fresh model context', tag: 'NoCLI.ai' },
  { name: 'new', description: 'Start a new chat', tag: 'NoCLI.ai' },
  { name: 'clear', description: 'Clear the current chat', tag: 'NoCLI.ai' },
  { name: 'help', description: 'Show commands and shortcuts', tag: 'NoCLI.ai' },
  { name: 'export', description: 'Copy this conversation as Markdown', tag: 'NoCLI.ai' },
  { name: 'rename', args: '<title>', description: 'Rename this conversation', tag: 'NoCLI.ai' },
  { name: 'agents', description: 'Open all active subagents', tag: 'NoCLI.ai' },
  { name: 'subagents', description: 'Open this chat’s subagents', tag: 'NoCLI.ai' },
  { name: 'mention', args: '<file>', description: 'Add a file to the task context', tag: 'Code' },
];
const COMMAND_PROMPTS = {
  review: (args) => `Review the current workspace changes${args ? `, focusing on ${args}` : ''}. Inspect the real diff and report concrete issues, risks, and verification steps.`,
  diff: () => 'Show the current git diff, including untracked files where possible, and explain the meaningful changes.',
  init: () => 'Create or update an AGENTS.md file for this workspace. Inspect the repository first and preserve existing instructions.',
  plan: (args) => `Make a concise implementation plan${args ? ` for: ${args}` : ' for the current task'}. Do not edit files until the plan is clear.`,
  goal: (args) => args ? `Treat this as the active task goal: ${args}. Restate the goal, constraints, and next verified step.` : 'State the current task goal, constraints, and next verified step.',
  skills: () => 'Inspect the available project skills/instructions and list only the ones relevant to this task, with when to use them.',
  mcp: (args) => `List the configured MCP tools${args ? ` in ${args} detail` : ''}, their purpose, and which are available in this session.`,
  mention: (args) => `Add the workspace file ${args || '(missing file path)'} to the task context. Inspect it and summarize the relevant parts before proceeding.`,
};
function conversationMarkdown(conv) {
  if (!conv) return '';
  return (conv.turns || []).map((turn) => `## ${turn.role === 'user' ? 'You' : 'NoCLI.ai'}\n\n${turn.content || ''}`).join('\n\n');
}
function runSlashCommand(input) {
  // A slash token can appear after context in the prompt, not only at column 1.
  const source = String(input || '').trim();
  const match = [...source.matchAll(/(?:^|\s)\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?/g)].at(-1);
  if (!match) return false;
  const args = (match[2] || '').trim();
  const command = match[1].toLowerCase() === 'cwd' ? 'pwd' : match[1].toLowerCase();
  if (!CORE_COMMANDS.some((item) => item.name === command)) return false;
  clearInput(); clearAttachments();
  if (command === 'new' || command === 'clear') { newChat(); addSysNote('Started a new chat.'); showChatView(); scrollBottom(); return true; }
  if (command === 'help') { showHelp(); return true; }
  if (command === 'model') { args ? setModelByName(args) : openModelPicker(); return true; }
  if (command === 'permissions') { openSettings(); return true; }
  if (command === 'agents' || command === 'subagents') { setSubagentsOpen(true); return true; }
  if (command === 'pwd') { showChatView(); addSysNote(projectCwd() || 'No workspace selected.'); scrollBottom(); return true; }
  if (command === 'status') {
    const conv = activeId && conversations.find((item) => item.id === activeId);
    showChatView(); addSysNote(`Scope: ${scopeMeta().label}\nEngine: ${ENGINE_META[currentProviderProfile()?.engine || 'kimi'].label}\nModel: ${$('model').value || 'none'}\nWorkspace: ${projectCwd() || 'none'}\nSession: ${conv?.sessionId ? 'resumable' : 'new context'}`); scrollBottom(); return true;
  }
  if (command === 'compact') {
    const conv = activeId && conversations.find((item) => item.id === activeId);
    if (conv) { conv.sessionId = null; saveConvs(); }
    showChatView(); addSysNote('Started a fresh model context. The visible transcript is preserved.'); scrollBottom(); return true;
  }
  if (command === 'export') {
    const conv = activeId && conversations.find((item) => item.id === activeId);
    const markdown = conversationMarkdown(conv);
    if (!markdown) { addSysNote('There is no conversation to export yet.'); return true; }
    navigator.clipboard.writeText(markdown).then(() => addSysNote('Conversation copied as Markdown.')).catch(() => addSysNote('Could not copy the conversation to the clipboard.')); return true;
  }
  if (command === 'rename') {
    const conv = activeId && conversations.find((item) => item.id === activeId);
    if (!conv || !args) { addSysNote('Usage: /rename <title>'); return true; }
    conv.title = args.slice(0, 120); conv.updatedAt = Date.now(); saveConvs(); renderRecents(); addSysNote('Conversation renamed.'); return true;
  }
  const promptFactory = COMMAND_PROMPTS[command];
  if (promptFactory) {
    const workspaceCommands = ['review', 'diff', 'init', 'plan', 'goal', 'skills', 'mcp', 'mention'];
    if (settings.scope === 'chat' && workspaceCommands.includes(command)) { addSysNote(`/${command} needs a workspace scope. Switch the composer badge off \u201cJust chat\u201d.`); return true; }
    const prompt = promptFactory(args);
    startMessage({ text: prompt, combined: prompt, images: [], productMode: settings.productMode, providerProfileId: currentProviderProfile()?.id, model: currentProviderProfile()?.model || $('model').value });
    return true;
  }
  return false;
}
let allCommands = CORE_COMMANDS;
let cmdOpen = false, cmdItems = [], cmdSel = 0;
function showCoreCommands(prefix) {
  const matches = CORE_COMMANDS.filter((c) => c.name.startsWith(prefix));
  if (!matches.length) return closeCmdList();
  cmdItems = matches; cmdSel = 0;
  const box = $('cmdlist');
  box.innerHTML = '<div class="cmdhead">NoCLI.ai commands</div>' + matches.map((c, i) =>
    '<div class="cmditem' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '"><span class="cmdname">/' + c.name + '</span><span class="cmddesc">' + c.description + '</span><span class="cmdtag">' + c.tag + '</span></div>'
  ).join('');
  box.classList.add('show'); cmdOpen = true;
  box.querySelectorAll('.cmditem').forEach((el) => { el.onmousedown = (ev) => { ev.preventDefault(); chooseCmd(+el.dataset.i); }; });
}

async function openCmdList() {
  const prompt = $('prompt');
  const value = prompt.value.slice(0, prompt.selectionStart ?? prompt.value.length);
  const m = [...value.matchAll(/(?:^|\s)\/([A-Za-z0-9_:.-]*)$/g)].at(-1);
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
  const prompt = $('prompt');
  const cursor = prompt.selectionStart ?? prompt.value.length;
  const before = prompt.value.slice(0, cursor);
  const token = [...before.matchAll(/(?:^|\s)\/([A-Za-z0-9_:.-]*)$/g)].at(-1);
  const start = token ? token.index + (token[0].startsWith(' ') ? 1 : 0) : cursor;
  prompt.value = prompt.value.slice(0, start) + '/' + c.name + ' ' + prompt.value.slice(cursor);
  prompt.selectionStart = prompt.selectionEnd = start + c.name.length + 2;
  closeCmdList(); autosize(); $('prompt').focus();
}

// ---- wiring ----------------------------------------------------------------
$('send').onclick = () => {
  send();
};
$('stopRun').onclick = () => {
  const turn = currentTurn(); if (!turn) return;
  const requestId = [...activeTurns.entries()].find(([, value]) => value === turn)?.[0];
  if (requestId) { stopping.add(requestId); window.nocli.stop(requestId); }
};
$('steer').onclick = () => {
  const turn = currentTurn(); const entry = takeComposerEntry();
  if (!turn || !entry) return;
  const requestId = [...activeTurns.entries()].find(([, value]) => value === turn)?.[0];
  if (!requestId) return;
  queueMessage(activeId, entry, true); steering.add(requestId); window.nocli.steer(requestId);
};
$('newchat').onclick = () => newChat();
$('model').onchange = () => {
  const profile = currentProviderProfile();
  if (profile?.kind === 'ollama') saveState('omodel', $('model').value);
  else if (profile?.kind === 'opencode') { profile.model = $('model').value; $('providerModel').value = profile.model; saveSettings(); }
  syncModelButton(); if (swarmMode) syncSwarmRoles();
};
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
let browserWidth = Math.max(340, Math.min(640, Number(localStorage.getItem('nocli-browser-width')) || 400));
let subagentsOpen = false; const subagents = new Map();
function renderSubagents() { const list = $('subagentsList'); list.innerHTML = ''; if (!subagents.size) { list.textContent = 'No delegated tasks yet.'; return; } for (const a of subagents.values()) { const card = document.createElement('div'); card.className = 'subagent-card'; card.innerHTML = '<strong>' + esc(a.task || 'Subagent task') + '</strong><div class="subagent-meta">' + esc(a.model || 'selected model') + ' · ' + esc(a.status || 'working') + '</div>' + (a.result ? '<div class="subagent-result">' + esc(a.result) + '</div>' : ''); list.appendChild(card); } }
function setSubagentsOpen(open) { subagentsOpen = open; $('subagentsPanel').classList.toggle('show', open); $('subagentsToggle').classList.toggle('active', open); $('subagentsToggle').setAttribute('aria-expanded', String(open)); if (open) renderSubagents(); }
function syncBrowserBounds() {
  if (!browserOpen) return;
  const r = $('browserSlot').getBoundingClientRect();
  window.nocli.browserShow({ x: r.x, y: r.y, width: r.width, height: r.height });
}
function setBrowserWidth(width) {
  const viewWidth = $('view-chat').getBoundingClientRect().width;
  const maximum = Math.max(340, Math.min(640, viewWidth - 440));
  browserWidth = Math.round(Math.max(340, Math.min(maximum, width)));
  $('browserPanel').style.setProperty('--browser-panel-width', browserWidth + 'px');
  localStorage.setItem('nocli-browser-width', String(browserWidth));
  requestAnimationFrame(syncBrowserBounds);
}
function setBrowserOpen(open) {
  browserOpen = open; $('view-chat').classList.toggle('browser-open', open); $('browserPanel').classList.toggle('show', open); $('browserToggle').classList.toggle('active', open);
  $('browserToggle').setAttribute('aria-expanded', String(open));
  $('browserToggle').title = open ? 'Close agent browser' : 'Open agent browser';
  if (open) { setBrowserWidth(browserWidth); requestAnimationFrame(syncBrowserBounds); } else window.nocli.browserHide();
}
function openBrowserAt(url) {
  setBrowserOpen(true); $('browserUrl').value = url; window.nocli.browserNavigate(url);
}
$('browserToggle').onclick = () => setBrowserOpen(!browserOpen);
$('browserResizeHandle').addEventListener('pointerdown', (event) => {
  if (window.matchMedia('(max-width: 760px)').matches) return;
  const startX = event.clientX, startWidth = browserWidth;
  const move = (next) => setBrowserWidth(startWidth + startX - next.clientX);
  const end = () => { document.body.classList.remove('browser-resizing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
  document.body.classList.add('browser-resizing'); event.currentTarget.setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
});
$('browserResizeHandle').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); setBrowserWidth(browserWidth + (event.key === 'ArrowLeft' ? 20 : -20));
});
$('subagentsToggle').onclick = () => setSubagentsOpen(!subagentsOpen); $('subagentsClose').onclick = () => setSubagentsOpen(false);
$('sentryModalClose').onclick = closeSentryModal;
$('sentryModalBackdrop').onclick = closeSentryModal;
$('sentryModalCopy').onclick = () => copyToClipboard($('sentryModalText').textContent || '', $('sentryModalCopy'));
$('sentryModalRetry').onclick = () => { if (sentryModalTarget) retrySwarmWorker(sentryModalTarget.session, sentryModalTarget.agent); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('sentryAgentModal').hidden) closeSentryModal(); });
$('windowMinimize').onclick = () => window.nocli.windowControl('minimize');
$('windowMaximize').onclick = () => window.nocli.windowControl('maximize');
$('windowClose').onclick = () => window.nocli.windowControl('close');
$('browserClose').onclick = () => setBrowserOpen(false);
$('browserBack').onclick = () => window.nocli.browserAction('back');
$('browserForward').onclick = () => window.nocli.browserAction('forward');
$('browserReload').onclick = () => window.nocli.browserAction('reload');
$('browserUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') openBrowserAt($('browserUrl').value.trim()); });
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && browserOpen) { event.preventDefault(); $('browserUrl').focus(); $('browserUrl').select(); }
  if (event.key === 'Escape' && browserOpen && document.activeElement === $('browserUrl')) { $('browserUrl').blur(); }
});
window.addEventListener('resize', () => requestAnimationFrame(syncBrowserBounds));
window.nocli.on('browser-status', (s) => { if (s.url) $('browserUrl').value = s.url; if (s.title) $('browserPageTitle').textContent = s.title; $('browserBack').disabled = !s.canBack; $('browserForward').disabled = !s.canForward; });
window.nocli.on('browser-invoked', (s) => { setBrowserOpen(true); if (s?.url) $('browserUrl').value = s.url; });
window.nocli.on('subagent-update', (agent) => {
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
for (const btn of document.querySelectorAll('[data-product-mode]')) btn.onclick = () => selectProductMode(btn.dataset.productMode);
$('automationForm').onsubmit = (event) => {
  event.preventDefault();
  const name = $('automationName').value.trim(); const prompt = $('automationPrompt').value.trim(); const cadence = $('automationCadence').value;
  if (!name || !prompt) return;
  automations.unshift({ id: rid(), name, prompt, cadence, scope: activeProductMode() === 'chat' ? 'full' : settings.scope, enabled: true, createdAt: Date.now(), nextRunAt: Date.now() + cadenceMs(cadence) });
  saveAutomations(); event.target.reset(); $('automationCadence').value = 'daily'; renderAutomations();
};
$('projectsPageAdd').onclick = () => { openSettings(); setTimeout(() => $('projName').focus(), 0); };
$('settingsClose').onclick = closeSettings;
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
$('sysPrompt').addEventListener('input', () => { settings.systemPrompt = $('sysPrompt').value; saveSettings(); });
$('themeSel').onchange = () => { settings.theme = $('themeSel').value; settings.colors = { ...THEME_PALETTES[settings.theme] }; settings.accent = settings.colors.accent; saveSettings(); applyAppearance(); syncPaletteInputs(); };
$('densitySel').onchange = () => { settings.density = $('densitySel').value; saveSettings(); applyAppearance(); };
$('motionSel').onchange = () => { settings.motion = $('motionSel').value; saveSettings(); applyAppearance(); };
$('fontSel').onchange = () => { settings.font = $('fontSel').value; saveSettings(); applyAppearance(); };
function syncScope() {
  if (!SCOPE_ORDER.includes(settings.scope)) settings.scope = 'chat';
  applyScope();
  syncModes();
  syncWorkspaceShell();
  refreshModelCapabilityBadge();
}
// The engine list is rendered from what is actually installed, so an
// unavailable harness is visible and labelled instead of failing at spawn.
function syncEngineSelect() {
  const select = $('engineSel');
  if (!select) return;
  const provider = currentProviderProfile();
  const active = ENGINE_ORDER.includes(provider?.engine) ? provider.engine : 'kimi';
  select.innerHTML = '';
  for (const id of ENGINE_ORDER) {
    const state = engineAvailability[id];
    const option = document.createElement('option');
    option.value = id;
    option.textContent = ENGINE_META[id].label + (state && state.installed === false ? ' \u2014 not installed' : state?.version ? ' \u00b7 ' + state.version : '');
    if (state && state.installed === false) option.disabled = true;
    select.appendChild(option);
  }
  select.value = active;
  if ($('engineInfo')) $('engineInfo').textContent = ENGINE_META[active].hint;
}
async function loadEngineAvailability() {
  try { engineAvailability = await window.nocli.engineAvailability() || {}; } catch { engineAvailability = {}; }
  syncEngineSelect();
}
// Permission mode: a segmented control rather than a <select>, because the
// difference between the three is the description, not the label.
function syncModes() {
  for (const btn of document.querySelectorAll('#modes .mode')) {
    const on = btn.dataset.mode === settings.scope;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  const permission = $('permissionSel'); if (permission) { permission.value = settings.permissionMode === 'full' ? 'full' : settings.permissionMode === 'approve' ? 'approve' : 'auto'; permission.disabled = settings.productMode === 'chat'; }
  const reasoning = $('reasoningSel'); if (reasoning) reasoning.value = settings.reasoning || 'auto';
}
for (const btn of document.querySelectorAll('#modes .mode')) {
  btn.onclick = () => { settings.scope = btn.dataset.mode; syncScope(); saveSettings(); };
}
$('permissionSel').onchange = () => { const mode = $('permissionSel').value; settings.permissionMode = mode; settings.scope = settings.productMode === 'agent' ? 'full' : mode === 'approve' ? 'read' : mode === 'full' ? 'full' : 'edit'; syncScope(); saveSettings(); };
$('reasoningSel').onchange = () => { settings.reasoning = $('reasoningSel').value; saveSettings(); };
$('engineSel').onchange = () => {
  const provider = currentProviderProfile();
  if (!provider) return;
  provider.engine = $('engineSel').value;
  saveSettings(); syncEngineSelect();
};
$('providerProfileSel').onchange = async () => { settings.activeProviderProfileId = $('providerProfileSel').value; saveSettings(); renderProviderProfiles(); syncEngineSelect(); if (currentProviderProfile()?.kind === 'opencode') await refreshOpenCodeModels(); else applyProviderModelChoices(); if (swarmMode) syncSwarmRoles(); };
$('providerUseOllama').onclick = useLocalOllama;
$('providerNew').onclick = startApiProviderSetup;
$('providerKind').onchange = syncProviderRouteFields;
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
window.nocli.on('llamacpp-install-progress', (p) => {
  if (!p) return;
  if (p.phase === 'download') {
    const pct = p.total ? Math.round((p.received / p.total) * 100) + '%' : formatBytes(p.received);
    $('llamaCppInstallStatus').textContent = `Downloading ${p.label}… ${pct}`;
  } else if (p.phase === 'extract') $('llamaCppInstallStatus').textContent = 'Extracting…';
});
window.nocli.on('llamacpp-status-change', (update) => {
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
$('recents-label').onclick = openSettings;
$('recentPopupToggle').onclick = (event) => { event.stopPropagation(); toggleRecentPopup(); };
document.addEventListener('click', (event) => { const popup = $('recentPopup'); if (popup?.classList.contains('show') && !popup.contains(event.target) && event.target !== $('recentPopupToggle')) closeRecentPopup(); });
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
  const picked = await window.nocli.pickFolder();
  if (!picked) return;
  defaultWorkspace = picked;
  $('workspacePath').value = picked;
  saveState('oworkspace', picked);
};
$('projInstr').addEventListener('input', () => { const p = activeProject(); if (p) { p.instructions = $('projInstr').value; saveProjects(); } });
function describeDependency(name, value) { return name + ': ' + (value ? value.replace(/\s+/g, ' ').slice(0, 48) : 'missing'); }
async function refreshAppInfo() {
  const info = await window.nocli.appInfo();
  $('versionInfo').textContent = 'NoCLI.ai v' + info.version + ' · ' + [describeDependency('Ollama', info.dependencies.ollama), describeDependency('Kimi Code', info.dependencies.kimi), describeDependency('Codex CLI', info.dependencies.codex), describeDependency('Claude Code', info.dependencies.claude), describeDependency('Node', info.dependencies.node)].join(' · ');
}
let availableAppUpdate = null;
function showUpdateToast(update) {
  availableAppUpdate = update;
  $('profileUpdateBadge').hidden = false;
  $('updateToastTitle').textContent = 'NoCLI.ai ' + update.version + ' is ready';
  $('updateToastBody').textContent = 'A verified update is ready to download.';
  $('updateToast').classList.add('show');
}
function showAvailableUpdate(update) {
  availableAppUpdate = update;
  $('profileUpdateBadge').hidden = false;
  $('maintenanceInfo').textContent = 'NoCLI.ai v' + update.version + ' is ready to download.';
  const packageLabel = update.packageLabel || 'installer';
  showUpdateDialog('NoCLI.ai ' + update.version + ' is ready', 'Download the verified ' + packageLabel + ' now? NoCLI.ai checks its SHA-256 before it can open it.', [
    { label: 'Later', run: () => {} },
    { label: 'Download and open', primary: true, onStart: () => { $('updateBody').textContent = 'Downloading NoCLI.ai ' + update.version + '…\n\nThis can take a minute. The ' + packageLabel + ' is verified before NoCLI.ai opens it.'; }, run: async () => { const file = await window.nocli.downloadAppUpdate(); if (file?.error) return file; return window.nocli.openUpdateInstaller(file.path); } },
  ]);
}
async function checkAppUpdate({ manual = false } = {}) {
  const button = $('appUpdateBtn'); if (manual) { button.disabled = true; $('maintenanceInfo').textContent = 'Checking for an NoCLI.ai update…'; }
  try {
    const update = await window.nocli.checkAppUpdate();
    if (update?.error) { $('maintenanceInfo').textContent = 'Update check failed: ' + update.error; return; }
    if (!update.available) { $('maintenanceInfo').textContent = 'NoCLI.ai is up to date (v' + update.current + ').'; return; }
    showUpdateToast(update); if (manual) showAvailableUpdate(update);
  } catch (error) { $('maintenanceInfo').textContent = 'Update check failed: ' + (error?.message || 'Unknown error'); }
  finally { if (manual) button.disabled = false; }
}
$('appUpdateBtn').onclick = () => checkAppUpdate({ manual: true });
window.nocli.on('app-update-available', (update) => { if (update?.available) showUpdateToast(update); });
$('updateToastAction').onclick = () => { $('updateToast').classList.remove('show'); if (availableAppUpdate) showAvailableUpdate(availableAppUpdate); };
$('updateToastDismiss').onclick = () => $('updateToast').classList.remove('show');
window.nocli.on('app-update-progress', (p) => {
  const status = 'Downloading NoCLI.ai update: ' + Math.min(100, Math.round(p.received / p.total * 100)) + '%';
  $('maintenanceInfo').textContent = status;
  if ($('updateModal').classList.contains('show')) $('updateBody').textContent = status + '\n\nVerifying the ' + (availableAppUpdate?.packageLabel || 'installer') + ' before NoCLI.ai opens it.';
});
$('depsBtn').onclick = async () => {
  $('depsBtn').disabled = true; $('maintenanceInfo').textContent = 'Downloading missing dependencies…';
  try { const result = await window.nocli.installDependencies(); $('maintenanceInfo').textContent = result.steps.join(' · ') || 'Everything required is already installed.'; await refreshAppInfo(); }
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
    if (lanServerOn) window.nocli.workspaceSeed(conversations).catch(() => {});
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
window.nocli.on('lan-status', updateLan);
window.nocli.on('models-changed', () => loadModels());
window.nocli.on('workspace-init', ({ host, conversations: shared }) => {
  $('lanWorkspaceInfo').textContent = 'Shared with ' + host + ': host models, shared chat history, and remote runs.';
  applySharedConversations(shared);
});
window.nocli.on('workspace-snapshot', ({ conversations: shared }) => applySharedConversations(shared));
function renderLanDevices(devices) {
  const box = $('lanDevices'); box.innerHTML = '';
  if (!devices?.length) { const empty = document.createElement('div'); empty.className = 'lan-info'; empty.textContent = 'No other NoCLI.ai devices found yet. Open NoCLI.ai on the other device and keep both on the same Wi-Fi.'; box.appendChild(empty); return; }
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
      const result = await window.nocli.lanConnectDevice(device);
      if (result?.ok) { $('lanHost').value = device.host + ':' + device.port; saveState('olanHost', $('lanHost').value); }
      setUpdateInfo(result?.error ? result.error : 'Connecting to ' + device.name + '…');
    };
    const request = document.createElement('button'); request.textContent = 'Request update'; request.disabled = !device.available;
    request.title = 'Ask this Host to share an NoCLI.ai installer';
    request.onclick = async () => {
      const result = await window.nocli.lanRequestDeviceUpdate(device);
      setUpdateInfo(result?.error ? result.error : 'Request sent to ' + device.name + '. It will appear in that device\'s NoCLI.ai window.');
    };
    actions.append(connect, request); row.append(meta, actions); box.appendChild(row);
  }
}
window.nocli.on('lan-devices', renderLanDevices);
$('lanServerChk').onchange = (e) => { saveState('olanHostEnabled', e.target.checked); window.nocli.lanServer(e.target.checked); };
$('lanCopyHost').onclick = async () => {
  const address = $('lanCopyHost').dataset.address;
  if (!address) return;
  try { await navigator.clipboard.writeText(address); $('lanCopyHost').textContent = 'Copied'; setTimeout(() => { $('lanCopyHost').textContent = 'Copy Host address'; }, 1200); }
  catch { setUpdateInfo('Could not copy the Host address — use ' + address + '.'); }
};
$('lanConnBtn').onclick = () => {
  if ($('lanConnBtn').dataset.mode === 'disc') window.nocli.lanDisconnect();
  else { const h = $('lanHost').value.trim(); if (h) { saveState('olanHost', h); window.nocli.lanConnect(h); } }
};
$('updatePickBtn').onclick = async () => {
  const result = await window.nocli.selectUpdateInstaller();
  setUpdateInfo(result?.error ? result.error : (result ? 'Ready to share ' + result.name + ' (' + formatBytes(result.bytes) + ').' : 'No installer selected.'));
};
$('updateOfferBtn').onclick = async () => {
  const result = await window.nocli.offerUpdate();
  setUpdateInfo(result?.error ? result.error : 'Offer sent to linked clients. They must accept before transfer starts.');
};
$('updateRequestBtn').onclick = async () => {
  const result = await window.nocli.requestUpdate();
  setUpdateInfo(result?.error ? result.error : 'Request sent. The Host must approve it first.');
};
window.nocli.on('lan-update-request', (request) => {
  const actions = [{ label: 'Decline', run: () => window.nocli.respondUpdateRequest(request.id, false) }];
  if (request.hasInstaller) actions.push({ label: 'Offer update', primary: true, run: () => window.nocli.respondUpdateRequest(request.id, true) });
  const requester = request.requester || 'A linked client';
  showUpdateDialog(requester + ' requested an update', request.hasInstaller ? requester + ' is asking for the installer you selected. Share it?' : requester + ' is asking for an update, but this Host has not selected an installer.', actions);
});
window.nocli.on('lan-update-offer', (offer) => {
  showUpdateDialog('Update available', 'The Host offers ' + offer.name + ' (' + formatBytes(offer.bytes) + ').\n\nNoCLI.ai verifies its SHA-256 before the installer can open.', [
    { label: 'Decline', run: () => window.nocli.acceptUpdateOffer(offer.id, false) },
    { label: 'Download update', primary: true, run: () => window.nocli.acceptUpdateOffer(offer.id, true) },
  ]);
});
window.nocli.on('lan-update-progress', (p) => setUpdateInfo((p.role === 'host' ? 'Sending' : 'Receiving') + ' update: ' + Math.min(100, Math.round(p.received / p.total * 100)) + '%'));
window.nocli.on('lan-update-error', (e) => setUpdateInfo('Update error: ' + (e.message || 'Transfer failed.')));
window.nocli.on('lan-update-ready', (update) => {
  setUpdateInfo('Verified update ready: ' + update.name);
  showUpdateDialog('Verified update ready', update.name + ' passed its SHA-256 check. Open the installer now?', [
    { label: 'Later', run: () => {} },
    { label: 'Open installer', primary: true, run: () => window.nocli.openUpdateInstaller(update.path) },
  ]);
});

// greeting by time of day
(function () {
  $('greet').textContent = greetingForTime();
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
    Object.assign(persisted, await window.nocli.loadState());
    // One-time migration from the original renderer-only store.
    for (const key of ['osettings', 'oprojects', 'oconvs', 'oswarmSessions', 'oautomations', 'omodel', 'oRuntime', 'oExoUrl', 'olanHost', 'olanHostEnabled', 'oactiveProject', 'odraft', 'oworkspace', 'ocloudModels', 'ouserProfile']) {
      if (persisted[key] === undefined) {
        const oldValue = localStorage.getItem(key);
        if (oldValue === null) continue;
        try { persisted[key] = ['osettings', 'oprojects', 'oconvs', 'oswarmSessions', 'oautomations', 'ocloudModels'].includes(key) ? JSON.parse(oldValue) : oldValue; }
        catch { continue; }
      }
    }
    window.nocli.saveState(persisted).catch(() => {});
  } catch {}
  loadSettings();
  loadProjects();
  defaultWorkspace = await window.nocli.ensureWorkspace();
  if (persisted.oworkspace !== defaultWorkspace) saveState('oworkspace', defaultWorkspace);
  $('workspacePath').value = defaultWorkspace;
  loadConvs();
  loadSwarmSessions();
  automations = Array.isArray(persisted.oautomations) ? persisted.oautomations : [];
  activeProjectId = projects.some((p) => p.id === persisted.oactiveProject) ? persisted.oactiveProject : null;
  $('lanHost').value = persisted.olanHost || '';
  $('lanServerChk').checked = persisted.olanHostEnabled === true;
  $('prompt').value = typeof persisted.odraft === 'string' ? persisted.odraft : '';
  autosize();
  applyAppearance();
  syncScope();
  syncProductMode();
  syncModes();
  renderRecents();
  updateProjectLabel();
  refreshAppInfo().catch(() => { $('versionInfo').textContent = 'Version information unavailable.'; });
  if ($('lanServerChk').checked) window.nocli.lanServer(true);
  // Restore last active view
  const savedView = ['chat', 'projects', 'models', 'automations'].includes(persisted.oactiveView) ? persisted.oactiveView : 'chat';
  if (savedView !== 'chat') switchView(savedView);
  setLoading('Ready', true);
  // Open the workspace first. LAN discovery and local model inventory can be
  // slow on first launch, so let them hydrate without blocking the UI.
  setTimeout(async () => {
    try { renderLanDevices(await window.nocli.lanRefresh()); } catch {}
    try { await loadModels(); } catch {}
  }, 0);
  setInterval(checkAutomations, 30000); checkAutomations();
})();
