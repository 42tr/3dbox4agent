'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const {createControlProxy} = require('@42tr/3dbox4agent-control/http-forward');
const {requestOriginError} = require('@42tr/3dbox4agent-control/request-origin');

const streamHeaders = ['host', 'origin', 'connection', 'upgrade', 'sec-websocket-key',
  'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];

function proxyStream(origin, req, socket, head) {
  const transport = origin.protocol === 'https:' ? https : http;
  const headers = Object.fromEntries(streamHeaders.filter(name => req.headers[name] !== undefined)
    .map(name => [name, req.headers[name]]));
  const upstream = transport.request(origin, {path: '/stream', headers});
  const cancel = () => upstream.destroy();
  socket.once('close', cancel);
  socket.on('error', () => socket.destroy());
  upstream.setTimeout(5000, cancel);
  upstream.on('error', () => socket.destroy());
  upstream.on('response', response => {
    response.destroy();
    socket.destroy();
  });
  upstream.on('upgrade', (response, peer, peerHead) => {
    socket.removeListener('close', cancel);
    if (socket.destroyed) return peer.destroy();
    peer.setTimeout(0);
    socket.once('close', () => peer.destroy());
    peer.once('close', () => socket.destroy());
    peer.on('error', () => peer.destroy());
    const headers = Object.entries(response.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
    if (peerHead.length) socket.write(peerHead);
    if (head.length) peer.write(head);
    socket.pipe(peer).pipe(socket);
  });
  upstream.end();
}

function createConsoleServer({
  controlUrl,
  worldUrl = process.env.BOX_WORLD_URL || 'http://127.0.0.1:8787',
  htmlPath = path.join(__dirname, '../dist/index.html')
} = {}) {
  const world = new URL(worldUrl);
  if (!['http:', 'https:'].includes(world.protocol) || world.username || world.password || world.pathname !== '/' || world.search || world.hash) {
    throw new Error('BOX_WORLD_URL must be an HTTP or HTTPS origin');
  }
  const proxy = createControlProxy(controlUrl, {preserveOrigin: true});
  const html = fs.readFileSync(htmlPath);
  const server = http.createServer((req, res) => {
    const error = requestOriginError(req);
    if (error) {
      res.writeHead(403, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      return res.end(JSON.stringify({error}));
    }
    const pathname = req.url.split('?', 1)[0];
    if (pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    const target = pathname.startsWith('/control/') ? req.url.slice('/control'.length)
      : pathname === '/health' ? '/world' + req.url : req.url;
    return proxy(req, res, target);
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.method !== 'GET' || req.url !== '/stream' || requestOriginError(req)) return socket.destroy();
    return proxyStream(world, req, socket, head);
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.CONSOLE_PORT || 8780);
  const host = process.env.CONSOLE_BIND || '127.0.0.1';
  createConsoleServer().listen(port, host, () => console.log(`Console listening at http://${host}:${port}`));
}

module.exports = {createConsoleServer};
