'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),P=require('../server/rust-physics');
const keys=['environment','ledger','control','execution','tasks','actions','resources'],exercised=new Set(),kinds=new Set(),chargeGuards=new Set();let frames=0,refusals=0;
function raw(stores){return Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native]))}
function hashes(r){return keys.map(k=>crypto.createHash('sha256').update(k==='execution'?r[k].snapshot()+r[k].snapshotExecution():r[k].snapshot()).digest('hex'))}
function atomic(w,stores,original,args){
 const [index,,physics]=args,r=raw(stores),points=Object.fromEntries(keys.map(k=>[k,stores[k].checkpoint()])),physical=physics?.checkpoint(),before=E.snapshot(w),actor=before.agents[index];
 const restore=()=>{for(const k of [...keys].reverse())stores[k].rollback(points[k]);if(physical)physics.rollback(physical)};
 const call=(tick=w.tick,env=r.environment)=>physics?physics.advanceRouteEvents(r.execution,index,tick,env,r.resources,r.tasks,r.actions,r.control,r.ledger):r.execution.advanceRouteEvents(index,tick,env,r.resources,r.tasks,r.actions,r.control,r.ledger);
 const probe=()=>{if(physics){const rays=w.agents.map(a=>physics.lidar(a,1,16,100));assert.deepEqual(physics.move(actor,0,0),{x:0,y:0,contacts:0});return rays}};
 try{
  const originalHashes=hashes(r);for(const tick of [-1,0,w.tick+.5,w.tick+1,4294967296+w.tick,NaN,Infinity]){assert.throws(()=>call(tick));assert.deepEqual(hashes(r),originalHashes)}
  const chargeIndex=before.actions.findIndex(a=>a.agentId===actor.id&&a.type==='charge'&&a.status==='accepted'&&a.phase==='travel');if(chargeIndex>=0&&!chargeGuards.has(w.physicsMode)){stores.actions.update(chargeIndex,{phase:'waiting'},w.tick);const inactive=hashes(r);assert.throws(()=>call(),/invalid world motion input/);assert.deepEqual(hashes(r),inactive);stores.actions.rollback(points.actions);assert.deepEqual(E.snapshot(w),before);chargeGuards.add(w.physicsMode)}
  const result=original.route(...args);assert.equal(result.published,true);assert.equal(Object.keys(result).includes('published'),false);const after=E.snapshot(w),events=after.events.slice(before.events.length);for(const e of events)kinds.add(e.kind);
  const committed=hashes(r);assert.throws(()=>call(),/invalid world motion input/);assert.deepEqual(hashes(r),committed);
  const key=w.physicsMode+':'+events.map(e=>e.kind).join(',');if(!events.length||exercised.has(key))return result;exercised.add(key);
  restore();assert.deepEqual(E.snapshot(w),before);const initialRays=probe();
  for(let position=1;position<=events.length;position++){
   let length=before.events.length;while(length<200000-position+1){const event=JSON.parse(r.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));r.control.observe(event.seq,r.ledger);length++}
   const padded=hashes(r);for(let retry=0;retry<2;retry++){assert.throws(()=>call(),/invalid world ledger input/);assert.deepEqual(hashes(r),padded);assert.deepEqual(probe(),initialRays);r.control.validateCommit(r.ledger);refusals++}
   restore();assert.deepEqual(E.snapshot(w),before);
  }
  const retried=original.route(...args);assert.deepEqual(retried,result);assert.deepEqual(E.snapshot(w),after);return retried;
 }finally{for(const p of Object.values(points))p.free();physical?.free()}
}
function bind(w){const stores={};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources']]){const s=require('../server/rust-world-'+name).create(w);stores[name]=s;E[method](w,s);if(name==='ledger'){stores.control=s.control(w);E.bindWorldControl(w,stores.control)}if(name==='motion'){const e=s.execution(w);stores.execution={...e,route(...args){return atomic(w,stores,e,args)}};E.bindWorldExecution(w,stores.execution)}}return stores}
function pair(scene,options,prepare=()=>{}){const a=E.create(42,'nearest',scene,{dispatchMode:'external',...options});prepare(a);const b=E.snapshot(a),stores=bind(b),pa=a.physicsMode==='rapier'?P.createPhysics(a):null,pb=b.physicsMode==='rapier'?P.createPhysics(b):null;return {a,b,stores,pa,pb,close(){E.disposeWorld(b);pa?.free();pb?.free()}}}
function equal(v){assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a));for(const a of v.a.agents)assert.deepEqual(E.observe(v.b,a.id),E.observe(v.a,a.id));assert.deepEqual(E.coordinatorObservation(v.b),E.coordinatorObservation(v.a))}
function both(v,fn){const r=fn(v.b);assert.deepEqual(r,fn(v.a));assert(r.ok,JSON.stringify(r));equal(v)}function step(v){E.step(v.a,v.pa);E.step(v.b,v.pb);equal(v);frames++}
for(const physicsMode of ['kinematic','rapier'])for(const variant of ['edge','effects','charge','depleted']){
 const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];scene.terrain=[];scene.riskZones=[];scene.riskNavigation='monitor';scene.resource.warehouse=[80,50];
 if(variant==='edge'){scene.riskZones=[{id:'edge',name:'边缘风险',x:99,y:40,w:1,h:20}];scene.terrain=[{id:'edge-terrain',name:'边缘地表',x:98,y:40,w:2,h:20,speedFactor:1,energyFactor:1}]}
 if(variant==='effects')scene.terrain=[{id:'route-terrain',name:'行驶地表',x:12,y:40,w:30,h:20,speedFactor:.7,energyFactor:1.5}];
 const v=pair(scene,{physicsMode},w=>{const a=variant==='edge'?w.agents[0]:w.agents.find(a=>a.role==='vehicle');if(variant==='edge')a.mobility='air';Object.assign(a,{x:variant==='edge'?98:10,y:50,speed:3});if(variant==='charge')a.battery=30;if(variant==='depleted')Object.assign(a,{battery:6,moveEnergyPerUnit:1})});
 try{const actor=variant==='edge'?v.a.agents[0]:v.a.agents.find(a=>a.role==='vehicle'),target=variant==='edge'?[100,50]:[80,50];if(['edge','effects'].includes(variant))both(v,w=>E.injectTerrainEffect(w,scene.terrain[0].id,20,.7,1.5));both(v,w=>E.submitAction(w,actor.id,{requestId:'route-'+variant,type:variant==='charge'?'charge':'move',...(variant==='charge'?{}:{target:{x:target[0],y:target[1]}}),targetTick:1,expiresTick:100}));
  for(let n=0;n<100&&!v.a.done;n++){step(v);if(!v.a.actions.some(a=>['pending','accepted'].includes(a.status)))break}
  if(variant==='effects')assert.equal(v.b.events.filter(e=>e.kind==='terrain_effect_exposure').length,1);
  if(variant==='edge'){assert(v.b.events.some(e=>e.kind==='footprint_boundary_exit'));assert(v.b.events.some(e=>e.kind==='risk_zone_entered'))}
  if(variant==='depleted')assert(v.b.agents.find(a=>a.id===actor.id).disabled);
 }finally{v.close()}
}
{const v=pair(E.getScene('lunar-outpost-v1'),{physicsMode:'rapier',dispatchMode:'rule'});try{for(let n=0;n<300&&!v.a.done;n++)step(v);assert(v.b.done&&!v.b.failed);assert(v.b.events.some(e=>e.kind==='collision_contact'))}finally{v.close()}}
// Delivery accounting comes from the actual task/resource owner, including a
// primitive move to pickup/site and an agent charge that resumes the delivery.
for(const mode of ['auto','agent','primitive']){
 const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];scene.terrain=[];const t=scene.tasks.find(t=>t.behavior==='deliver');scene.tasks=[{...t,target:[45,50],duration:2,dependsOn:[]}];scene.resource.warehouse=[25,50];scene.resource.site=[45,50];scene.chargingStation=[10,50];
 const v=pair(scene,{executionMode:mode},w=>Object.assign(w.agents.find(a=>a.role==='vehicle'),{x:15,y:50,speed:3,...(mode==='agent'?{battery:30}:{})}));
 try{const id=v.a.agents.find(a=>a.role==='vehicle').id,task=v.a.tasks[0];both(v,w=>E.assign(w,task.id,id));let serial=0,charged=false;
  for(let n=0;n<140&&!v.a.done;n++){const a=v.a.agents.find(a=>a.id===id);if(mode==='agent'&&!charged&&n===2){const active=v.a.actions.find(a=>a.agentId===id&&a.status==='accepted');if(active)both(v,w=>E.cancelAction(w,id,active.requestId));both(v,w=>E.submitAction(w,id,{requestId:'resume-charge',type:'charge',targetTick:w.tick+1,expiresTick:w.tick+100}));charged=true}
   if(a.status==='assigned'&&!v.a.actions.some(x=>x.agentId===id&&['pending','accepted'].includes(x.status))){const goal=task.phase==='to_pickup'?v.a.part.position:task.target,travel=Math.hypot(a.x-goal[0],a.y-goal[1])>3,requestId='delivery-'+(++serial);both(v,w=>E.submitAction(w,id,{requestId,type:mode==='primitive'?(travel?'move':'work_task'):'execute_task',...(mode==='primitive'&&travel?{target:{x:goal[0],y:goal[1]}}:{taskId:task.id}),targetTick:w.tick+1,expiresTick:w.tick+100}))}step(v)
  }assert(v.b.done&&!v.b.failed);assert(v.b.agents.find(a=>a.id===id).deliveryTravel.loadedDistance>0);
 }finally{v.close()}
}
assert.equal(chargeGuards.size,2);
for(const kind of ['risk_zone_entered','footprint_boundary_exit','terrain_effect_exposure','collision_contact'])assert(kinds.has(kind),kind);
console.log('Native route events: '+frames+' paired frames, '+exercised.size+' event sequences and '+refusals+' late ledger refusals; actual terrain/risk/footprint/contact events, native clock and duplicate fencing, collider/state rollback, derived delivery/charge ownership, at-station charge rejection, scoped parity and identical retry passed');
