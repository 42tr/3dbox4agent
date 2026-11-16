'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {mkdtempSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {setTimeout: sleep} = require('node:timers/promises');

(async () => {
  const directory = mkdtempSync(path.join(tmpdir(), '3dbox-runner-token-'));
  const tokenFile = path.join(directory, 'builtin.token');
  const oldToken = 'old-' + 'a'.repeat(40);
  const newToken = 'new-' + 'b'.repeat(40);
  writeFileSync(tokenFile, oldToken);
  const seen = [];
  const control = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const accepted = req.headers.authorization === 'Bearer ' + newToken;
      seen.push({path: req.url, accepted});
      res.writeHead(accepted ? 200 : 401, {'content-type': 'application/json'});
      if (req.url === '/runners/v1/runners/builtin/register' && accepted) {
        return res.end('{"protocolVersion":1}');
      }
      if (req.url === '/runners/v1/runners/builtin/claim' && accepted) {
        return res.end('{"job":null}');
      }
      return res.end('{"error":"unauthorized"}');
    });
  });
  await once(control.listen(0, '127.0.0.1'), 'listening');
  const base = `http://127.0.0.1:${control.address().port}`;
  const child = spawn('python3', ['packages/agent/python/runner_web.py'], {
    env: {...process.env, BOX_CONTROL_URL: base, BOX_RUNNER_TOKEN_FILE: tokenFile,
      BOX_RUNNER_TOKEN: '', BOX_RUNNER_ID: 'builtin', BOX_RUNNER_PORT: '0'},
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 8000;
    let address;
    while (!address && Date.now() < deadline) {
      const match = /Runner listening on (127\.0\.0\.1:\d+)/.exec(output);
      if (match) address = match[1];
      else await sleep(50);
    }
    assert(address, output);
    await sleep(300);
    writeFileSync(tokenFile, newToken);
    let healthy = false;
    while (!healthy && Date.now() < deadline) {
      try {
        const response = await fetch(`http://${address}/health`);
        healthy = response.ok && (await response.json()).registered === true;
      } catch {}
      if (!healthy) await sleep(100);
    }
    assert(healthy, 'runner must reload the rotated token and register again');
    assert(seen.some(item => item.path.endsWith('/register') && !item.accepted));
    assert(seen.some(item => item.path.endsWith('/register') && item.accepted));
    assert.equal(readFileSync(tokenFile, 'utf8'), newToken);
    console.log('Runner token file reload after credential rotation passed');
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await new Promise(resolve => control.close(resolve));
    rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
