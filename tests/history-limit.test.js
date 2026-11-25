'use strict';
const assert = require('node:assert/strict');
const {createServer} = require('../server/world-server');

(async () => {
  const budget = 240_000;
  const server = createServer({maxHistoryBytes: budget});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, method = 'GET', body, token) {
    const response = await fetch(base + path, {
      method,
      headers: {'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {})},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(response.ok, path + ': ' + response.status);
    return response.json();
  }
  try {
    const session = await request('/sessions', 'POST', {seed: 42, sceneId: 'industrial-park-v2'});
    const root = '/sessions/' + session.sessionId;
    const token = session.adminToken;
    await request(root + '/step', 'POST', {count: 10}, token);
    const history = await request(root + '/history', 'GET', undefined, token);
    assert(history.truncated);
    assert(history.frames[0].revision > 0);
    assert.equal(history.frames.at(-1).revision, 10);
    assert(history.frames.every(frame => frame.cameraFrames['drone-1'].svg));
    assert(Buffer.byteLength(JSON.stringify(history.frames)) <= budget + 1);
    const first = await request(root + '/history?limit=1&camera=0', 'GET', undefined, token);
    assert.equal(first.through, 10);
    assert.equal(first.nextAfter, history.frames[0].revision);
    assert.equal(first.frames[0].cameraFrames, undefined);
    await request(root + '/step', 'POST', {count: 1}, token);
    const tail = await request(root + '/history?limit=100&after=' + first.nextAfter + '&through=10&camera=0', 'GET', undefined, token);
    assert.equal(tail.revision, 11);
    assert.equal(tail.frames.at(-1).revision, 10);
    assert.equal(tail.nextAfter, null);
    console.log('History limits count camera payloads and bound a paged read to a fixed revision');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
