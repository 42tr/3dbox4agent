'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),{bind}=require('./native-task-frame-support');
const target=[25,65],a={id:'rover-1',x:40,y:60,battery:85},b={id:'rover-3',x:16,y:52,battery:95};
for(const candidates of [[a,b],[b,a]]){assert.equal(E.choose({task:{target},candidates},'nearest'),'rover-1');assert.equal(E.choose({task:{target},candidates},'battery'),'rover-3')}
assert.equal((40-25)**2+(60-65)**2,(16-25)**2+(52-65)**2);
let compared=0;
for(const physicsMode of ['kinematic','rapier']){
 const scene=E.getScene('shore-echelons-v1'),js=E.create(7,'nearest',scene,{physicsMode}),native=Init.create(7,'nearest',scene,{physicsMode}),worlds=[js,native],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{
  if(ps[0]){E.bindRaySensors(js,ps[0]);Init.finishRay(native,ps[1]);E.bindRaySensors(native,ps[1],true)}bind(native,ps[1],{batch:true,actionBatch:true,worldBatch:true});
  while(!native.tasks.find(t=>t.id==='confirm').assignee&&native.tick<100){worlds.forEach((w,i)=>E.step(w,ps[i]));assert.deepEqual(E.snapshot(native),E.snapshot(js));compared++}
  assert.equal(native.tasks.find(t=>t.id==='confirm').assignee,'rover-1');
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log(JSON.stringify({passed:true,regression:'mathematically equal sqrt250 distances use existing ID tie rule, independent of hypot rounding',nativeMissionCases:2,comparedFrames:compared}));
