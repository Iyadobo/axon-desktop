// src/lan.js -- same-WiFi link between two app instances.
// ponytail: raw TCP + newline-delimited JSON. No HTTP, no web GUI.
// The server runs claude locally and streams events back over the socket; the
// client forwards chats to the server and maps events back to the renderer, so
// the renderer UI is unchanged on either side.
const net = require('net');
const os = require('os');

const PORT = 47301;
const NL = '\n';

// IPv4 non-internal addresses -- what the server prints for the other device.
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const i of ifs[name] || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
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
function startServer({ onChat, onMessage, onStatus, port }) {
  const sockets = new Map();
  const server = net.createServer((sock) => {
    const st = { child: null };
    sockets.set(sock, st);
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

module.exports = { PORT, lanIPs, lineStream, parseMsg, startServer, sendTo, connectClient };

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
