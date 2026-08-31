// Throwaway preload for preview-stream.js. Sets a benign window.ollama stub so
// app.js's startup calls resolve, and exposes window.__fire to replay events.
const listeners = {};
window.ollama = {
  on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); },
  fire(ch, v) { (listeners[ch] || []).forEach((cb) => cb(v)); },
};
// every other method -> async empty/sensible default
for (const m of ['listModels','refreshCloudModels','listCommands','fetchCommands','refreshCommands','chat','stop','steer','clear','pickFolder','ensureWorkspace','loadState','saveState','lanServer','lanConnect','lanConnectDevice','lanDisconnect','workspaceUpsert','workspaceSeed','lanRefresh','lanRequestDeviceUpdate','selectUpdateInstaller','offerUpdate','requestUpdate','respondUpdateRequest','acceptUpdateOffer','openUpdateInstaller','checkAppUpdate','downloadAppUpdate','appInfo','installDependencies','terminalOpen','windowControl','browserShow','browserHide','browserNavigate','browserAction']) {
  window.ollama[m] = (...a) => Promise.resolve(
    m === 'listModels' ? { models: [] }
    : m === 'listCommands' ? []
    : m === 'loadState' ? {}
    : m === 'appInfo' ? { version: '0.6.0', dependencies: { ollama: true, claude: true, node: true } }
    : m === 'chat' ? { ok: true }
    : {}
  );
}
