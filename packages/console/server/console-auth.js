'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {promisify} = require('node:util');
const scrypt = promisify(crypto.scrypt);
const COOKIE = 'threebox_console_session';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers});
  res.end(JSON.stringify(value));
}

// Cookie-authenticated writes require a same-origin JSON request. The caller
// has already checked Host and Origin against the deployment allowlist.
function browserWriteAllowed(req) {
  return typeof req.headers.origin === 'string'
    && req.headers['content-type']?.split(';')[0].trim() === 'application/json'
    && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw Error('invalid_request');
  }
  return JSON.parse(body);
}

function createConsoleAuth({
  username = process.env.BOX_CONSOLE_USERNAME || '',
  passwordHash = process.env.BOX_CONSOLE_PASSWORD_HASH || '',
  operatorToken = process.env.BOX_RUNNER_OPERATOR_TOKEN || '',
  dataDir = process.env.BOX_CONSOLE_DATA_DIR || path.join(process.cwd(), '.3dbox/console'),
  secure = (process.env.BOX_CONSOLE_URL || '').startsWith('https://'),
  sessionSeconds = 7 * 24 * 60 * 60,
  now = Date.now,
} = {}) {
  const configured = Boolean(username && passwordHash && operatorToken);
  if ((username || passwordHash) && (!configured || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash))) {
    throw Error('Console login requires BOX_CONSOLE_USERNAME, a valid BOX_CONSOLE_PASSWORD_HASH and BOX_RUNNER_OPERATOR_TOKEN');
  }
  const fingerprint = digest(JSON.stringify([username, passwordHash, operatorToken]));
  const filename = path.join(dataDir, 'sessions.json');
  const sessions = new Map();
  const attempts = new Map();
  const streams = new Map();
  if (configured) {
    fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});
    try {
      const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (stored.fingerprint === fingerprint) {
        for (const [key, value] of Object.entries(stored.sessions)) {
          if (/^[a-f0-9]{64}$/.test(key) && value.username === username && value.expiresAt > now()) sessions.set(key, value);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function save() {
    for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key);
    const tmp = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({fingerprint, sessions: Object.fromEntries(sessions)}), {mode: 0o600});
    fs.renameSync(tmp, filename);
  }
  function cookie(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  function keyFor(req) {
    const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
    if (values.length !== 1) return null;
    const token = values[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? digest(token) : null;
  }
  function session(req) {
    if (!configured || req.headers['sec-fetch-site'] === 'cross-site') return null;
    const key = keyFor(req), value = sessions.get(key);
    return value && value.expiresAt > now() ? {key, ...value} : null;
  }
  function revoke(key) {
    sessions.delete(key);
    save();
    for (const response of streams.get(key) || []) response.destroy();
    streams.delete(key);
  }
  // End active SSE responses on logout/expiry, not just on the next HTTP poll.
  function bindResponse(auth, res) {
    if (!streams.has(auth.key)) streams.set(auth.key, new Set());
    streams.get(auth.key).add(res);
    const timer = setTimeout(() => res.destroy(), Math.max(1, auth.expiresAt - now()));
    timer.unref();
    res.once('close', () => {
      clearTimeout(timer);
      streams.get(auth.key)?.delete(res);
      if (!streams.get(auth.key)?.size) streams.delete(auth.key);
    });
  }
  async function handle(req, res, pathname) {
    if (pathname === '/auth/session' && req.method === 'GET') {
      const value = session(req);
      return json(res, 200, {configured, authenticated: !!value,
        ...(value ? {username: value.username, expiresAt: value.expiresAt} : {})});
    }
    if (!['/auth/login', '/auth/logout'].includes(pathname) || req.method !== 'POST') return json(res, 404, {error: 'not_found'});
    if (!browserWriteAllowed(req)) return json(res, 403, {error: 'invalid_origin'});
    if (!configured) return json(res, 503, {error: 'console_login_not_configured'});
    if (pathname === '/auth/logout') {
      const key = keyFor(req);
      if (key && sessions.has(key)) revoke(key);
      return json(res, 200, {authenticated: false}, {'set-cookie': cookie('', 0)});
    }
    const ip = req.socket.remoteAddress;
    const recent = (attempts.get(ip) || []).filter(at => at > now() - 300000);
    if (recent.length >= 10) return json(res, 429, {error: 'login_rate_limited'}, {'retry-after': '300'});
    if (attempts.size >= 1000 && !attempts.has(ip)) attempts.delete(attempts.keys().next().value);
    attempts.set(ip, [...recent, now()]);
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, {error: 'invalid_request'}); }
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) return json(res, 400, {error: 'invalid_request'});
    const [, salt, expected] = passwordHash.split(':');
    const actual = await scrypt(body.password, salt, 64);
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), actual) || body.username !== username) return json(res, 401, {error: 'invalid_credentials'});
    attempts.delete(ip);
    const oldKey = keyFor(req);
    if (oldKey && sessions.has(oldKey)) revoke(oldKey);
    if (sessions.size >= 1000) revoke(sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex');
    const value = {username, expiresAt: now() + sessionSeconds * 1000};
    sessions.set(digest(token), value);
    save();
    return json(res, 200, {authenticated: true, ...value}, {'set-cookie': cookie(token, sessionSeconds)});
  }
  return {handle, session, bindResponse, operatorToken};
}

module.exports = {createConsoleAuth, hashPassword, browserWriteAllowed, json};
