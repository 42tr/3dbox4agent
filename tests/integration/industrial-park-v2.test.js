'use strict';

const assert = require('node:assert/strict');
const E = require('../../packages/world/src/world-core');
const Nav = require('../../packages/world/src/navigation');
const {unwrapArchive} = require('../../packages/world/src/replay');
const {createServer} = require('../../packages/world/server/world-server');

const sceneId = 'industrial-park-v2';
const seeds = [1, 42, 73];
const archive = (seed, frames, id = sceneId) => ({
  format: '3dbox-prototype-v1', config: {sceneId: id, seed, policy: 'nearest'}, frames,
});

function verifyMission(seed, frames) {
  assert.equal(frames[0].worldSize, 224);
  assert(frames.at(-1).done && !frames.at(-1).failed);
  assert.equal(frames.at(-1).tasks.filter(task => task.status === 'done').length, 5);
  assert(frames[0].agents.filter(agent => agent.role === 'vehicle').every(agent => agent.x < 100));
  assert(frames.some(frame => frame.agents.some(agent => agent.role === 'vehicle' && agent.x > 100)));
  assert.equal(unwrapArchive(archive(seed, frames)).coverage.end, 'finished');
}

async function verifyServer(backend) {
  const rules = backend === 'rust' ? 'rust' : 'js';
  const server = createServer({physicsBackend: backend, taskBackend: rules, communicationBackend: rules, navigationBackend: rules});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function api(path, {method = 'GET', data, token, status = 200} = {}) {
    const response = await fetch(origin + path, {method, headers: {
      'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {}),
    }, body: data === undefined ? undefined : JSON.stringify(data)});
    const result = await response.json();
    assert.equal(response.status, status, path + (result.error ? ": " + result.error : ""));
    return result;
  }
  try {
    for (const [seed, sensorMode] of [...seeds.map(seed => [seed, 'geometry']), ...(backend === 'rust' ? [[42, 'rapier']] : [])]) {
      const session = await api('/sessions', {method: 'POST', data: {sceneId, seed, sensorMode, physicsMode: 'rapier'}, status: 201});
      const path = '/sessions/' + session.sessionId;
      const token = session.adminToken;
      await api(path + '/step', {method: 'POST', data: {count: 350}, token});
      const {frames} = await api(path + '/history?after=-1', {token});
      verifyMission(seed, frames.map(frame => frame.world));
      await api(path, {method: 'DELETE', token});
    }
    const session = await api('/sessions', {method: 'POST', data: {sceneId, physicsMode: 'rapier', dispatchMode: 'external'}, status: 201});
    const path = '/sessions/' + session.sessionId;
    const actor = session.world.agents.find(agent => agent.role === 'drone');
    const credential = await api(path + '/agents/' + actor.id + '/credentials', {method: 'POST', data: {}, token: session.adminToken, status: 201});
    const actionPath = path + '/agents/' + actor.id + '/actions';
    const move = {type: 'move', requestId: 'out-of-bounds', targetTick: 1, expiresTick: 90, target: {x: 224.1, y: 75}};
    const rejection = await api(actionPath, {method: 'POST', data: move, token: credential.agentToken, status: 409});
    assert.equal(rejection.error, 'invalid_action');
    const accepted = await api(actionPath, {method: 'POST', data: {...move, requestId: 'inside', target: {x: 206, y: 143}}, token: credential.agentToken});
    assert.equal(accepted.action.status, 'pending');
    const done = await api(path + '/step', {method: 'POST', data: {count: 42}, token: session.adminToken});
    assert(done.world.agents.find(agent => agent.id === actor.id).x > 200);
    await api(path, {method: 'DELETE', token: session.adminToken});

    // A flat flight into the workshop roof used to move the native proxy in
    // elevation and reject the next tick. Exercise that contact in isolation.
    const contactSession = await api('/sessions', {method: 'POST', data: {sceneId, physicsMode: 'rapier', dispatchMode: 'external'}, status: 201});
    const contactPath = '/sessions/' + contactSession.sessionId;
    const actorPath = contactPath + '/agents/' + actor.id;
    const contactCredential = await api(actorPath + '/credentials', {method: 'POST', data: {}, token: contactSession.adminToken, status: 201});
    await api(actorPath + '/actions', {method: 'POST', data: {
      ...move, requestId: 'workshop-contact', target: {x: 206, y: 120},
    }, token: contactCredential.agentToken});
    const contact = await api(contactPath + '/step', {method: 'POST', data: {count: 40}, token: contactSession.adminToken});
    assert.equal(contact.world.tick, 40);
    assert(contact.world.events.some(event => event.tick > 8 && event.kind === 'collision_contact' && event.agentId === actor.id));
    await api(contactPath, {method: 'DELETE', token: contactSession.adminToken});
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  const scene = E.getScene(sceneId);
  const detour = Nav.plan([91, 77], [205, 77], scene.obstacles, [], 'distance', null, scene.worldSize);
  assert(detour.length > 1);
  for (const [start, goal] of [[[107, 220], [106, 168]], [[222, 120], [165, 120]]]) {
    assert.deepEqual(Nav.plan(start, goal, scene.obstacles, [], 'distance', null, scene.worldSize), [goal]);
  }
  assert.equal(Nav.plan([91, 77], [225, 77], scene.obstacles, [], 'distance', null, scene.worldSize), null);
  const native = require('../../packages/world/native/physics/target/release/box_physics.node');
  const clip = JSON.parse(native.guardMovement(JSON.stringify({
    worldSize: scene.worldSize, x: 220, y: 120, dx: 10, dy: 0, riskZones: [],
  })));
  assert(clip.crossing && clip.x === 224 && clip.dx === 4);
  const local = E.create(42, 'nearest', scene, {dispatchMode: 'external'});
  assert.equal(E.submitAction(local, 'drone-1', {
    type: 'move', requestId: 'beyond', targetTick: 1, expiresTick: 40, target: {x: 224.1, y: 75},
  }).reason, 'invalid_action');
  for (const seed of seeds) {
    const world = E.create(seed, 'nearest', scene);
    const frames = [E.snapshot(world)];
    while (!world.done && world.tick < 350) {
      E.step(world);
      frames.push(E.snapshot(world));
    }
    verifyMission(seed, frames);
  }
  const classic = E.create(42);
  assert.equal(classic.worldSize, undefined);
  assert.equal(unwrapArchive(archive(42, [E.snapshot(classic)], classic.sceneId)).archive.config.sceneId, 'industrial-park-v1');
  const invalidFrame = {...E.snapshot(local), worldSize: 100};
  assert.throws(() => unwrapArchive(archive(42, [invalidFrame])), /记录格式/);
  for (const backend of ['wasm', 'rust']) await verifyServer(backend);
  console.log('224-unit park completes all tasks on three backends, rejects out-of-bounds moves, and replays both scene versions');
})().catch(error => {console.error(error); process.exitCode = 1;});
