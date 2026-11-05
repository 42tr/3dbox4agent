'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),M=require('../src/materials'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),R=require('../src/replay'),{bind}=require('./native-task-frame-support');
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy']){
 const scene=E.getScene('lunar-materials-v1');scene.navigation=navigation;const a=E.create(42,'nearest',scene,{physicsMode}),b=Init.create(42,'nearest',scene,{physicsMode}),worlds=[a,b],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{
  assert.deepEqual(b,E.snapshot(a),'initial');bind(b,ps[1],{batch:true,actionBatch:true,worldBatch:true});const frames=[E.snapshot(b)];let held=false;
  for(let i=0;i<700&&!b.done;i++){worlds.forEach((w,j)=>E.step(w,ps[j]));assert.deepEqual(E.snapshot(b),E.snapshot(a),`${physicsMode}/${navigation}/${b.tick}`);M.validateState(b.materials,b.tasks,scene.materials);held||=b.materials.reservations.length>0;assert.deepEqual(E.observe(b,'rover-3'),E.observe(a,'rover-3'));assert.deepEqual(E.coordinatorObservation(b),E.coordinatorObservation(a));const own=E.observe(b,'rover-3');assert(!Object.hasOwn(own,'materials'));assert(!JSON.stringify(own.self.materialReservations).includes('remaining'));frames.push(E.snapshot(b))}
  assert(b.done&&!b.failed);assert(held);assert.equal(b.tasks.filter(t=>t.status==='done').length,7);assert.deepEqual(M.metrics(b.materials).map(x=>[x.id,x.remaining,x.reserved,x.consumed]),[['sample-case',0,0,1],['repair-kit',0,0,2]]);
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames};assert(R.validateArchive(archive));for(const change of [x=>x.materials.stock[0].remaining=1,x=>x.tasks.find(t=>t.materialCost).materialCost[0].amount=2]){const bad=structuredClone(archive);change(bad.frames.at(-1));assert.throws(()=>R.validateArchive(bad))}
  console.log(JSON.stringify({scene:scene.id,physicsMode,navigation,tick:b.tick,complete:7,materials:M.metrics(b.materials)}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log('Material whole worlds: exact JS/native initialization, six complete motion/navigation missions and every frame, scoped own leases, material conservation and immutable replay costs/state passed');
