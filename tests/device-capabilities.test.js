'use strict';

const assert = require('node:assert/strict');
const {once} = require('node:events');
const E = require('../packages/world/src/world-core');
const Sensors = require('../packages/world/src/sensors');
const Flight = require('../packages/world/src/flight');
const {unwrapArchive} = require('../packages/world/src/replay');
const {createServer} = require('../packages/world/server/world-server');
const {createHttpAgentClient} = require('../packages/control/src/agent-control-client');

const move = (requestId, bearingDeg, distanceM, targetTick = 1) => ({
  type: 'move', requestId, direction: {bearingDeg, distanceM}, targetTick, expiresTick: targetTick + 20,
});
const close = (a, b) => Math.abs(a - b) < 1e-5;

function fixture() {
  const scene = E.getScene();
  scene.agents = [{role: 'vehicle', label: '运输车', count: 1, capabilities: ['deliver'], speed: 3,
    spawnArea: {x: 20, y: 30, w: 1, h: 1}}];
  scene.obstacles = [];
  return scene;
}

function verifyDirection() {
  const scene = fixture();
  scene.obstacles.push({id: 'wall', x: 30, y: 26, w: 2, h: 10, height: 5});
  const world = E.create(42, 'nearest', scene, {dispatchMode: 'external'});
  const id = world.agents[0].id;
  const frames = [E.snapshot(world)];
  const intent = move('east', 90, 20);
  const submitted = E.submitAction(world, id, intent);
  assert(submitted.ok);
  assert.equal(E.submitAction(world, id, {...intent, direction: {bearingDeg: 0, distanceM: 20}}).reason, 'request_id_conflict');
  assert.equal(E.submitAction(world, id, move('bad-bearing', 360, 5)).reason, 'invalid_action');
  assert.equal(E.submitAction(world, id, move('bad-distance', 0, 41)).reason, 'invalid_action');
  assert.equal(E.submitAction(world, id, {type: 'move', requestId: 'bad-z', target: {x: 20, y: 30, z: 16}, targetTick: 1, expiresTick: 20}).reason, 'flight_motion_unavailable');
  frames.push(E.snapshot(world));
  for (let i = 0; i < 5; i++) {
    E.step(world);
    frames.push(E.snapshot(world));
  }
  const result = E.submitAction(world, id, intent);
  assert(result.ok && result.duplicate);
  assert.equal(result.action.status, 'failed');
  assert.equal(result.action.reason, 'movement_blocked');
  assert(close(result.action.result.position.x, 29.199));
  assert(close(result.action.result.position.y, 30));
  assert(close(result.action.result.completedM, 9.199));
  assert(close(result.action.result.remainingM, 10.801));
  const archive = {format: '3dbox-prototype-v1', config: {seed: 42, policy: 'nearest', scene}, frames};
  unwrapArchive(archive);
  const forged = structuredClone(archive);
  forged.frames.at(-1).actions[0].result.position.y += 1;
  assert.throws(() => unwrapArchive(forged), /记录格式/);

  const freeScene = fixture();
  const w = E.create(42, 'nearest', freeScene, {dispatchMode: 'external'});
  assert(E.submitAction(w, id, move('first', 0, 3)).ok);
  assert(E.submitAction(w, id, move('stale-start', 90, 10, 2)).ok);
  E.step(w);
  E.step(w);
  assert.equal(w.actions[0].status, 'completed');
  assert.equal(w.actions[1].reason, 'pose_changed');
  assert(close(w.agents[0].x, 20) && close(w.agents[0].y, 27));

  const interrupted = E.create(42, 'nearest', freeScene, {dispatchMode: 'external'});
  assert(E.submitAction(interrupted, id, move('blocked-midway', 90, 20)).ok);
  E.step(interrupted);
  assert(E.injectRoadblock(interrupted, {x: 30, y: 25, w: 4, h: 10}, 20).ok);
  for (let i = 0; i < 5; i++) E.step(interrupted);
  assert.equal(interrupted.actions[0].reason, 'movement_blocked');
  assert(close(interrupted.agents[0].x, 29.199) && close(interrupted.agents[0].y, 30));
  assert(!interrupted.events.some(e => e.kind === 'roadblock_replanned'));

  const cancelled = E.create(42, 'nearest', freeScene, {dispatchMode: 'external'});
  assert(E.submitAction(cancelled, id, move('cancel', 90, 10)).ok);
  E.step(cancelled);
  const stop = E.cancelAction(cancelled, id, 'cancel');
  assert(stop.ok && stop.action.status === 'cancelled' && close(stop.action.result.completedM, 3));
  E.step(cancelled);
  assert(close(cancelled.agents[0].x, 23));

  const rapier = E.create(42, 'nearest', freeScene, {physicsMode: 'rapier', dispatchMode: 'external'});
  assert.equal(E.submitAction(rapier, id, move('unsupported', 90, 8)).reason, 'directional_motion_unavailable');
}

