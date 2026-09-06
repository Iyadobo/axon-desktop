const { contextBridge, ipcRenderer } = require('electron');
// Preload runs in Electron's sandboxed loader, which intentionally cannot
// import arbitrary sibling modules. Keep this tiny pure normalizer here; the
// matching Node module is used by the non-Electron self-check.
function browserInvocation(toolName, args = {}) {
  const name = String(toolName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const url = [args.url, args.href, args.target].find((value) => typeof value === 'string' && value.trim());
  if (['webfetch', 'browseropen', 'browsernavigate', 'browsergoto'].includes(name) && url) return { type: 'navigate', url: url.trim() };
  const query = [args.query, args.q, args.search].find((value) => typeof value === 'string' && value.trim());
  if (['websearch', 'browsersearch'].includes(name) && query) return { type: 'navigate', url: 'https://www.google.com/search?q=' + encodeURIComponent(query.trim()) };
  return null;
}
contextBridge.exposeInMainWorld('ollama', {
  listModels: () => ipcRenderer.invoke('list-models'),
  modelCapabilities: (model, productMode, provider) => ipcRenderer.invoke('model-capabilities', { model, productMode, provider }),
  refreshCloudModels: () => ipcRenderer.invoke('refresh-cloud-models'),
  downloadCatalogue: () => ipcRenderer.invoke('model-download-catalogue'),
  pullModel: (model) => ipcRenderer.invoke('pull-model', model),
  hardwareProfile: () => ipcRenderer.invoke('hardware-profile'),
  setRuntime: (runtime) => ipcRenderer.invoke('set-runtime', runtime),
  checkExo: (url) => ipcRenderer.invoke('check-exo', url),
  llamaCppStatus: () => ipcRenderer.invoke('llamacpp-runtime-status'),
  llamaCppInstall: () => ipcRenderer.invoke('llamacpp-install'),
  llamaCppPickModel: () => ipcRenderer.invoke('llamacpp-pick-model'),
  llamaCppCheckPeer: (peer) => ipcRenderer.invoke('llamacpp-check-peer', peer),
  llamaCppSetConfig: (next) => ipcRenderer.invoke('llamacpp-set-config', next),
  llamaCppStart: () => ipcRenderer.invoke('llamacpp-start'),
  llamaCppStop: () => ipcRenderer.invoke('llamacpp-stop'),
  chat: (model, prompt, sessionId, opts) => ipcRenderer.invoke('chat', { model, prompt, sessionId, ...opts }),
  swarmStart: (opts) => ipcRenderer.invoke('swarm-start', opts),
  swarmRetryWorker: (opts) => ipcRenderer.invoke('swarm-retry-worker', opts),
  stop: (requestId) => ipcRenderer.invoke('chat-stop', requestId),
  steer: (requestId) => ipcRenderer.invoke('chat-steer', requestId),
  clear: () => ipcRenderer.invoke('clear'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  ensureWorkspace: () => ipcRenderer.invoke('ensure-workspace'),
  loadState: () => ipcRenderer.invoke('load-state'),
  saveState: (updates) => ipcRenderer.invoke('save-state', updates),
  lanServer: (enabled) => ipcRenderer.invoke('lan-server-toggle', enabled),
  lanConnect: (host) => ipcRenderer.invoke('lan-connect', host),
  lanConnectDevice: (device) => ipcRenderer.invoke('lan-connect-device', device),
  lanDisconnect: () => ipcRenderer.invoke('lan-disconnect'),
  workspaceUpsert: (conversation) => ipcRenderer.invoke('workspace-upsert', conversation),
  workspaceSeed: (conversations) => ipcRenderer.invoke('workspace-seed', conversations),
  lanRefresh: () => ipcRenderer.invoke('lan-discovery-refresh'),
  lanRequestDeviceUpdate: (device) => ipcRenderer.invoke('lan-request-device-update', device),
  selectUpdateInstaller: () => ipcRenderer.invoke('update-select-installer'),
  offerUpdate: () => ipcRenderer.invoke('update-offer'),
  requestUpdate: () => ipcRenderer.invoke('update-request'),
  respondUpdateRequest: (id, approved) => ipcRenderer.invoke('update-respond-request', id, approved),
  acceptUpdateOffer: (id, approved) => ipcRenderer.invoke('update-accept-offer', id, approved),
  openUpdateInstaller: (file) => ipcRenderer.invoke('update-open-installer', file),
  checkAppUpdate: () => ipcRenderer.invoke('app-update-check'),
  downloadAppUpdate: () => ipcRenderer.invoke('app-update-download'),
  appInfo: () => ipcRenderer.invoke('app-info'),
  engineAvailability: () => ipcRenderer.invoke('engine-availability'),
  installDependencies: () => ipcRenderer.invoke('install-dependencies'),
  terminalOpen: () => ipcRenderer.invoke('terminal-open'),
  windowControl: (action) => ipcRenderer.invoke('window-control', action),
  browserShow: (bounds) => ipcRenderer.invoke('browser-show', bounds),
  browserHide: () => ipcRenderer.invoke('browser-hide'),
  browserNavigate: (url) => ipcRenderer.invoke('browser-navigate', url),
  browserAction: (action) => ipcRenderer.invoke('browser-action', action),
  browserInvocation: (toolName, args) => browserInvocation(toolName, args),
  providerSave: (profile, apiKey) => ipcRenderer.invoke('provider-save', profile, apiKey),
  on: (ch, cb) => { ipcRenderer.on(ch, (_e, v) => cb(v)); },
});
