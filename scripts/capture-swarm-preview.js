const fs = require('fs');

const DEBUG_URL = 'http://127.0.0.1:9223/json/list';
const OUTPUT_DIR = 'C:/Users/Iyad/AppData/Local/Temp/nocli-swarm-qa';

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const pages = await (await fetch(DEBUG_URL)).json();
  const page = pages.find((entry) => entry.type === 'page' && entry.url.includes('/src/renderer/index.html'));
  if (!page) throw new Error('NoCLI.ai renderer target was not found.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const runtimeErrors = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params?.exceptionDetails?.text || 'Runtime exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') runtimeErrors.push(message.params.args?.map((arg) => arg.value || arg.description).join(' ') || 'Console error');
    const done = pending.get(message.id);
    if (done) { pending.delete(message.id); done(message); }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const requestId = ++id; pending.set(requestId, resolve); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails, null, 2));
    return response.result?.result?.value;
  };
  const measure = `(()=>{const els=[...document.querySelectorAll('h1,h2,h3,h4,p,span,a,li,small,button,td,th,b,summary,figcaption,time,dt,dd')].filter(e=>e.textContent.trim()&&e.offsetParent);const sizes=[...new Set(els.map(e=>parseFloat(getComputedStyle(e).fontSize)))].sort((a,b)=>b-a);const weights=[...new Set(els.map(e=>getComputedStyle(e).fontWeight))].sort();const surfaces=[...new Set([...document.querySelectorAll('*')].map(e=>getComputedStyle(e).backgroundColor).filter(c=>c&&!c.includes('rgba(0, 0, 0, 0)')))];const lefts={};els.forEach(e=>{const l=Math.round(e.getBoundingClientRect().left);lefts[l]=(lefts[l]||0)+1});const leaf=[...document.querySelectorAll('body *')].filter(e=>e.offsetParent&&e.textContent.trim()&&![...e.children].some(c=>c.textContent.trim()));const boxes=leaf.map(e=>{const r=e.getBoundingClientRect();return{top:r.top+scrollY,bot:r.bottom+scrollY}}).sort((a,b)=>a.top-b.top);let mb=-1,gaps=[];boxes.forEach(b=>{if(b.top-mb>120&&mb>0)gaps.push(Math.round(b.top-mb));mb=Math.max(mb,b.bot)});const ps=[...document.querySelectorAll('p')].filter(e=>e.offsetParent);let minPara=Infinity;for(let i=1;i<ps.length;i++){if(ps[i].parentElement===ps[i-1].parentElement)minPara=Math.min(minPara,Math.round(ps[i].getBoundingClientRect().top-ps[i-1].getBoundingClientRect().bottom))}return{sizes,steps:sizes.length,under14:els.filter(e=>parseFloat(getComputedStyle(e).fontSize)<14).length,pctUnder16:Math.round(els.filter(e=>parseFloat(getComputedStyle(e).fontSize)<16).length/els.length*100),total:els.length,weights,surfaces,axes:Object.entries(lefts).filter(([,n])=>n>2).length,gaps,maxGapPctVh:Math.round(Math.max(...gaps,0)/innerHeight*100),minParaGap:minPara===Infinity?'n/a':minPara,minTap:Math.min(...[...document.querySelectorAll('a,summary,button')].filter(e=>e.offsetParent).map(e=>Math.round(e.getBoundingClientRect().height))),images:document.images.length,viewport:innerWidth,overflowX:document.documentElement.scrollWidth-innerWidth,docH:document.body.scrollHeight,designNav:document.querySelectorAll('[data-view="design"],#view-design').length,swarmVisible:!document.querySelector('#swarmControls').hidden}})()`;
  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate("typeof openSwarm === 'function'")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await evaluate("(async()=>{ document.querySelector('#modelPicker')?.classList.remove('show'); await loadModels(); switchView('chat'); openSwarm(); return true; })()");
    for (const width of [1440, 390]) {
      const height = width === 390 ? 844 : 900;
      let emulatedWidth = width;
      let emulatedHeight = height;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await send('Emulation.setDeviceMetricsOverride', { width: emulatedWidth, height: emulatedHeight, deviceScaleFactor: 1, mobile: false });
        const viewport = await evaluate('({width:innerWidth,height:innerHeight})');
        if (viewport.width === width) break;
        emulatedWidth = Math.max(320, Math.round(emulatedWidth * width / viewport.width));
        emulatedHeight = Math.max(480, Math.round(emulatedHeight * height / viewport.height));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await evaluate(measure);
      console.log(JSON.stringify(result, null, 1));
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      fs.writeFileSync(`${OUTPUT_DIR}/swarm-${width}.png`, Buffer.from(shot.result.data, 'base64'));
    }
    await evaluate("document.querySelector('.swarm-advanced').open=true; true");
    await new Promise((resolve) => setTimeout(resolve, 150));
    console.log(`EXPANDED ${JSON.stringify(await evaluate(measure), null, 1)}`);
    const expanded = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    fs.writeFileSync(`${OUTPUT_DIR}/swarm-390-settings.png`, Buffer.from(expanded.result.data, 'base64'));
    console.log(`RUNTIME_ERRORS ${JSON.stringify(runtimeErrors)}`);
    console.log(`SCREENSHOTS ${OUTPUT_DIR}`);
  } finally {
    socket.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
