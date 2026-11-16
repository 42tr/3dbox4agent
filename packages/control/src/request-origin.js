'use strict';

const net = require('node:net');

// IPs and localhost work without configuration. DNS names must be explicitly
// allowlisted so a hostile domain cannot rebind to a loopback/private service.
function allowedHostname(hostname) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (bare === 'localhost' || net.isIP(bare) !== 0) return true;
  return (process.env.BOX_ALLOWED_HOSTS || '').split(',')
    .map(value => value.trim().toLowerCase()).filter(Boolean).includes(bare);
}

// Browser requests must use the same authority as the page; HTTPS may
// terminate at a reverse proxy. Non-browser requests still require route auth.
function requestOriginError(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !host || /[\s\\/?#@%,]/.test(host)) return 'invalid_host';
  try {
    const target = new URL(`http://${host}`);
    if (!target.hostname || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return 'invalid_host';
    if (!allowedHostname(target.hostname.toLowerCase())) return 'invalid_host';
  } catch { return 'invalid_host'; }
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  if (typeof origin !== 'string') return 'invalid_origin';
  try {
    const source = new URL(origin);
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin || source.origin !== new URL(`${source.protocol}//${host}`).origin) return 'invalid_origin';
  } catch { return 'invalid_origin'; }
  return null;
}

module.exports = {requestOriginError};
