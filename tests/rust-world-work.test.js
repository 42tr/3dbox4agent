'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),Native=require('../rust/physics/target/release/box_physics.node'),Components=require('../server/native-components');
function bind(w){
 const stores={};for(const [name,method] of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources']]){
  const store=require('../server/rust-world-'+name).create(w);stores[name]=store;E[method](w,store);
  if(name==='ledger')E.bindWorldControl(w,store.control(w));
  if(name==='motion'){stores.execution=store.execution(w);E.bindWorldExecution(w,stores.execution)}
 }return stores;
}
let frames=0;
function pair(scene,options={},prepare=()=>{}){const a=E.create(42,'nearest',scene,{dispatchMode:'external',...options});prepare(a);const b=E.snapshot(a),physics=[a,b].map(w=>w.physicsMode==='rapier'?P.createPhysics(w):null);for(const w of [a,b])E.bindTaskRules(w,require('../server/rust-task-rules'));const stores=bind(b);return {a,b,stores,physics,close(){E.disposeWorld(b);physics.forEach(p=>p?.free())}}}
function both(v,fn){assert.deepEqual(fn(v.b),fn(v.a));assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a))}
function step(v){E.step(v.a,v.physics[0]);E.step(v.b,v.physics[1]);assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a));for(const a of v.a.agents)assert.deepEqual(E.observe(v.b,a.id),E.observe(v.a,a.id));frames++}
function sceneFor(behavior){const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];scene.terrain=[];const task=scene.tasks.find(t=>t.behavior===behavior),spawn=E.create(42,'nearest',scene).agents.find(a=>a.role===task.role);scene.tasks=[{...task,target:[spawn.x,spawn.y],duration:3,dependsOn:[]}];scene.resource.warehouse=[spawn.x,spawn.y];scene.resource.site=[spawn.x,spawn.y];return scene}
function setupResource(w,behavior){if(behavior==='repair'){w.asset.diagnosis='confirmed';Object.assign(w.part,{location:'site',position:w.tasks[0].target.slice()})}if(behavior==='verify'){Object.assign(w.asset,{condition:'repaired',diagnosis:'confirmed'});Object.assign(w.part,{location:'consumed',position:null})}}
// Every behavior, execution mode and depletion boundary exercises the actual
// coupled phase, including primitive loading handover and accepted action completion.
for(const behavior of ['survey','sample','detect','confirm','deliver','repair','verify'])for(const mode of ['auto','agent','primitive'])for(const depleted of [false,true]){
 const v=pair(sceneFor(behavior),{executionMode:mode},w=>{setupResource(w,behavior);const a=w.agents.find(a=>a.role===w.tasks[0].role);a.workEnergyPerTick=depleted?5:.08;if(depleted)a.battery=6});
 try{
  const task=v.b.tasks[0],actor=v.b.agents.find(a=>a.role===task.role),taskId=task.id,id=actor.id;
  both(v,w=>E.assign(w,taskId,id));
  for(let i=0;i<25&&!v.a.done;i++){
   if(v.a.agents.find(a=>a.id===id).status==='assigned')both(v,w=>E.submitAction(w,id,{requestId:'work-'+i,type:mode==='primitive'?'work_task':'execute_task',taskId,targetTick:w.tick+1,expiresTick:w.tick+100}));
   step(v);
  }
  assert.equal(v.b.tasks[0],task);assert.equal(v.b.agents.find(a=>a.id===id),actor);
  if(depleted){assert.equal(actor.disabled,true);assert.equal(actor.work,0);assert(v.b.events.some(e=>e.kind==='energy_depleted'));assert.equal(task.status,'pending')}
  else{assert.equal(task.status,'done');assert.equal(actor.status,'idle');assert.equal(actor.work,0);if(behavior==='deliver')assert.equal(v.b.part.location,'site');if(behavior==='repair')assert.equal(v.b.part.location,'consumed');if(behavior==='verify')assert.equal(v.b.asset.condition,'operational');if(mode!=='auto')assert(v.b.actions.some(a=>a.status==='completed'))}
 }finally{v.close()}
}
// Whole worlds retain task/event/observation order under native Rapier and routes.
for(const physicsMode of ['kinematic','rapier'])for(const sceneId of ['industrial-park-v1','lunar-outpost-v1','lunar-sampling-v1','shore-coordination-v1']){
 const v=pair(E.getScene(sceneId),{dispatchMode:'rule',physicsMode});try{for(let n=0;n<500&&!v.a.done;n++)step(v);assert.equal(v.b.done,true);assert.equal(v.b.failed,false)}finally{v.close()}
}
{
 const scene=sceneFor('survey'),w=E.create(42,'nearest',scene,{dispatchMode:'external'}),stores=bind(w),id=w.agents.find(a=>a.role===w.tasks[0].role).id;
 E.assign(w,w.tasks[0].id,id);E.step(w);E.step(w);
 const t=Components.reference(stores.tasks,'tasks').native,m=Components.reference(stores.execution,'execution').native,env=Components.reference(stores.environment,'environment').native,r=Components.reference(stores.resources,'resources').native,a=Components.reference(stores.actions,'actions').native,taskId=w.tasks[0].id;
 const state=()=>[t.snapshot(),m.snapshot(),m.snapshotExecution(),r.snapshot(),a.snapshot()];const before=state();
 assert.throws(()=>t.advanceWork(taskId,JSON.stringify({tick:2}),m,env,r,a));assert.deepEqual(state(),before);
 env.expireRoadblocks(3);env.expireTerrain(3);
 const foreign=require('../server/rust-world-resources').create(w),foreignRaw=Components.reference(foreign,'resources').native;
 assert.throws(()=>t.advanceWork(taskId,JSON.stringify({tick:3}),m,env,foreignRaw,a));assert.deepEqual(state(),before);
 assert.throws(()=>t.advanceWork(taskId,JSON.stringify({tick:3,work:999}),m,env,r,a));assert.deepEqual(state(),before);
 t.advanceWork(taskId,JSON.stringify({tick:3}),m,env,r,a);const after=state();assert.throws(()=>t.advanceWork(taskId,JSON.stringify({tick:3}),m,env,r,a));assert.deepEqual(state(),after);
 // Restored task ownership cannot reapply the committed snapshot tick.
 const restored=new Native.WorldTasks(JSON.stringify({tick:3,tasks:JSON.parse(t.snapshot()),agents:w.agents.map(a=>({id:a.id,role:a.role,capabilities:a.capabilities}))}));
 assert.throws(()=>restored.advanceWork(taskId,JSON.stringify({tick:3}),m,env,r,a));assert.deepEqual(state(),after);restored.free();foreign.free();E.disposeWorld(w);
}
{
 // Reach the terminal work threshold with a valid native resource run whose
 // verify precondition is inconsistent. Refusal follows staged energy/work and
 // resource checks, and must leave every participant exactly unchanged.
 const scene=sceneFor('verify'),w=E.create(42,'nearest',scene,{dispatchMode:'external'});setupResource(w,'verify');const stores=bind(w),id=w.agents.find(a=>a.role===w.tasks[0].role).id;E.assign(w,w.tasks[0].id,id);E.step(w);E.step(w);E.step(w);
 const raw={tasks:Components.reference(stores.tasks,'tasks').native,motion:Components.reference(stores.execution,'execution').native,environment:Components.reference(stores.environment,'environment').native,actions:Components.reference(stores.actions,'actions').native};
 const snapshot=E.snapshot(w);snapshot.asset.condition='fault';snapshot.part.location='site';snapshot.part.position=snapshot.tasks[0].target.slice();const badStore=require('../server/rust-world-resources').create(snapshot),bad=Components.reference(badStore,'resources').native;
 // A fresh task owner can bind the malformed participant only at the new tick.
 const taskOwner=new Native.WorldTasks(JSON.stringify({tick:3,tasks:snapshot.tasks,agents:snapshot.agents.map(a=>({id:a.id,role:a.role,capabilities:a.capabilities}))}));raw.environment.expireRoadblocks(4);raw.environment.expireTerrain(4);const state=()=>[taskOwner.snapshot(),raw.motion.snapshot(),raw.motion.snapshotExecution(),bad.snapshot(),raw.actions.snapshot()];const before=state();assert.throws(()=>taskOwner.advanceWork(w.tasks[0].id,JSON.stringify({tick:4}),raw.motion,raw.environment,bad,raw.actions));assert.deepEqual(state(),before);taskOwner.free();badStore.free();E.disposeWorld(w);
}
{
 const v=pair(sceneFor('deliver'),{},w=>{w.agents.find(a=>a.role==='vehicle').battery=35;w.agents.find(a=>a.role==='vehicle').workEnergyPerTick=5});
 try{const id=v.a.agents.find(a=>a.role==='vehicle').id;both(v,w=>E.assign(w,w.tasks[0].id,id));for(let n=0;n<20&&!v.a.done;n++)step(v);assert(v.b.events.some(e=>e.kind==='part_loaded'));assert(v.b.events.some(e=>e.kind==='part_dropped'));assert.equal(v.b.part.location,'ground');assert.equal(v.b.part.reservedBy,null)}finally{v.close()}
}
{
 // Invalid route rejection occurs after preparing a real pickup on private
 // copies; no carried-part, phase or work reset can leak from that preparation.
 const scene=sceneFor('deliver'),w=E.create(42,'nearest',scene,{dispatchMode:'external'}),stores=bind(w),id=w.agents.find(a=>a.role==='vehicle').id;E.assign(w,w.tasks[0].id,id);
 for(let n=0;n<4;n++)E.step(w);
 const t=Components.reference(stores.tasks,'tasks').native,m=Components.reference(stores.execution,'execution').native,env=Components.reference(stores.environment,'environment').native,r=Components.reference(stores.resources,'resources').native,a=Components.reference(stores.actions,'actions').native;
 env.expireRoadblocks(5);env.expireTerrain(5);assert.equal(JSON.parse(t.advanceWork(w.tasks[0].id,JSON.stringify({tick:5}),m,env,r,a)).effect,'route_to_site');
 const state=()=>[t.snapshot(),m.snapshot(),m.snapshotExecution(),r.snapshot(),a.snapshot()],before=state();assert.throws(()=>t.finishLoading(w.tasks[0].id,JSON.stringify({tick:5}),JSON.stringify([[101,0]]),m,env,r,a));assert.deepEqual(state(),before);
 t.finishLoading(w.tasks[0].id,JSON.stringify({tick:5}),JSON.stringify([w.tasks[0].target]),m,env,r,a);assert.equal(JSON.parse(r.snapshot()).part.location,'carried');assert.equal(JSON.parse(t.snapshot())[0].phase,'to_site');const loaded=state();assert.throws(()=>t.finishLoading(w.tasks[0].id,JSON.stringify({tick:5}),JSON.stringify([w.tasks[0].target]),m,env,r,a));assert.deepEqual(state(),loaded);E.disposeWorld(w);
}
console.log('Native task work: '+frames+' paired frames, all behaviors/modes, energy depletion, primitive loading, terminal resources/actions, scoped observations and duplicate/identity/staged-atomicity guards passed');
