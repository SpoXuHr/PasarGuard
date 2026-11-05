'use strict';
// WebSocket framing only; authentication, quotas and traffic accounting remain
// inside the existing managed Xray inbounds. Loopback only, no open proxy.
const http = require('http');
const net = require('net');
const WebSocket = require('./vendor/ws');
const targets = { '/railway-vmess': 21025, '/railway-trojan': 21002, '/railway-openvpn': 21023 };
// Unified per-user path ("/<subId>"): all WS configs of one user share a
// single path, so for those the target inbound is selected from the first
// payload bytes of the protocol handshake instead of from the path.
const TOKEN_PATH = /^\/[A-Za-z0-9_-]{8,64}$/;

function classifyProtocol(buf) {
  // Trojan: 56 lowercase hex chars (SHA-224 of the password) + CRLF.
  if (buf.length >= 58
      && /^[0-9a-f]{56}$/.test(buf.subarray(0, 56).toString('ascii'))
      && buf[56] === 13 && buf[57] === 10) return 21002;
  // VLESS: version 0x00, 16-byte UUID, empty addons, TCP/UDP command.
  if (buf.length >= 19 && buf[0] === 0 && buf[17] === 0 && (buf[18] === 1 || buf[18] === 2)) return 21001;
  // Everything else is VMess (AEAD header has no fixed marker).
  return 21025;
}

function pipeTo(stream, port, firstChunk) {
  const upstream = net.createConnection({ host: '127.0.0.1', port });
  if (firstChunk && firstChunk.length) upstream.write(firstChunk);
  upstream.on('error', () => stream.destroy());
  stream.on('error', () => upstream.destroy());
  upstream.on('close', () => stream.destroy());
  stream.on('close', () => upstream.destroy());
  stream.pipe(upstream).pipe(stream);
}

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocket.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { socket.destroy(); return; }
  const fixedPort = targets[pathname];
  const isTokenPath = !fixedPort && TOKEN_PATH.test(pathname);
  if ((!fixedPort && !isTokenPath) || req.method !== 'GET') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const stream = WebSocket.createWebSocketStream(ws, { highWaterMark: 65536 });
    if (fixedPort) { pipeTo(stream, fixedPort, null); return; }
    let buffered = Buffer.alloc(0);
    let decided = false;
    const decide = (port) => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      pipeTo(stream, port, buffered);
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= 58 || (buffered.length >= 19 && buffered[0] === 0)) decide(classifyProtocol(buffered));
    };
    const timer = setTimeout(() => decide(classifyProtocol(buffered)), 3000);
    stream.on('data', onData);
    stream.on('error', () => clearTimeout(timer));
    stream.on('close', () => clearTimeout(timer));
  });
});
server.on('error', (err) => { console.error('ws tcp bridge error:', err.message); process.exitCode = 1; });
server.listen(21130, '127.0.0.1', () => console.log('WS TCP bridge listening on 127.0.0.1:21130'));
