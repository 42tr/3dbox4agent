'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),H=require('../src/elevation'),Replay=require('../src/replay'),{bind}=require('./native-task-frame-support');
function fixture(){const s=E.getScene('lunar-outpost-v1');s.id='heightfield-world-test';s.heightfield={rows:3,cols:3,heights:[0,2,4,0,2,4,0,2,4]};s.obstacles=[];s.terrain=[];s.riskZones=[];s.agents=[{role:'worker',label:'Worker',count:1,mobility:'ground',capabilities:['inspect'],speed:3,moveEnergyPerUnit:.5}];s.tasks=[{id:'survey',name:'Survey',behavior:'survey',capability:'inspect',role:'worker',target:[80,60],duration:2,dependsOn:[]}];s.resource={warehouse:[20,80],site:[80,60]};return s}
let ticks=0;
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy']){
 const s=fixture();s.navigation=navigation;const js=E.create(42,'nearest',s,{physicsMode}),native=Init.create(42,'nearest',s,{physicsMode});assert.deepEqual(native,E.snapshot(js));
 const worlds=[js,native],physics=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{
  if(physicsMode==='rapier'){E.bindRaySensors(js,physics[0]);Init.finishRay(native,physics[1]);E.bindRaySensors(native,physics[1],true);assert.deepEqual(native,E.snapshot(js))}
  bind(native,physics[1],{batch:true,actionBatch:true,worldBatch:true});const history=[E.snapshot(native)];
  for(let i=0;i<100&&!native.done;i++){
   E.step(js,physics[0]);E.step(native,physics[1]);ticks++;
   assert.deepEqual(E.snapshot(native),E.snapshot(js),`${physicsMode}/${navigation}/${native.tick}`);assert.deepEqual(E.observe(native,'worker-1'),E.observe(js,'worker-1'));history.push(E.snapshot(native));
  }
  assert(native.done&&!native.failed);const a=native.agents[0];assert(a.terrainDistance>0);assert(Math.abs(a.battery-(a.initialBattery-a.distance*.5*1.08-2*.08))<1e-6);const o=E.observe(native,a.id);assert.equal(o.self.elevation,H.height(native.heightfield,a.x,a.y));assert.equal(o.self.slopeDegrees,H.surface(native.heightfield,a.x,a.y).slopeDegrees);assert(!Object.hasOwn(o,'heightfield'));
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:s.id,scene:s},frames:history};assert(Replay.validateArchive(archive));const bad=structuredClone(archive);bad.frames[0].heightfield.heights[0]=3;assert.throws(()=>Replay.validateArchive(bad));
 }finally{worlds.forEach(E.disposeWorld);physics.forEach(p=>p?.free())}
}
console.log(JSON.stringify({scenarios:6,ticks}));console.log('Heightfield worlds: exact JS/native creation, whole-world steps, physical rays, slope speed/energy, self-only surface observations and replay map identity passed');
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy']){
 const s=E.getScene('lunar-heightfield-v1');s.navigation=navigation;const a=E.create(42,'nearest',s,{physicsMode}),b=Init.create(42,'nearest',s,{physicsMode}),worlds=[a,b],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{
  if(ps[0]){E.bindRaySensors(a,ps[0]);Init.finishRay(b,ps[1]);E.bindRaySensors(b,ps[1],true)}bind(b,ps[1],{batch:true,actionBatch:true,worldBatch:true});
  for(let i=0;i<700&&!b.done;i++){E.step(a,ps[0]);E.step(b,ps[1]);assert.deepEqual(E.snapshot(b),E.snapshot(a),`builtin/${navigation}/${physicsMode}/${b.tick}`)}
  assert(b.done&&!b.failed);assert.equal(b.tasks.filter(t=>t.status==='done').length,7);console.log(JSON.stringify({builtin:s.id,navigation,physicsMode,tick:b.tick,complete:7}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
// A navigable ridge hides ground peers/targets and radio hops while absolute
// altitude aircraft retain sight; fixed sensors use height above local ground.
for(const ray of [false,true]){
 const s=fixture();s.heightfield={rows:3,cols:3,heights:[0,0,0,0,10,0,0,0,0]};s.sensorRange=100;s.resource.site=[90,50];s.tasks[0].target=[90,50];s.agents=[{role:'worker',label:'Worker',count:2,mobility:'ground',capabilities:['inspect'],speed:2},{role:'scout',label:'Scout',count:1,mobility:'air',capabilities:['inspect'],speed:3}];s.fixedSensors=[{id:'tower',name:'Tower',x:10,y:50,height:16,range:100,interval:1}];Object.assign(s.communication,{range:100,lineOfSight:true,delay:1,lossRate:0});
 const worlds=[E.create(42,'nearest',s,{physicsMode:ray?'rapier':'kinematic',dispatchMode:'external'}),E.create(42,'nearest',s,{physicsMode:ray?'rapier':'kinematic',dispatchMode:'external'})];for(const w of worlds){Object.assign(w.agents[0],{x:10,y:50});Object.assign(w.agents[1],{x:90,y:50});Object.assign(w.agents[2],{x:10,y:30});E.refreshPerceptions(w)}
 const ps=worlds.map(w=>ray?P.createPhysics(w):null);
 try{
  if(ray)worlds.forEach((w,i)=>E.bindRaySensors(w,ps[i]));bind(worlds[1],ps[1],{batch:true,actionBatch:true,worldBatch:true});
  for(const w of worlds){const ground=E.observe(w,'worker-1');assert(!ground.nearby.some(a=>a.id==='worker-2'));assert(!ground.visibleTargets.some(t=>t.id==='survey'));assert(E.observe(w,'scout-1').nearby.some(a=>a.id==='worker-2'));assert(E.sendMessage(w,'worker-1','worker-2','ridge').ok);assert(E.submitAction(w,'worker-1',{requestId:'scan-ridge',type:'scan',targetTick:1,expiresTick:30}).ok)}
  for(let i=0;i<4;i++){worlds.forEach((w,j)=>E.step(w,ps[j]));assert.deepEqual(E.snapshot(worlds[1]),E.snapshot(worlds[0]))}
  const w=worlds[1];assert(w.events.some(e=>e.kind==='message_failed'&&e.reason==='obstructed'));assert.equal(w.actions[0].result.kind,'not_detected');assert(w.events.some(e=>e.kind==='fixed_sensor_delivered'));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log('Heightfield sensing: native/JS ground/air terrain occlusion, blocked peer delivery, actual scan rays and locally mounted fixed sensors passed');
