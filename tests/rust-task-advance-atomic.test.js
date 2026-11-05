'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics');
const {bind,raw,hashes,order}=require('./native-task-frame-support');
let refusals=0,sequences=0,guardChecks=0;const observed=[];
function fixture(){const s=E.getScene('lunar-outpost-v1');s.obstacles=[];s.terrain=[];s.riskZones=[];s.agents=[{role:'worker',label:'Worker',count:2,mobility:'ground',capabilities:['inspect'],speed:3}];const a=E.create(42,'nearest',s).agents;s.tasks=a.map((a,i)=>({id:'task-'+i,name:'Task '+i,behavior:'survey',role:'worker',capability:'inspect',target:[a.x,a.y],duration:1,dependsOn:[]}));s.communication.lossRate=0;return s}
for(const physicsMode of ['kinematic','rapier']){
 const scene=fixture(),w=E.create(42,'nearest',scene,{dispatchMode:'external',executionMode:'primitive',physicsMode}),p=physicsMode==='rapier'?P.createPhysics(w):null;
 let done=false;
 const stores=bind(w,p,{probe(world,s,control,args){
  if(done)return control.advanceWorkingTasks(...args);done=true;
  const r=raw(s),keys=[...order,'control'],points=Object.fromEntries(keys.map(k=>[k,s[k].checkpoint()])),point=p?.checkpoint(),before=E.snapshot(w),originalHash=hashes(s,p,w);
  const restore=()=>{for(const k of keys.slice().reverse())s[k].rollback(points[k]);if(point)p.rollback(point)};
  const call=(tick=w.tick,refs=r,physical=p)=>physical?physical.advanceWorkingTasks(refs.control,tick,...order.map(k=>refs[k])):refs.control.advanceWorkingTasks(tick,...order.map(k=>refs[k]));
  try{
   for(const tick of [NaN,Infinity,-1,0,w.tick+.5,w.tick+1,4294967296+w.tick]){assert.throws(()=>call(tick));assert.deepEqual(hashes(s,p,w),originalHash);guardChecks++}
   const other=E.create(42,'nearest',scene,{dispatchMode:'external',physicsMode}),op=physicsMode==='rapier'?P.createPhysics(other):null,os=bind(other,op),foreign=raw(os);
   try{for(const key of [...order,'control']){const changed={...r,[key]:foreign[key]};assert.throws(()=>call(w.tick,changed));assert.deepEqual(hashes(s,p,w),originalHash);guardChecks++}if(op){assert.throws(()=>call(w.tick,r,op));assert.deepEqual(hashes(s,p,w),originalHash);guardChecks++}}finally{E.disposeWorld(other);op?.free()}
   if(p){p.syncRoadblocks([{id:'foreign-shape',x:0,y:0,w:1,h:1,height:2}]);const changed=hashes(s,p,w);assert.throws(()=>call());assert.deepEqual(hashes(s,p,w),changed);p.rollback(point);guardChecks++}
   control.advanceWorkingTasks(...args);const after=E.snapshot(w),newEvents=after.events.slice(before.events.length);assert.deepEqual(newEvents.map(e=>e.kind),['task_work_started','action_completed','task_completed','task_work_started','action_completed','task_completed']);
   const committed=hashes(s,p,w);assert.throws(()=>call());assert.deepEqual(hashes(s,p,w),committed);guardChecks++;
   restore();assert.deepEqual(E.snapshot(w),before);
   // Refuse after task A completed, then after task B's start. Neither the
   // earlier task nor the device activity sample may escape the outer batch.
   for(const position of [4,6]){
    let length=before.events.length;while(length<200000-position+1){const e=JSON.parse(r.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));r.control.observe(e.seq,r.ledger);length++}
    const padded=hashes(s,p,w);for(let retry=0;retry<2;retry++){assert.throws(()=>call(),/invalid world ledger input/);assert.deepEqual(hashes(s,p,w),padded);r.control.validateCommit(r.ledger);refusals++}
    restore();assert.deepEqual(E.snapshot(w),before);
   }
   control.advanceWorkingTasks(...args);assert.deepEqual(E.snapshot(w),after);observed.push({physicsMode,events:newEvents.map(e=>e.kind)});sequences++;
  }finally{for(const point of Object.values(points))point.free();point?.free()}
 }});
 try{for(let i=0;i<2;i++){assert(E.assign(w,'task-'+i,w.agents[i].id).ok);assert(E.submitAction(w,w.agents[i].id,{requestId:'work-'+i,type:'work_task',taskId:'task-'+i,targetTick:1,expiresTick:10}).ok)}E.step(w,p);assert(w.done&&!w.failed);assert(w.tasks.every(t=>t.status==='done'));assert(w.agents.every(a=>a.activity.task===1));const r=raw(stores);E.disposeWorld(w);assert.throws(()=>r.control.advanceWorkingTasks(w.tick,...order.map(k=>r[k])))}finally{E.disposeWorld(w);p?.free()}
}
assert.equal(sequences,2);assert.equal(refusals,8);console.log(JSON.stringify({sequences,refusals,guardChecks,observed}));console.log('Native task-frame atomicity: full activity/two-task batch, actual collider/map identity and foreign/clock/duplicate/closed guards; eight late ledger refusals preserve every native/physical query and private frame lease, checkpoint restores yield identical successful retry passed');
