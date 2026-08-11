// Minimal chat on the Claude Code harness, routed to the selected Ollama model.
// Style: "Relay" modernist (light/dark, sidebar, surface composer card). Features:
// slash-command autocomplete, system prompt + appearance settings, file attachments,
// folder-workspace projects, markdown rendering, copy, per-turn model labels.
const $ = (id) => document.getElementById(id);
const rid = () => Math.random().toString(36).slice(2);

let conversations = [];   // [{id, sessionId, title, model, ts, projectId}]
let activeId = null;      // current conversation id (null = home/fresh)
let active = null;        // streaming turn: { turnEl, stepsEl, bubbleEl, think, cursor, content, started, model }
let busy = false, stopping = false;

// ---- settings / appearance --------------------------------------------------
const DEFAULT_SETTINGS = { systemPrompt: '', accent: '#2a4bd6', theme: 'light', density: 'normal' };
let settings = { ...DEFAULT_SETTINGS };
const ACCENTS = ['#2a4bd6', '#007d5a', '#b03060', '#8a3df0', '#c2410c', '#111827'];
const persisted = {};
function loadSettings() { try { settings = { ...DEFAULT_SETTINGS, ...(persisted.osettings || {}) }; } catch {} }
function saveState(key, value) { persisted[key] = value; window.ollama.saveState({ [key]: value }).catch(() => {}); }
function saveSettings() { saveState('osettings', settings); }
function applyAppearance() {
  const r = document.documentElement;
  r.style.setProperty('--color-accent', settings.accent);
  r.dataset.theme = settings.theme;
  r.classList.remove('density-compact', 'density-comfortable');
  if (settings.density === 'compact') r.classList.add('density-compact');
  else if (settings.density === 'comfortable') r.classList.add('density-comfortable');
  refreshGridColor();
}
function renderSwatches() {
  const box = $('swatches'); box.innerHTML = '';
  for (const c of ACCENTS) {
    const s = document.createElement('span');
    s.className = 'sw' + (c.toLowerCase() === settings.accent.toLowerCase() ? ' sel' : '');
    s.style.background = c; s.title = c;
    s.onclick = () => { settings.accent = c; saveSettings(); applyAppearance(); renderSwatches(); };
    box.appendChild(s);
  }
  const ci = document.createElement('input');
  ci.type = 'color'; ci.value = ACCENTS.includes(settings.accent) ? '#2a4bd6' : settings.accent;
  ci.title = 'Custom color';
  ci.oninput = () => { settings.accent = ci.value; saveSettings(); applyAppearance(); renderSwatches(); };
  box.appendChild(ci);
}
function openSettings() {
  $('sysPrompt').value = settings.systemPrompt;
  $('themeSel').value = settings.theme;
  $('densitySel').value = settings.density;
  renderSwatches(); renderProjects();
  $('settings').classList.add('show');
}
function closeSettings() { $('settings').classList.remove('show'); }

// ---- projects (folder workspaces) -----------------------------------------
let projects = [];        // [{id, name, path, instructions}]
let activeProjectId = null;
function loadProjects() { try { projects = Array.isArray(persisted.oprojects) ? persisted.oprojects : []; } catch {} }
function saveProjects() { saveState('oprojects', projects); }
function activeProject() { return projects.find((p) => p.id === activeProjectId) || null; }
function projectCwd() { return activeProject()?.path || null; }
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
    d.onclick = () => { activeProjectId = p.id; saveState('oactiveProject', activeProjectId); renderProjects(); renderRecents(); updateProjectLabel(); };
    const del = document.createElement('button'); del.className = 'pdel'; del.textContent = '✕'; del.title = 'Delete project (keeps chats)';
    del.onclick = (e) => { e.stopPropagation(); projects = projects.filter((x) => x.id !== p.id); if (activeProjectId === p.id) { activeProjectId = null; saveState('oactiveProject', null); } saveProjects(); renderProjects(); renderRecents(); updateProjectLabel(); };
    d.appendChild(del); box.appendChild(d);
  }
  const p = activeProject();
  const wrap = $('projInstrWrap');
  if (p) { wrap.style.display = ''; $('projInstrLabel').textContent = 'Instructions — ' + p.name; $('projInstr').value = p.instructions || ''; }
  else wrap.style.display = 'none';
}
function updateProjectLabel() {
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
async function loadModels() {
  setLoading('Checking local models…');
  try {
    const data = await window.ollama.listModels();
    const sel = $('model'); sel.innerHTML = '';
    const models = data.models || [];
    if (!models.length) return setStatus(false, 'no models');
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = m.name + (m.details?.parameter_size ? ' · ' + m.details.parameter_size : '');
      sel.appendChild(o);
    }
    const pref = persisted.omodel;
    if (pref && models.some((m) => m.name === pref)) sel.value = pref;
    setStatus(true, 'ready');
  } catch { setStatus(false, 'offline'); }
}
function setModelByName(name) {
  const sel = $('model');
  const opt = [...sel.options].find((o) => o.value === name || o.value.startsWith(name));
  if (opt) { sel.value = opt.value; saveState('omodel', sel.value); showChatView(); addSysNote('Model set to ' + opt.value + '.'); }
  else { showChatView(); addSysNote('Model "' + name + '" not found. Available: ' + [...sel.options].map((o) => o.value).join(', ')); }
  scrollBottom();
}

