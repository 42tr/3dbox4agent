'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),R=require('../src/replay'),C=require('./native-task-frame-support');
const results=[];
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy']){
 const scene=E.getScene('lunar-power-v1');scene.navigation=navigation;const options={physicsMode},a=E.create(42,'nearest',scene,options),b=Init.create(42,'nearest',scene,options),ws=[a,b],ps=ws.map(w=>physicsMode==='rapier'?P.createPhysics(w):null),frames=[E.snapshot(b)];assert.deepEqual(b,a);C.bind(b,ps[1],{batch:true,actionBatch:true,worldBatch:true});
 try{
  while(!a.done&&a.tick<1000){ws.forEach((w,i)=>E.step(w,ps[i]));assert.deepEqual(E.snapshot(b),E.snapshot(a),physicsMode+'/'+navigation+'/'+a.tick);frames.push(E.snapshot(b))}
  assert(a.done&&!a.failed);assert.equal(a.tasks.filter(t=>t.status==='done').length,11);assert.deepEqual(E.metrics(b),E.metrics(a));
  for(const relay of b.agents.filter(a=>a.role==='relay')){assert(relay.disabled);assert.equal(relay.battery,0);assert.equal(relay.status,'fault');assert(relay.relayState.deployed);assert.equal(relay.faultGeneration,0);assert(b.events.some(e=>e.kind==='energy_depleted'&&e.agentId===relay.id&&e.source==='operating'))}
  assert.equal(b.faults,0);assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));results.push({physicsMode,navigation,tick:a.tick,tasks:11,baseEnergy:E.metrics(a).operatingEnergy.energySpent,relayPowerDepletionDistinctFromTaskCompletion:true});
 }finally{ws.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log(JSON.stringify({cases:results.length,wholeWorldFramesPaired:true,allArchivesValidated:true,results}));
