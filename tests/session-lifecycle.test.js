'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {createServer} = require('../server/world-server');
const {createSupervisor} = require('../server/world-supervisor');
const {createRegistry} = require('../packages/world/server/creation-registry');

async function checkWorkerExpiry(directory) {
  const server = createSupervisor({maxWorkers: 1, worldOptions: {sessionTtlMs: 200,
    journalDir: directory, replayJournal: true}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const create = () => fetch(base + '/sessions', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: '{}'});
  try {
    const created = await create();
    assert.equal(created.status, 201);
    const session = await created.json();
    const deadline = Date.now() + 5000;
    while (server.inspectWorkers().length) {
      assert(Date.now() < deadline, 'expired worker was not reclaimed');
      await sleep(25);
    }
    const headers = {authorization: 'Bearer ' + session.adminToken};
    assert.equal((await fetch(base + '/sessions/' + session.sessionId, {headers})).status, 404);
    const journal = await fetch(base + '/event-journals/' + session.sessionId + '/replay?camera=0', {headers});
    assert.equal(journal.status, 200);
    const replay = await journal.json();
    assert.equal(replay.closeReason, 'expired');
    assert.equal(replay.frames[0].revision, 0);
    assert.equal(replay.frames[0].cameraFrames, undefined);
    const next = await create();
    assert.equal(next.status, 201);
    await next.json();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function checkCreationTurnover() {
  for (const window of [{}, {creationExpiresAt: Date.now() + 30_000}]) {
    const registry = createRegistry();
    let creations = 0;
    const create = () => ({sessionId: String(++creations)});
    for (let i = 0; i < 130; i++) {
      const input = {creationKey: i.toString(16).padStart(64, '0'), ...window};
      const session = await registry.run(input, create);
      assert.equal(await registry.run(input, create), session);
      registry.closeSession(session.sessionId);
      await assert.rejects(registry.run(input, create), {message: 'session_not_found', status: 404});
    }
    assert.equal(creations, 130);
  }
}

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
    await checkWorkerExpiry(path.join(directory, 'supervised'));
    await checkCreationTurnover();
    console.log('Idle expiry releases the worker, preserves the journal, and frees creation receipt capacity');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
