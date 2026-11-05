'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),C=require('./native-task-frame-support'),M=require('../src/materials'),{fixture}=require('./operating-power-support');
let cases=0;
for(const physicsMode of ['kinematic','rapier'])for(const mode of ['mixed','frames','whole'])for(const kind of ['pending','construction','cargo','charge-loss']){
 const w=E.create(42,'nearest',fixture(kind),{physicsMode,dispatchMode:'external'}),p=physicsMode==='rapier'?P.createPhysics(w):null;
 const s=C.bind(w,p,{batch:mode!=='mixed',actionBatch:mode!=='mixed',worldBatch:mode==='whole',worldProbe:(_w,_s,control,args)=>control.advanceWorldStep(...args)}),r=C.raw(s);
 try{
  const actor=w.agents.find(a=>a.operatingEnergyPerTick!==undefined);
  if(kind==='pending'){assert(E.injectLowEnergy(w,actor.id,1).ok);assert(E.submitAction(w,actor.id,{requestId:'future',type:'move',target:{x:50,y:50},targetTick:1,expiresTick:40}).ok)}
  if(kind==='construction'||kind==='cargo')assert(E.assign(w,w.tasks[0].id,actor.id).ok);
  if(kind==='charge-loss'){assert(E.injectLowEnergy(w,actor.id,5).ok);assert(E.submitAction(w,actor.id,{requestId:'charge',type:'charge',targetTick:1,expiresTick:40}).ok)}
  while(actor.battery>actor.operatingEnergyPerTick){assert(w.tick<30&&!w.done);E.step(w,p)}
  if(kind==='cargo')assert.equal(w.part.location,'carried');
  if(kind==='construction')assert.equal(M.metrics(w.materials)[0].reserved,1);
  const before=E.snapshot(w),hashes=C.hashes(s,p,w),method=mode==='whole'?'advanceWorldStep':'operating',original=s.control[method];let committed=false;
  s.control[method]=function(...args){original.apply(this,args);const nativeActor=JSON.parse(r.execution.snapshotExecution()).find(a=>a.id===actor.id);
   assert(nativeActor.disabled,'observe actual native depletion before throwing');assert.equal(nativeActor.operatingState.tick,before.tick+1);assert.equal(JSON.parse(r.execution.snapshot()).find(a=>a.id===actor.id).battery,0);
   assert(JSON.parse(r.ledger.snapshot()).events.some(e=>e.kind==='energy_depleted'&&e.agentId===actor.id&&e.source==='operating'));committed=true;throw Error('after actual operating energy commit');
  };
  assert.throws(()=>E.step(w,p),e=>e.worldTransactionFailure&&e.rollbackRestored);assert(committed);s.control[method]=original;
  assert.deepEqual(E.snapshot(w),before);assert.deepEqual(C.hashes(s,p,w),hashes);assert(!actor.disabled);
  E.step(w,p);assert(actor.disabled);assert.equal(actor.battery,0);assert.equal(actor.faultGeneration,0);assert.equal(w.faults,0);assert.equal(w.events.filter(e=>e.kind==='energy_depleted'&&e.agentId===actor.id&&e.source==='operating').length,1);
  assert(Math.abs(actor.operatingState.energySpent-(before.agents.find(a=>a.id===actor.id).operatingState.energySpent+before.agents.find(a=>a.id===actor.id).battery))<1e-9);
  if(kind==='construction'){assert.equal(M.metrics(w.materials)[0].reserved,0);assert.equal(M.metrics(w.materials)[0].consumed,0)}
  if(kind==='cargo'){assert.equal(w.part.location,'ground');assert.deepEqual(w.part.position,[actor.x,actor.y])}
  cases++;
 }finally{E.disposeWorld(w);p?.free()}
}
console.log(JSON.stringify({cases,actualNativeCommitObserved:true,allComponentAndColliderHashesRestored:true,retryDebitsAndTerminatesOnce:true}));
