// src/lan.js -- same-WiFi link between two app instances.
// ponytail: raw TCP + newline-delimited JSON. No HTTP, no web GUI.
// The server runs claude locally and streams events back over the socket; the
// client forwards chats to the server and maps events back to the renderer, so
// the renderer UI is unchanged on either side.
const net = require('net');
const os = require('os');
const dgram = require('dgram');

const PORT = 47301;
const DISCOVERY_PORT = 47302;
const NL = '\n';

// IPv4 non-internal addresses -- what the server prints for the other device.
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const i of ifs[name] || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

function broadcastIPs() {
  const out = new Set(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) for (const i of entries || []) {
    if (i.family !== 'IPv4' || i.internal || !i.address || !i.netmask) continue;
    const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number);
    if (ip.length !== 4 || mask.length !== 4) continue;
    out.add(ip.map((v, n) => (v | (255 ^ mask[n])) & 255).join('.'));
  }
  return [...out];
}

// UDP is discovery only: no installer bytes or chat contents travel here. The
// existing TCP connection remains the explicit, user-approved control channel.
function createDiscovery({ id, name, getAdvertisement, onDevices, port = DISCOVERY_PORT }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const seen = new Map();
  let timer = null, stopped = false;
  const emit = () => onDevices([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
  const prune = () => {
    const now = Date.now(); let changed = false;
    for (const [key, device] of seen) if (now - device.seenAt > 15000) { seen.delete(key); changed = true; }
    if (changed) emit();
  };
  const announce = () => {
    if (stopped) return;
    prune();
    const ad = getAdvertisement() || {};
    const message = Buffer.from(JSON.stringify({ type: 'axon-discovery', id, name: String(name || 'Axon device').slice(0, 80), port: ad.port || PORT, available: !!ad.available }));
    for (const address of broadcastIPs()) socket.send(message, port, address, () => {});
  };
  socket.on('message', (buffer, remote) => {
    let msg; try { msg = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (!msg || msg.type !== 'axon-discovery' || !msg.id || msg.id === id || typeof msg.name !== 'string' || !Number.isInteger(msg.port) || msg.port < 1 || msg.port > 65535) return;
    const key = String(msg.id);
    const next = { id: key, name: msg.name.slice(0, 80), host: remote.address, port: msg.port, available: !!msg.available, seenAt: Date.now() };
    const previous = seen.get(key); seen.set(key, next);
    if (!previous || previous.host !== next.host || previous.port !== next.port || previous.available !== next.available || previous.name !== next.name) emit();
  });
  socket.on('error', () => {});
  socket.bind(port, () => { try { socket.setBroadcast(true); } catch {} announce(); timer = setInterval(announce, 4000); });
  return { refresh: announce, stop() { stopped = true; if (timer) clearInterval(timer); try { socket.close(); } catch {} }, devices: () => [...seen.values()] };
}

// incremental NDJSON line splitter: feed chunks, calls onLine per complete line.
function lineStream(onLine) {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf(NL)) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
  };
}

function parseMsg(line) { try { return JSON.parse(line); } catch { return null; } }

// ---- server ----------------------------------------------------------------
// onChat/onMessage receive a per-socket state. Hosts may attach `holders`, a
// requestId -> child map, so one Stop never cancels unrelated chats.
// onStatus(state, info): 'listening' | 'error:<code>' | 'closed'
function startServer({ onChat, onMessage, onStatus, onConnect, port }) {
  const sockets = new Map();
  const server = net.createServer((sock) => {
    const st = { child: null };
    sockets.set(sock, st);
    onConnect?.(sock, st);
    const ls = lineStream((line) => {
      const msg = parseMsg(line); if (!msg) return;
      if (onMessage) onMessage(msg, sock, st);
      else if (msg.type === 'chat') onChat?.(msg, sock, st);
      else if (msg.type === 'stop') { if (st.child && !st.child.killed) st.child.kill(); }
    });
    sock.on('data', ls.feed);
    sock.on('error', () => {});
    sock.on('close', () => {
      if (st.holders) for (const holder of st.holders.values()) if (holder.child && !holder.child.killed) holder.child.kill();
      if (st.child && !st.child.killed) st.child.kill();
      sockets.delete(sock);
    });
  });
  server.on('error', (e) => onStatus('error:' + (e.code || e.message)));
  server.on('listening', () => onStatus('listening', { port: server.address().port, ips: lanIPs() }));
  server.on('close', () => onStatus('closed'));
  server.listen(port == null ? PORT : port);
  return {
    server,
    sendTo(sock, obj) { sendTo(sock, obj); },
    broadcast(obj) { for (const s of sockets.keys()) sendTo(s, obj); },
    stop() { for (const s of [...sockets.keys()]) s.end(); sockets.clear(); try { server.close(); } catch {} },
  };
}

// write one NDJSON message to a socket
function sendTo(sock, obj) { try { sock.write(JSON.stringify(obj) + NL); } catch {} }

// ---- client ----------------------------------------------------------------
// onMsg(msg): a parsed server message. onStatus(state): 'connected' | 'disconnected' | 'error:<code>'
function connectClient(host, port, { onMsg, onStatus }) {
  let connected = false;
  const queue = []; // ponytail: buffer sends issued before the socket connects.
  const sock = net.connect(port, host);
  const ls = lineStream((line) => { const m = parseMsg(line); if (m) onMsg(m); });
  sock.on('connect', () => {
    connected = true;
    for (const obj of queue) { try { sock.write(JSON.stringify(obj) + NL); } catch {} }
    queue.length = 0;
    onStatus('connected');
  });
  sock.on('data', ls.feed);
  sock.on('error', (e) => onStatus('error:' + (e.code || e.message)));
  sock.on('close', () => { connected = false; onStatus('disconnected'); });
  return {
    send(obj) { if (connected) { try { sock.write(JSON.stringify(obj) + NL); return true; } catch { return false; } } queue.push(obj); return true; },
    end() { try { sock.end(); } catch {} },
  };
}

module.exports = { PORT, DISCOVERY_PORT, lanIPs, lineStream, parseMsg, startServer, sendTo, connectClient, createDiscovery };

// ---- self-check: TCP loopback, client sends chat -> server replies delta+done
function selfcheck() {
  return new Promise((resolve) => {
    let pass = 0, fail = 0;
    const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL', m); } };
    let cli;
    const srv = startServer({
      port: 0,
      onChat: (msg, sock, st) => {
        ok(msg.type === 'chat' && msg.prompt === 'hi' && msg.requestId === 'r1', 'server got request-scoped chat');
        sendTo(sock, { type: 'delta', requestId: msg.requestId, text: 'hello' });
        sendTo(sock, { type: 'done', requestId: msg.requestId, sessionId: msg.sessionId, ok: true });
      },
      // ponytail: drive off onStatus (attached before listen) to avoid a listen/listening race.
      onStatus: (state, info) => {
        if (state !== 'listening') return;
        cli = connectClient('127.0.0.1', info.port, {
          onMsg: (m) => {
            if (m.type === 'delta') ok(m.text === 'hello' && m.requestId === 'r1', 'client got request-scoped delta');
            if (m.type === 'done') {
              ok(m.ok === true && m.requestId === 'r1', 'client got request-scoped done');
              cli.end(); srv.stop();
              console.log('lan selfcheck:', pass, 'passed,', fail, 'failed');
              resolve(!fail);
            }
          },
          onStatus: () => {},
        });
        cli.send({ type: 'chat', requestId: 'r1', model: 'x', prompt: 'hi', sessionId: 's1', systemPrompt: '' });
      },
    });
  });
}
if (require.main === module) selfcheck().then((r) => process.exit(r ? 0 : 1));
