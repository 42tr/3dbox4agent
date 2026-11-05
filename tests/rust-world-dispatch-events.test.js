'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),Physics=require('../server/rust-physics'),Replay=require('../src/replay');
const keys=['dispatch','execution','environment','tasks','resources','actions','peer','reports','control','ledger'],sequences=new Set();let operations=0,frames=0,refusals=0;
function hashes(raw,physics,w){const result=keys.map(k=>crypto.createHash('sha256').update(k==='execution'?raw[k].snapshot()+raw[k].snapshotExecution():raw[k].snapshot()).digest('hex'));if(physics)result.push(crypto.createHash('sha256').update(JSON.stringify(w.agents.map(a=>physics.lidar(a,1.5,8,100)))).digest('hex'));return result}
function atomic(w,store,method,args,context,physics){
 const stores={...context,dispatch:store},raw=Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native])),refs=keys.slice(1).map(k=>raw[k]),points=Object.fromEntries(keys.map(k=>[k,stores[k].checkpoint()])),before=E.snapshot(w);
 const restore=()=>{for(const k of [...keys].reverse())stores[k].rollback(points[k])};
 const native=t=>method==='readyEvents'?raw.dispatch.readyEvents(t,...refs):method==='settleEvents'?raw.dispatch.settleEvents(args[0],t,...refs):method==='cancelEvents'?raw.dispatch.cancelEvents(args[0],t,...refs):raw.dispatch[method](JSON.stringify(args[0]),t,...refs);
 try{
  const result=store[method](...args),after=E.snapshot(w),events=after.events.slice(before.events.length);operations++;assert.equal(result.published,true);assert(!Object.keys(result).includes('published'));assert(!Object.keys(result).includes('assigned'));
  const d=result.decision,key=[method,w.dispatchMode,w.executionMode,physics?'rapier':'kinematic',d?.status||'',d?.reason||result.reason||'',...events.map(e=>e.kind+':'+(e.reason||''))].join('|');if(sequences.has(key))return result;sequences.add(key);restore();const initial=hashes(raw,physics,w);
  for(const tick of [-1,w.tick+.5,w.tick+1,4294967296+w.tick,NaN,Infinity]){assert.throws(()=>native(tick));assert.deepEqual(hashes(raw,physics,w),initial)}
  raw.ledger.append(JSON.stringify({message:'unobserved',type:'info'}));assert.throws(()=>native(w.tick));restore();assert.deepEqual(hashes(raw,physics,w),initial);
  for(let at=1;at<=events.length;at++){
   for(let n=before.events.length;n<200000-at+1;n++){const row=JSON.parse(raw.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));raw.control.observe(row.seq,raw.ledger)}
   const padded=hashes(raw,physics,w);for(let retry=0;retry<2;retry++){assert.throws(()=>native(w.tick),/invalid world ledger input/);assert.deepEqual(hashes(raw,physics,w),padded);raw.control.validateCommit(raw.ledger);refusals++}restore();assert.deepEqual(E.snapshot(w),before);
  }
  const retry=store[method](...args);assert.deepEqual(retry,result);assert.deepEqual(E.snapshot(w),after);return retry;
 }finally{for(const p of Object.values(points))p.free()}
}
function bind(w,physics,checked=true){const stores={};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources'],['peer','bindWorldPeer'],['reports','bindWorldReports'],['dispatch','bindWorldDispatch'],['perceptions','bindWorldPerceptions'],['requests','bindWorldRequests']]){let s=require('../server/rust-world-'+name).create(w,name==='perceptions'?physics:undefined);stores[name]=s;if(name==='dispatch'&&checked){const original=s;s={...original,get views(){return original.views}};for(const op of ['immediateEvents','externalEvents','enqueueEvents','readyEvents','settleEvents','cancelEvents'])s[op]=(...args)=>atomic(w,original,op,args,args[op==='readyEvents'?1:2],physics)}E[method](w,s);if(name==='ledger'){stores.control=s.control(w);E.bindWorldControl(w,stores.control)}if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}}return stores}
function pair(mode='networked_external',config={},executionMode='auto',physical=false,custom){const scene=custom||E.getScene('industrial-park-parallel-v1');Object.assign(scene.communication,{lossRate:0,...config});const a=E.create(42,'nearest',scene,{dispatchMode:mode,executionMode,physicsMode:physical?'rapier':'kinematic'}),b=E.snapshot(a),physics=physical?[Physics.createPhysics(a),Physics.createPhysics(b)]:[null,null];return {worlds:[a,b],physics,stores:bind(b,physics[1]),scene}}
function both(p,fn){const r=fn(p.worlds[1]);assert.deepEqual(r,fn(p.worlds[0]));same(p);return r}
function same(p){assert.deepEqual(E.snapshot(p.worlds[1]),E.snapshot(p.worlds[0]));assert.deepEqual(E.coordinatorObservation(p.worlds[1]),E.coordinatorObservation(p.worlds[0]));for(const a of p.worlds[0].agents)assert.deepEqual(E.observe(p.worlds[1],a.id),E.observe(p.worlds[0],a.id))}
function step(p,n=1){for(let i=0;i<n;i++){E.step(p.worlds[0],p.physics[0]);E.step(p.worlds[1],p.physics[1]);same(p);frames++}}
function choice(w,id='one'){const o=E.coordinatorObservation(w),t=o.tasks.find(t=>t.candidates.length);assert(t);return {requestId:id,taskId:t.id,agentId:t.candidates[0].id,observedTick:o.tick}}
function dispose(p){E.disposeWorld(p.worlds[1]);p.physics.forEach(x=>x?.free())}
for(const kind of ['delivered','dropped','expired','interrupted','unavailable','stale_observation','not_available']){
 const p=pair('networked_external',kind==='dropped'?{lossRate:1}:kind==='expired'?{ttl:1}:kind==='stale_observation'?{delay:6}:{}),input=choice(p.worlds[0]);try{
  assert.equal(both(p,w=>E.withCoordinator(w,'alpha',input.requestId,()=>E.submitExternalDecision(w,input))).decision.status,'pending');assert(both(p,w=>E.withCoordinator(w,'alpha',input.requestId,()=>E.submitExternalDecision(w,input))).duplicate);const view=p.worlds[1].decisions[0];
  if(kind==='interrupted')assert(both(p,w=>E.interruptCommunication(w,input.agentId,20)).ok);if(kind==='unavailable'){assert(both(p,w=>E.assign(w,input.taskId,input.agentId)).ok);assert(both(p,w=>({ok:E.fault(w)})).ok)}if(kind==='not_available')assert(both(p,w=>E.submitAction(w,input.agentId,{requestId:'busy',type:'move',target:{x:48,y:50},targetTick:1,expiresTick:100})).ok);
  step(p);const fork=E.snapshot(p.worlds[1]);bind(fork,null,false);try{for(let i=0;i<7;i++){step(p);E.step(fork);assert.deepEqual(E.snapshot(fork),E.snapshot(p.worlds[1]))}}finally{E.disposeWorld(fork)}
  assert.equal(view.status,kind==='delivered'?'accepted':['stale_observation','not_available'].includes(kind)?'rejected':'failed');if(kind!=='delivered')assert.equal(view.reason,kind);assert.equal(p.worlds[1].decisions[0],view);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:p.scene.id,scene:p.scene},frames:[E.snapshot(p.worlds[1])]}));
 }finally{dispose(p)}
}
for(const mode of ['rule','networked','networked_reported','external']){
 const p=pair(mode);try{let faulted=false;for(let i=0;i<400&&!p.worlds[0].done;i++){
  if(mode==='networked_reported'){const o=E.coordinatorObservation(p.worlds[0]),t=o.tasks.find(t=>t.candidates.length);if(t)both(p,w=>E.submitExternalDecision(w,{requestId:'d-'+i,taskId:t.id,agentId:t.candidates[0].id,observedTick:o.tick}))}
  if(i===10&&mode==='networked')assert(both(p,w=>E.interruptCommunication(w,w.communication.dispatchQueue[0]?.agentId||w.agents[0].id,12)).ok);
  if(i===17)both(p,w=>E.setDispatchMode(w,'external'));if(i===18){assert(both(p,w=>E.proposeSurvey(w,{requestId:'new-task',observedTick:w.tick,task:{id:'additional-survey',name:'补充勘察',role:'drone',target:[80,50],duration:2,dependsOn:[]}})).ok);both(p,w=>E.setDispatchMode(w,'networked'))}
  step(p);if(!faulted&&i>35&&p.worlds[0].tasks.some(t=>t.status==='active')){both(p,w=>E.fault(w));faulted=true}
 }assert(p.worlds[1].done&&!p.worlds[1].failed);assert(p.worlds[1].tasks.some(t=>t.id==='additional-survey'&&t.status==='done'));}finally{dispose(p)}
}
for(const physical of [false,true])for(const execution of ['auto','agent','primitive']){
 const p=pair('external',{},execution,physical);try{const input=choice(p.worlds[0]);assert.equal(both(p,w=>E.submitExternalDecision(w,input)).decision.status,'accepted');for(const bad of [{requestId:'unknown',taskId:'unknown?目标',agentId:'',observedTick:0},{requestId:'future',taskId:'inspect',agentId:'drone-1',observedTick:Number.MAX_SAFE_INTEGER}])assert.equal(both(p,w=>E.submitExternalDecision(w,bad)).decision.status,'rejected');step(p,2)}finally{dispose(p)}
}
// Reported admission sees the delayed authorized cache, then actual availability
// is checked again on delivery. A temporary physical wall invalidates a route.
{
 const p=pair('networked_reported');try{step(p,3);const input=choice(p.worlds[0]);assert(both(p,w=>E.submitAction(w,input.agentId,{requestId:'busy',type:'move',target:{x:48,y:50},targetTick:w.tick+1,expiresTick:w.tick+100})).ok);step(p,2);input.observedTick=p.worlds[0].tick;assert.equal(both(p,w=>E.submitExternalDecision(w,input)).decision.status,'pending');step(p,3);assert.equal(p.worlds[1].decisions[0].reason,'not_available')}finally{dispose(p)}
 const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];scene.terrain=[];scene.tasks=[{id:'survey',name:'地面勘察',role:'rover',capability:'inspect',behavior:'survey',target:[80,50],duration:2,dependsOn:[]}];const q=pair('networked_external',{delay:3,ttl:30,decisionMaxAge:20},'auto',false,scene);try{const input=choice(q.worlds[0]);assert.equal(both(q,w=>E.submitExternalDecision(w,input)).decision.status,'pending');assert(both(q,w=>E.injectRoadblock(w,{x:55,y:0,w:4,h:100},20)).ok);step(q,3);assert.equal(q.worlds[1].decisions[0].reason,'not_available')}finally{dispose(q)}
}
// Multiple queued commands cancel in declaration order with their decision state.
{
 const p=pair();try{for(let i=0;i<2;i++){const input=choice(p.worlds[0],'queued-'+i);assert.equal(both(p,w=>E.submitExternalDecision(w,input)).decision.status,'pending')}both(p,w=>E.setDispatchMode(w,'rule'));assert(p.worlds[1].decisions.every(d=>d.reason==='mode_changed'));assert.deepEqual(p.worlds[1].events.slice(-3).map(e=>e.kind),['dispatch_failed','dispatch_failed','dispatch_mode_changed'])}finally{dispose(p)}
}
// No host navigation callback is needed for native decision admission or queued
// delivery; both legs of a transport route are checked against the owned map.
for(const mode of ['external','networked_external']){
 const scene=E.getScene();const deliver=scene.tasks.find(t=>t.behavior==='deliver');scene.tasks=[{...deliver,dependsOn:[]},{...scene.tasks[0],id:'hold',dependsOn:[deliver.id]}];scene.communication.lossRate=0;const w=E.create(42,'nearest',scene,{dispatchMode:mode}),s=bind(w,null,false);let hostPlans=0;E.bindNavigation(w,{plan(){hostPlans++;throw Error('host navigation called')}});try{const input={requestId:'owned-map',taskId:deliver.id,agentId:'vehicle-1',observedTick:0};assert(E.submitExternalDecision(w,input).ok);if(mode==='networked_external')for(let i=0;i<3;i++)E.step(w);assert.equal(w.decisions[0].status,'accepted');assert.equal(w.tasks[0].status,'active');assert(w.agents.find(a=>a.id==='vehicle-1').route.length);assert.equal(hostPlans,0)}finally{E.disposeWorld(w)}
}
// Actual decision-limit histories are produced through the normal JS command
// interface before native binding, then a delivered rule packet must not assign.
{
 const scene=E.getScene('industrial-park-parallel-v1');scene.communication.lossRate=0;const a=E.create(42,'nearest',scene,{dispatchMode:'networked'});for(let i=0;i<1000;i++)assert(E.submitDecision(a,{requestId:'limit-'+i,taskId:'unknown',agentId:'unknown',observedTick:0},'rule').ok);const b=E.snapshot(a),p={worlds:[a,b],physics:[null,null],stores:bind(b,null),scene};try{assert.equal(both(p,w=>E.submitDecision(w,{requestId:'over-limit',taskId:'inspect',agentId:'drone-1',observedTick:0})).reason,'decision_limit');step(p,4);assert(b.events.some(e=>e.kind==='dispatch_failed'&&e.reason==='decision_limit'));assert(b.tasks.every(t=>t.status==='pending'));assert.equal(b.decisions.length,1000);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:[E.snapshot(b)]}))}finally{dispose(p)}
}
// New native commands do not accept caller reasons/routes/transport outcomes.
{
 const p=pair('external'),w=p.worlds[1],s=p.stores,r=Object.fromEntries(keys.map(k=>[k,C.reference(s[k],k).native])),refs=keys.slice(1).map(k=>r[k]);try{const input={actor:'external',requestId:'native',taskId:'inspect',agentId:'drone-1',observedTick:0,coordinatorId:'alpha'},before=hashes(r,null,w);for(const extra of [{reason:'not_available'},{route:[[99,99]]}]){assert.throws(()=>r.dispatch.immediateEvents(JSON.stringify({...input,...extra}),0,...refs));assert.deepEqual(hashes(r,null,w),before)}
  const accepted=JSON.parse(r.dispatch.immediateEvents(JSON.stringify(input),0,...refs));assert(accepted.ok);assert.equal(accepted.decision.status,'accepted');const after=hashes(r,null,w);assert.equal(JSON.parse(r.dispatch.immediateEvents(JSON.stringify({...input,coordinatorId:'bravo'}),0,...refs)).reason,'request_id_conflict');assert.deepEqual(hashes(r,null,w),after);const point=r.ledger.checkpoint();r.ledger.finish(false);assert(JSON.parse(r.dispatch.immediateEvents(JSON.stringify(input),0,...refs)).duplicate);assert.equal(JSON.parse(r.dispatch.immediateEvents(JSON.stringify({...input,requestId:'new'}),0,...refs)).reason,'world_finished');r.ledger.rollback(point);point.free();assert.deepEqual(hashes(r,null,w),after);
  const foreign=require('../server/rust-world-environment').create(w),changed=[...refs];changed[1]=C.reference(foreign,'environment').native;assert.throws(()=>r.dispatch.immediateEvents(JSON.stringify(input),0,...changed));assert.deepEqual(hashes(r,null,w),after);foreign.free();
 }finally{dispose(p)}
}
assert(operations>500);assert(sequences.size>=20);assert(refusals>=60);console.log(`Native dispatch events: ${frames} paired frames, ${operations} operations, ${sequences.size} event sequences and ${refusals} late append refusals; native route/assignment/resource/decision coupling, actual versus reported admission, six transport/admission failures, modes/execution/physics, ownership/source/clock/prefix/identity fences, multi-cancel order, no host planner, exact native/collider recovery and independent command forks/replay passed`);
