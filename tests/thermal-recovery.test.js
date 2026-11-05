'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),{bind,hashes}=require('./native-task-frame-support');
function fixture(){const s=E.getScene('lunar-outpost-v1');s.id='thermal-recovery';s.obstacles=[];s.terrain=[];s.riskZones=[];s.agents=[{role:'worker',label:'Worker',count:1,mobility:'ground',capabilities:['inspect'],speed:3,workEnergyPerTick:1,thermal:{ambientC:-20,initialC:54,limitC:55,resumeC:30,coolingCPerTick:5,heatCPerEnergy:20}}];const a=E.create(42,'nearest',s).agents[0];s.tasks=[{id:'work',name:'Work',behavior:'survey',capability:'inspect',role:'worker',target:[a.x,a.y],duration:3,dependsOn:[]}];return s}
for(const physicsMode of ['kinematic','rapier']){
 const scene=fixture(),a=E.create(42,'nearest',scene),b=E.create(42,'nearest',scene),worlds=[a,b];for(const w of worlds)w.physicsMode=physicsMode;const ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);let inject=false;
 const stores=bind(b,ps[1],{batch:true,actionBatch:true,worldBatch:true,worldProbe(w,stores,control,args){const result=control.advanceWorldStep(...args);if(inject){inject=false;throw Error('thermal rollback after committed step')}return result}});
 try{
  for(let i=0;i<2;i++){E.step(a,ps[0]);E.step(b,ps[1]);assert.deepEqual(E.snapshot(b),E.snapshot(a))}assert.equal(b.tasks[0].status,'active');assert.equal(b.agents[0].work,0);assert.equal(b.agents[0].battery,b.agents[0].initialBattery);assert(b.agents[0].thermalState.protected);assert.equal(b.events.filter(e=>e.kind==='thermal_protection_entered').length,1);const assigned=b.tasks[0].assignmentId;
  const before=E.snapshot(b),nativeBefore=hashes(stores,ps[1],b);inject=true;assert.throws(()=>E.step(b,ps[1]),e=>e.rollbackRestored&&e.cause?.message==='thermal rollback after committed step');assert.deepEqual(E.snapshot(b),before);assert.deepEqual(hashes(stores,ps[1],b),nativeBefore);
  while(!a.done&&a.tick<30){E.step(a,ps[0]);E.step(b,ps[1]);assert.deepEqual(E.snapshot(b),E.snapshot(a));assert.equal(b.tasks[0].assignmentId,assigned)}assert(b.done&&!b.failed);assert.equal(b.tasks[0].status,'done');assert.equal(b.events.filter(e=>e.kind==='thermal_protection_entered').length,3);assert.equal(b.events.filter(e=>e.kind==='thermal_protection_cleared').length,3);assert.equal(E.metrics(b).thermal.limitViolations,0);assert.equal(E.metrics(b).thermal.trips,3);
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
// Refuse after native work enqueues a private protection fact, before flushing it.
{
 const scene=fixture(),a=E.create(42,'nearest',scene),b=E.snapshot(a),stores=bind(b,null,{batch:false,actionBatch:false,worldBatch:false,worldProbe(){throw Error('unused whole-world path')}}),finish=stores.execution.finishThermals;let refuse=false;
 stores.execution.finishThermals=function(tick){if(refuse){refuse=false;throw Error('before thermal flush')}return finish(tick)};
 try{E.step(a);E.step(b);const before=E.snapshot(b);refuse=true;assert.throws(()=>E.step(b),e=>e.rollbackRestored&&e.cause?.message==='before thermal flush');assert.deepEqual(E.snapshot(b),before);E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a));assert.equal(b.events.filter(e=>e.kind==='thermal_protection_entered').length,1)}finally{E.disposeWorld(a);E.disposeWorld(b)}
}
// A rollback before end-of-tick flushing must discard JS-derived pending facts.
{
 const scene=fixture(),w=E.create(42,'nearest',scene,{dispatchMode:'external'}),reference=E.snapshot(w),Tx=require('../server/world-transaction'),dummy={checkpoint(){return {free(){}}},rollback(){}};const tx=Tx.create(w,[dummy],E.snapshot,E.restoreHostState);E.bindWorldTransaction(w,tx);
 assert(E.submitAction(w,w.agents[0].id,{requestId:'scan',type:'scan',targetTick:1,expiresTick:30}).ok);const before=E.snapshot(w);assert.throws(()=>tx.run(()=>{E.step(w);throw Error('abort thermal tick')}),e=>e.rollbackRestored);assert.deepEqual(E.snapshot(w),before);E.step(w);assert.equal(w.events.filter(e=>e.kind==='thermal_protection_entered').length,1);E.disposeWorld(w);
}
for(const id of ['lunar-outpost-v1','industrial-park-v1']){const w=E.create(42,'nearest',E.getScene(id));assert(w.agents.every(a=>!Object.hasOwn(a,'thermal')&&!Object.hasOwn(a,'thermalState')));assert(!Object.hasOwn(E.metrics(w),'thermal'))}
console.log('Thermal task recovery: headroom waits preserve assignments, native late-failure rollback restores every participant, retry emits facts once, JS pending facts clear on rollback, optional metrics and legacy absence passed');
