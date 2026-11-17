'use strict';

const assert = require('node:assert/strict');
const E = require('../packages/world/src/world-core');
const Domain = require('../packages/world/src/industrial-park-domain');
const {createServer} = require('../packages/world/server/world-server');

const scene = E.getScene('industrial-park-v2');
const domain = Domain.createIndustrialParkDomain(scene, {clock: (() => { let tick = 0; return () => ++tick; })()});
const catalog = domain.catalog();
assert.equal(Domain.createCatalog('industrial-park-v2').sceneId, 'industrial-park-v2');

assert.equal(catalog.sceneId, 'industrial-park-v2');
assert(catalog.objects.some(object => object.id === 'warehouse' && object.type === 'warehouse'));
assert(catalog.objects.some(object => object.id === 'equipment-main' && object.operations.includes('diagnose')));
assert(catalog.objects.some(object => object.id === 'vehicle-1' && object.operations.includes('dispatch')));
assert(catalog.objects.some(object => object.type === 'person' && object.operations.includes('authenticate')));
assert(catalog.objects.some(object => object.type === 'order' && object.operations.includes('release')));
assert.equal(catalog.taskTemplates.scene.length, 5);
assert(catalog.operationCatalog.equipment.includes('createMaintenanceOrder'));
const sceneTaskDomain = Domain.createIndustrialParkDomain(scene);
const sceneTask = sceneTaskDomain.createSceneTask('inspect');
assert.equal(sceneTask.type, Domain.TASK_TYPES.INSPECTION);
assert.deepEqual(sceneTask.input.target, [112, 70]);

const events = [];
domain.subscribe(event => events.push(event));
const first = domain.execute('equipment-main', 'diagnose', {result: 'bearing_wear'}, {requestId: 'diagnose-1', actorId: 'robot-1'});
const replay = domain.execute('equipment-main', 'diagnose', {result: 'bearing_wear'}, {requestId: 'diagnose-1', actorId: 'robot-1'});
assert.deepEqual(replay, first);
assert.equal(domain.getObject('equipment-main').properties.diagnosis, 'bearing_wear');
assert.equal(events.length, 1);
assert.throws(() => domain.execute('equipment-main', 'diagnose', {result: 'other'}, {requestId: 'diagnose-1'}), /request_id_conflict/);
const equipment = domain.object('equipment-main');
assert.equal(typeof equipment.diagnose, 'function');
equipment.diagnose({result: 'bearing_wear-verified'}, {requestId: 'diagnose-2'});
assert.equal(domain.getObject('equipment-main').properties.diagnosis, 'bearing_wear-verified');

const task = domain.createTask(Domain.TASK_TYPES.MAINTENANCE, {id: 'maintenance-1', targetObjectId: 'equipment-main'});
assert.equal(task.status, 'pending');
assert.equal(domain.getObject('maintenance-1').type, 'task');
domain.assignTask(task.id, 'robot-1');
domain.startTask(task.id);
for (let i = 0; i < 4; i++) domain.advanceTask(task.id);
assert.equal(domain.getTask(task.id).status, 'completed');
assert.equal(domain.getObject(task.id).state, 'completed');
assert.equal(domain.listTasks({status: 'completed'}).length, 1);

const operationTask = domain.createTask({type: Domain.TASK_TYPES.INSPECTION, id: 'inspection-1'});
domain.execute(operationTask.id, 'assign', {actorId: 'drone-1'}, {requestId: 'task-assign-1'});
domain.execute(operationTask.id, 'start', {}, {requestId: 'task-start-1'});
assert.equal(domain.getTask(operationTask.id).status, 'active');

(async () => {
  const server = createServer({physicsBackend: 'wasm'});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(origin + '/industrial-park/catalog');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sceneId, 'industrial-park-v2');
    assert(body.objects.length >= 40);
    const tasks = await fetch(origin + '/industrial-park/tasks');
    assert.equal(tasks.status, 200);
    assert.equal((await tasks.json()).templates.scene.length, 5);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('industrial park domain catalog, commands, task lifecycle, and HTTP discovery pass');
})().catch(error => { console.error(error); process.exitCode = 1; });
