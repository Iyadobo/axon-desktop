// Renderer visual/regulation check using isolated preview data.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const width = Number(process.argv[2]) || 1440;
const view = process.argv[3] || 'chat';
const mode = process.argv[4] || '';
const height = width <= 400 ? 844 : 900;
const suffix = String(width);
const root = path.join(__dirname, '..');
const output = path.join(__dirname, `audit-shell-${suffix}-${view}${mode ? '-' + mode : ''}.png`);
app.setPath('userData', path.join(root, '.electron-data', `audit-shell-${suffix}`));
app.disableHardwareAcceleration();

const audit = `(() => {
  document.getElementById('loading')?.remove();
  if ('${view}' !== 'chat') switchView('${view}');
  if ('${mode}') selectProductMode('${mode}');
  const els=[...document.querySelectorAll('h1,h2,h3,h4,p,span,a,li,small,button,td,th,b,summary,figcaption,time,dt,dd')].filter(e=>e.textContent.trim()&&e.offsetParent);
  const leaf=[...document.querySelectorAll('body *')].filter(e=>e.offsetParent&&e.textContent.trim()&&![...e.children].some(c=>c.textContent.trim()));
  const boxes=leaf.map(e=>{const r=e.getBoundingClientRect();return{top:r.top+scrollY,bot:r.bottom+scrollY}}).sort((a,b)=>a.top-b.top);
  let mb=-1,gaps=[];boxes.forEach(b=>{if(b.top-mb>120&&mb>0)gaps.push(Math.round(b.top-mb));mb=Math.max(mb,b.bot)});
  const clickable=[...document.querySelectorAll('a,button,summary,[role="button"],[role="link"],[onclick]')].filter(e=>e.offsetParent);
  return {viewport:innerWidth,overflowX:document.documentElement.scrollWidth-innerWidth,under14:els.filter(e=>parseFloat(getComputedStyle(e).fontSize)<14).map(e=>e.tagName+':'+e.textContent.trim().slice(0,24)),smallTargets:clickable.filter(e=>{const r=e.getBoundingClientRect();return r.height<44||r.width<44}).map(e=>e.tagName+':'+Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height)),deadAnchors:clickable.filter(e=>e.tagName==='A'&&!e.getAttribute('href')).map(e=>e.textContent.trim().slice(0,32)),sizes:[...new Set(els.map(e=>parseFloat(getComputedStyle(e).fontSize)))].sort((a,b)=>b-a),weights:[...new Set(els.map(e=>getComputedStyle(e).fontWeight))].sort(),gaps,maxGapPctVh:Math.round(Math.max(...gaps,0)/innerHeight*100),images:document.images.length,docH:document.body.scrollHeight};
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height, useContentSize:true, show:false, paintWhenInitiallyHidden:true, webPreferences:{ preload:path.join(__dirname,'preview-preload.js'), contextIsolation:false, sandbox:false, backgroundThrottling:false } });
  await win.loadFile(path.join(root,'src','renderer','index.html'));
  await new Promise(resolve=>setTimeout(resolve,500));
  const result = await win.webContents.executeJavaScript(audit,true);
  win.show();
  win.webContents.invalidate();
  await new Promise(resolve=>setTimeout(resolve,350));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(output,image.toPNG());
  process.stdout.write(JSON.stringify(result,null,2)+'\nSCREENSHOT='+output+'\n');
  app.quit();
});
