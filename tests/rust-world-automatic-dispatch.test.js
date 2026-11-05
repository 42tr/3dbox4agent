'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),Physics=require('../server/rust-physics'),Replay=require('../src/replay');
const keys=['dispatch','execution','environment','tasks','resources','actions','peer','reports','control','ledger'],sequences=new Set();let operations=0,frames=0,refusals=0;
function hashes(raw,physics,w){const result=keys.map(k=>crypto.createHash('sha256').update(k==='execution'?raw[k].snapshot()+raw[k].snapshotExecution():raw[k].snapshot()).digest('hex'));if(physics)result.push(crypto.createHash('sha256').update(JSON.stringify(w.agents.map(a=>physics.lidar(a,1.5,8,100)))).digest('hex'));return result}
function atomic(w,store,method,args,context,physics){
 const stores={...context,dispatch:store},raw=Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native])),refs=keys.slice(1).map(k=>raw[k]),points=Object.fromEntries(keys.map(k=>[k,stores[k].checkpoint()])),before=E.snapshot(w);
 const restore=()=>{for(const k of [...keys].reverse())stores[k].rollback(points[k])};
 const native=t=>method==='automaticEvents'?raw.dispatch.automaticEvents(t,...refs):method==='readyEvents'?raw.dispatch.readyEvents(t,...refs):method==='settleEvents'?raw.dispatch.settleEvents(args[0],t,...refs):method==='cancelEvents'?raw.dispatch.cancelEvents(args[0],t,...refs):raw.dispatch[method](JSON.stringify(args[0]),t,...refs);
 try{
  let result;try{result=store[method](...args)}catch(error){console.error('Native batch context',w.dispatchMode,w.policy,w.tick,w.agents.map(a=>a.id));try{native(w.tick)}catch(nativeError){throw nativeError}throw error}const after=E.snapshot(w),events=after.events.slice(before.events.length);operations++;assert.equal(result.published,true);assert(!Object.keys(result).includes('published'));assert(!Object.keys(result).includes('assigned'));
  const d=result.decision,key=[method,w.dispatchMode,w.executionMode,physics?'rapier':'kinematic',d?.status||'',d?.reason||result.reason||'',result.assignments??'',result.enqueued??'',...events.map(e=>e.kind+':'+(e.reason||''))].join('|');if(sequences.has(key))return result;sequences.add(key);restore();const initial=hashes(raw,physics,w);
  for(const tick of [-1,w.tick+.5,w.tick+1,4294967296+w.tick,NaN,Infinity]){assert.throws(()=>native(tick));assert.deepEqual(hashes(raw,physics,w),initial)}
  raw.ledger.append(JSON.stringify({message:'unobserved',type:'info'}));assert.throws(()=>native(w.tick));restore();assert.deepEqual(hashes(raw,physics,w),initial);
  for(let at=1;at<=events.length;at++){
   for(let n=before.events.length;n<200000-at+1;n++){const row=JSON.parse(raw.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));raw.control.observe(row.seq,raw.ledger)}
   const padded=hashes(raw,physics,w);for(let retry=0;retry<2;retry++){assert.throws(()=>native(w.tick),/invalid world ledger input/);assert.deepEqual(hashes(raw,physics,w),padded);raw.control.validateCommit(raw.ledger);refusals++}restore();assert.deepEqual(E.snapshot(w),before);
  }
  const retry=store[method](...args);assert.deepEqual(retry,result);assert.deepEqual(E.snapshot(w),after);return retry;
 }finally{for(const p of Object.values(points))p.free()}
}
function bind(w,physics,checked=true){const stores={};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources'],['peer','bindWorldPeer'],['reports','bindWorldReports'],['dispatch','bindWorldDispatch'],['perceptions','bindWorldPerceptions'],['requests','bindWorldRequests']]){let s=require('../server/rust-world-'+name).create(w,name==='perceptions'?physics:undefined);stores[name]=s;if(name==='dispatch'&&checked){const original=s;s={...original,get views(){return original.views}};for(const op of ['automaticEvents'])s[op]=(...args)=>atomic(w,original,op,args,args[op==='automaticEvents'?1:2],physics)}E[method](w,s);if(name==='ledger'){stores.control=s.control(w);E.bindWorldControl(w,stores.control)}if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}}return stores}
function pair(mode='networked_external',config={},executionMode='auto',physical=false,custom){const scene=custom||E.getScene('industrial-park-parallel-v1');Object.assign(scene.communication,{lossRate:0,...config});const a=E.create(42,'nearest',scene,{dispatchMode:mode,executionMode,physicsMode:physical?'rapier':'kinematic'}),b=E.snapshot(a),physics=physical?[Physics.createPhysics(a),Physics.createPhysics(b)]:[null,null];return {worlds:[a,b],physics,stores:bind(b,physics[1]),scene}}
function both(p,fn){const r=fn(p.worlds[1]);assert.deepEqual(r,fn(p.worlds[0]));same(p);return r}
function same(p){assert.deepEqual(E.snapshot(p.worlds[1]),E.snapshot(p.worlds[0]));assert.deepEqual(E.coordinatorObservation(p.worlds[1]),E.coordinatorObservation(p.worlds[0]));for(const a of p.worlds[0].agents)assert.deepEqual(E.observe(p.worlds[1],a.id),E.observe(p.worlds[0],a.id))}
function step(p,n=1){for(let i=0;i<n;i++){E.step(p.worlds[0],p.physics[0]);E.step(p.worlds[1],p.physics[1]);same(p);frames++}}
function choice(w,id='one'){const o=E.coordinatorObservation(w),t=o.tasks.find(t=>t.candidates.length);assert(t);return {requestId:id,taskId:t.id,agentId:t.candidates[0].id,observedTick:o.tick}}
function dispose(p){E.disposeWorld(p.worlds[1]);p.physics.forEach(x=>x?.free())}

// Both immutable policies, all execution modes and actual motion backends.
for(const mode of ['rule','networked'])for(const policy of ['nearest','battery'])for(const execution of ['auto','agent','primitive'])for(const physical of [false,true]){
 const p=pair(mode,{delay:2,ttl:30,decisionMaxAge:20},execution,physical);try{
  // Policy is immutable once bound: construct a second correctly seeded pair.
  if(policy==='battery'){dispose(p);const scene=E.getScene('industrial-park-parallel-v1');Object.assign(scene.communication,{delay:2,ttl:30,decisionMaxAge:20,lossRate:0});const a=E.create(42,'battery',scene,{dispatchMode:mode,executionMode:execution,physicsMode:physical?'rapier':'kinematic'}),b=E.snapshot(a);p.worlds=[a,b];p.physics=physical?[Physics.createPhysics(a),Physics.createPhysics(b)]:[null,null];p.stores=bind(b,p.physics[1]);p.scene=scene}
  step(p,execution==='auto'?8:4);assert(p.worlds[1].tasks.some(t=>t.status==='active'));assert(p.worlds[1].decisions.every(d=>d.actor=== (mode==='rule'?'rule':'network')));
 }finally{dispose(p)}
}
// Stable priority/deadline/declaration order; a skipped branch retains its rule
// request index. Resource reservation suppresses a second pickup in the batch.
for(const mode of ['rule','networked']){
 const scene=E.getScene('industrial-park-parallel-v1');const base=scene.tasks[0],delivery=scene.tasks.find(t=>t.behavior==='deliver');scene.obstacles=[];scene.terrain=[];scene.tasks=[{...base,id:'missing',capability:'absent',priority:100},{...base,id:'early',priority:10,deadline:4},{...base,id:'tie-a',priority:10,deadline:9},{...base,id:'tie-b',priority:10,deadline:9},{...delivery,id:'pickup',priority:50,dependsOn:[]},{...delivery,id:'duplicate-pickup',priority:20,dependsOn:[]}];
 const p=pair(mode,{delay:2,ttl:30,decisionMaxAge:20},'auto',false,scene);try{step(p);const w=p.worlds[1],rows=mode==='rule'?w.decisions:w.communication.dispatchQueue;assert.deepEqual(rows.map(r=>r.taskId),mode==='rule'?['pickup','early','tie-a','tie-b']:['pickup','duplicate-pickup','early','tie-a','tie-b']);if(mode==='rule'){assert.deepEqual(rows.map(r=>r.requestId),['rule-1-1','rule-1-3','rule-1-4','rule-1-5']);assert.equal(w.part.reservedBy,'pickup')}step(p,4)}finally{dispose(p)}
}
// English identifier ties across allowed punctuation, digits and mixed case.
for(const policy of ['nearest','battery'])for(const mode of ['rule','networked']){
 const roles=['_','-','0','9','a','A','b','B','aa','aA','Aa','AA','a_','a-','a0','a9','_a','-a','z','Z','r_2','r-2','r-10','r-1'];
 const scene=E.getScene();scene.obstacles=[];scene.terrain=[];scene.agents=roles.map(role=>({role,label:role,count:1,capabilities:['inspect'],speed:1,mobility:'air'}));scene.tasks=roles.map((_,i)=>({id:'t-'+i,name:'Tie '+i,behavior:'survey',role:roles[0],capability:'inspect',target:[80,80],duration:1000,dependsOn:[]}));scene.communication.lossRate=0;
 const a=E.create(42,policy,scene,{dispatchMode:mode});for(const actor of a.agents){actor.x=20;actor.y=20;actor.battery=actor.initialBattery=100}const b=E.snapshot(a),p={worlds:[a,b],physics:[null,null],stores:bind(b,null,false),scene};try{step(p);const rows=mode==='rule'?b.decisions:b.communication.dispatchQueue;assert.deepEqual(rows.map(r=>r.agentId),a.agents.map(x=>x.id).sort((a,b)=>a.localeCompare(b,'en')))}finally{dispose(p)}
}
// Shared capabilities permit a different declared equipment role, as in the
// public JS candidate contract. Native resources must accept and finish it while
// still checking the actual execution role/capability catalog for the actor.
{
 const scene=E.getScene();scene.obstacles=[];scene.terrain=[];scene.agents=[{role:'declared',label:'Declared',count:1,capabilities:['inspect'],speed:10},{role:'capable',label:'Capable',count:1,capabilities:['inspect'],speed:10,mobility:'air'}];scene.tasks=[{id:'shared',name:'Shared capability',behavior:'survey',role:'declared',capability:'inspect',target:[55,50],duration:2,dependsOn:[]}];
 const a=E.create(42,'nearest',scene,{dispatchMode:'rule'});a.agents[0].x=10;a.agents[0].y=20;a.agents[1].x=50;a.agents[1].y=50;const b=E.snapshot(a),p={worlds:[a,b],physics:[null,null],stores:bind(b,null),scene};try{step(p,6);assert.equal(b.tasks[0].assignee,'capable-1');assert(b.done&&!b.failed);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:[E.snapshot(b)]}))}finally{dispose(p)}
}
// All seven behaviors may run on another equipment type with the capability;
// this also exercises native work ownership, cargo effects and archive replay.
for(const mode of ['rule','networked']){
 const scene=E.getScene();scene.agents=scene.agents.map(a=>({...a,role:'support-'+a.role,mobility:a.role==='drone'?'air':'ground'}));const p=pair(mode,{delay:3,ttl:30,decisionMaxAge:20},'auto',false,scene);try{for(let i=0;i<450&&!p.worlds[0].done;i++)step(p);const w=p.worlds[1];assert(w.done&&!w.failed);assert(w.tasks.every(t=>t.status==='done'));assert.equal(w.part.location,'consumed');assert.equal(w.asset.condition,'operational');assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:[E.snapshot(w)]}))}finally{dispose(p)}
}
// Native route filtering, moving ground barriers, risk/terrain, failures and
// avoid/retry selection continue to match the public JS world and observations.
for(const mode of ['rule','networked'])for(const sceneId of ['lunar-outpost-v1','industrial-park-risk-detour-v1']){
 const scene=E.getScene(sceneId),p=pair(mode,{delay:3,ttl:30,decisionMaxAge:20},'auto',false,scene);try{
  step(p,3);if(sceneId==='lunar-outpost-v1'){both(p,w=>E.injectRoadblock(w,{x:55,y:0,w:4,h:100},15));both(p,w=>E.fault(w))}
  for(let i=0;i<320&&!p.worlds[0].done;i++)step(p);assert(p.worlds[1].done&&!p.worlds[1].failed);
  assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:[E.snapshot(p.worlds[1])]}));
 }finally{dispose(p)}
}
for(const loss of [0,1]){
 const p=pair('networked',{lossRate:loss});try{step(p,6);if(loss){assert(Object.keys(p.worlds[1].communication.dispatchAvoid).length);assert(p.worlds[1].events.some(e=>e.kind==='dispatch_failed'&&e.reason==='dropped'))}const copy=E.snapshot(p.worlds[1]),s=bind(copy,null,false);try{step(p,3);for(let i=0;i<3;i++)E.step(copy);assert.deepEqual(E.snapshot(copy),E.snapshot(p.worlds[1]))}finally{E.disposeWorld(copy)}}finally{dispose(p)}
}
// The complete rule/network planning phase needs no host route provider.
for(const mode of ['rule','networked']){
 const scene=E.getScene();const d=scene.tasks.find(t=>t.behavior==='deliver');scene.tasks=[{...d,dependsOn:[]},{...scene.tasks[0],id:'hold',dependsOn:[d.id]}];scene.communication.lossRate=0;
 const w=E.create(42,'nearest',scene,{dispatchMode:mode}),s=bind(w,null,false);let plans=0;E.bindNavigation(w,{plan(){plans++;throw Error('host planning must not run')}});try{for(let i=0;i<4;i++)E.step(w);assert.equal(w.tasks[0].status,'active');assert(w.agents.some(a=>a.route.length));assert.equal(plans,0)}finally{E.disposeWorld(w)}
}
// Existing request identities and the decision cap apply to the entire batch,
// including a cap reached by its first successful assignment.
for(const kind of ['conflict','limit']){
 const scene=E.getScene('industrial-park-parallel-v1');const a=E.create(42,'nearest',scene,{dispatchMode:'rule'});
 for(let i=0;i<(kind==='limit'?999:1);i++)assert(E.submitDecision(a,{requestId:kind==='limit'?'limit-'+i:'rule-1-0',taskId:'unknown',agentId:'unknown',observedTick:0},'rule').ok);
 const b=E.snapshot(a),p={worlds:[a,b],physics:[null,null],stores:bind(b,null),scene};try{step(p);assert.equal(b.tasks.filter(t=>t.status==='active').length,1);if(kind==='limit')assert.equal(b.decisions.length,1000);else assert(!b.tasks.find(t=>t.id===a.tasks[0].id).assignee)}finally{dispose(p)}
}
// Raw entry has no caller policy/candidate/route payload; it binds the actual
// control policy and participants and refuses unacknowledged/future contexts.
{
 const p=pair('rule'),w=p.worlds[1],s=p.stores,r=Object.fromEntries(keys.map(k=>[k,C.reference(s[k],k).native])),refs=keys.slice(1).map(k=>r[k]);try{
  const before=hashes(r,null,w);for(const tick of [-1,.5,1,NaN,Infinity]){assert.throws(()=>r.dispatch.automaticEvents(tick,...refs));assert.deepEqual(hashes(r,null,w),before)}
  assert.throws(()=>r.dispatch.automaticEvents(JSON.stringify({policy:'battery',candidates:[]}),...refs));assert.deepEqual(hashes(r,null,w),before);
  const foreign=require('../server/rust-world-environment').create(w),changed=[...refs];changed[1]=C.reference(foreign,'environment').native;const result=JSON.parse(r.dispatch.automaticEvents(0,...refs));assert(result.assignments>=2);const after=hashes(r,null,w);assert.throws(()=>r.dispatch.automaticEvents(0,...changed));assert.deepEqual(hashes(r,null,w),after);foreign.free();
 }finally{dispose(p)}
}
for(const mode of ['external','networked_external','networked_reported']){const p=pair(mode);try{const s=p.stores,c={execution:s.execution,environment:s.environment,tasks:s.tasks,resources:s.resources,actions:s.actions,peer:s.peer,reports:s.reports,control:s.control,ledger:s.ledger};const before=E.snapshot(p.worlds[1]);assert.throws(()=>s.dispatch.automaticEvents(0,c));assert.deepEqual(E.snapshot(p.worlds[1]),before)}finally{dispose(p)}}
assert(frames>500);assert(operations>500);assert(sequences.size>=10);assert(refusals>=40);console.log(`Native automatic dispatch: ${frames} paired frames, ${operations} batches, ${sequences.size} event sequences and ${refusals} late append refusals; native stable task/identifier ordering, two policies, reservations/avoidance/resource/actual-map selection, three execution modes and both physics backends, whole-batch rollback, no host planner and independent forks/replay passed`);
