'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics');
const {bind,raw,hashes,order}=require('./native-task-frame-support');
let refusals=0,sequences=0,guardChecks=0;const observed=[];
function fixture(){const s=E.getScene('lunar-outpost-v1');s.obstacles=[];s.terrain=[];s.riskZones=[];s.agents=[{role:'worker',label:'Worker',count:2,mobility:'ground',capabilities:['inspect'],speed:3}];const a=E.create(42,'nearest',s).agents;s.tasks=a.map((a,i)=>({id:'task-'+i,name:'Task '+i,behavior:'survey',role:'worker',capability:'inspect',target:[a.x,a.y],duration:1,dependsOn:[],deadline:1}));Object.assign(s.communication,{range:1000,delay:1,lossRate:0});return s}
for(const physicsMode of ['kinematic','rapier']){
 const scene=fixture(),w=E.create(42,'nearest',scene,{dispatchMode:'external',executionMode:'auto',physicsMode}),p=physicsMode==='rapier'?P.createPhysics(w):null;let done=false;
 const stores=bind(w,p,{actionBatch:true,worldBatch:true,worldProbe(world,s,control,args){
  if(done||w.tick===0)return control.advanceWorldStep(...args);done=true;
  const r=raw(s),keys=[...order,'control'],points=Object.fromEntries(keys.map(k=>[k,s[k].checkpoint()])),point=p?.checkpoint(),before=E.snapshot(w),originalHash=hashes(s,p,w),oldTick=w.tick;
  const restore=()=>{for(const k of keys.slice().reverse())s[k].rollback(points[k]);if(point)p.rollback(point)};
  const call=(tick=oldTick,refs=r,physical=p)=>physical?physical.advanceWorldStep(refs.control,tick,...order.map(k=>refs[k])):refs.control.advanceWorldStep(tick,...order.map(k=>refs[k]));
  try{
   for(const tick of [NaN,Infinity,-1,oldTick+.5,oldTick+1,4294967296+oldTick]){assert.throws(()=>call(tick));assert.deepEqual(hashes(s,p,w),originalHash);guardChecks++}
   const other=E.create(42,'nearest',scene,{dispatchMode:'external',physicsMode}),op=physicsMode==='rapier'?P.createPhysics(other):null,os=bind(other,op,{actionBatch:true,worldBatch:true}),foreign=raw(os);
   try{for(const key of [...order,'control']){const changed={...r,[key]:foreign[key]};assert.throws(()=>call(oldTick,changed));assert.deepEqual(hashes(s,p,w),originalHash);guardChecks++}if(op){assert.throws(()=>call(oldTick,r,op));assert.deepEqual(hashes(s,p,w),originalHash);guardChecks++}}finally{E.disposeWorld(other);op?.free()}
   if(p){p.syncRoadblocks([{id:'foreign-shape',x:0,y:0,w:1,h:1,height:2}]);const changed=hashes(s,p,w);assert.throws(()=>call());assert.deepEqual(hashes(s,p,w),changed);p.rollback(point);guardChecks++}
   control.advanceWorldStep(...args);const after=E.snapshot(w),newEvents=after.events.slice(before.events.length);assert.equal(after.tick,oldTick+1);assert(newEvents.some(e=>e.kind==='message_delivered'));assert.equal(newEvents.filter(e=>e.kind==='deadline_missed').length,2);assert.equal(newEvents.filter(e=>e.kind==='action_completed').length,2);
   const committed=hashes(s,p,w);assert.throws(()=>call());assert.deepEqual(hashes(s,p,w),committed);guardChecks++;
   if(p)p.bindWorldStep(r.control,...order.map(k=>r[k]));else r.control.bindWorldStep(...order.map(k=>r[k]));assert.throws(()=>call());assert.deepEqual(hashes(s,p,w),committed);guardChecks++;
   if(p){assert.throws(()=>r.control.advanceWorldStep(w.tick,...order.map(k=>r[k])))}else{const wrong=P.createPhysics(w);try{assert.throws(()=>call(w.tick,r,wrong))}finally{wrong.free()}}assert.deepEqual(hashes(s,p,w),committed);guardChecks++;
   restore();assert.deepEqual(E.snapshot(w),before);
   // Refuse in time/message/action phases, after prior phases already modified
   // private stores. Every actual participant and physical query must stay put.
   const positions=[1,newEvents.findIndex(e=>e.kind==='message_delivered')+1,newEvents.length];assert.equal(new Set(positions).size,3);
   for(const position of positions){let length=before.events.length;while(length<200000-position+1){const e=JSON.parse(r.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));r.control.observe(e.seq,r.ledger);length++}const padded=hashes(s,p,w);for(let retry=0;retry<2;retry++){assert.throws(()=>call(),/invalid world ledger input/);assert.deepEqual(hashes(s,p,w),padded);r.control.validateCommit(r.ledger);refusals++}restore();assert.deepEqual(E.snapshot(w),before)}
   control.advanceWorldStep(...args);assert.deepEqual(E.snapshot(w),after);observed.push({physicsMode,events:newEvents.map(e=>e.kind)});sequences++;
  }finally{for(const point of Object.values(points))point.free();point?.free()}
 }});
 try{E.step(w,p);const positions=w.agents.map(a=>[a.x,a.y]);assert(E.sendMessage(w,w.agents[0].id,w.agents[1].id,'native tick atomic delivery',[],'message').ok);for(let i=0;i<2;i++)assert(E.submitAction(w,w.agents[i].id,{requestId:'move-'+i,type:'move',target:{x:positions[i][0]+1,y:positions[i][1]},targetTick:w.tick+1,expiresTick:10}).ok);E.step(w,p);assert(!w.done&&!w.failed);assert(w.tasks.every(t=>t.status==='pending'));assert(w.actions.every(a=>a.status==='completed'));assert(w.agents.every((a,i)=>a.activity.manual===1&&Math.abs(a.x-positions[i][0]-1)<1e-6));const r=raw(stores);E.disposeWorld(w);assert.throws(()=>r.control.advanceWorldStep(w.tick,...order.map(k=>r[k])))}finally{E.disposeWorld(w);p?.free()}
}
assert.equal(sequences,2);assert.equal(refusals,12);console.log(JSON.stringify({sequences,refusals,guardChecks,observed}));console.log('Native complete-tick atomicity: time, peer delivery and two physical moves; foreign participants/clock/physics/map/duplicate/closed guards;12 late ledger refusals preserve every native participant, private clock lease and actual colliders; checkpoint retries match exact successful frames');
