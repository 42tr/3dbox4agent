'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),Replay=require('../src/replay'),{bind}=require('./native-task-frame-support');
for(const physicsMode of ['kinematic','rapier']){
 const scene=E.getScene('lunar-thermal-v1'),js=E.create(42,'nearest',scene,{physicsMode}),native=Init.create(42,'nearest',scene,{physicsMode}),worlds=[js,native],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);let peak=0;
 try{
  assert.deepEqual(native,E.snapshot(js),'initialization');
  if(ps[0]){E.bindRaySensors(js,ps[0]);Init.finishRay(native,ps[1]);E.bindRaySensors(native,ps[1],true)}
  bind(native,ps[1],{batch:true,actionBatch:true,worldBatch:true});const frames=[E.snapshot(native)];
  for(let i=0;i<700&&!native.done;i++){
   worlds.forEach((w,j)=>E.step(w,ps[j]));assert.deepEqual(E.snapshot(native),E.snapshot(js),`${physicsMode}/${native.tick}`);
   for(const a of native.agents){assert(a.thermalState.temperatureC<=a.thermal.limitC);assert(a.thermalState.temperatureC>=a.thermal.ambientC);assert.equal(a.thermalState.tick,native.tick);peak=Math.max(peak,a.thermalState.peakC)}
   assert.deepEqual(E.observe(native,'rover-3'),E.observe(js,'rover-3'));assert.deepEqual(E.coordinatorObservation(native),E.coordinatorObservation(js));assert(!JSON.stringify(E.coordinatorObservation(native)).includes('temperatureC'));frames.push(E.snapshot(native));
  }
  assert(native.done&&!native.failed);assert.equal(native.tasks.filter(t=>t.status==='done').length,7);assert(native.events.some(e=>e.kind==='thermal_protection_entered'));assert(native.events.some(e=>e.kind==='thermal_protection_cleared'));assert(native.tick>192);
  assert(E.observe(native,'rover-3').self.thermal);const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames};assert(Replay.validateArchive(archive));
  for(const mutate of [f=>f.agents[0].thermalState.temperatureC=201,f=>f.agents[0].thermalState.tick=0,f=>f.agents[0].thermal.heatCPerEnergy=1]){const bad=structuredClone(archive);mutate(bad.frames[1]);assert.throws(()=>Replay.validateArchive(bad))}
  console.log(JSON.stringify({scene:scene.id,physicsMode,tick:native.tick,complete:7,peak,events:native.events.filter(e=>e.kind.startsWith('thermal_')).length}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log('Thermal whole worlds: exact JS/native initialization, all execution state and events per step, own observations, hard temperature bounds, task recovery and immutable replay profile/state validation passed');