function verifyFlight() {
  const scene = fixture();
  scene.agents.unshift({role: 'drone', label: '无人机', count: 1, speed: 3.8,
    capabilities: ['inspect'], spawnArea: {x: 20, y: 30, w: 1, h: 1}});
  scene.agents[1].spawnArea = {x: 60, y: 30, w: 1, h: 1};
  scene.obstacles.push({id: 'wall', x: 28, y: 25, w: 5, h: 10, height: 40});
  const world = E.create(42, 'nearest', scene, {dispatchMode: 'external'});
  const id = 'drone-1', actor = world.agents[0];
  const frames = [E.snapshot(world)];
  const step = () => {E.step(world); frames.push(E.snapshot(world));};
  const submit = (requestId, payload) => {
    const targetTick = world.tick + 1;
    const result = E.submitAction(world, id, {type: 'move', requestId, ...payload, targetTick, expiresTick: targetTick + 20});
    assert(result.ok, JSON.stringify(result));
    frames.push(E.snapshot(world));
    return world.actions.at(-1);
  };
  const rise = submit('rise', {vertical: {deltaM: 5}});
  step();
  assert.deepEqual(Sensors.position(actor), {x: 20, y: 30, z: 18});
  assert.equal(rise.status, 'accepted');
  assert(close(rise.result.remainingM, 3));
  step(); step();
  assert.equal(rise.status, 'completed');
  assert.equal(E.observe(world, id).self.z, 21);
  assert(close(rise.result.completedM, 5));
  const retreat = submit('descend', {vertical: {deltaM: -5}});
  step();
  assert(E.cancelAction(world, id, 'descend').ok);
  frames.push(E.snapshot(world));
  step();
  assert.equal(retreat.status, 'cancelled');
  assert.equal(actor.flightZ, 19);
  assert(close(retreat.result.remainingM, 3));
  const limit = submit('too-low', {vertical: {deltaM: -18}});
  step();
  assert.equal(limit.reason, 'flight_height_limit');
  assert.equal(actor.flightZ, 19);

  const waypoint = submit('bypass', {target: {x: 40, y: 30, z: 19}});
  while (['pending', 'accepted'].includes(waypoint.status) && world.tick < 50) step();
  assert.equal(waypoint.status, 'completed');
  assert.deepEqual(waypoint.result.position, {x: 40, y: 30, z: 19});
  assert(waypoint.result.completedM > 20);
  assert(frames.some(frame => Math.abs(frame.agents[0].y - 30) > 5));
  unwrapArchive({format: '3dbox-prototype-v1', config: {seed: 42, policy: 'nearest', scene}, frames});
  const forged = structuredClone(frames.at(-1));
  forged.agents[0].flightZ = .5;
  assert.throws(() => unwrapArchive({format: '3dbox-prototype-v1', config: {seed: 42, policy: 'nearest', scene}, frames: [forged]}), /记录格式/);

  const overlap = fixture();
  overlap.agents.unshift(scene.agents[0]);
  const crossing = E.create(42, 'nearest', overlap, {dispatchMode: 'external'});
  assert(E.submitAction(crossing, id, {type: 'move', requestId: 'collision', vertical: {deltaM: -14}, targetTick: 1, expiresTick: 20}).ok);
  for (let i = 0; i < 9; i++) E.step(crossing);
  assert.equal(crossing.actions[0].reason, 'collision_blocked');
  assert(close(crossing.agents[0].flightZ, 3.1));
  assert(crossing.actions[0].result.remainingM > 1);

  const terrain = {heightfield: {rows: 2, cols: 3, heights: [0, 10, 0, 0, 10, 0]}, obstacles: []};
  const from = {x: 5, y: 30, z: 10}, to = {x: 95, y: 30, z: 10};
  assert(!Flight.clear(terrain, from, to));
  const ridge = Flight.plan(terrain, from, to);
  assert(ridge?.some(point => point.z >= 12));
}

