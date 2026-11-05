'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),P=require('../server/rust-physics');
const keys=['environment','ledger','control','execution','tasks','actions','resources'],sequences=new Set();let frames=0,refusals=0,sensorRefusals=0;
function raw(stores){return Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native]))}
function hashes(r){return keys.map(k=>crypto.createHash('sha256').update(k==='execution'?r[k].snapshot()+r[k].snapshotExecution():r[k].snapshot()).digest('hex'))}
function atomic(w,stores,original,args){
 const [index,,,,,physics]=args,r=raw(stores),points=Object.fromEntries(keys.map(k=>[k,stores[k].checkpoint()])),before=E.snapshot(w);
 const restore=()=>{for(const k of [...keys].reverse())stores[k].rollback(points[k])};
 const call=(tick=w.tick)=>physics?physics.stationaryActionEvents(r.actions,index,tick,r.execution,r.environment,r.resources,r.tasks,r.control,r.ledger):r.actions.advanceStationaryEvents(index,tick,r.execution,r.environment,r.resources,r.tasks,r.control,r.ledger);
 const rays=()=>stores.physics?w.agents.map(a=>stores.physics.lidar(a,1,16,100)):undefined;
 try{
  const untouched=hashes(r),physical=rays();for(const tick of [-1,0,w.tick+.5,w.tick+1,w.tick+4294967296,NaN,Infinity]){assert.throws(()=>call(tick));assert.deepEqual(hashes(r),untouched)}
  if(physics)assert.throws(()=>r.actions.advanceStationaryEvents(index,w.tick,r.execution,r.environment,r.resources,r.tasks,r.control,r.ledger));else{const foreign=P.createPhysics(w);try{assert.throws(()=>foreign.stationaryActionEvents(r.actions,index,w.tick,r.execution,r.environment,r.resources,r.tasks,r.control,r.ledger))}finally{foreign.free()}}sensorRefusals++;assert.deepEqual(hashes(r),untouched);assert.deepEqual(rays(),physical);
  // A host-supplied resume flag is ignored by the owned path; only the native
  // controller's mode can decide how an assigned task resumes after charge.
  args[6]={...args[6],resumeAgent:w.executionMode!=='agent'};
  const result=original.stationary(...args);assert.equal(result.published,true);assert.equal(Object.keys(result).includes('published'),false);const after=E.snapshot(w),events=after.events.slice(before.events.length),committed=hashes(r);
  assert.throws(()=>call());assert.deepEqual(hashes(r),committed);assert.deepEqual(rays(),physical);
  const action=after.actions[index],key=[action.type,action.result?.kind,w.sensorModel,w.executionMode,...events.map(e=>e.kind)].join(':');if(!events.length||sequences.has(key))return result;sequences.add(key);
  restore();assert.deepEqual(E.snapshot(w),before);
  for(let position=1;position<=events.length;position++){
   let length=before.events.length;while(length<200000-position+1){const event=JSON.parse(r.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));r.control.observe(event.seq,r.ledger);length++}
   const padded=hashes(r);for(let retry=0;retry<2;retry++){assert.throws(()=>call(),/invalid world ledger input/);assert.deepEqual(hashes(r),padded);assert.deepEqual(rays(),physical);r.control.validateCommit(r.ledger);refusals++}
   restore();assert.deepEqual(E.snapshot(w),before);
  }
  const retried=original.stationary(...args);assert.deepEqual(retried,result);assert.deepEqual(E.snapshot(w),after);return retried;
 }finally{for(const p of Object.values(points))p.free()}
}
function bind(w,physics){const stores={physics};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources']]){let s=require('../server/rust-world-'+name).create(w);if(name==='actions'){const original=s;s={...s,get views(){return original.views},stationary(...args){return atomic(w,stores,original,args)}}}stores[name]=s;E[method](w,s);if(name==='ledger'){stores.control=s.control(w);E.bindWorldControl(w,stores.control)}if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}}return stores}
function pair(scene,options={},prepare=()=>{}){const a=E.create(42,'nearest',scene,{dispatchMode:'external',...options});prepare(a);const b=E.snapshot(a),physics=[a,b].map(w=>w.physicsMode==='rapier'?P.createPhysics(w):null);if(options.rays){E.bindRaySensors(a,physics[0]);E.bindRaySensors(b,physics[1])}const stores=bind(b,physics[1]);return {a,b,physics,stores,close(){E.disposeWorld(b);physics.forEach(p=>p?.free())}}}
function equal(v){assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a));for(const a of v.a.agents)assert.deepEqual(E.observe(v.b,a.id),E.observe(v.a,a.id));assert.deepEqual(E.coordinatorObservation(v.b),E.coordinatorObservation(v.a))}function step(v,n=1){for(let i=0;i<n;i++){E.step(v.a,v.physics[0]);E.step(v.b,v.physics[1]);equal(v);frames++}}function both(v,fn){const result=fn(v.b);assert.deepEqual(result,fn(v.a));assert(result.ok,JSON.stringify(result));equal(v);return result}
for(const rays of [false,true])for(const vision of ['visible','blocked','air-over','far','normal','exact-range'])for(const depleted of [false,true]){
 const scene=E.getScene();scene.obstacles=[];scene.resource.site=[24,20];if(['blocked','air-over'].includes(vision))scene.obstacles=[{id:'screen',x:21,y:19,w:1,h:2,height:3}];
 const v=pair(scene,{physicsMode:rays?'rapier':'kinematic',rays},w=>{Object.assign(w.agents[0],{x:20,y:20,mobility:vision==='air-over'?'air':'ground',sensorRange:vision==='far'?3:vision==='exact-range'?4:10,battery:depleted?6:50,workEnergyPerTick:depleted?5:.08});if(vision==='normal'){w.asset.condition='operational';Object.assign(w.part,{location:'consumed',position:null,carrierId:null,reservedBy:null})}});
 try{both(v,w=>E.submitAction(w,w.agents[0].id,{requestId:'scan',type:'scan',targetTick:1,expiresTick:100}));const action=v.b.actions[0],agent=v.b.agents[0];step(v,depleted?2:3);assert.equal(v.b.actions[0],action);assert.equal(v.b.agents[0],agent);assert.equal(action.status,depleted?'failed':'completed');if(!depleted)assert.equal(action.result.kind,['blocked','far'].includes(vision)?'not_detected':vision==='normal'?'normal':'anomaly');else assert.deepEqual(v.b.events.slice(-2).map(e=>e.kind),['action_failed','energy_depleted'])}finally{v.close()}
}
for(const mode of ['auto','agent','primitive'])for(const sensing of ['kinematic','geometry','ray']){
 const scene=E.getScene();scene.obstacles=[];const v=pair(scene,{executionMode:mode,physicsMode:sensing==='kinematic'?'kinematic':'rapier',rays:sensing==='ray'},w=>{for(const a of w.agents.slice(0,2))Object.assign(a,{x:w.chargingStation[0],y:w.chargingStation[1],battery:a===w.agents[0]?70:60})});
 try{if(mode!=='auto')both(v,w=>E.assign(w,'inspect',w.agents[0].id));for(const id of v.a.agents.slice(0,2).map(a=>a.id))both(v,w=>E.submitAction(w,id,{requestId:'charge',type:'charge',targetTick:1,expiresTick:100}));step(v,4);assert.equal(v.b.actions[0].phase,'charging');assert.equal(v.b.actions[1].phase,'waiting');assert.equal(v.b.agents[1].battery,60);step(v);assert.equal(v.b.actions[0].status,'completed');assert.equal(v.b.actions[1].phase,'charging');assert.equal(v.b.agents[1].battery,62);if(mode!=='auto'){assert.equal(v.b.agents[0].status,'assigned');assert.equal(v.b.agents[0].taskNeedsRoute,mode==='agent'?true:undefined)}step(v,9);assert.equal(v.b.actions[1].status,'completed')}finally{v.close()}
}
assert(sequences.size>=10);assert(sensorRefusals>100);console.log('Native stationary events: '+frames+' paired frames, '+sequences.size+' event sequences, '+refusals+' late ledger refusals and '+sensorRefusals+' wrong-sensor refusals; scan results/depletion order, owned mode/resumption, queue handover, exact native/physical preservation, scoped parity and identical successful retry passed');
