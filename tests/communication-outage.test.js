'use strict';
const assert = require('node:assert/strict');
const E = require('../src/engine');
const Replay = require('../src/replay');
const { createServer } = require('../server/world-server');

(async () => {
  const scene = structuredClone(E.scene);
  scene.communication.lossRate = 0;
  scene.communication.range = 1000;
  const world = E.create(42, 'nearest', scene);
  assert.equal(E.interruptCommunication(world, 'missing', 4).reason, 'unknown_agent');
  assert.equal(E.interruptCommunication(world, 'drone-1', 0).reason, 'invalid_duration');
  assert(E.sendMessage(world, 'drone-1', 'drone-2', 'before').ok);
  assert(E.sendMessage(world, 'drone-3', 'drone-2', 'unaffected').ok);
  assert(E.interruptCommunication(world, 'drone-1', 3).ok);
  assert.equal(E.interruptCommunication(world, 'drone-1', 3).reason, 'already_interrupted');
  assert(E.observe(world, 'drone-1').self.communicationInterrupted);
  for (let i = 0; i < 3; i++) E.step(world);
  assert(world.events.some(e => e.kind === 'message_failed' && e.reason === 'interrupted'));
  assert.equal(E.observe(world, 'drone-2').inbox[0].text, 'unaffected');
  assert(E.observe(world, 'drone-1').self.communicationInterrupted);
  E.step(world);
  assert(!E.observe(world, 'drone-1').self.communicationInterrupted);
  assert(world.events.some(e => e.kind === 'communication_restored' && e.tick === 4));
  assert(E.sendMessage(world, 'drone-1', 'drone-2', 'after').ok);
  for (let i = 0; i < 3; i++) E.step(world);
  assert(E.observe(world, 'drone-2').inbox.some(m => m.text === 'after'));

  // The normal scene is used for archive validation, which checks scene compatibility.
  const archiveWorld = E.create(42);
  assert(E.interruptCommunication(archiveWorld, 'drone-1', 2).ok);
  const archive = {format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames:[E.snapshot(archiveWorld)]};
  assert(Replay.validateArchive(archive));
  const legacy = structuredClone(archive);
  delete legacy.frames[0].communication.outages;
  assert(Replay.validateArchive(legacy));
  const invalid = structuredClone(archive);
  invalid.frames[0].communication.outages = [null];
  assert.throws(() => Replay.validateArchive(invalid));

  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', data, token) {
    const response = await fetch(base + path, {method, headers:{'content-type':'application/json', ...(token ? {authorization:'Bearer '+token} : {})}, body:data === undefined ? undefined : JSON.stringify(data)});
    return [response.status, await response.json()];
  }
  try {
    const [, session] = await request('/sessions', 'POST', {seed:42});
    const root = '/sessions/' + session.sessionId, admin = session.adminToken;
    const [, agent] = await request(root + '/agents/drone-1/credentials', 'POST', {}, admin);
    let [status] = await request(root + '/communication-outage', 'POST', {agentId:'drone-1', duration:3}, agent.agentToken);
    assert.equal(status, 403);
    let result;
    [status, result] = await request(root + '/communication-outage', 'POST', {agentId:'drone-1', duration:3}, admin);
    assert.equal(status, 200);
    assert.equal(result.world.communication.outages[0].untilTick, 3);
    await request(root + '/message', 'POST', {from:'drone-2',to:'drone-1',text:'test'}, admin);
    [, result] = await request(root + '/step', 'POST', {count:4}, admin);
    assert(result.world.events.some(e => e.kind === 'message_failed' && e.reason === 'interrupted'));
    assert(result.world.events.some(e => e.kind === 'communication_restored'));
    assert.equal(result.world.communication.outages.length, 0);
    console.log('communication outage tests passed');
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
