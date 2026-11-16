'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {createServer} = require('../server/world-server');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '3dbox-session-lifecycle-'));
  const server = createServer({journalDir: directory, sessionTtlMs: 200, journalRetentionMs: 200});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await fetch(base + '/sessions', {method: 'POST',
      headers: {'content-type': 'application/json'}, body: '{"sceneId":"shore-surface-v1"}'});
    assert.equal(response.status, 201);
    const session = await response.json();
    const journal = path.join(directory, session.sessionId + '.jsonl');
    assert(fs.existsSync(journal));
    const deadline = Date.now() + 5000;
    // Do not poll the session itself: authenticated activity intentionally
    // refreshes its idle deadline. Wait first, then check once.
    await sleep(700);
    const status = (await fetch(base + '/sessions/' + session.sessionId,
      {headers: {authorization: 'Bearer ' + session.adminToken}})).status;
    assert.equal(status, 404, 'idle session was not expired');
    while (fs.existsSync(journal)) {
      assert(Date.now() < deadline, 'expired journal was not reclaimed');
      await sleep(50);
    }
    console.log('Idle session expiry and journal retention cleanup passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
