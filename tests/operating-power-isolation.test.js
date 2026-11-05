'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),C=require('./native-task-frame-support'),{fixture}=require('./operating-power-support');
let foreign=0,forged=0;
for(const physicsMode of ['kinematic','rapier']){
 const worlds=[0,1].map(()=>E.create(42,'nearest',fixture('pending'),{physicsMode,dispatchMode:'external'})),ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null),stores=worlds.map((w,i)=>C.bind(w,ps[i],{batch:true,actionBatch:true,worldBatch:true})),rs=stores.map(C.raw);
 const hashes=()=>stores.map((s,i)=>C.hashes(s,ps[i],worlds[i]));
 try{
  // Stop at the native time/power boundary. This intermediate phase is not a complete replay frame.
  stores.forEach((s,i)=>s.control.time(s.execution,s.environment,s.tasks,s.peer,0,ps[i],()=>{},()=>{},{actions:s.actions,resources:s.resources}));
  const before=worlds.map(E.snapshot),saved=hashes(),call=(r,tick=1)=>r.control.advanceOperatingEnergy(tick,r.execution,r.environment,r.tasks,r.actions,r.resources,r.ledger);
  for(const component of ['execution','environment','tasks','actions','resources','control','ledger']){
   assert.throws(()=>call({...rs[0],[component]:rs[1][component]}),component);assert.deepEqual(hashes(),saved,component+' changed either world');assert.deepEqual(worlds.map(E.snapshot),before);foreign++;
  }
  for(const tick of [0,2,1.5,NaN,Infinity]){assert.throws(()=>call(rs[0],tick));assert.deepEqual(hashes(),saved)}
  const actor=worlds[0].agents.find(a=>a.operatingEnergyPerTick!==undefined),index=worlds[0].agents.indexOf(actor);
  for(const patch of [{operatingEnergyPerTick:.1},{operatingState:{energySpent:0,tick:1}}]){assert.throws(()=>rs[0].execution.updateExecution(index,JSON.stringify(patch)));assert.deepEqual(hashes(),saved);forged++}
  assert.throws(()=>rs[0].tasks.interrupt(JSON.stringify({kind:'power_depleted',agentId:actor.id}),1,rs[0].execution,rs[0].environment,rs[0].resources,rs[0].actions,rs[0].control,rs[0].ledger));assert.deepEqual(hashes(),saved);forged++;
  const battery=actor.battery;call(rs[0]);const ownExecution=JSON.parse(rs[0].execution.snapshotExecution()).find(a=>a.id===actor.id),ownMotion=JSON.parse(rs[0].execution.snapshot()).find(a=>a.id===actor.id);
  assert.equal(ownExecution.operatingState.energySpent,5);assert.equal(ownExecution.operatingState.tick,1);assert.equal(ownMotion.battery,battery-5);assert.deepEqual(C.hashes(stores[1],ps[1],worlds[1]),saved[1]);
  const once=hashes();assert.throws(()=>call(rs[0]));assert.deepEqual(hashes(),once,'duplicate phase changed state');
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log(JSON.stringify({foreignComponentsRejected:foreign,forgedInputsRejected:forged,wrongClocksAndDuplicateDebitsRejected:true,bothWorldsAndCollidersUnchanged:true,ownPhaseDebitsExactlyOnce:true}));
