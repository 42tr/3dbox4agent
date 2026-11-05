'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),Actions=require('../server/rust-world-actions');
const originalCreate=Actions.create,keys=['environment','ledger','control','execution','tasks','actions','resources'],sequences=new Set();let refusals=0,phases=0;
function hash(raw){return keys.map(k=>crypto.createHash('sha256').update(k==='execution'?raw[k].snapshot()+raw[k].snapshotExecution():raw[k].snapshot()).digest('hex'))}
function atomic(w,store,kind,index,args){
 const [execution,environment,resources,tasks,control,ledger,now]=args,stores={execution,environment,resources,tasks,control,ledger,actions:store},raw=Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native])),points=Object.fromEntries(keys.map(k=>[k,stores[k].checkpoint()])),before=E.snapshot(w);
 const restore=()=>{for(const k of [...keys].reverse())stores[k].rollback(points[k])};
 const call=(tick=now)=>{const values=[raw.execution,raw.environment,raw.resources,raw.tasks,raw.control,raw.ledger];return kind==='cancel'?raw.actions.cancelIntentEvents(index,tick,...values):kind==='travel'?raw.actions.settleTravelEvents(index,tick,...values):raw.actions.cancelRunEvents(tick,...values)};
 try{
  const unchanged=hash(raw);for(const tick of [-1,now+.5,now+1,4294967296+now,NaN,Infinity]){assert.throws(()=>call(tick));assert.deepEqual(hash(raw),unchanged)}
  const result=store.lifecycle(kind,index,...args);assert.equal(result.published,true);assert.equal(Object.keys(result).includes('published'),false);const after=E.snapshot(w),events=after.events.slice(before.events.length),committed=hash(raw);phases++;
  if(kind==='cancel'&&result.ok&&!result.duplicate){assert.equal(JSON.parse(call()).duplicate,true);assert.deepEqual(hash(raw),committed)}
  if(kind==='run'){assert.deepEqual(JSON.parse(call()),[]);assert.deepEqual(hash(raw),committed)}
  if(kind==='travel'&&after.actions[index].status!=='accepted'){assert.throws(()=>call());assert.deepEqual(hash(raw),committed)}
  const action=before.actions[index],key=[kind,action?.type,action?.status,w.executionMode,...events.map(e=>e.kind)].join(':');if(!events.length||sequences.has(key))return result;sequences.add(key);restore();assert.deepEqual(E.snapshot(w),before);
  for(let position=1;position<=events.length;position++){
   let length=before.events.length;while(length<200000-position+1){const event=JSON.parse(raw.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));raw.control.observe(event.seq,raw.ledger);length++}
   const padded=hash(raw);for(let retry=0;retry<2;retry++){assert.throws(()=>call(),/invalid world ledger input/);assert.deepEqual(hash(raw),padded);raw.control.validateCommit(raw.ledger);refusals++}
   restore();assert.deepEqual(E.snapshot(w),before);
  }
  const retried=store.lifecycle(kind,index,...args);assert.deepEqual(retried,result);assert.deepEqual(E.snapshot(w),after);return retried;
 }finally{for(const point of Object.values(points))point.free()}
}
Actions.create=w=>{const store=originalCreate(w);return {...store,get views(){return store.views},lifecycle(kind,index,...args){return atomic(w,store,kind,index,args)}}};
try{require('./rust-world-lifecycle.test.js');
 // Cancel a real action-owned road wait. Refusing its second append must not
 // retain the earlier wait-ended event or clear the native wait/route owner.
 {const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];scene.terrain=[];const a=E.create(42,'nearest',scene,{dispatchMode:'external'}),b=E.snapshot(a);for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources']]){const store=require('../server/rust-world-'+name).create(b);E[method](b,store);if(name==='ledger')E.bindWorldControl(b,store.control(b));if(name==='motion')E.bindWorldExecution(b,store.execution(b))}try{const id=a.agents[0].id;for(const w of [a,b]){assert(E.injectRoadblock(w,{x:55,y:0,w:4,h:100},100).ok);assert(E.submitAction(w,id,{requestId:'wait-cancel',type:'move',target:{x:80,y:28},targetTick:1,expiresTick:100}).ok);E.step(w)}assert.deepEqual(E.snapshot(b),E.snapshot(a));assert(b.agents[0].roadblockWait);for(const w of [b,a])assert(E.cancelAction(w,id,'wait-cancel').ok);assert.deepEqual(E.snapshot(b),E.snapshot(a));assert.deepEqual(b.events.slice(-2).map(e=>e.kind),['roadblock_wait_ended','action_cancelled']);assert(!b.agents[0].roadblockWait);assert.deepEqual(E.observe(b,id),E.observe(a,id))}finally{E.disposeWorld(b)}}
 assert(phases>100);assert(sequences.size>=20);assert(refusals>=40);console.log('Native lifecycle events: '+phases+' real native phases, '+sequences.size+' event sequences and '+refusals+' late ledger refusals; five-type pending/accepted cancellation, ordinary/duplicate/done-world outcomes, movement/charge settlement, cargo/requeue order and counters, bulk run/wait cleanup, strict clocks, exact native restoration and identical retry passed')}finally{Actions.create=originalCreate}