function verifyFlightControl() {
  const scene = fixture();
  scene.agents = [{role: 'drone', label: '无人机', count: 1, speed: 3.8,
    capabilities: ['inspect','confirm'], spawnArea: {x: 21, y: 30, w: 1, h: 1}}];
  scene.obstacles.push({id:'roof', x: 34, y: 30, w: 5, h: 6, height: 5});
  const world = E.create(42, 'nearest', scene, {dispatchMode: 'external'});
  const actor = world.agents[0];
  const frames = [E.snapshot(world)];
  const step = () => { E.step(world); frames.push(E.snapshot(world)); };
  const queue = (requestId, payload) => {
    const command = {requestId,type:'move',targetTick:world.tick+1,expiresTick:world.tick+40,...payload};
    assert(E.submitAction(world,actor.id,command).ok);
    frames.push(E.snapshot(world));
    return world.actions.at(-1);
  };
  const complete = action => {
    for(let i=0;i<40&&['pending','accepted'].includes(action.status);i++)step();
    assert(!['pending','accepted'].includes(action.status), JSON.stringify(action));
  };

  const flying = queue('airborne-start', {flightControl:{mode:'takeoff'}});
  complete(flying);
  assert.equal(flying.reason,'already_airborne');
  const roof = queue('roof', {flightControl:{mode:'land',x:36,y:33}});
  complete(roof);
  assert.equal(roof.reason,'landing_site_unavailable');

  const hover = queue('hold', {flightControl:{mode:'hover',durationTicks:4}});
  const position = Sensors.position(actor);
  const battery = actor.battery;
  step();step();
  assert.equal(hover.result.heldTicks,2);
  assert.equal(hover.result.remainingTicks,2);
  assert.deepEqual(Sensors.position(actor), position);
  assert(actor.battery<battery);
  assert(E.cancelAction(world,actor.id,'hold').ok);
  step();
  assert.equal(hover.result.heldTicks,2);
  assert.deepEqual(Sensors.position(actor),position);

  const land = queue('land', {flightControl:{mode:'land',x:25,y:34}});
  complete(land);
  assert.equal(land.status,'completed');
  assert.deepEqual(land.result.position,{x:25,y:34,z:.8});
  assert.equal(actor.landed,true);
  assert.equal(E.observe(world,actor.id).self.flightState,'landed');
  assert.equal(world.done,false, 'the parked drone can still take off to serve the ready task');
  assert.equal(E.injectRoadblock(world,{x:24,y:33,w:3,h:3},10).reason,'agent_in_roadblock');

  const noGroundTaxi = queue('taxi', {target:{x:20,y:20}});
  complete(noGroundTaxi);
  assert.equal(noGroundTaxi.reason,'takeoff_required');
  const lift = queue('lift', {flightControl:{mode:'takeoff'}});
  complete(lift);
  assert.equal(lift.status,'completed');
  assert.equal(actor.landed,undefined);
  assert.equal(actor.flightZ,8);
  assert.deepEqual(E.submitAction(world,actor.id,{
    type:'move',requestId:'lift',targetTick:lift.targetTick,expiresTick:lift.expiresTick,
    flightControl:{mode:'takeoff',heightM:8},
  }).action,lift);

  const hoverCompleted = queue('hold-to-end', {flightControl:{mode:'hover',durationTicks:3}});
  complete(hoverCompleted);
  assert.equal(hoverCompleted.result.heldTicks,3);
  assert.equal(hoverCompleted.status,'completed');

  complete(queue('raise-for-landing-abort', {vertical:{deltaM:1}}));
  const abort = queue('abort-at-low-height', {flightControl:{mode:'land',x:25,y:34}});
  for(let i=0;i<4;i++)step();
  assert.equal(abort.status,'accepted');
  assert.equal(actor.flightZ,1);
  assert(E.cancelAction(world,actor.id,abort.requestId).ok);
  step();
  assert.equal(E.observe(world,actor.id).self.flightState,'low_altitude');
  const recovery = queue('recover', {flightControl:{mode:'takeoff',heightM:4}});
  complete(recovery);
  assert.equal(recovery.status,'completed');
  assert.equal(actor.flightZ,4);
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',scene},frames};
  unwrapArchive(archive);
  const forged=structuredClone(archive);
  forged.frames.at(-1).actions.find(action=>action.requestId==='hold-to-end').result.heldTicks=5;
  assert.throws(()=>unwrapArchive(forged),/记录格式/);

  const shore = E.getScene('shore-surface-v1');
  assert.equal(Flight.landingPoint(shore,80,20),null);
  const steep={heightfield:{rows:2,cols:2,heights:[-10,10,10,10]}};
  assert.equal(Flight.landingPoint(steep,15,15),null);
}

