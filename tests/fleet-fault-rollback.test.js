'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),C=require('./native-task-frame-support'),M=require('../src/materials'),{fixture,faultInput}=require('./fleet-fault-support');
function sceneFor(kind){
 if(kind==='construction'){const s=require('./construction-support').fixture();s.agents[0].recoverableFault=true;return s}
 if(kind==='cargo'){const s=E.getScene('lunar-outpost-v1');s.obstacles=[];s.terrain=[];s.agents.find(a=>a.role==='vehicle').recoverableFault=true;const task=s.tasks.find(t=>t.behavior==='deliver'),probe=E.create(42,'nearest',s),a=probe.agents.find(a=>a.role==='vehicle');s.tasks=[{...task,target:[a.x+30,a.y],dependsOn:[],duration:4}];s.resource.warehouse=[a.x,a.y];s.resource.site=s.tasks[0].target.slice();return s}
 return fixture();
}
for(const physicsMode of ['kinematic','rapier'])for(const kind of ['idle','resident','construction','cargo'])for(const failureAt of ['ledger','control']){
 const w=E.create(42,'nearest',sceneFor(kind),{physicsMode,dispatchMode:'external'}),p=physicsMode==='rapier'?P.createPhysics(w):null,s=C.bind(w,p,{batch:true,actionBatch:true,worldBatch:true}),r=C.raw(s);let target;
 try{
  if(kind==='idle')target=w.agents.find(a=>a.id==='endpoint-1');
  if(kind==='resident'){assert(E.assign(w,'deploy','relay-1').ok);for(let i=0;i<100&&w.tasks[0].status!=='done';i++)E.step(w,p);assert.equal(w.tasks[0].status,'done');target=w.agents.find(a=>a.id==='relay-1');assert(target.relayState.deployed);assert.equal(M.metrics(w.materials)[0].consumed,1)}
  if(kind==='construction'){target=w.agents.find(a=>a.id==='builder-1');assert(E.assign(w,'build-shed',target.id).ok);assert.equal(M.metrics(w.materials)[0].reserved,1)}
  if(kind==='cargo'){target=w.agents.find(a=>a.role==='vehicle');assert(E.assign(w,w.tasks[0].id,target.id).ok);for(let i=0;i<40&&w.part.location!=='carried';i++)E.step(w,p);assert.equal(w.part.location,'carried')}
  const before=E.snapshot(w),hashes=C.hashes(s,p,w),generation=target.faultGeneration,method=failureAt==='ledger'?'append':'observe',object=r[failureAt],original=object[method];let committed=false;
  object[method]=function(...args){const out=original.apply(this,args);const events=JSON.parse(r.ledger.snapshot()).events;const fault=events?.at(-1);if(fault?.kind==='device_fault'){
   const live=JSON.parse(r.execution.snapshotExecution()).find(a=>a.id===target.id);assert(live.disabled);assert.equal(live.faultGeneration,generation+1);
   if(failureAt==='control')assert.equal(JSON.parse(r.control.snapshot()).faults,before.faults+1);
   committed=true;throw Error('after actual '+failureAt+' fault commit');
  }return out};
  assert.throws(()=>E.injectFault(w,faultInput(w,target.id)),e=>e.worldTransactionFailure&&e.rollbackRestored);assert(committed,'failure must occur after actual native mutation');delete object[method];assert.deepEqual(E.snapshot(w),before);assert.deepEqual(C.hashes(s,p,w),hashes);assert(!target.disabled);
  assert(E.injectFault(w,faultInput(w,target.id)).ok);assert(target.disabled);assert.equal(target.faultGeneration,generation+1);assert.equal(w.events.filter(e=>e.kind==='device_fault').length,1);
  if(kind==='cargo'){assert.equal(w.part.location,'ground');assert.deepEqual(w.part.position,[target.x,target.y])}
  if(kind==='construction')assert.equal(M.metrics(w.materials)[0].reserved,0);
  if(kind==='resident'){assert.equal(target.status,'fault');assert.deepEqual(target.relayState,before.agents.find(a=>a.id===target.id).relayState);assert.equal(M.metrics(w.materials)[0].consumed,1)}
  console.log(JSON.stringify({physicsMode,kind,failureAt,actualCommitObserved:true,allComponentAndColliderHashesRestored:true,retryFaultOnce:true}));
 }finally{E.disposeWorld(w);p?.free()}
}
