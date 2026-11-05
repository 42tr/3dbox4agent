'use strict';
const assert = require('node:assert/strict');
const E = require('../src/engine');
const Replay = require('../src/replay');
const {createServer} = require('../server/world-server');

function configured(overrides = {}) {
  const scene = structuredClone(E.scene);
  Object.assign(scene.communication, overrides);
  return E.create(42, 'nearest', scene, {dispatchMode:'networked'});
}
function runInterruption() {
  const s = configured({lossRate:0});
  E.step(s);
  assert.equal(s.tasks[0].status, 'pending');
  assert.equal(s.communication.dispatchQueue.length, 1);
  const original = s.communication.dispatchQueue[0].agentId;
  assert(E.interruptCommunication(s, original, 20).ok);
  for (let i = 0; i < 3; i++) E.step(s);
  assert(s.events.some(e => e.kind === 'dispatch_failed' && e.reason === 'interrupted' && e.agentId === original));
  assert.equal(s.tasks[0].status, 'pending');
  assert.notEqual(s.communication.dispatchQueue[0].agentId, original);
  for (let i = 0; i < 3; i++) E.step(s);
  assert.equal(s.tasks[0].status, 'active');
  assert.notEqual(s.tasks[0].assignee, original);
  assert.equal(s.decisions.filter(d => d.taskId === 'inspect' && d.status === 'accepted').length, 1);
  while (!s.done && s.tick < 1000) E.step(s);
  assert(s.done && !s.failed);
  assert.equal(s.asset.condition, 'operational');
  assert(s.events.some(e => e.kind === 'communication_restored' && e.agentId === original));
  return s;
}

(async () => {
  assert.deepEqual(runInterruption(), runInterruption());
  const lost = configured({lossRate:1});
  for (let i = 0; i < 25; i++) E.step(lost);
  assert(!lost.done);
  assert(lost.events.filter(e => e.kind === 'dispatch_failed' && e.reason === 'dropped').length > 1);
  assert.equal(lost.decisions.length, 0);
  const expired = configured({lossRate:0,delay:3,ttl:1});
  for (let i = 0; i < 4; i++) E.step(expired);
  assert(expired.events.some(e => e.kind === 'dispatch_failed' && e.reason === 'expired'));
  const stale = configured({lossRate:0,delay:6,ttl:15});
  for (let i = 0; i < 7; i++) E.step(stale);
  assert(stale.events.some(e => e.kind === 'dispatch_failed' && e.reason === 'stale_observation'));
  const first = E.create(42, 'nearest', E.scene, {dispatchMode:'networked'});
  E.step(first);
  const archive = {format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames:[E.snapshot(first)]};
  assert(Replay.validateArchive(archive));
  const corrupt = structuredClone(archive);
  corrupt.frames[0].communication.dispatchQueue = [null];
  assert.throws(() => Replay.validateArchive(corrupt));

  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method='GET', body, token) {
    const response = await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return [response.status, await response.json()];
  }
  try {
    const [status, session] = await request('/sessions','POST',{seed:42,dispatchMode:'networked'});
    assert.equal(status,201);
    const root='/sessions/'+session.sessionId, admin=session.adminToken;
    let [, state] = await request(root+'/step','POST',{count:1},admin);
    const selected = state.world.communication.dispatchQueue[0].agentId;
    await request(root+'/communication-outage','POST',{agentId:selected,duration:20},admin);
    [, state] = await request(root+'/step','POST',{count:6},admin);
    assert(state.world.events.some(e => e.kind==='dispatch_failed' && e.reason==='interrupted'));
    assert.equal(state.world.tasks[0].status,'active');
    assert.notEqual(state.world.tasks[0].assignee,selected);
    [, state] = await request(root+'/history?after=-1','GET',undefined,admin);
    assert(state.frames.some(f=>f.world.events.some(e=>e.kind==='dispatch_failed'&&e.reason==='interrupted')));
    console.log('network dispatch tests passed');
  } finally { server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