async function verifyScopedApi() {
  const server = createServer({physicsBackend: 'wasm', taskBackend: 'js'});
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  async function request(path, token, body, status = 200) {
    const response = await fetch(baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  try {
    const session = await request('/sessions', null, {sceneId: 'industrial-park-fixed-sensor-v1', dispatchMode: 'external'}, 201);
    const root = '/sessions/' + session.sessionId;
    const {adminToken} = session;
    const agentId = 'drone-1';
    const {agentToken} = await request(root + '/agents/' + agentId + '/credentials', adminToken, {}, 201);
    const agent = createHttpAgentClient({baseUrl, agentId, sessionId: session.sessionId, token: agentToken});
    const before = await agent.observe({includeDevice: true});
    const device = before.device;
    assert.equal(device.source, 'self');
    assert.equal(device.observedTick, before.tick);
    assert.equal(device.profile.id, agentId);
    assert.equal(device.profile.mobility, 'air');
    assert.equal(device.pose.z, 16);
    assert(device.availableActions.some(action => action.name === 'ascend' && action.available));
    assert.equal(device.pose.x, before.self.x);
    assert.equal(device.pose.y, before.self.y);
    assert.equal(device.status.batteryPct, before.self.battery);
    assert(device.availableActions.some(action => action.name === 'move_direction' && action.available));
    assert(!Object.hasOwn(await agent.observe(), 'device'));
    assert(!Object.hasOwn(before, 'world'));
    for (const contact of device.observations) assert(contact.observedTick <= before.tick && contact.source);
    await request(root + '/observations/vehicle-1?include=device', agentToken, undefined, 403);
    await request(root + '/coordinator/observation?include=device', agentToken, undefined, 403);

    const intent = move('agent-east', 90, 2, before.tick + 1);
    assert.equal((await agent.submitAction(intent)).action.status, 'pending');
    assert.equal((await agent.observe({includeDevice: true})).device.availableActions.find(a => a.name === 'move_to').reason, 'action_pending');
    await request(root + '/step', adminToken, {count: 1});
    const after = (await agent.observe({includeDevice: true})).device;
    assert.equal(after.actions.at(-1).status, 'completed');
    assert(close(after.pose.x, device.pose.x + 2));
    assert(close(after.pose.y, device.pose.y));
    assert(close(after.pose.courseDeg, 90));
    assert(close(after.pose.speedMPerTick, 2));
    assert.equal(after.status.activeActionId, null);
    const climb = {type: 'move', requestId: 'agent-rise', vertical: {deltaM: 3}, targetTick: 2, expiresTick: 20};
    assert.equal((await agent.submitAction(climb)).action.status, 'pending');
    await request(root + '/step', adminToken, {count: 2});
    const raised = (await agent.observe({includeDevice: true})).device;
    assert.equal(raised.pose.z, 19);
    assert.equal(raised.pose.verticalSpeedMPerTick, 1);
    assert.equal(raised.actions.at(-1).result.completedM, 3);
    assert(raised.availableActions.some(action => action.name === 'hover' && action.available));
    assert(raised.availableActions.some(action => action.name === 'takeoff' && action.reason === 'already_airborne'));
    const hold = {type:'move',requestId:'agent-hold',flightControl:{mode:'hover',durationTicks:2},targetTick:4,expiresTick:20};
    assert.equal((await agent.submitAction(hold)).action.status,'pending');
    await request(root + '/step', adminToken, {count:2});
    const held = (await agent.observe({includeDevice:true})).device;
    assert.equal(held.actions.at(-1).result.heldTicks,2);
    assert.equal(held.pose.z,raised.pose.z);
    await request(root + '/agents/vehicle-1/actions', adminToken, {...climb, targetTick: 4}, 409);
    const first = (await request(root + '/coordinator/observation?include=device', adminToken)).fixedSensors[0];
    assert.equal(first.observedTick, null);
    assert.equal(first.profile.intervalTicks, 10);
    await request(root + '/step', adminToken, {count: 50});
    const sensors = (await request(root + '/coordinator/observation?include=device', adminToken)).fixedSensors;
    assert.equal(sensors[0].source, 'fixed_sensor_report');
    assert(sensors[0].reading && Number.isSafeInteger(sensors[0].observedTick));
    const cargo = (await request(root + '/observations/vehicle-1?include=device', adminToken)).device;
    assert.deepEqual(cargo.cargo, {load: null, reserved: false});
    assert(cargo.availableActions.every(action => action.name !== 'scan'));

    const shore = await request('/sessions', null, {sceneId: 'shore-rescue-v1', dispatchMode: 'external'}, 201);
    for (const [id, range] of [['drone-1', 60], ['rover-1', 30], ['vehicle-1', 40], ['robot-1', 15], ['boat-1', 50], ['relay-1', 25]]) {
      const telemetry = (await request('/sessions/' + shore.sessionId + '/observations/' + id + '?include=device', shore.adminToken)).device;
      assert.equal(telemetry.availableActions.find(action => action.name === 'move_direction').parameters.direction.distanceM.maximum, range);
      assert.equal(telemetry.profile.id, id);
      if (id === 'robot-1') assert(telemetry.availableActions.some(action => action.name === 'rescue'));
      if (id === 'boat-1') assert(telemetry.waterConditions.region);
      if (id === 'relay-1') assert.equal(telemetry.relay.deployed, false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  verifyDirection();
  verifyFlight();
  verifyFlightControl();
  await verifyScopedApi();
  console.log('Device telemetry, directional moves and flight controls passed: scoped state, fixed sensors, action progress, obstacles, stale pose, replay, and backend gating.');
})().catch(error => { console.error(error); process.exitCode = 1; });
