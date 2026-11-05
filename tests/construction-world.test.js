'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),D=require('../src/construction'),M=require('../src/materials'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),R=require('../src/replay'),B=require('../src/stream-protobuf'),{bind}=require('./native-task-frame-support');
const variants=['kinematic','rapier'].flatMap(physicsMode=>['distance','time','energy'].map(navigation=>({physicsMode,navigation,dispatchMode:'rule'})).concat([{physicsMode,navigation:'distance',dispatchMode:'networked_reported'}]));
for(const {physicsMode,navigation,dispatchMode} of variants){
 const scene=E.getScene('lunar-construction-v1');scene.navigation=navigation;
 const a=E.create(42,'nearest',scene,{physicsMode,dispatchMode}),b=Init.create(42,'nearest',scene,{physicsMode,dispatchMode}),worlds=[a,b],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{assert.deepEqual(b,E.snapshot(a));bind(b,ps[1],{batch:true,actionBatch:true,worldBatch:true});const frames=[E.snapshot(b)];
  for(let i=0;i<900&&!b.done;i++){
   if(dispatchMode==='networked_reported')for(const w of worlds)for(const t of E.coordinatorObservation(w).tasks){const current=E.coordinatorObservation(w).tasks.find(x=>x.id===t.id),agent=current?.candidates[0];if(agent)assert(E.submitExternalDecision(w,{requestId:'construction-plan-'+t.id+'-'+w.tick,taskId:t.id,agentId:agent.id,observedTick:w.tick}).ok)}
   worlds.forEach((w,j)=>E.step(w,ps[j]));assert.deepEqual(E.snapshot(b),E.snapshot(a),physicsMode+'/'+navigation+'/'+b.tick);D.validateWorld(b,scene.constructionSites);M.validateState(b.materials,b.tasks,scene.materials);
   for(const id of ['relay-1','rover-3']){const own=E.observe(b,id);assert.deepEqual(own,E.observe(a,id));assert.deepEqual(B.decode(B.encode(own,2)),own);if(id==='rover-3')assert(!Object.hasOwn(own.self,'relayState'))}
   assert.deepEqual(E.coordinatorObservation(b),E.coordinatorObservation(a));frames.push(E.snapshot(b));
  }
  assert(b.done&&!b.failed,JSON.stringify({physicsMode,navigation,dispatchMode,tick:b.tick,last:b.events.slice(-5)}));assert.equal(E.metrics(b).completed,11);assert.equal(b.construction.sites.filter(s=>s.status==='built').length,2);assert.equal(M.metrics(b.materials).find(x=>x.id==='construction-kit').consumed,2);assert.equal(b.agents.filter(a=>a.relayState?.deployed).length,2);assert(b.agents.filter(a=>a.relayState?.deployed).every(a=>a.status==='deployed'));assert.equal(M.metrics(b.materials).find(x=>x.id==='relay-kit').consumed,2);
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames};assert(R.validateArchive(archive));
  for(const mutate of [w=>w.construction.sites[0].builtTick++,w=>w.construction.sites[0].assignmentId++,w=>w.construction.sites[0].agentId='not-a-builder',w=>delete w.construction,w=>w.tasks.find(t=>t.behavior==='build').buildSite='other']){const bad=structuredClone(archive);mutate(bad.frames.at(-1));assert.throws(()=>R.validateArchive(bad))}
  console.log(JSON.stringify({physicsMode,navigation,dispatchMode,centralRange:scene.communication.range,tick:b.tick,complete:11,sites:b.construction.sites,relays:b.agents.filter(a=>a.deployableRelay).map(a=>({id:a.id,relayState:a.relayState}))}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log('Construction whole worlds: eight exact JS/native initialization and complete missions, actual two-site builds and stationary deployments, scoped observations, binary-v2 own extension, kit conservation, immutable replay and native coordinator parity passed');
