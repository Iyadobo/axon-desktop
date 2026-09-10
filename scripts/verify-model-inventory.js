const fs = require('fs');

const DEBUG_URL = 'http://127.0.0.1:9223/json/list';
const OUTPUT = 'C:/Users/Iyad/AppData/Local/Temp/nocli-model-inventory.png';
const RECOVERY_OUTPUT = 'C:/Users/Iyad/AppData/Local/Temp/nocli-model-recovery.png';

async function main() {
  const pages = await (await fetch(DEBUG_URL)).json();
  const page = pages.find((entry) => entry.type === 'page' && entry.url.includes('/src/renderer/index.html'));
  if (!page) throw new Error('NoCLI.ai renderer target was not found.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const runtimeErrors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params?.exceptionDetails?.text || 'Runtime exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') runtimeErrors.push(message.params.args?.map((arg) => arg.value || arg.description).join(' ') || 'Console error');
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails, null, 2));
    return response.result?.result?.value;
  };
  try {
    await send('Runtime.enable');
    await send('Page.enable');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate("typeof switchView === 'function'")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!(await evaluate("typeof switchView === 'function'"))) throw new Error('NoCLI.ai renderer did not finish loading.');
    const result = await evaluate(`(async()=>{
      switchView('chat');
      const direct = await window.nocli.listModels();
      await loadModels();
      document.querySelector('#modelBtn').click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return JSON.stringify({
        directCount: direct?.models?.length || 0,
        directNames: (direct?.models || []).map((model) => model.name),
        activeProvider: currentProviderProfile(),
        localCatalogueCount: localModelCatalogue.length,
        onDeviceCount: localModelCatalogue.filter((model) => model.source === 'local').length,
        cloudCount: localModelCatalogue.filter((model) => model.source === 'cloud').length,
        pickerCatalogueCount: modelCatalogue.length,
        selectOptions: [...document.querySelector('#model').options].map((option) => option.value),
        pickerRows: [...document.querySelectorAll('#modelList [role="option"]')].map((row) => row.textContent.trim()),
        buttonLabel: document.querySelector('#modelBtnName').textContent,
        pickerVisible: document.querySelector('#modelPicker').classList.contains('show'),
        status: document.querySelector('#statusText')?.textContent || '',
      });
    })()`);
    console.log(result);
    const recoveryStart = await evaluate(`(async()=>{
      localModelCatalogue = []; modelCatalogue = [];
      await loadModels(async () => { throw new Error('simulated unavailable'); });
      renderPicker();
      return JSON.stringify({
        state: modelInventoryState,
        retryVisible: Boolean(document.querySelector('#modelList .picker-empty button')),
        message: document.querySelector('#modelList .picker-empty')?.textContent.trim(),
      });
    })()`);
    console.log(`RECOVERY_START ${recoveryStart}`);
    const recoveryScreenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    fs.writeFileSync(RECOVERY_OUTPUT, Buffer.from(recoveryScreenshot.result.data, 'base64'));
    await evaluate("document.querySelector('#modelList .picker-empty button').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const recoveryResult = await evaluate(`JSON.stringify({
      state: modelInventoryState,
      catalogueCount: modelCatalogue.length,
      pickerRows: document.querySelectorAll('#modelList [role="option"]').length,
      retryVisible: Boolean(document.querySelector('#modelList .picker-empty button')),
    })`);
    console.log(`RECOVERY_RESULT ${recoveryResult}`);
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    fs.writeFileSync(OUTPUT, Buffer.from(screenshot.result.data, 'base64'));
    console.log(`RUNTIME_ERRORS ${JSON.stringify(runtimeErrors)}`);
    console.log(`RECOVERY_SCREENSHOT ${RECOVERY_OUTPUT}`);
    console.log(`SCREENSHOT ${OUTPUT}`);
    await evaluate("document.querySelector('#modelPicker').classList.remove('show'); true");
  } finally {
    ws.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
