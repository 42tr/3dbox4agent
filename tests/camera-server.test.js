'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const {createServer} = require('../packages/world/server/world-server');

function request(port, path, method = 'GET', body, token) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...(body === undefined ? {} : {'content-type': 'application/json'}),
        ...(token ? {authorization: `Bearer ${token}`} : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
    });
    request.on('error', reject);
    if (body !== undefined) request.end(JSON.stringify(body)); else request.end();
  });
}

(async () => {
  const server = createServer({maxSessions: 1});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const created = await request(server.address().port, '/sessions', 'POST', {sceneId: 'industrial-park-v2'});
    assert.equal(created.status, 201);
    const session = JSON.parse(created.body);
    const route = `/sessions/${session.sessionId}/agents/drone-1/camera`;
    const initial = await request(server.address().port, route, 'GET', undefined, session.adminToken);
    assert.equal(initial.status, 200);
    assert.match(initial.headers['content-type'], /^image\/svg\b/);
    assert.match(initial.body.toString('utf8'), /SIM CAM/);
    const rotated = await request(server.address().port, `${route}?yaw=45&pitch=-12`, 'GET', undefined, session.adminToken);
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.toString('utf8'), /45° \/ -12°/);
    const old = await request(server.address().port, `${route}?revision=0`, 'GET', undefined, session.adminToken);
    assert.equal(old.status, 200);
    const deleted = await request(server.address().port, `/sessions/${session.sessionId}`, 'DELETE', undefined, session.adminToken);
    assert.equal(deleted.status, 200);
    console.log('World camera endpoint and retained frame access passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
