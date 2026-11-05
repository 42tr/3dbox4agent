'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),P=require('../server/rust-physics');let frames=0,calls=0;const outcomes={};
function bind(w,hook){const stores={};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources'],['peer','bindWorldPeer'],['reports','bindWorldReports'],['dispatch','bindWorldDispatch'],['requests','bindWorldRequests']]){const s=require('../server/rust-world-'+name).create(w);stores[name]=s;E[method](w,s);if(name==='ledger'){const c=s.control(w);stores.control=c;E.bindWorldControl(w,{...c,settleTick(...args){hook?.(w,stores);const result=c.settleTick(...args);calls++;outcomes[result]=(outcomes[result]||0)+1;return result}})}if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}}return stores}
function pair(scene=E.getScene(),options={},prepare=()=>{},hook){const a=E.create(42,'nearest',scene,{dispatchMode:'external',...options});prepare(a);const b=E.snapshot(a),physics=[a,b].map(w=>w.physicsMode==='rapier'?P.createPhysics(w):null),stores=bind(b,hook);return {a,b,stores,physics,close(){E.disposeWorld(b);physics.forEach(p=>p?.free())}}}
function equal(v){assert.deepEqual(E.snapshot(v.b),E.snapshot(v.a));assert.deepEqual(E.coordinatorObservation(v.b),E.coordinatorObservation(v.a));for(const a of v.a.agents)assert.deepEqual(E.observe(v.b,a.id),E.observe(v.a,a.id))}
function both(v,fn){const b=fn(v.b),a=fn(v.a);assert.deepEqual(b,a);equal(v);return b}
function step(v,n=1){for(let i=0;i<n&&!v.a.done;i++){E.step(v.a,v.physics[0]);E.step(v.b,v.physics[1]);equal(v);frames++}}
function simple(mobility='air'){const s=E.getScene();s.obstacles=[];s.terrain=[];s.agents=[{...s.agents[0],count:1,mobility}];s.tasks=[{...s.tasks[0],target:[48,50],dependsOn:[]}];return s}
for(const id of ['industrial-park-v1','industrial-park-parallel-v1','industrial-park-fixed-sensor-v1','lunar-outpost-v1','lunar-sampling-v1','shore-coordination-v1'])for(const physicsMode of ['kinematic','rapier']){
 const v=pair(E.getScene(id),{physicsMode,dispatchMode:'rule'});try{step(v,600);assert(v.b.done&&!v.b.failed,id)}finally{v.close()}
}
for(const dispatchMode of ['rule','external','networked','networked_external','networked_reported'])for(const executionMode of ['auto','agent','primitive']){
 const v=pair(simple(),{dispatchMode,executionMode});try{both(v,w=>E.submitAction(w,w.agents[0].id,{requestId:'future',type:'scan',targetTick:8,expiresTick:30}));step(v,12);if(!v.a.done){both(v,w=>E.setDispatchMode(w,'rule'));if(executionMode==='auto')step(v,300);else {const t=v.a.tasks[0];if(t.status==='active')both(v,w=>E.submitAction(w,w.agents[0].id,{requestId:'task',taskId:t.id,type:executionMode==='agent'?'execute_task':'work_task',targetTick:w.tick+1,expiresTick:w.tick+200}));step(v,200)}}assert(!v.b.failed)}finally{v.close()}
}
// Native ending uses actual component state and navigation, not caller-supplied
// termination summaries or a replaced host planner.
{
 const v=pair(simple());try{E.bindTaskRules(v.b,{...require('../server/rust-task-rules'),termination(){throw Error('host summary must not classify native world')}});E.bindNavigation(v.b,{plan(){throw Error('host planner must not classify native world')}});step(v,3);assert(!v.b.done)}finally{v.close()}
}
for(const mobility of ['air','ground'])for(const navigation of ['distance','time','energy'])for(const battery of [0,1,5]){
 const s=simple(mobility);s.navigation=navigation;const v=pair(s,{},w=>{Object.assign(w.agents[0],{x:20,y:30,battery})});try{step(v,3);if(battery===0)assert(v.b.failed);else if(!v.b.failed){assert(v.b.chargeRecovery);both(v,w=>E.submitAction(w,w.agents[0].id,{requestId:'charge',type:'charge',targetTick:w.tick+1,expiresTick:w.tick+80}));step(v,40);assert(!v.b.chargeRecovery)}}finally{v.close()}
}
// Strict energy threshold, measured using the existing public segment integral.
for(const delta of [0,1e-9,2e-9]){
 const s=simple(),cost=40*.045;s.resource.warehouse=[20,20];const v=pair(s,{},w=>{Object.assign(w.agents[0],{x:60,y:20,battery:cost+delta})});try{step(v);assert.equal(!!v.b.chargeRecovery,delta>1e-9);assert.equal(v.b.failed,delta<=1e-9)}finally{v.close()}
}
{
 const s=simple('ground');s.terrain=[{id:'soft',name:'软地',x:15,y:15,w:30,h:30,speedFactor:1,energyFactor:2}];s.resource.warehouse=[20,20];const v=pair(s,{},w=>{Object.assign(w.agents[0],{x:40,y:20,battery:2})});try{both(v,w=>E.injectTerrainEffect(w,'soft',3,.5,5));step(v,4);assert(v.b.chargeRecovery&&!v.b.done);assert.equal(v.b.terrainEffects.length,0)}finally{v.close()}
}
{
 const v=pair(simple(),{},w=>{w.agents[0].disabled=true;w.agents[0].status='fault'});try{both(v,w=>E.injectRoadblock(w,{x:0,y:0,w:2,h:2},2));step(v,2);assert(!v.b.done);step(v);assert(v.b.done&&v.b.failed)}finally{v.close()}
}
for(const behavior of ['deliver','repair','verify']){
 const s=E.getScene();s.obstacles=[];s.tasks=[{...s.tasks.find(t=>t.behavior===behavior),dependsOn:[]}];const v=pair(s,{},w=>{if(behavior==='deliver')Object.assign(w.part,{location:'site',position:w.part.site.slice()})});try{step(v);assert(v.b.failed);const e=v.b.events.find(e=>e.kind==='run_failed');assert.equal(e.taskId,s.tasks[0].id);assert.equal(e.reason,behavior==='repair'?'anomaly_unconfirmed':behavior==='verify'?'repair_required':'part_unavailable')}finally{v.close()}
}
const keys=['control','ledger','execution','environment','tasks','actions','resources'];function raw(stores){return Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native]))}const args=r=>[r.execution,r.environment,r.tasks,r.actions,r.resources,r.ledger];function hash(r){return keys.map(k=>crypto.createHash('sha256').update(k==='execution'?r[k].snapshot()+r[k].snapshotExecution():r[k].snapshot()).digest('hex'))}
{
 const v=pair(simple(),{dispatchMode:'rule'},w=>{while(!w.done)E.step(w)});try{const r=raw(v.stores),before=hash(r);assert.equal(r.control.settleTick(v.b.tick,...args(r)),'already_done');assert.deepEqual(hash(r),before);assert.throws(()=>r.control.settleTick(v.b.tick,...args(r)));assert.deepEqual(hash(r),before)}finally{v.close()}
}
{
 let checked=false;const v=pair(simple(),{},()=>{},(w,stores)=>{if(w.tick!==2)return;const r=raw(stores),before=hash(r);for(const tick of [0,1,3,NaN]){assert.throws(()=>r.control.settleTick(tick,...args(r)));assert.deepEqual(hash(r),before)}const foreign=require('../server/rust-world-actions').create(w);assert.throws(()=>r.control.settleTick(w.tick,...args({...r,actions:C.reference(foreign,'actions').native})));assert.deepEqual(hash(r),before);foreign.free();const cp=r.control.checkpoint(),lp=r.ledger.checkpoint();r.ledger.append(JSON.stringify({message:'unobserved prefix',type:'info',kind:'fixture'}));const stale=hash(r);assert.throws(()=>r.control.settleTick(w.tick,...args(r)));assert.deepEqual(hash(r),stale);r.ledger.rollback(lp);const peer=C.reference(stores.peer,'peer').native,time=r.control.beginTime(w.tick,r.execution,r.environment,r.tasks,peer,r.ledger);assert.throws(()=>r.control.settleTick(w.tick+1,...args(r)));r.control.abortTime(time,r.execution,r.environment,r.tasks,peer,r.ledger);time.free();assert.deepEqual(hash(r),before);assert.equal(r.control.settleTick(w.tick,...args(r)),'continue');const committed=hash(r);assert.throws(()=>r.control.settleTick(w.tick,...args(r)));assert.deepEqual(hash(r),committed);r.control.rollback(cp);r.ledger.rollback(lp);assert.deepEqual(hash(r),before);cp.free();lp.free();checked=true});try{step(v,3);assert(checked)}finally{v.close()}
}
// Terminal state and both its result event and charge-wait exit remain private
// until the final append succeeds. Exact retries must reach the same late error.
for(const kind of ['completed','failed','wait_charge','failed_wait_end']){
 const s=simple(),v=pair(s,{},w=>{if(kind==='failed_wait_end')w.agents[0].battery=5;if(kind==='completed'){E.setDispatchMode(w,'rule');while(!w.done)E.step(w);w.done=false;w.failed=false}else{E.step(w);if(kind==='wait_charge')w.agents[0].battery=5;else{w.agents[0].battery=0;w.agents[0].disabled=true;w.agents[0].status='fault'}}while(w.events.length<(kind==='failed_wait_end'?199999:200000))w.events.push({seq:w.events.length+1,tick:w.tick,message:'capacity',type:'info',kind:'fixture'})});try{const r=raw(v.stores),before=hash(r);for(let n=0;n<2;n++){assert.throws(()=>r.control.settleTick(v.b.tick,...args(r)),/invalid world ledger input/);assert.deepEqual(hash(r),before);r.control.validateCommit(r.ledger)}}finally{v.close()}
}
assert(calls>100);for(const kind of ['continue','completed','failed','wait_charge','wait_roadblock'])assert(outcomes[kind]>0,kind);console.log('Native ending: '+frames+' paired frames, '+JSON.stringify(outcomes)+'; actual owned graph/actors/actions/resources/navigation, exact energy/future-terrain recovery, result and wait events, foreign/stale/duplicate/checkpoint fencing and repeated late terminal-event atomic refusal passed');