// ---- conversations / recents ----------------------------------------------
function loadConvs() { try { conversations = Array.isArray(persisted.oconvs) ? persisted.oconvs : []; } catch { conversations = []; } }
function saveConvs() { saveState('oconvs', conversations.slice(0, 50)); }
function renderRecents() {
  const box = $('recents'); box.innerHTML = '';
  const visible = conversations.filter((c) => (c.projectId || null) === activeProjectId);
  if (!visible.length) {
    const e = document.createElement('div'); e.style.cssText = 'font-size:12px;opacity:.4;padding:7px 8px';
    e.textContent = activeProjectId ? 'No chats in this project yet.' : 'No chats yet.'; box.appendChild(e);
  }
  for (const c of visible) {
    const d = document.createElement('div');
    d.className = 'recent' + (c.id === activeId ? ' active' : '');
    d.textContent = c.title || '(empty)';
    d.title = c.title || '';
    d.onclick = () => openConv(c.id);
    const del = document.createElement('span'); del.className = 'rdel'; del.textContent = '✕'; del.title = 'Delete chat';
    del.onclick = (e) => { e.stopPropagation(); conversations = conversations.filter((x) => x.id !== c.id); saveConvs(); if (activeId === c.id) newChat(); else renderRecents(); };
    d.appendChild(del); box.appendChild(d);
  }
}
function openConv(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  activeId = id;
  if (conv.model && [...$('model').options].some((o) => o.value === conv.model)) $('model').value = conv.model;
  showChatView();
  $('log').innerHTML = '';
  addSysNote('Resumed "' + conv.title + '" — earlier context is retained by the agent (prior messages aren’t re-shown).');
  renderRecents();
  scrollBottom();
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
function newChat() { activeId = null; $('log').innerHTML = ''; showHomeView(); renderRecents(); }

// ---- log helpers -----------------------------------------------------------
function addUserTurn(text, images = []) {
  const t = document.createElement('div'); t.className = 'turn user';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  t.appendChild(b); $('log').appendChild(t);
  if (images.length) {
    const gallery = document.createElement('div'); gallery.className = 'user-images';
    for (const image of images) { const pic = document.createElement('img'); pic.src = 'data:' + image.type + ';base64,' + image.data; pic.alt = image.name || 'Attached image'; gallery.appendChild(pic); }
    t.appendChild(gallery);
  }
}
function newAiTurn(model) {
  const t = document.createElement('div'); t.className = 'turn ai';
  const head = document.createElement('div'); head.className = 'turnhead';
  head.textContent = model || '';
  const steps = document.createElement('div'); steps.className = 'steps';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  const think = document.createElement('span'); think.className = 'think'; think.innerHTML = '<i></i><i></i><i></i>';
  bubble.appendChild(think);
  if (head.textContent) t.appendChild(head);
  t.appendChild(steps); t.appendChild(bubble); $('log').appendChild(t);
  scrollBottom();
  return { turnEl: t, stepsEl: steps, bubbleEl: bubble, think, cursor: null, content: '', started: false, model };
}
function addSysNote(text) {
  const t = document.createElement('div'); t.className = 'turn sys';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  t.appendChild(b); $('log').appendChild(t);
}
function addStep(s) {
  if (!active) return;
  active.stepsEl.querySelectorAll('.step.active').forEach((el) => el.classList.remove('active'));
  if (s.type === 'tool_call') {
    const d = document.createElement('div'); d.className = 'step tool active';
    d.innerHTML = '▸ <span class="fn">' + esc(s.fn) + '</span> ' + esc(typeof s.args === 'string' ? s.args : JSON.stringify(s.args));
    active.stepsEl.appendChild(d);
  } else if (s.type === 'tool_result') {
    const d = document.createElement('div'); d.className = 'step';
    const r = String(s.result).slice(0, 500);
    d.innerHTML = '<span class="res">↳ ' + esc(r) + (s.result.length > 500 ? ' …' : '') + '</span>';
    active.stepsEl.appendChild(d);
  }
  scrollBottom();
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
  let out = '', inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { out += '</ul>'; inUl = false; } if (inOl) { out += '</ol>'; inOl = false; } };
  for (const ln of lines) {
    const cm = ln.match(/^~~C(\d+)~~$/);
    if (cm) { closeLists(); out += codes[+cm[1]] + '\n'; continue; }
    if (/^\s*[-*]\s+/.test(ln)) { if (!inUl) { closeLists(); out += '<ul>'; inUl = true; } out += '<li>' + inline(ln.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { if (!inOl) { closeLists(); out += '<ol>'; inOl = true; } out += '<li>' + inline(ln.replace(/^\s*\d+\.\s+/, '')) + '</li>'; continue; }
    closeLists();
    if (/^###\s+/.test(ln)) out += '<h4>' + inline(ln.slice(4)) + '</h4>';
    else if (/^##\s+/.test(ln)) out += '<h3>' + inline(ln.slice(3)) + '</h3>';
    else if (/^#\s+/.test(ln)) out += '<h2>' + inline(ln.slice(2)) + '</h2>';
    else if (ln.trim() === '') out += '\n';
    else out += '<p>' + inline(ln) + '</p>';
  }
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
window.ollama.on('chat-delta', (d) => {
  if (!active) return;
  if (!active.started) {
    active.started = true;
    active.stepsEl.querySelectorAll('.step.active').forEach((el) => el.classList.remove('active'));
    if (active.think) { active.think.remove(); active.think = null; }
  }
  active.content += d;
  renderMarkdown(active.bubbleEl, active.content);
  scrollBottom();
});
window.ollama.on('chat-step', addStep);
window.ollama.on('chat-error', (msg) => { if (stopping) return; if (!active) return;
  if (active.think) { active.think.remove(); active.think = null; }
  active.turnEl.classList.add('error'); active.bubbleEl.textContent = '[error] ' + msg; });
window.ollama.on('chat-done', ({ sessionId } = {}) => {
  if (active) {
    if (active.think) { active.think.remove(); active.think = null; }
    active.stepsEl.querySelectorAll('.step.active').forEach((el) => el.classList.remove('active'));
    if (!active.started && !active.turnEl.classList.contains('error')) active.bubbleEl.textContent = '(no response)';
    else if (active.started) { renderMarkdown(active.bubbleEl, active.content); addCopyBtn(active.turnEl, active.content); }
  }
  active = null; setBusy(false); stopping = false;
  if (sessionId && activeId) {
    const conv = conversations.find((c) => c.id === activeId);
    if (conv && !conv.sessionId) { conv.sessionId = sessionId; saveConvs(); }
  }
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
function setBusy(b) {
  busy = b;
  $('send').textContent = b ? '■' : '→';
  $('send').className = b ? 'stop' : '';
  $('send').title = b ? 'Stop' : 'Send';
}

async function send() {
  if (busy) return;
  const text = $('prompt').value.trim();
  if (!text && !attachments.length) return;

  // built-in REPL commands (handled app-side; they don't exist in headless -p)
  if (text === '/clear' || text === '/new') { clearInput(); clearAttachments(); newChat(); addSysNote('Started a new chat.'); showChatView(); scrollBottom(); return; }
  if (text === '/help' || text.startsWith('/help ')) { clearInput(); showHelp(); return; }
  if (text === '/compact') { clearInput(); showChatView(); addSysNote('/compact isn’t available in headless mode — use /clear to start a fresh session.'); scrollBottom(); return; }
  if (text.startsWith('/model ')) { clearInput(); setModelByName(text.slice(7).trim()); return; }

  const combined = inlineAttachments(text);
  const images = attachments.filter((a) => a.image).map((a) => ({ name: a.name, type: a.type, data: a.data }));
  const model = $('model').value;
  const fileCount = attachments.length;
  clearInput(); clearAttachments();
  // create / reuse conversation
  let conv = activeId ? conversations.find((c) => c.id === activeId) : null;
  if (!conv) {
    conv = { id: rid(), sessionId: null, title: text.replace(/\s+/g, ' ').slice(0, 48) || '(attachment)', model, ts: Date.now(), projectId: activeProjectId };
    conversations.unshift(conv); activeId = conv.id; renderRecents();
  }
  showChatView();
  addUserTurn(text + (fileCount ? '  +' + fileCount + ' attachment' + (fileCount === 1 ? '' : 's') : ''), images);
  active = newAiTurn(model);
  setBusy(true);
  await window.ollama.chat(conv.model, combined, conv.sessionId, { systemPrompt: projectSystemPrompt(), cwd: projectCwd(), images });
}

// ---- slash-command autocomplete -------------------------------------------
// ponytail: known app-side commands appear instantly while the CLI discovery
// fills the rest of the list in the background.
const CORE_COMMANDS = [
  { name: 'new', description: 'Start a fresh chat', tag: 'Axion' },
  { name: 'clear', description: 'Start a fresh chat', tag: 'Axion' },
  { name: 'model', description: 'Switch the active model', tag: 'Axion' },
  { name: 'help', description: 'Show commands and shortcuts', tag: 'Axion' },
  { name: 'compact', description: 'Start fresh (headless fallback)', tag: 'Axion' },
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
$('send').onclick = () => (busy ? (stopping = true, window.ollama.stop()) : send());
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

// attachments
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { addFiles($('fileInput').files); $('fileInput').value = ''; };
const card = $('composerCard');
card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dragging'); });
card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('dragging'); });
card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('dragging'); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
$('prompt').addEventListener('paste', (e) => { const files = e.clipboardData?.files; if (files?.length) { e.preventDefault(); addFiles(files); } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (cmdOpen) closeCmdList(); else closeSettings(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); $('prompt').focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
});

// settings
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = closeSettings;
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
$('sysPrompt').addEventListener('input', () => { settings.systemPrompt = $('sysPrompt').value; saveSettings(); });
$('themeSel').onchange = () => { settings.theme = $('themeSel').value; saveSettings(); applyAppearance(); };
$('densitySel').onchange = () => { settings.density = $('densitySel').value; saveSettings(); applyAppearance(); };
$('recents-label').onclick = openSettings;
$('projPick').onclick = createProject;
$('projInstr').addEventListener('input', () => { const p = activeProject(); if (p) { p.instructions = $('projInstr').value; saveProjects(); } });

// ---- LAN: same-WiFi link (server / client) ---------------------------------
// ponytail: the renderer just toggles server / connects client and shows status;
// main does the TCP + NDJSON (src/lan.js). Client mode is reflected so the user
// knows chats route through the server.
let lanClientConnected = false;
function updateLan(s) {
  if (s.server !== undefined) {
    const info = $('lanServerInfo'); const chk = $('lanServerChk');
    if (s.server === 'listening') info.textContent = 'Server running — from the other device connect to ' + (s.ips || []).map((ip) => ip + ':' + s.port).join('  or  ');
    else if (s.server === 'closed' || s.server === 'off') { info.textContent = ''; chk.checked = false; }
    else if (s.server.startsWith('error')) { info.textContent = 'Server error: ' + s.server; chk.checked = false; }
    else info.textContent = s.server;
  }
  if (s.client !== undefined) {
    const info = $('lanClientInfo'); const btn = $('lanConnBtn');
    lanClientConnected = (s.client === 'connected');
    if (s.client === 'connected') { info.textContent = 'Connected — your chats route through the server.'; btn.textContent = 'Disconnect'; btn.dataset.mode = 'disc'; }
    else if (s.client === 'disconnected') { info.textContent = ''; btn.textContent = 'Connect'; btn.dataset.mode = 'conn'; }
    else if (s.client.startsWith('error')) { info.textContent = 'Connection failed: ' + s.client; btn.textContent = 'Connect'; btn.dataset.mode = 'conn'; }
    else { info.textContent = s.client; btn.textContent = 'Connect'; btn.dataset.mode = 'conn'; }
  }
}
window.ollama.on('lan-status', updateLan);
$('lanServerChk').onchange = (e) => window.ollama.lanServer(e.target.checked);
$('lanConnBtn').onclick = () => {
  if ($('lanConnBtn').dataset.mode === 'disc') window.ollama.lanDisconnect();
  else { const h = $('lanHost').value.trim(); if (h) { saveState('olanHost', h); window.ollama.lanConnect(h); } }
};

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
    for (const key of ['osettings', 'oprojects', 'oconvs', 'omodel', 'olanHost', 'oactiveProject', 'odraft']) {
      if (persisted[key] === undefined) {
        const oldValue = localStorage.getItem(key);
        if (oldValue === null) continue;
        try { persisted[key] = ['osettings', 'oprojects', 'oconvs'].includes(key) ? JSON.parse(oldValue) : oldValue; }
        catch { continue; }
      }
    }
    window.ollama.saveState(persisted).catch(() => {});
  } catch {}
  loadSettings();
  loadProjects();
  loadConvs();
  activeProjectId = projects.some((p) => p.id === persisted.oactiveProject) ? persisted.oactiveProject : null;
  $('lanHost').value = persisted.olanHost || '';
  $('prompt').value = typeof persisted.odraft === 'string' ? persisted.odraft : '';
  autosize();
  applyAppearance();
  renderRecents();
  updateProjectLabel();
  await loadModels();
  setLoading('Ready', true);
})();
