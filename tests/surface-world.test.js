'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),D=require('../src/surface-domain'),Replay=require('../src/replay'),{bind}=require('./native-task-frame-support');
const scene=require('../examples/scenes/shore-surface.json');
function differences(a,b,p=''){
 if(Object.is(a,b))return [];if(!a||!b||typeof a!=='object'||typeof b!=='object')return [{path:p,js:a,native:b}];
 let out=[];for(const k of new Set([...Object.keys(a),...Object.keys(b)])){out.push(...differences(a[k],b[k],p+'/'+k));if(out.length>=8)break}return out;
}
function equal(a,b,label){const diff=differences(a,b);if(diff.length)throw Error(label+' '+JSON.stringify(diff))}
let frames=0;const weightedResults=new Map();
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy'])for(const executionMode of ['auto','agent','primitive'])for(const weighted of [false,true]){
 const config=structuredClone(scene);config.navigation=navigation;if(weighted)config.terrain=[{id:'east-slow-water',name:'Slow eastern passage',x:72,y:35,w:20,h:30,speedFactor:.5,energyFactor:1.25}];
 const js=E.create(42,'nearest',config,{physicsMode,executionMode}),native=Init.create(42,'nearest',config,{physicsMode,executionMode}),worlds=[js,native],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{
  equal(E.snapshot(js),native,'initial');if(ps[0]){E.bindRaySensors(js,ps[0]);Init.finishRay(native,ps[1]);E.bindRaySensors(native,ps[1],true)}
  bind(native,ps[1],{batch:true,actionBatch:true,worldBatch:true});const history=[E.snapshot(native)];
  for(let i=0;i<1200&&!native.done;i++){
   if(executionMode!=='auto')for(const w of worlds)for(const a of w.agents){const o=E.observe(w,a.id),t=o.assignedTasks.find(t=>t.status==='active');if(!t||o.actions.some(x=>['pending','accepted'].includes(x.status)))continue;const common={requestId:'surface-'+a.id+'-'+w.tick,targetTick:w.tick+1,expiresTick:w.tick+40};let input;if(executionMode==='agent')input={...common,type:'execute_task',taskId:t.id};else if(t.withinReach)input={...common,type:'work_task',taskId:t.id};else{const point=t.approachPoint??t.waypoint;if(!point)continue;input={...common,type:'move',target:{x:point[0],y:point[1]}}}const result=E.submitAction(w,a.id,input);assert(result.ok,JSON.stringify({mode:executionMode,physicsMode,tick:w.tick,agent:a.id,input,result}))}
   worlds.forEach((w,j)=>E.step(w,ps[j]));equal(E.snapshot(js),E.snapshot(native),physicsMode+'/'+navigation+'/'+native.tick);frames++;history.push(E.snapshot(native));
   for(const a of native.agents){assert(D.bodyFree(native.surfaceDomain,a.mobility,[a.x,a.y]),a.id+' left its domain');equal(E.observe(js,a.id),E.observe(native,a.id),'observation/'+a.id+'/'+native.tick)}
  }
  assert(native.done&&!native.failed,'mission must finish');assert.equal(native.tasks.filter(t=>t.status==='done').length,7);assert(native.agents.filter(a=>a.mobility==='water').some(a=>a.distance>20));assert(native.events.some(e=>e.kind==='part_loaded'));assert.equal(native.part.location,'consumed');
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:config.id,scene:config},frames:history};assert(Replay.validateArchive(archive));
  const bad=structuredClone(archive);bad.frames[0].surfaceDomain.water[0].x=44;assert.throws(()=>Replay.validateArchive(bad));
  const pose=structuredClone(archive);Object.assign(pose.frames[1].agents.find(a=>a.mobility==='water'),{x:25,y:50});assert.throws(()=>Replay.validateArchive(pose));
  if(weighted&&executionMode==='auto')weightedResults.set(physicsMode+'/'+navigation,E.metrics(native));
  console.log(JSON.stringify({physicsMode,navigation,executionMode,weighted,tick:native.tick,complete:7,frames:history.length}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
for(const mode of ['kinematic','rapier']){const distance=weightedResults.get(mode+'/distance'),time=weightedResults.get(mode+'/time'),energy=weightedResults.get(mode+'/energy');assert(time.ticks<energy.ticks);assert(time.terrainDistance<energy.terrainDistance);assert(energy.energyUsed<time.energyUsed);assert.equal(distance.terrainDistance,energy.terrainDistance)}
console.log('Surface worlds: actual16-device air/ground/water task chain, exact JS/native per-frame and own-observation parity, shore pickup, every pose legal and immutable-domain replay passed '+JSON.stringify({cases:36,frames}));
