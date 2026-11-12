'use strict';

const http = require('node:http');
const https = require('node:https');

const CONTROL_HTTP_ORIGIN = 'http://127.0.0.1:8789';
const prefix = '/control';
const requestHeaders = ['authorization', 'content-type', 'content-length', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const responseHeaders = ['content-type', 'content-length', 'cache-control', 'content-disposition', 'x-content-type-options', 'mcp-session-id'];

function selectHeaders(headers, names) {
  return Object.fromEntries(names.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]));
}

function createControlProxy(controlUrl = process.env.BOX_CONTROL_URL || CONTROL_HTTP_ORIGIN, {preserveOrigin = false} = {}) {
  const origin = new URL(controlUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw Error('BOX_CONTROL_URL must be an HTTP or HTTPS origin');
  }
  const transport = origin.protocol === 'https:' ? https : http;
  const headers = preserveOrigin ? [...requestHeaders, 'host', 'origin'] : requestHeaders;
  return function proxyControl(req, res, path) {
    const upstream = transport.request(origin, {
      method: req.method,
      path,
      headers: selectHeaders(req.headers, headers)
    }, response => {
      upstream.setTimeout(0);
      res.writeHead(response.statusCode, selectHeaders(response.headers, responseHeaders));
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(35000, () => upstream.destroy());
    upstream.on('error', () => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(502, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      res.end(JSON.stringify({error: 'control_unreachable'}));
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  };
}

function createControlForwarder(controlUrl) {
  const proxy = createControlProxy(controlUrl);
  return function forwardControl(req, res) {
    if (!req.url.startsWith(prefix + '/')) return false;
    proxy(req, res, req.url.slice(prefix.length));
    return true;
  };
}

module.exports = {createControlForwarder, createControlProxy};
