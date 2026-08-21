// Installs and drives the prebuilt llama.cpp CUDA runtime that powers Axon's
// two-PC RPC pool: download the official Windows CUDA release (no cmake/nvcc
// required), then spawn either rpc-server (expose this PC's GPU to a remote
// host) or llama-server (the host, pulling in one or more remote GPUs via
// --rpc). RPC has no auth or encryption -- ggml-rpc-server's own docs call it
// experimental and insecure -- so every bind here is checked against this
// machine's own interface addresses to keep it off any routable network.
const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const RELEASE_TAG = 'b10549';
const ASSET_MAIN = 'llama-b10549-bin-win-cuda-12.4-x64.zip';
const ASSET_CUDART = 'cudart-llama-bin-win-cuda-12.4-x64.zip';
const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE_TAG}/`;
const INSTALL_BYTES_APPROX = 391443627 + 250969968; // cudart + main zip, from the release manifest

function exePaths(root) {
  const dir = path.join(root, 'llamacpp', 'bin');
  // The release ships the RPC binary as ggml-rpc-server.exe, not rpc-server.exe --
  // verified against the actual b10549 win-cuda-12.4-x64 zip contents.
  return { dir, llamaServer: path.join(dir, 'llama-server.exe'), rpcServer: path.join(dir, 'ggml-rpc-server.exe') };
}
function runtimeStatus(root) {
  const { dir, llamaServer, rpcServer } = exePaths(root);
  return { dir, installed: fs.existsSync(llamaServer) && fs.existsSync(rpcServer), llamaServer, rpcServer };
}

function fetchWithRedirects(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects.'));
    const req = https.get(url, { headers: { 'User-Agent': 'Axon-LlamaCppInstaller' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(fetchWithRedirects(new URL(res.headers.location, url).href, redirects + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download returned ${res.statusCode} for ${url}`)); }
      resolve(res);
    });
    req.setTimeout(20000, () => req.destroy(new Error('Download connection timed out.')));
    req.on('error', reject);
  });
}
async function downloadToFile(url, dest, onProgress) {
  const res = await fetchWithRedirects(url);
  const total = Number(res.headers['content-length']) || 0;
  let received = 0;
  const stream = fs.createWriteStream(dest);
  try {
    for await (const chunk of res) {
      received += chunk.length;
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
      onProgress?.({ received, total });
    }
    await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));
  } catch (error) { try { stream.destroy(); fs.unlinkSync(dest); } catch {} throw error; }
}
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Extraction failed (exit ' + code + ').'))));
    child.on('error', reject);
  });
}
// Some llama.cpp release zips nest their contents in one top-level folder;
// flatten it so llama-server.exe always ends up directly in destDir.
function flattenSingleSubdir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const sub = path.join(dir, entries[0].name);
    for (const item of fs.readdirSync(sub)) {
      const target = path.join(dir, item);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      fs.renameSync(path.join(sub, item), target);
    }
    fs.rmdirSync(sub);
  }
}
async function installRuntime(root, onProgress) {
  const { dir } = exePaths(root);
  const tmp = path.join(root, 'llamacpp', '_download');
  fs.mkdirSync(tmp, { recursive: true });
  const mainZip = path.join(tmp, ASSET_MAIN), cudartZip = path.join(tmp, ASSET_CUDART);
  try {
    onProgress?.({ phase: 'download', label: 'llama.cpp CUDA runtime', received: 0, total: 0 });
    await downloadToFile(RELEASE_BASE + ASSET_MAIN, mainZip, (p) => onProgress?.({ phase: 'download', label: 'llama.cpp CUDA runtime', ...p }));
    onProgress?.({ phase: 'download', label: 'CUDA runtime libraries', received: 0, total: 0 });
    await downloadToFile(RELEASE_BASE + ASSET_CUDART, cudartZip, (p) => onProgress?.({ phase: 'download', label: 'CUDA runtime libraries', ...p }));
    onProgress?.({ phase: 'extract' });
    fs.mkdirSync(dir, { recursive: true });
    await extractZip(mainZip, dir); flattenSingleSubdir(dir);
    await extractZip(cudartZip, dir); flattenSingleSubdir(dir);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  const status = runtimeStatus(root);
  if (!status.installed) throw new Error('Install completed but llama-server.exe / rpc-server.exe were not found afterward.');
  onProgress?.({ phase: 'done' });
  return status;
}

// ---- isolated-NIC network guards -------------------------------------------
function ownIPv4s() {
  const out = new Set(['127.0.0.1']);
  for (const entries of Object.values(os.networkInterfaces())) for (const i of entries || []) if (i.family === 'IPv4') out.add(i.address);
  return out;
}
// rpc-server has no auth or transport encryption, so a bind address must be
// one this machine actually owns -- never 0.0.0.0 and never a typed-in address
// that happens to belong to someone else.
function assertOwnAddress(ip) {
  if (!ownIPv4s().has(ip)) throw new Error(`${ip} is not an address on this machine. Bind rpc-server only to your isolated Ethernet NIC's own IP (e.g. 192.168.50.1).`);
}
function checkPeerReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const done = (ok, error) => { if (settled) return; settled = true; try { socket.destroy(); } catch {} resolve(ok ? { ok: true } : { ok: false, error: error || 'unreachable' }); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timed out'));
    socket.once('error', (e) => done(false, e.message));
  });
}
function parsePeers(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function validatePeer(peer) {
  const match = /^([\w.-]+):(\d{1,5})$/.exec(peer);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error(`"${peer}" is not a valid host:port RPC peer address.`);
  return { host: match[1], port: Number(match[2]) };
}

// ---- process lifecycle ------------------------------------------------------
function spawnTracked(command, args, { onLine, onExit } = {}) {
  const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail = [];
  const capture = (chunk) => { const text = chunk.toString(); onLine?.(text); tail.push(text); if (tail.length > 40) tail.shift(); };
  child.stdout?.on('data', capture); child.stderr?.on('data', capture);
  child.on('exit', (code, signal) => onExit?.(code, signal, tail.join('').slice(-4000)));
  return child;
}
function startWorker({ rpcServerPath, bindIp, port, onLine, onExit }) {
  assertOwnAddress(bindIp);
  return spawnTracked(rpcServerPath, ['-H', bindIp, '-p', String(port)], { onLine, onExit });
}
function startHost({ llamaServerPath, modelPath, apiPort, rpcPeers, contextSize, onLine, onExit }) {
  if (!modelPath || !fs.existsSync(modelPath)) throw new Error('Select a GGUF model file first.');
  const peers = parsePeers(rpcPeers); peers.forEach(validatePeer);
  // The API only needs to be reachable by the loopback-bound bridge, so it
  // never listens on the isolated NIC (or anywhere else) itself.
  const args = ['--model', modelPath, '--host', '127.0.0.1', '--port', String(apiPort), '-ngl', '999'];
  if (contextSize) args.push('-c', String(contextSize));
  if (peers.length) args.push('--rpc', peers.join(','));
  return spawnTracked(llamaServerPath, args, { onLine, onExit });
}

module.exports = {
  RELEASE_TAG, ASSET_MAIN, ASSET_CUDART, INSTALL_BYTES_APPROX,
  exePaths, runtimeStatus, installRuntime, flattenSingleSubdir,
  ownIPv4s, assertOwnAddress, checkPeerReachable, parsePeers, validatePeer,
  startWorker, startHost, selfcheck,
};

// ---- self-check -------------------------------------------------------------
function selfcheck() {
  return new Promise(async (resolve) => {
    let pass = 0, fail = 0;
    const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL', m); } };
    const fsExtra = require('fs'), osExtra = require('os'), pathExtra = require('path');

    // 1. runtimeStatus against an empty dir: not installed, correct paths.
    (() => {
      const tmp = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), 'axon-llamacpp-'));
      const status = runtimeStatus(tmp);
      ok(status.installed === false, 'empty install dir reports not installed');
      ok(status.llamaServer.endsWith('llama-server.exe') && status.rpcServer.endsWith('rpc-server.exe'), 'runtimeStatus resolves expected binary names');
      fsExtra.mkdirSync(pathExtra.dirname(status.llamaServer), { recursive: true });
      fsExtra.writeFileSync(status.llamaServer, ''); fsExtra.writeFileSync(status.rpcServer, '');
      ok(runtimeStatus(tmp).installed === true, 'runtimeStatus reports installed once both binaries exist');
      fsExtra.rmSync(tmp, { recursive: true, force: true });
    })();

    // 2. flattenSingleSubdir collapses one nesting level.
    (() => {
      const tmp = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), 'axon-flatten-'));
      const nested = pathExtra.join(tmp, 'build-x64');
      fsExtra.mkdirSync(nested); fsExtra.writeFileSync(pathExtra.join(nested, 'llama-server.exe'), 'x');
      flattenSingleSubdir(tmp);
      ok(fsExtra.existsSync(pathExtra.join(tmp, 'llama-server.exe')) && !fsExtra.existsSync(nested), 'flattenSingleSubdir hoists nested release contents');
      fsExtra.rmSync(tmp, { recursive: true, force: true });
    })();

    // 3. peer address validation.
    (() => {
      ok(parsePeers('192.168.50.2:50052, 192.168.50.3:50053').length === 2, 'parsePeers splits a comma list');
      ok((() => { try { validatePeer('192.168.50.2:50052'); return true; } catch { return false; } })(), 'validatePeer accepts host:port');
      ok((() => { try { validatePeer('not-a-peer'); return false; } catch { return true; } })(), 'validatePeer rejects malformed input');
    })();

    // 4. bind-address guard only allows this machine's own interfaces.
    (() => {
      ok((() => { try { assertOwnAddress('203.0.113.5'); return false; } catch { return true; } })(), 'assertOwnAddress rejects a foreign IP');
      ok((() => { try { assertOwnAddress('127.0.0.1'); return true; } catch { return false; } })(), 'assertOwnAddress accepts loopback');
    })();

    // 5. checkPeerReachable against a real loopback listener, and against a closed port.
    await new Promise((resolveTest) => {
      const server = net.createServer((socket) => socket.end());
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const reachable = await checkPeerReachable('127.0.0.1', port);
        ok(reachable.ok === true, 'checkPeerReachable connects to a real open port');
        server.close();
        const unreachable = await checkPeerReachable('127.0.0.1', port, 500);
        ok(unreachable.ok === false, 'checkPeerReachable reports a closed port as unreachable');
        resolveTest();
      });
    });

    console.log('llamacpp-runtime selfcheck:', pass, 'passed,', fail, 'failed');
    resolve(!fail);
  });
}
if (require.main === module) selfcheck().then((r) => process.exit(r ? 0 : 1));
