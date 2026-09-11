// Throwaway smoke test: loads the real renderer (with a stubbed window.nocli via
// preview-preload.js), drives a synthetic ordered chat stream (thinking -> text ->
// tool_call -> tool_result -> final text), screenshots it, and prints console
// errors. Separate userData -> separate single-instance lock, so the live NoCLI.ai is
// never touched. Run once:  npx electron scripts/preview-stream.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(__dirname, '..', '.electron-data', 'preview-tmp'));
app.disableHardwareAcceleration();
const OUT = path.join(__dirname, 'preview-stream.png');
const LOG = path.join(__dirname, 'preview-stream.log');
const log = (m) => { const line = '[' + new Date().toISOString() + '] ' + m; fs.appendFileSync(LOG, line + '\n'); };
fs.writeFileSync(LOG, '');
const errors = [];
log('script loaded');

const drive = `(() => {
  const loading = document.getElementById('loading');
  if (loading) loading.style.setProperty('display', 'none', 'important');
  const turn = newAiTurn('qwen3:4b');
  addStep({ type: 'thinking', text: 'The user wants the config. I should read config.js first, then explain what it exports.' }, turn);
  feedText(turn, 'Let me check the config file.\\n\\n');
  addStep({ type: 'tool_call', fn: 'Read', args: { file_path: 'config.js' } }, turn);
  addStep({ type: 'tool_result', result: 'module.exports = { port: 4199 };' }, turn);
  feedText(turn, 'Here is what I found.\\n\\nThe config exports a **port** key set to 4199. That is the full answer.');
  showChatView();
  const appRoot = document.getElementById('app');
  return { driven: true, loadingExists: !!document.getElementById('loading'), appDisplay: appRoot ? getComputedStyle(appRoot).display : 'missing', bodyText: document.body.innerText.slice(0, 160), shell: ['swarmLaunch','chatSidebar','recents-label'].map(id => { const e=document.getElementById(id); const r=e.getBoundingClientRect(); return [id,getComputedStyle(e).order,Math.round(r.top),Math.round(r.height),getComputedStyle(e).display]; }) };
})()`;

app.on('ready', () => {
  log('app ready');
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, paintWhenInitiallyHidden: true, webPreferences: { preload: path.join(__dirname, 'preview-preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { log('console[' + level + ']: ' + message); if (level >= 2) errors.push('[' + level + '] ' + message); });
  win.webContents.on('did-fail-load', (_e, code, desc) => log('DID-FAIL-LOAD ' + code + ' ' + desc));
  win.webContents.on('did-finish-load', async () => {
    log('did-finish-load');
    try {
      await new Promise((r) => setTimeout(r, 300));
      log('driving...');
      const res = await win.webContents.executeJavaScript(drive, true);
      log('drive result: ' + JSON.stringify(res));
      win.show();
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 500));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(OUT, img.toPNG());
      log('SCREENSHOT written: ' + OUT + ' (' + img.toPNG().length + ' bytes)');
      log('CONSOLE_ERRORS: ' + JSON.stringify(errors));
    } catch (e) { log('PREVIEW_FAILED: ' + (e.stack || e.message)); }
    app.quit();
  });
  log('loading file...');
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
});
