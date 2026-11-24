'use strict';

const assert = require('node:assert/strict');
const E = require('../packages/world/src/world-core');
const {unwrapArchive} = require('../packages/world/src/replay');

const scene = E.getScene('industrial-park-v2');
scene.obstacles = [];
const spawn = {drone:[100,72,1],vehicle:[42,94,2],robot:[148,125,2]};
scene.agents = scene.agents.map(agent => {
  const [x,y,count] = spawn[agent.role];
  return {...agent,count,spawnArea:{x,y,w:8,h:4}};
});
const world = E.create(42,'nearest',scene,{executionMode:'primitive',dispatchMode:'external'});
const frames = [E.snapshot(world)];
let serial = 0;
const capture = () => frames.push(E.snapshot(world));
const step = () => { E.step(world); capture(); };
const task = id => world.tasks.find(row => row.id === id);
function queue(agentId, body) {
  const command = {requestId:'a-'+(++serial),targetTick:world.tick+1,expiresTick:world.tick+80,...body};
  const result = E.submitAction(world,agentId,command);
  assert(result.ok,JSON.stringify(result));
  capture();
  return {command,action:world.actions.at(-1)};
}
function finish(entry, expected='completed', reason) {
  for (let i=0;i<120&&['pending','accepted'].includes(entry.action.status);i++) step();
  assert.equal(entry.action.status,expected,JSON.stringify(entry.action));
  assert.equal(entry.action.reason,reason);
  return entry.action;
}
function run(agentId, body, expected, reason) {
  return finish(queue(agentId,body),expected,reason);
}
function work(agentId, taskId, operation, expected, reason) {
  return run(agentId,{type:'work_task',taskId,...(operation?{operation}:{})},expected,reason);
}
function give(agentId, taskId) {
  const result = E.assign(world,taskId,agentId);
  assert(result.ok,JSON.stringify(result));
  capture();
}
function revoke(agentId, taskId) {
  const r = E.revokeTask(world,{requestId:'revoke-'+(++serial),taskId,agentId,assignmentId:task(taskId).assignmentId,observedTick:world.tick});
  assert.equal(r.revocation?.status,'accepted',JSON.stringify(r));
  capture();
}
function observed(agentId, taskId) {
  return E.observe(world,agentId).assignedTasks.find(row=>row.id===taskId);
}
function approach(agentId, taskId, offset) {
  const info = observed(agentId,taskId);
  if (info.withinReach&&!offset) return;
  const [x,y] = info.approachPoint??info.waypoint;
  run(agentId,{type:'move',target:{x:x+(offset?.[0]??0),y:y+(offset?.[1]??0)}});
  assert(observed(agentId,taskId).withinReach);
}
for (const id of ['inspect','confirm']) {
  give('drone-1',id);
  approach('drone-1',id);
  work('drone-1',id);
}

give('vehicle-1','deliver');
approach('vehicle-1','deliver');
assert.equal(observed('vehicle-1','deliver').workOperation.operation,'dock_pickup');
work('vehicle-1','deliver','load','rejected','operation_out_of_order');
work('vehicle-1','deliver','dock_pickup');
approach('vehicle-1','deliver',[1,0]);
approach('vehicle-1','deliver',[0,0]);
work('vehicle-1','deliver','load','rejected','operation_out_of_order');
work('vehicle-1','deliver','dock_pickup');
work('vehicle-1','deliver',null,'rejected','operation_required');
const interrupted = queue('vehicle-1',{type:'work_task',taskId:'deliver',operation:'load'});
step();step();
assert.equal(interrupted.action.progress,2);
assert(E.cancelAction(world,'vehicle-1',interrupted.command.requestId).ok);
capture();
assert.equal(world.part.location,'warehouse');

const load = queue('vehicle-1',{type:'work_task',taskId:'deliver',operation:'load'});
finish(load);
assert.equal(world.part.carrierId,'vehicle-1');
assert.equal(E.submitAction(world,'vehicle-1',load.command).duplicate,true);
assert.equal(E.submitAction(world,'vehicle-1',{...load.command,operation:'unload'}).reason,'request_id_conflict');
revoke('vehicle-1','deliver');
assert.equal(world.part.location,'ground');
assert.equal(task('deliver').operationState.last,'restart');
run('vehicle-1',{type:'move',target:{x:66,y:107}});
give('vehicle-2','deliver');
approach('vehicle-2','deliver');
work('vehicle-2','deliver','dock_pickup');
work('vehicle-2','deliver','load');
approach('vehicle-2','deliver',[-3,0]);
work('vehicle-2','deliver','dock_delivery');
work('vehicle-2','deliver','unload');
assert.equal(world.part.location,'ground');
assert.deepEqual(world.part.position,task('deliver').target);
assert.equal(E.assign(world,'repair','robot-1').reason,'task_not_ready');
revoke('vehicle-2','deliver');
give('vehicle-2','deliver');
assert.equal(observed('vehicle-2','deliver').workOperation.operation,'handoff');
const receipt=work('vehicle-2','deliver','handoff');
assert.deepEqual(receipt.result.partPosition,task('deliver').target);
assert.equal(receipt.result.quantity,1);
assert.equal(world.part.location,'site');

give('robot-1','repair');
approach('robot-1','repair',[0,-3]);
work('robot-1','repair','install','rejected','operation_out_of_order');
work('robot-1','repair','diagnose');
work('robot-1','repair','remove');
const installed = work('robot-1','repair','install');
assert.equal(installed.result.consumed,1);
assert.equal(world.part.location,'consumed');
assert.equal(world.asset.condition,'fault');
assert(E.injectFault(world,{agentId:'robot-1'}).ok);
capture();
give('robot-2','repair');
approach('robot-2','repair',[0,3]);
assert.equal(observed('robot-2','repair').workOperation.operation,'self_test');
assert(work('robot-2','repair','self_test').result.passed);
assert.equal(world.asset.condition,'repaired');
assert.equal(world.actions.filter(a=>a.operation==='install'&&a.status==='completed').length,1);

give('drone-1','verify');
approach('drone-1','verify');
work('drone-1','verify');
assert.equal(world.asset.condition,'operational');
assert(world.done&&!world.failed);
const archive = {format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',scene},frames};
unwrapArchive(archive);
const forged = structuredClone(archive);
forged.frames.at(-1).actions.find(a=>a.operation==='install'&&a.status==='completed').result.assignmentId++;
assert.throws(()=>unwrapArchive(forged),/记录格式/);
console.log('Explicit task operations passed: full mission, docking invalidation, cancellation, retry, dropped cargo, transfer after unloading and installation, and replay.');
