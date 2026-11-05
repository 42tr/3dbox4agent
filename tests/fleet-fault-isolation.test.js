'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),C=require('./native-task-frame-support'),{fixture,faultInput}=require('./fleet-fault-support');
for(const physicsMode of ['kinematic','rapier']){
 const worlds=[0,1].map(()=>E.create(42,'nearest',fixture(),{physicsMode,dispatchMode:'external'})),ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null),stores=worlds.map((w,i)=>C.bind(w,ps[i],{batch:true,actionBatch:true,worldBatch:true})),raw=stores.map(C.raw);
 const before=worlds.map(E.snapshot),hashes=()=>stores.map((s,i)=>C.hashes(s,ps[i],worlds[i])),saved=hashes();
 const call=(r,input)=>r.tasks.interrupt(JSON.stringify(input),0,r.execution,r.environment,r.resources,r.actions,r.control,r.ledger);
 try{
  for(const component of ['execution','environment','tasks','actions','resources','control','ledger']){
   assert.throws(()=>call({...raw[0],[component]:raw[1][component]},{kind:'device_fault',...faultInput(worlds[0],'endpoint-1')}),component);
   assert.deepEqual(hashes(),saved,component+' changed native state');assert.deepEqual(worlds.map(E.snapshot),before);
  }
  assert.equal(JSON.parse(call(raw[0],{kind:'device_fault',agentId:'endpoint-1'})).reason,'invalid_fault');assert.deepEqual(hashes(),saved);
  assert.throws(()=>call(raw[0],{kind:'device_fault',agentId:'endpoint-1',expectedFaultGeneration:null}));assert.deepEqual(hashes(),saved);
  assert.equal(JSON.parse(call(raw[0],{kind:'device_fault',agentId:'endpoint-1',expectedFaultGeneration:7})).reason,'fault_changed');assert.deepEqual(hashes(),saved);
  assert(E.injectFault(worlds[0],faultInput(worlds[0],'endpoint-1')).ok);assert(worlds[0].agents.find(a=>a.id==='endpoint-1').disabled);assert.deepEqual(E.snapshot(worlds[1]),before[1]);assert.deepEqual(C.hashes(stores[1],ps[1],worlds[1]),saved[1]);
  console.log(JSON.stringify({physicsMode,firstInterventionForeignComponentsRejected:7,bothWorldsUnchanged:true,ownConditionalFaultWorks:true}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
