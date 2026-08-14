// Legacy fallback icon generator. The canonical Axon mark is src/assets/axion-logo.png.
// ponytail: pure-Node rasterizer (no deps), 4x4 supersample AA, single IDAT PNG,
// ICO wraps the PNG. Node 'zlib' for compression, hand-rolled CRC32.
// Run: node gen-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256, R = 54;                       // canvas + rounded-corner radius
const ACC = [42, 75, 214];                    // --color-accent #2a4bd6
const C = 128;                                // center
const SOMA_R = 7, END_R = 8, BRANCH_H = 3.2;  // neuron geometry
const ER = 86;                                // endpoint radius
const ends = [];
for (let i = 0; i < 6; i++) { const a = (i * 60) * Math.PI / 180; ends.push([C + ER * Math.sin(a), C - ER * Math.cos(a)]); }

const inCircle = (px, py, cx, cy, r) => { const dx = px - cx, dy = py - cy; return dx * dx + dy * dy <= r * r; };
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy; const ex = px - x, ey = py - y; return Math.sqrt(ex * ex + ey * ey);
}
function inRoundedRect(x, y) {
  if (x < 0 || y < 0 || x > S || y > S) return false;
  const corners = [[R, R], [S - R, R], [R, S - R], [S - R, S - R]];
  if ((x < R || x > S - R) && (y < R || y > S - R)) {
    for (const [cx, cy] of corners) { if ((x < R ? x < cx : x > cx) && (y < R ? y < cy : y > cy)) return inCircle(x, y, cx, cy, R); }
  }
  return true;
}
function inNeuron(px, py) {
  if (inCircle(px, py, C, C, SOMA_R)) return true;
  for (const [ex, ey] of ends) { if (inCircle(px, py, ex, ey, END_R)) return true; if (distToSeg(px, py, C, C, ex, ey) <= BRANCH_H) return true; }
  return false;
}
// per-sample color: white neuron over accent rounded square over transparent
function sample(px, py) {
  if (inNeuron(px, py)) return [255, 255, 255, 255];
  if (inRoundedRect(px, py)) return [ACC[0], ACC[1], ACC[2], 255];
  return [0, 0, 0, 0];
}

const buf = Buffer.alloc(S * S * 4);
const SS = 4;                                 // supersample factor
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      r += c[0]; g += c[1]; b += c[2]; a += c[3];
    }
    const n = SS * SS, o = (y * S + x) * 4;
    buf[o] = Math.round(r / n); buf[o + 1] = Math.round(g / n); buf[o + 2] = Math.round(b / n); buf[o + 3] = Math.round(a / n);
  }
}

// ---- PNG encode (RGBA, color type 6, single IDAT) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii'), len = Buffer.alloc(4);
  len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc(S * (1 + S * 4));
for (let y = 0; y < S; y++) { raw[y * (1 + S * 4)] = 0; buf.copy(raw, y * (1 + S * 4) + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

// ---- ICO (wraps the PNG; one 256x256 entry) ----
const ico = Buffer.alloc(6 + 16 + png.length);
// ICONDIR: reserved(2)=0, type(2)=1, count(2)=1
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
const e = 6; // entry offset
ico[e + 0] = 0; ico[e + 1] = 0; ico[e + 2] = 0; ico[e + 3] = 0;     // 256 -> 0 for both dims, colors 0, reserved 0
ico.writeUInt16LE(1, e + 4); ico.writeUInt16LE(32, e + 6);          // planes 1, bitcount 32
ico.writeUInt32LE(png.length, e + 8); ico.writeUInt32LE(6 + 16, e + 12);
png.copy(ico, 22);

const dir = path.join(__dirname, 'src', 'assets');
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
console.log('wrote icon.png (' + png.length + 'B) + icon.ico (' + ico.length + 'B) -- Axon neuron mark');
