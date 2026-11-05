'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),P=require('../server/rust-physics');let frames=0,calls=0;
function bind(w){const stores={};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources'],['peer','bindWorldPeer'],['reports','bindWorldReports'],['dispatch','bindWorldDispatch'],['requests','bindWorldRequests']]){const s=require('../server/rust-world-'+name).create(w);stores[name]=s;E[method](w,s);if(name==='ledger'){const c=s.control(w);stores.control=c;E.bindWorldControl(w,{...c,time(...args){calls++;return c.time(...args)}})}if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}}return stores}
function pair(scene=E.getScene(),options={},prepare=()=>{}){const a=E.create(42,'nearest',scene,{dispatchMode:'external',...options});prepare(a);const b=E.snapshot(a),physics=[a,b].map(w=>w.physicsMode==='rapier'?P.createPhysics(w):null),stores=bind(b);return {a,b,stores,physics,close(){E.disposeWorld(b);physics.forEach(p=>p?.free())}}}
function equal(v){assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a));assert.deepEqual(E.coordinatorObservation(v.b),E.coordinatorObservation(v.a));for(const a of v.a.agents)assert.deepEqual(E.observe(v.b,a.id),E.observe(v.a,a.id))}
function both(v,fn){const b=fn(v.b),a=fn(v.a);assert.deepEqual(b,a);equal(v);return b}
function step(v,n=1){for(let i=0;i<n&&!v.a.done;i++){E.step(v.a,v.physics[0]);E.step(v.b,v.physics[1]);equal(v);frames++}}
function scene(){const s=E.getScene();s.obstacles=[];s.terrain=[{id:'zone',name:'试验区',x:40,y:40,w:10,h:10,speedFactor:.8,energyFactor:1.2}];Object.assign(s.communication,{range:1000,delay:2,lossRate:0});s.tasks[0].deadline=1;return s}
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy']){
 const s=scene();s.navigation=navigation;const v=pair(s,{physicsMode},w=>{w.tasks.push({...w.tasks[0],id:'already-done',status:'done',assignee:'drone-2',assignmentId:1})});try{
  both(v,w=>E.injectRoadblock(w,{x:0,y:0,w:2,h:2},1));both(v,w=>E.injectTerrainEffect(w,'zone',1));both(v,w=>E.interruptCommunication(w,'drone-2',1));both(v,w=>E.sendMessage(w,'drone-1','drone-2','after restore'));step(v);assert.equal(v.b.roadblocks.length,1);assert.equal(v.b.terrainEffects.length,1);assert.equal(v.b.communication.outages.length,1);step(v);
  assert.deepEqual(v.b.events.filter(e=>e.tick===2&&['roadblock_ended','terrain_effect_ended','deadline_missed','communication_restored','message_delivered'].includes(e.kind)).map(e=>e.kind),['roadblock_ended','terrain_effect_ended','deadline_missed','communication_restored','message_delivered']);assert.equal(v.b.events.filter(e=>e.kind==='deadline_missed').length,1);assert.equal(v.b.events.find(e=>e.kind==='deadline_missed').taskId,s.tasks[0].id);both(v,w=>E.setDispatchMode(w,'rule'));step(v,500);assert(v.b.done&&!v.b.failed);
 }finally{v.close()}
}
// All scene families exercise the new boundary alongside native task execution.
for(const id of ['industrial-park-parallel-v1','lunar-outpost-v1','lunar-sampling-v1','shore-coordination-v1'])for(const physicsMode of ['kinematic','rapier']){
 const v=pair(E.getScene(id),{physicsMode,dispatchMode:'rule'});try{step(v,500);assert(v.b.done&&!v.b.failed,id)}finally{v.close()}
}
assert.throws(()=>new (require('../rust/physics/target/release/box_physics.node').WorldTimeTicket)());
const keys=['control','ledger','execution','environment','tasks','peer'];
function raw(v){return Object.fromEntries(keys.map(k=>[k,C.reference(v.stores[k],k).native]))}
const args=r=>[r.execution,r.environment,r.tasks,r.peer,r.ledger];
function hash(r){return keys.map(k=>crypto.createHash('sha256').update(k==='execution'?r[k].snapshot()+r[k].snapshotExecution():r[k].snapshot()).digest('hex'))}
function timed(v){both(v,w=>E.injectRoadblock(w,{x:0,y:0,w:2,h:2},1));both(v,w=>E.injectTerrainEffect(w,'zone',1));both(v,w=>E.interruptCommunication(w,'drone-2',1));step(v)}
{
 const v=pair(scene());try{timed(v);const r=raw(v),before=hash(r);for(const tick of [-1,0,2,NaN]){assert.throws(()=>r.control.beginTime(tick,...args(r)));assert.deepEqual(hash(r),before)}const t=r.control.beginTime(1,...args(r));assert.equal(JSON.parse(t.plan()).tick,2);assert.throws(()=>r.control.validateCommit(r.ledger));assert.throws(()=>r.control.setMode(JSON.stringify('rule'),r.ledger));assert.throws(()=>r.control.commitTime(t,...args(r)));assert.throws(()=>r.control.finishTime(t,...args(r)));const foreign=pair(scene());try{const f=raw(foreign);assert.throws(()=>f.control.timeTerrain(t,...args(f)))}finally{foreign.close()}
  r.control.timeTerrain(t,...args(r));assert.throws(()=>r.control.timeTerrain(t,...args(r)));r.control.finishTime(t,...args(r));r.control.commitTime(t,...args(r));r.control.validateCommit(r.ledger);for(const method of ['timeTerrain','finishTime','commitTime','abortTime'])assert.throws(()=>r.control[method](t,...args(r)));assert.throws(()=>t.plan());t.free();t.free();
 }finally{v.close()}
}
for(const phase of ['road','terrain','finish']){
 const v=pair(scene());try{timed(v);const r=raw(v),before=hash(r),t=r.control.beginTime(1,...args(r));if(phase!=='road')r.control.timeTerrain(t,...args(r));if(phase==='finish')r.control.finishTime(t,...args(r));assert.notDeepEqual(hash(r),before);r.control.abortTime(t,...args(r));assert.deepEqual(hash(r),before);r.control.validateCommit(r.ledger);assert.throws(()=>r.control.abortTime(t,...args(r)));t.free();equal(v)}finally{v.close()}
}
// Refuse time, catalog and actor mutations after issue, then restore even when
// those mutations made the current clocks incompatible with phase validation.
for(const mutate of [r=>r.ledger.advance(2),r=>r.environment.expireTerrain(3),r=>r.peer.restore(3),r=>r.execution.updateExecution(0,JSON.stringify({blockedTicks:7})),r=>r.tasks.append(JSON.stringify({...E.normalizeSurveyTask({id:'foreign-catalog',name:'外来目录',role:'drone',target:[48,50],duration:2,dependsOn:[]}),status:'pending',assignee:null}))]){
 const v=pair(scene());try{timed(v);const r=raw(v),before=hash(r),t=r.control.beginTime(1,...args(r));mutate(r);if(JSON.parse(r.execution.snapshotExecution())[0].blockedTicks===7){r.control.timeTerrain(t,...args(r));r.control.finishTime(t,...args(r));r.execution.updateExecution(0,JSON.stringify({blockedTicks:8}));assert.throws(()=>r.control.commitTime(t,...args(r)))}else assert.throws(()=>r.control.timeTerrain(t,...args(r)));r.control.abortTime(t,...args(r));assert.deepEqual(hash(r),before);t.free();equal(v)}finally{v.close()}
}
{
 const v=pair(scene());try{timed(v);const r=raw(v),before=hash(r),points=Object.fromEntries(keys.map(k=>[k,r[k].checkpoint()])),t=r.control.beginTime(1,...args(r));for(const k of keys)r[k].rollback(points[k]);for(const method of ['timeTerrain','finishTime','commitTime','abortTime'])assert.throws(()=>r.control[method](t,...args(r)));assert.deepEqual(hash(r),before);t.free();for(const p of Object.values(points))p.free();r.control.validateCommit(r.ledger)}finally{v.close()}
}
// Callback mutations and throws must restore native data and physical barriers,
// even when the caller does not use the outer world transaction.
for(const phase of ['road','terrain'])for(const physicsMode of ['kinematic','rapier']){
 const v=pair(scene(),{physicsMode});try{timed(v);const r=raw(v),before=hash(r),world=E.snapshot(v.b),physical=v.physics[1];if(physical)physical.syncRoadblocks(v.b.roadblocks);const visible=()=>physical.visible({x:-1,y:1,z:1},{x:3,y:1,z:1});if(physical)assert.equal(visible(),false);const callbacks=[()=>{if(physical){physical.syncRoadblocks(v.b.roadblocks);assert.equal(visible(),true)}},()=>{}],index=phase==='road'?0:1,previous=callbacks[index];callbacks[index]=()=>{previous();v.stores.execution.update(0,{route:[[20,20]],blockedTicks:3});throw Error('callback failure')};assert.throws(()=>v.stores.control.time(v.stores.execution,v.stores.environment,v.stores.tasks,v.stores.peer,v.b.tick,physical,...callbacks),/world_step_failed/);assert.deepEqual(hash(r),before);assert.deepEqual(E.snapshot(v.b),world);if(physical)assert.equal(visible(),false);r.control.validateCommit(r.ledger);step(v,2)}finally{v.close()}
}
// A phase with two real events hits capacity on its second append. Refusal is
// atomic within that phase, and abort returns every owned store to old time.
for(const phase of ['road','terrain','finish']){
 const s=scene();s.tasks[1].deadline=1;s.terrain.push({...s.terrain[0],id:'other',name:'另一试验区'});const v=pair(s,{},w=>{E.step(w);w.roadblocks=phase==='road'?[0,1].map(i=>({id:'roadblock-'+(i+1),x:i*3,y:0,w:2,h:2,height:4,startedTick:0,untilTick:1})):[];w.terrainEffects=phase==='terrain'?s.terrain.map(z=>({zoneId:z.id,startedTick:0,untilTick:1,speedFactor:.5,energyFactor:1.8})):[];w.events=w.roadblocks.map((b,i)=>({seq:i+1,tick:0,message:'road fixture',type:'info',kind:'roadblock_started',...b}));while(w.events.length<199999)w.events.push({seq:w.events.length+1,tick:1,message:'capacity',type:'info',kind:'fixture'})});try{
  const r=raw(v),before=hash(r);for(let attempt=0;attempt<2;attempt++){if(phase==='road'){assert.throws(()=>r.control.beginTime(1,...args(r)),/invalid world ledger input/)}else{const t=r.control.beginTime(1,...args(r));if(phase==='finish')r.control.timeTerrain(t,...args(r));const staged=hash(r);assert.throws(()=>r.control[phase==='terrain'?'timeTerrain':'finishTime'](t,...args(r)),/invalid world ledger input/);assert.deepEqual(hash(r),staged);r.control.abortTime(t,...args(r));t.free()}assert.deepEqual(hash(r),before);r.control.validateCommit(r.ledger)}
 }finally{v.close()}
}
assert(calls>100);console.log('Native clock/expiry: '+frames+' paired frames; inclusive boundaries, deadline filtering and event order, restored delivery, all scene families, both physics and route metrics, opaque phases/foreign/reuse fencing, callback rollback and repeated late-capacity atomic refusal passed');
