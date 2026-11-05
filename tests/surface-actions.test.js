'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),D=require('../src/surface-domain'),Replay=require('../src/replay'),{bind}=require('./native-task-frame-support');
const base=require('../examples/scenes/shore-surface.json');
function fixture(mobility){const s=structuredClone(base),role=mobility==='water'?'boat':'vehicle',a=s.agents.find(a=>a.role===role);a.count=1;a.spawnArea=mobility==='water'?{x:80,y:20,w:10,h:10}:{x:10,y:40,w:10,h:10};s.agents=[a];s.id='surface-actions-'+mobility;s.tasks=[{id:'later',name:'Later',behavior:'survey',role,capability:a.capabilities[0],target:mobility==='water'?[80,75]:[20,75],duration:10,dependsOn:[]}];return s}
for(const physicsMode of ['kinematic','rapier'])for(const mobility of ['ground','water'])for(const barrier of [false,true]){
 const config=fixture(mobility),options={physicsMode,dispatchMode:'external'},js=E.create(42,'nearest',config,options),native=Init.create(42,'nearest',config,options),worlds=[js,native],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null),id=config.agents[0].role+'-1';
 try{
  if(ps[0]){E.bindRaySensors(js,ps[0]);Init.finishRay(native,ps[1]);E.bindRaySensors(native,ps[1],true)}bind(native,ps[1],{batch:true,actionBatch:true,worldBatch:true});
  const before=worlds.map(w=>({x:w.agents[0].x,y:w.agents[0].y}));
  for(const w of worlds)assert(E.submitAction(w,id,{requestId:'forbidden',type:'move',target:{x:mobility==='water'?20:80,y:50},targetTick:1,expiresTick:40}).ok);
  worlds.forEach((w,i)=>E.step(w,ps[i]));assert.deepEqual(E.snapshot(native),E.snapshot(js));
  assert.equal(native.actions[0].reason,'unreachable_target');assert(['failed','rejected'].includes(native.actions[0].status));worlds.forEach((w,i)=>assert.deepEqual({x:w.agents[0].x,y:w.agents[0].y},before[i]));
  for(const w of worlds){assert(E.injectLowEnergy(w,id,5).ok);if(barrier)assert(E.injectRoadblock(w,{x:mobility==='water'?47:35,y:2,w:8,h:96},8).ok);assert(E.submitAction(w,id,{requestId:'charge',type:'charge',targetTick:2,expiresTick:41}).ok)}
  const history=[E.snapshot(native)];let waited=false;
  for(let i=0;i<180&&!['completed','failed','rejected'].includes(native.actions[1].status);i++){
   worlds.forEach((w,j)=>E.step(w,ps[j]));assert.deepEqual(E.snapshot(native),E.snapshot(js));assert.deepEqual(E.observe(native,id),E.observe(js,id));history.push(E.snapshot(native));waited=waited||!!native.agents[0].roadblockWait;assert(D.bodyFree(native.surfaceDomain,mobility,[native.agents[0].x,native.agents[0].y]));
  }
  assert.equal(native.actions[1].status,'completed');assert.equal(native.agents[0].battery,80);assert(Math.hypot(native.agents[0].x-45,native.agents[0].y-50)<=3);assert.equal(waited,barrier);assert(!D.free(native.surfaceDomain,mobility,native.chargingStation,2));assert(native.agents[0].distance>1);
  assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{scene:config,sceneId:config.id,seed:42,policy:'nearest'},frames:history}));
  console.log(JSON.stringify({physicsMode,mobility,barrier,waited,tick:native.tick,battery:80,shoreChargeCompleted:true}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
// Equal actor IDs and legal initial poses cannot legitimize a foreign surface map.
const config=fixture('water'),w=E.create(42,'nearest',config,{physicsMode:'rapier'}),foreign=E.snapshot(w);foreign.surfaceDomain.water[0].x=46;foreign.surfaceDomain.water[0].w=54;
const p=P.createPhysics(foreign);try{E.bindRaySensors(w,p);const before=E.snapshot(w);assert.throws(()=>bind(w,p,{batch:true,actionBatch:true,worldBatch:true}));assert.deepEqual(E.snapshot(w),before)}finally{E.disposeWorld(w);p.free()}
const corner={water:[{id:'corner',name:'Corner',x:10,y:10,w:80,h:80}]};assert(D.bodyFree(corner,'ground',[9.4,9.4]));assert(!D.free(corner,'ground',[9.4,9.4],.8));assert(!D.bodyFree(corner,'ground',[9.5,9.5]));
for(const mutate of [s=>{delete s.surfaceDomain},s=>{s.heightfield={rows:2,cols:2,heights:[0,0,0,0]}},s=>{s.agents[0].spawnArea.x=0},s=>{s.agents[0].spawnArea.extra=1}]){const s=fixture('water');mutate(s);assert.throws(()=>E.create(42,'nearest',s));assert.throws(()=>Init.create(42,'nearest',s))}
console.log('Surface actions: exact JS/native own-state parity for strict off-domain move refusal and shoreline charging, timed closed-channel waits/resume, actual sphere-corner legality, foreign-map binding rejection, replay and scene/spawn guards passed');

const builder=E.getScene("lunar-construction-v1");delete builder.heightfield;builder.surfaceDomain=structuredClone(base.surfaceDomain);builder.agents.find(a=>a.role==="robot").mobility="water";assert.throws(()=>E.create(42,"nearest",builder),/builders must use ground mobility/);assert.throws(()=>Init.create(42,"nearest",builder),/invalid world initialization input/);
