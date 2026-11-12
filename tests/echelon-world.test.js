'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),D=require('../src/surface-domain'),Replay=require('../src/replay'),{bind}=require('./native-task-frame-support');
const scene=require('../examples/scenes/shore-echelons.json');
function differences(a,b,p=''){
 if(Object.is(a,b))return [];if(!a||!b||typeof a!=='object'||typeof b!=='object')return [{path:p,js:a,native:b}];
 let out=[];for(const k of new Set([...Object.keys(a),...Object.keys(b)])){out.push(...differences(a[k],b[k],p+'/'+k));if(out.length>=8)break}return out;
}
function equal(a,b,label){const diff=differences(a,b);if(diff.length)throw Error(label+' '+JSON.stringify(diff))}
let frames=0;
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy'])for(const executionMode of ['auto','agent','primitive']){
 const config=structuredClone(scene);config.navigation=navigation;
 const js=E.create(42,'nearest',config,{physicsMode,executionMode}),native=Init.create(42,'nearest',config,{physicsMode,executionMode}),worlds=[js,native],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{
  equal(E.snapshot(js),native,'initial');if(ps[0]){E.bindRaySensors(js,ps[0]);Init.finishRay(native,ps[1]);E.bindRaySensors(native,ps[1],true)}
  bind(native,ps[1],{batch:true,actionBatch:true,worldBatch:true});const history=[E.snapshot(native)];
  for(let i=0;i<1200&&!native.done;i++){
   if(executionMode!=='auto')for(const w of worlds)for(const a of w.agents){const o=E.observe(w,a.id),t=o.assignedTasks.find(t=>t.status==='active');if(!t||o.actions.some(x=>['pending','accepted'].includes(x.status)))continue;const common={requestId:'surface-'+a.id+'-'+w.tick,targetTick:w.tick+1,expiresTick:w.tick+40};let input;if(executionMode==='agent')input={...common,type:'execute_task',taskId:t.id};else if(t.withinReach)input={...common,type:'work_task',taskId:t.id};else{const point=Object.hasOwn(t,'approachPoint')?t.approachPoint:t.waypoint;if(!point)continue;input={...common,type:'move',target:{x:point[0],y:point[1]}}}const result=E.submitAction(w,a.id,input);assert(result.ok,JSON.stringify({mode:executionMode,physicsMode,tick:w.tick,agent:a.id,input,result}))}
   worlds.forEach((w,j)=>E.step(w,ps[j]));equal(E.snapshot(js),E.snapshot(native),physicsMode+'/'+navigation+'/'+native.tick);frames++;history.push(E.snapshot(native));
   for(const a of native.agents){assert(D.bodyFree(native.surfaceDomain,a.mobility,[a.x,a.y]),a.id+' left its domain');equal(E.observe(js,a.id),E.observe(native,a.id),'observation/'+a.id+'/'+native.tick)}
  }
  assert(native.done&&!native.failed,'mission must finish');assert.equal(native.tasks.filter(t=>t.status==='done').length,9);assert(native.agents.filter(a=>a.mobility==='water').some(a=>a.distance>20));assert(native.events.some(e=>e.kind==='part_loaded'));assert.equal(native.part.location,'consumed');
  if(physicsMode==='kinematic'&&executionMode==='auto'){
   const recovery=native.events.filter(event=>event.agentId==='relay-1'&&['collision_contact','collision_replan','relay_deployed'].includes(event.kind));
   assert.deepEqual(recovery.map(event=>event.kind),['collision_contact','collision_replan','relay_deployed']);
   for(const frame of history){
    const relay=frame.agents.find(agent=>agent.id==='relay-1'),vehicle=frame.agents.find(agent=>agent.id==='vehicle-1');
    assert(Math.hypot(relay.x-vehicle.x,relay.y-vehicle.y)>=1.6-1e-8,'the relay must clear the parked vehicle without overlap');
   }
  }
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:config.id,scene:config},frames:history};assert(Replay.validateArchive(archive));
  const bad=structuredClone(archive);bad.frames[0].surfaceDomain.water[0].x=44;assert.throws(()=>Replay.validateArchive(bad));
  const pose=structuredClone(archive);Object.assign(pose.frames[1].agents.find(a=>a.mobility==='water'),{x:25,y:50});assert.throws(()=>Replay.validateArchive(pose));
  const deployed=native.agents.filter(a=>a.relayState?.deployed);assert.equal(deployed.length,1);assert.equal(native.materials.stock[0].remaining,0);assert.equal(E.metrics(native).materials[0].consumed,1);const milestones=E.metrics(native).taskMilestones,get=id=>milestones.find(t=>t.taskId===id);assert(get('confirm').firstAssignedTick>Math.max(get('guide-shore').completedTick,get('deploy-shore').completedTick));assert(get('guide-shore').firstAssignedTick<=get('sea-survey').completedTick);assert.deepEqual(deployed[0].relayState.position,[deployed[0].x,deployed[0].y]);assert(Math.hypot(deployed[0].x-40,deployed[0].y-30)<=4);const resident=history.find(w=>w.agents.find(a=>a.id===deployed[0].id)?.relayState?.deployed).agents.find(a=>a.id===deployed[0].id);assert.deepEqual([deployed[0].x,deployed[0].y,deployed[0].distance],[resident.x,resident.y,resident.distance]);assert(!Object.hasOwn(native,'echelons'));assert(!Object.hasOwn(E.observe(native,deployed[0].id),'echelons'));
  console.log(JSON.stringify({physicsMode,navigation,executionMode,tick:native.tick,complete:9,frames:history.length}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log('Echelon worlds: actual18-device9-task guide/water parallel preparation, dependency-gated deployment/consumable, exact JS/native frames and own observations, body legality and replay passed '+JSON.stringify({cases:18,frames}));
