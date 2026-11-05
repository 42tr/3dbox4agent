'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),Native=require('../rust/physics/target/release/box_physics.node'),Components=require('../server/native-components');
function bind(w){
 const stores={};for(const [name,method] of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources']]){
  const store=require('../server/rust-world-'+name).create(w);stores[name]=store;E[method](w,store);
  if(name==='ledger')E.bindWorldControl(w,store.control(w));
  if(name==='motion'){stores.execution=store.execution(w);E.bindWorldExecution(w,stores.execution)}
 }return stores;
}
function pair(scene,options={},prepare=()=>{}){
 const a=E.create(42,'nearest',scene,{dispatchMode:'external',...options});prepare(a);const b=E.snapshot(a),physics=[a,b].map(w=>w.physicsMode==='rapier'?P.createPhysics(w):null);
 for(const [i,w] of [a,b].entries()){E.bindTaskRules(w,require('../server/rust-task-rules'));if(options.rays)E.bindRaySensors(w,physics[i])}
 const stores=bind(b);return {a,b,physics,stores,close(){E.disposeWorld(b);physics.forEach(p=>p?.free())}};
}
let frames=0;
function step(v,n=1){for(let i=0;i<n;i++){E.step(v.a,v.physics[0]);E.step(v.b,v.physics[1]);assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a));frames++}}
function both(v,fn){const a=fn(v.a),b=fn(v.b);assert.deepEqual(b,a);assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a));return a}
for(const rays of [false,true])for(const vision of ['visible','blocked','air-over','far','normal','exact-range'])for(const depleted of [false,true]){
 const scene=E.getScene();scene.obstacles=[];scene.resource.site=[24,20];
 if(['blocked','air-over'].includes(vision))scene.obstacles=[{id:'screen',x:21,y:19,w:1,h:2,height:3}];
 const v=pair(scene,{physicsMode:rays?'rapier':'kinematic',rays},w=>{
  Object.assign(w.agents[0],{x:20,y:20,mobility:vision==='air-over'?'air':'ground',sensorRange:vision==='far'?3:vision==='exact-range'?Math.hypot(4,0):10,battery:depleted?6:50,workEnergyPerTick:depleted?5:.08});
  if(vision==='normal'){w.asset.condition='operational';Object.assign(w.part,{location:'consumed',position:null,carrierId:null,reservedBy:null})}
 });
 try{
  const id=v.a.agents[0].id;assert(both(v,w=>E.submitAction(w,id,{requestId:'scan',type:'scan',targetTick:1,expiresTick:100})).ok);const action=v.b.actions[0],agent=v.b.agents[0];
  step(v,depleted?2:3);assert.equal(v.b.actions[0],action);assert.equal(v.b.agents[0],agent);
  assert.equal(action.status,depleted?'failed':'completed');
  if(!depleted)assert.equal(action.result.kind,['blocked','far'].includes(vision)?'not_detected':vision==='normal'?'normal':'anomaly');
 }finally{v.close()}
}
for(const mode of ['auto','agent','primitive']){
 const scene=E.getScene();scene.obstacles=[];
 const v=pair(scene,{executionMode:mode},w=>{for(const a of w.agents.slice(0,2))Object.assign(a,{x:w.chargingStation[0],y:w.chargingStation[1],battery:a===w.agents[0]?70:60})});
 try{
  if(mode!=='auto')assert(both(v,w=>E.assign(w,'inspect',w.agents[0].id)).ok);
  for(const id of v.a.agents.slice(0,2).map(a=>a.id))assert(both(v,w=>E.submitAction(w,id,{requestId:'charge',type:'charge',targetTick:1,expiresTick:100})).ok);
  step(v,4);assert.equal(v.b.actions[0].phase,'charging');assert.equal(v.b.actions[1].phase,'waiting');assert.equal(v.b.agents[1].battery,60);
  step(v);assert.equal(v.b.actions[0].status,'completed');assert.equal(v.b.actions[1].phase,'charging');assert.equal(v.b.agents[1].battery,62);
  if(mode!=='auto'){assert.equal(v.b.agents[0].status,'assigned');assert.equal(v.b.agents[0].taskNeedsRoute,mode==='agent'?true:undefined)}
  step(v,9);assert.equal(v.b.actions[1].status,'completed');
 }finally{v.close()}
}
// Current map queries and exact range rounding agree at randomized boundaries.
for(let i=0;i<100;i++){
 const scene=E.getScene();scene.obstacles=[];const target=[30+(i*.713)%20,25+(i*.317)%20];scene.resource.site=target;
 const v=pair(scene,{},w=>{const a=w.agents[0];a.sensorRange=Math.hypot(target[0]-a.x,target[1]-a.y)});
 try{both(v,w=>E.submitAction(w,w.agents[0].id,{requestId:'edge',type:'scan',targetTick:1,expiresTick:100}));step(v,3)}finally{v.close()}
}
{
 const scene=E.getScene();scene.obstacles=[];
 const w=E.create(42,'nearest',scene,{dispatchMode:'external'}),stores=bind(w);E.submitAction(w,w.agents[0].id,{requestId:'live',type:'scan',targetTick:1,expiresTick:100});E.step(w);
 const rawMotion=Components.reference(stores.execution,'execution').native,env=Components.reference(stores.environment,'environment').native,resources=Components.reference(stores.resources,'resources').native,tasks=Components.reference(stores.tasks,'tasks').native;
 const current=E.snapshot(w).actions[0],actions=new Native.WorldActions(JSON.stringify({tick:1,agents:w.agents.map(a=>a.id),actions:[current]})),context=JSON.stringify({tick:1,resumeAgent:false});
 assert.throws(()=>actions.advanceStationary(0,context,rawMotion,env,resources,tasks));env.expireRoadblocks(2);env.expireTerrain(2);const nextContext=JSON.stringify({tick:2,resumeAgent:false});actions.advanceStationary(0,nextContext,rawMotion,env,resources,tasks);const before=actions.snapshot(),motion=rawMotion.snapshot(),execution=rawMotion.snapshotExecution();
 assert.throws(()=>actions.advanceStationary(0,nextContext,rawMotion,env,resources,tasks));assert.equal(actions.snapshot(),before);assert.equal(rawMotion.snapshot(),motion);assert.equal(rawMotion.snapshotExecution(),execution);
 assert.throws(()=>actions.advanceStationary(0,JSON.stringify({tick:2,resumeAgent:false}),rawMotion,env,resources,tasks));assert.throws(()=>actions.advanceStationary(0,JSON.stringify({tick:1,resumeAgent:'yes'}),rawMotion,env,resources,tasks));
 const foreign=require('../server/rust-world-resources').create(w),foreignRaw=Components.reference(foreign,'resources').native;
 env.expireRoadblocks(3);env.expireTerrain(3);
 assert.throws(()=>actions.advanceStationary(0,JSON.stringify({tick:3,resumeAgent:false}),rawMotion,env,foreignRaw,tasks));assert.equal(actions.snapshot(),before);assert.equal(rawMotion.snapshot(),motion);
 actions.advanceStationary(0,JSON.stringify({tick:3,resumeAgent:false}),rawMotion,env,resources,tasks);assert.equal(JSON.parse(actions.snapshot())[0].status,'completed');foreign.free();
 actions.free();E.disposeWorld(w);
}
{
 const w=E.create(42,'nearest',E.getScene(),{dispatchMode:'external'}),stores=bind(w);E.submitAction(w,w.agents[0].id,{requestId:'scan',type:'scan',targetTick:1,expiresTick:100});E.step(w);
 const record={agentId:w.agents[0].id,requestId:'far-charge',type:'charge',targetTick:1,expiresTick:100,submittedTick:0,status:'accepted',updatedTick:1,phase:'waiting',energyAdded:0};
 const actions=new Native.WorldActions(JSON.stringify({tick:1,agents:w.agents.map(a=>a.id),actions:[record]})),motion=Components.reference(stores.execution,'execution').native,env=Components.reference(stores.environment,'environment').native,resources=Components.reference(stores.resources,'resources').native,tasks=Components.reference(stores.tasks,'tasks').native;
 env.expireRoadblocks(2);env.expireTerrain(2);const saved=[actions.snapshot(),motion.snapshot(),motion.snapshotExecution()];assert.throws(()=>actions.advanceStationary(0,JSON.stringify({tick:2,resumeAgent:false}),motion,env,resources,tasks));assert.deepEqual([actions.snapshot(),motion.snapshot(),motion.snapshotExecution()],saved);actions.free();E.disposeWorld(w);
}
{
 // A valid intermediate accepted scan at progress3 cannot advance to progress4.
 // The rejection happens after staged energy/result computation and preserves
 // all three native components rather than retaining the battery deduction.
 const scene=E.getScene();scene.obstacles=[];const w=E.create(42,'nearest',scene,{dispatchMode:'external'}),stores=bind(w);E.submitAction(w,w.agents[0].id,{requestId:'staged',type:'scan',targetTick:1,expiresTick:100});E.step(w);
 const record={...E.snapshot(w).actions[0],progress:3},actions=new Native.WorldActions(JSON.stringify({tick:1,agents:w.agents.map(a=>a.id),actions:[record]}));
 const rawMotion=Components.reference(stores.execution,'execution').native,env=Components.reference(stores.environment,'environment').native,resources=Components.reference(stores.resources,'resources').native,tasks=Components.reference(stores.tasks,'tasks').native;
 env.expireRoadblocks(2);env.expireTerrain(2);const before=[actions.snapshot(),rawMotion.snapshot(),rawMotion.snapshotExecution()];assert.throws(()=>actions.advanceStationary(0,JSON.stringify({tick:2,resumeAgent:false}),rawMotion,env,resources,tasks));assert.deepEqual([actions.snapshot(),rawMotion.snapshot(),rawMotion.snapshotExecution()],before);
 actions.free();E.disposeWorld(w);
}
console.log('Native stationary actions: '+frames+' paired frames, geometry/ray scans, exact radius, depletion, queue handover, assigned charge resumption, stable views, duplicate/time/type guards and atomic rejection passed');
