const fs = require('fs');

const DEBUG_URL = 'http://127.0.0.1:9223/json/list';
const OUTPUT_DIR = 'C:/Users/Iyad/AppData/Local/Temp/axon-design-qa';

async function connect() {
  const pages = await (await fetch(DEBUG_URL)).json();
  const page = pages.find((entry) => entry.type === 'page' && entry.url.includes('/src/renderer/index.html'));
  if (!page) throw new Error('Axon renderer target was not found.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
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
  return { ws, send, runtimeErrors };
}

async function evaluate(send, expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails, null, 2));
  return response.result?.result?.value;
}

async function capture(send, filename) {
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(`${OUTPUT_DIR}/${filename}`, Buffer.from(screenshot.result.data, 'base64'));
}

async function setCssViewport(send, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const actual = await evaluate(send, 'JSON.stringify([innerWidth, innerHeight])');
  const [actualWidth, actualHeight] = JSON.parse(actual);
  await send('Emulation.setDeviceMetricsOverride', {
    width: Math.max(1, Math.round(width * width / actualWidth)),
    height: Math.max(1, Math.round(height * height / actualHeight)),
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function measure(send, width, height) {
  await setCssViewport(send, width, height);
  return evaluate(send, `JSON.stringify((()=>{
    const els=[...document.querySelectorAll('h1,h2,h3,h4,p,span,a,li,small,button,td,th,b,summary,figcaption,time,dt,dd')]
      .filter(e=>e.textContent.trim()&&e.offsetParent);
    const sizes=[...new Set(els.map(e=>parseFloat(getComputedStyle(e).fontSize)))].sort((a,b)=>b-a);
    const weights=[...new Set(els.map(e=>getComputedStyle(e).fontWeight))].sort();
    const surfaces=[...new Set([...document.querySelectorAll('*')]
      .map(e=>getComputedStyle(e).backgroundColor).filter(c=>c&&!c.includes('rgba(0, 0, 0, 0)')))];
    const lefts={};els.forEach(e=>{const l=Math.round(e.getBoundingClientRect().left);lefts[l]=(lefts[l]||0)+1});
    const leaf=[...document.querySelectorAll('body *')]
      .filter(e=>e.offsetParent&&e.textContent.trim()&&![...e.children].some(c=>c.textContent.trim()));
    const boxes=leaf.map(e=>{const r=e.getBoundingClientRect();return{top:r.top+scrollY,bot:r.bottom+scrollY}})
      .sort((a,b)=>a.top-b.top);
    let mb=-1,gaps=[];boxes.forEach(b=>{if(b.top-mb>120&&mb>0)gaps.push(Math.round(b.top-mb));mb=Math.max(mb,b.bot)});
    const ps=[...document.querySelectorAll('p')].filter(e=>e.offsetParent);
    let minPara=Infinity;
    for(let i=1;i<ps.length;i++){if(ps[i].parentElement===ps[i-1].parentElement)
      minPara=Math.min(minPara,Math.round(ps[i].getBoundingClientRect().top-ps[i-1].getBoundingClientRect().bottom))}
    return {
      sizes, steps:sizes.length,
      under14:els.filter(e=>parseFloat(getComputedStyle(e).fontSize)<14).length,
      pctUnder16:Math.round(els.filter(e=>parseFloat(getComputedStyle(e).fontSize)<16).length/els.length*100),
      total:els.length, weights, surfaces,
      axes:Object.entries(lefts).filter(([,n])=>n>2).length,
      gaps, maxGapPctVh:Math.round(Math.max(...gaps,0)/innerHeight*100),
      minParaGap:minPara===Infinity?'n/a':minPara,
      minTap:Math.min(...[...document.querySelectorAll('a,summary,button')]
        .filter(e=>e.offsetParent).map(e=>Math.round(e.getBoundingClientRect().height))),
      images:document.images.length,
      viewport:innerWidth,
      overflowX:document.documentElement.scrollWidth-innerWidth,
      docH:document.body.scrollHeight
    };
  })(),null,1)`);
}

async function main() {
  const { ws, send, runtimeErrors } = await connect();
  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1024, deviceScaleFactor: 1, mobile: false });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await evaluate(send, "typeof switchView === 'function'")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await evaluate(send, "switchView('design'); document.title = 'Axon Design'; true");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const state = await evaluate(send, `JSON.stringify({
      view: activeView,
      designActive: document.querySelector('#view-design').classList.contains('active'),
      cards: document.querySelectorAll('.direction-card').length,
      selected: document.querySelector('.direction-card.selected h3')?.textContent,
      centeredBrowserDelta: (() => { const button = document.querySelector('#browserToggle').getBoundingClientRect(); const icon = document.querySelector('#browserToggle svg').getBoundingClientRect(); return Math.round(((icon.left + icon.width / 2) - (button.left + button.width / 2)) * 10) / 10; })(),
      overflowX: document.documentElement.scrollWidth - innerWidth,
      viewport: [innerWidth, innerHeight]
    })`);
    console.log(state);
    const selection = await evaluate(send, `(() => {
      document.querySelectorAll('.direction-card')[0].click();
      const selected = document.querySelector('.direction-card.selected h3')?.textContent;
      document.querySelectorAll('.direction-card')[1].click();
      return JSON.stringify({ selected, restored: document.querySelector('.direction-card.selected h3')?.textContent });
    })()`);
    console.log(selection);
    await capture(send, '01-signal-canvas.png');

    const originalNotes = await evaluate(send, 'JSON.stringify(designNotes)');
    const originalBrief = await evaluate(send, "document.querySelector('#designBriefText').textContent");
    await evaluate(send, "document.querySelector('#designCritique').click(); document.querySelector('#designPrototype').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const interaction = await evaluate(send, `JSON.stringify({
      notesActive: document.querySelector('#designNotesTab').classList.contains('active'),
      noteCount: document.querySelectorAll('#designInspectorBody li').length,
      prototypeMode: document.querySelector('#view-design').classList.contains('prototype-mode'),
      prototypeLabel: document.querySelector('#designPrototype').textContent
    })`);
    console.log(interaction);
    await capture(send, '02-critique-prototype.png');
    await evaluate(send, "document.querySelector('#designPrototype').click(); true");
    const originalDirection = await evaluate(send, 'JSON.stringify(DESIGN_DIRECTIONS[selectedDesignDirection])');
    await evaluate(send, `(() => {
      const input = document.querySelector('#designPrompt');
      input.value = 'Make the selected branch calmer and faster to scan';
      document.querySelector('#designPromptForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const branchResult = await evaluate(send, `JSON.stringify({
      promptCleared: document.querySelector('#designPrompt').value === '',
      brief: document.querySelector('#designBriefText').textContent,
      summary: DESIGN_DIRECTIONS[selectedDesignDirection].summary,
      generateEnabled: !document.querySelector('#designGenerate').disabled
    })`);
    console.log(branchResult);
    await evaluate(send, `Object.assign(DESIGN_DIRECTIONS[selectedDesignDirection], ${originalDirection}); renderDesignDirections(); renderDesignInspector(); true`);
    console.log(`RUNTIME_ERRORS ${JSON.stringify(runtimeErrors)}`);
    console.log('MEASURE 1440');
    console.log(await measure(send, 1440, 1024));
    console.log('MEASURE 390');
    console.log(await measure(send, 390, 844));
    await evaluate(send, `designNotes.splice(0, designNotes.length, ...${originalNotes}); designInspectorTab = 'overview'; document.querySelector('#designBriefText').textContent = ${JSON.stringify(originalBrief)}; renderDesignInspector(); true`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1024, deviceScaleFactor: 1, mobile: false });
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
