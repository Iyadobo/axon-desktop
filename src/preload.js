const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ollama', {
  listModels: () => ipcRenderer.invoke('list-models'),
  listCommands: () => ipcRenderer.invoke('list-commands'),
  fetchCommands: (model) => ipcRenderer.invoke('fetch-commands', model),
  refreshCommands: (model) => ipcRenderer.invoke('refresh-commands', model),
  chat: (model, prompt, sessionId, opts) => ipcRenderer.invoke('chat', { model, prompt, sessionId, ...opts }),
  stop: () => ipcRenderer.invoke('chat-stop'),
  clear: () => ipcRenderer.invoke('clear'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loadState: () => ipcRenderer.invoke('load-state'),
  saveState: (updates) => ipcRenderer.invoke('save-state', updates),
  lanServer: (enabled) => ipcRenderer.invoke('lan-server-toggle', enabled),
  lanConnect: (host) => ipcRenderer.invoke('lan-connect', host),
  lanDisconnect: () => ipcRenderer.invoke('lan-disconnect'),
  on: (ch, cb) => { ipcRenderer.on(ch, (_e, v) => cb(v)); },
});
