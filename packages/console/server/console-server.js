'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createControlProxy} = require('@42tr/3dbox4agent-control/http-forward');
const {requestOriginError} = require('@42tr/3dbox4agent-control/request-origin');
const {loadDeploymentInfo, renderDeploymentPage} = require('./deployment-info');
const {createConsoleAuth, browserWriteAllowed, json} = require('./console-auth');
const {serveLogin} = require('./login-page');

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
  auth: authOptions,
  worldUrl = process.env.BOX_WORLD_URL || 'http://127.0.0.1:8787',
  htmlPath = path.join(__dirname, '../dist/index.html'),
  deploymentInfoPath = process.env.BOX_DEPLOYMENT_INFO || path.join(__dirname, '../../../deployment-info.json')
} = {}) {
  const world = new URL(worldUrl);
  if (!['http:', 'https:'].includes(world.protocol) || world.username || world.password || world.pathname !== '/' || world.search || world.hash) {
    throw new Error('BOX_WORLD_URL must be an HTTP or HTTPS origin');
  }
  const proxy = createControlProxy(controlUrl, {preserveOrigin: true});
  const auth = createConsoleAuth(authOptions);
  const html = fs.readFileSync(htmlPath);
  const htmlGzip = zlib.gzipSync(html, {level: 6});
  const deploymentInfo = loadDeploymentInfo(deploymentInfoPath);
  const deploymentJson = Buffer.from(JSON.stringify(deploymentInfo), 'utf8');
  const deploymentHtml = renderDeploymentPage(deploymentInfo);
  const server = http.createServer((req, res) => {
    const error = requestOriginError(req);
    if (error) {
      res.writeHead(403, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      return res.end(JSON.stringify({error}));
    }
    const pathname = req.url.split('?', 1)[0];
    if (pathname === '/login' && ['GET', 'HEAD'].includes(req.method)) return serveLogin(req, res);
    if (pathname.startsWith('/auth/')) {
      return auth.handle(req, res, pathname).catch(() => {
        if (!res.headersSent && !res.destroyed) json(res, 500, {error: 'login_unavailable'});
      });
    }
    if (pathname.startsWith('/console-api/')) {
      const session = auth.session(req);
      if (!session) return json(res, 401, {error: 'login_required'});
      const target = req.url.slice('/console-api'.length);
      // Only browser management routes may borrow the operator identity.
      const taskRoute = /^\/runs\/v1\/(?:integrations(?:\/[a-zA-Z0-9-]+)?|runs(?:\/[a-zA-Z0-9-]+(?:\/(?:report|observer|events(?:\/stream)?|commands\/(?:pause_run|resume_run|cancel_run)))?)?)$/;
      const runnerRoute = /^\/runners\/v1\/(?:runners(?:\/[a-zA-Z0-9-]+)?|runs(?:\/[a-zA-Z0-9-]+(?:\/(?:report|observer|cancel))?)?)$/;
      const route = target.split('?', 1)[0];
      if (!taskRoute.test(route) && !runnerRoute.test(route)) return json(res, 404, {error: 'not_found'});
      if (!['GET', 'HEAD'].includes(req.method) && !browserWriteAllowed(req)) return json(res, 403, {error: 'invalid_origin'});
      req.headers.authorization = 'Bearer ' + auth.operatorToken;
      auth.bindResponse(session, res);
      return proxy(req, res, target);
    }
    if (pathname === '/deployment.json' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'content-length': deploymentJson.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      return res.end(req.method === 'HEAD' ? undefined : deploymentJson);
    }
    if (pathname === '/deployment' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-length': deploymentHtml.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      return res.end(req.method === 'HEAD' ? undefined : deploymentHtml);
    }
    if (pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
      const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const body = gzip ? htmlGzip : html;
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'vary': 'accept-encoding', ...(gzip ? {'content-encoding': 'gzip'} : {})});
      return res.end(req.method === 'HEAD' ? undefined : body);
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
