'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Tx=require('../server/world-transaction');
const Native=require('../rust/physics/target/release/box_physics.node');
const names=['environment','ledger','control','motion','execution','tasks','actions','peer','reports','dispatch','resources','perceptions','requests'];
function bind(options={}){
 const scene=E.getScene('lunar-outpost-v1'),w=E.create(42,'nearest',scene,{dispatchMode:'external',physicsMode:options.physics?'rapier':'kinematic'}),stores={},participants=[];
 if(options.task!==false){E.bindTaskRules(w,require('../server/rust-task-rules'));E.bindNavigation(w,require('../server/rust-navigation'))}
 if(options.comm!==false)E.bindCommunicationRules(w,require('../server/rust-communication'));
 const physics=options.physics?require(options.physics==='wasm'?'../server/physics':'../server/rust-physics').createPhysics(w):null;
 if(options.physics==='rust')E.bindRaySensors(w,physics);
 function add(name,fn,store){stores[name]=store;E[fn](w,store);participants.push(store);return store}
 if(options.task!==false){
  add('environment','bindWorldEnvironment',require('../server/rust-world-environment').create(w));
  const ledger=add('ledger','bindWorldLedger',require('../server/rust-world-ledger').create(w));add('control','bindWorldControl',ledger.control(w));
  const motion=require('../server/rust-world-motion').create(w);stores.motion=motion;E.bindWorldMotion(w,motion);add('execution','bindWorldExecution',motion.execution(w));
  add('tasks','bindWorldTasks',require('../server/rust-world-tasks').create(w));add('actions','bindWorldActions',require('../server/rust-world-actions').create(w));
 }
 if(options.comm!==false){add('peer','bindWorldPeer',require('../server/rust-world-peer').create(w));add('reports','bindWorldReports',require('../server/rust-world-reports').create(w))}
 if(options.task!==false){for(const [name,fn] of [['dispatch','bindWorldDispatch'],['resources','bindWorldResources'],['perceptions','bindWorldPerceptions'],['requests','bindWorldRequests']])add(name,fn,require('../server/rust-world-'+name).create(w,physics))}
 if(physics)participants.push(physics);
 const driver=Tx.create(w,participants,E.snapshot,E.restoreHostState);E.bindWorldTransaction(w,driver);
 return {w,stores,physics,driver,close(){E.disposeWorld(w);physics?.free()}};
}
function refusal(fn,reason){assert.throws(fn,e=>{const ok=e.status===503&&e.worldTransactionFailure&&e.rollbackRestored===true&&(!reason||e.cause?.message===reason);if(!ok)console.error({status:e.status,transaction:e.worldTransactionFailure,restored:e.rollbackRestored,cause:e.cause,rollbackErrors:e.rollbackErrors});return ok})}
function proposal(w){return {requestId:'rollback-survey',observedTick:w.tick,task:{id:'rollback-survey',name:'恢复后复勘',role:'rover',target:[48,50],duration:2,dependsOn:[]}}}
function perturb(v){
 const w=v.w;
 assert.equal(E.proposeSurvey(w,proposal(w)).proposal.status,'accepted');
 assert(E.sendMessage(w,'rover-1','rover-2','checkpoint',[],'rollback-message').ok);
 assert(E.interruptCommunication(w,'rover-2',6).ok);
 assert(E.injectTerrainEffect(w,'soft-regolith',6,.5,2).ok);
 assert(E.injectRoadblock(w,{x:80,y:85,w:3,h:3},4).ok);
 E.setDispatchMode(w,'networked_reported');
 for(let i=0;i<25;i++)E.step(w,v.physics);
 E.setDispatchMode(w,'rule');E.step(w,v.physics);
 assert(E.fault(w));
}
(async()=>{
 await require('../server/physics').initialize();
 assert.throws(()=>new Native.WorldCheckpoint());
 {
  const ledger=new Native.WorldLedger(JSON.stringify({tick:0,done:false,failed:false,events:[]})),point=ledger.checkpoint();
  assert.throws(()=>ledger.rollback({}));ledger.free();assert.throws(()=>ledger.rollback(point));assert.throws(()=>ledger.checkpoint());point.free();
 }
 for(const options of [{physics:'rust'},{physics:'rust',task:false,comm:false},{physics:'wasm',comm:false},{physics:'rust',task:false},{task:false},{comm:false}]){
  console.log('checking rollback',options);const a=bind(options),b=bind(options),before=E.snapshot(a.w),agent=a.w.agents[0],task=a.w.tasks[0],asset=a.w.asset;
  const ranges=a.physics?.lidar?.(agent,1.5,12,100);
  for(const name of names){
   const store=a.stores[name];if(!store)continue;
   const point=store.checkpoint();assert.throws(()=>b.stores[name].rollback(point));point.free();assert.throws(()=>store.rollback(point));
  }
  if(a.physics){const point=a.physics.checkpoint();assert.throws(()=>b.physics.rollback(point));point.free();assert.throws(()=>a.physics.rollback(point))}
  try{refusal(()=>a.driver.run(()=>{perturb(a);throw Error('host failure after multiple native commits')}),'host failure after multiple native commits');}catch(error){assert.deepEqual(E.snapshot(a.w),before);throw error}
  assert.deepEqual(E.snapshot(a.w),before);assert.equal(a.w.agents[0],agent);assert.equal(a.w.tasks[0],task);assert.equal(a.w.asset,asset);
  if(ranges)assert.deepEqual(a.physics.lidar(agent,1.5,12,100),ranges);
  // Reusing the rolled-back IDs, clocks, report schedules and task catalog must
  // behave exactly like an independent world which never executed the failure.
  perturb(a);perturb(b);assert.deepEqual(E.snapshot(a.w),E.snapshot(b.w));
  for(let i=0;i<400&&!a.w.done;i++){E.step(a.w,a.physics);E.step(b.w,b.physics);assert.deepEqual(E.snapshot(a.w),E.snapshot(b.w))}
  assert(a.w.done&&!a.w.failed);a.close();b.close();
 }
 {
  const a=bind({physics:'rust'}),before=E.snapshot(a.w);
  refusal(()=>a.driver.run(()=>a.stores.control.mode('rule')));assert.deepEqual(E.snapshot(a.w),before);
  E.setDispatchMode(a.w,'rule');for(let i=0;i<5;i++)E.step(a.w,a.physics);E.setDispatchMode(a.w,'external');
  const task=a.w.tasks.find(t=>t.status==='active'),saved=E.snapshot(a.w);
  refusal(()=>a.driver.run(()=>a.stores.requests.prepareRevocation({requestId:'pending',taskId:task.id,agentId:task.assignee,assignmentId:task.assignmentId,observedTick:a.w.tick},a.w,null)));
  assert.deepEqual(E.snapshot(a.w),saved);
  assert.equal(E.revokeTask(a.w,{requestId:'pending',taskId:task.id,agentId:task.assignee,assignmentId:task.assignmentId,observedTick:a.w.tick}).revocation.status,'accepted');
  a.close();
 }
 {
  const a=bind({physics:'rust'}),b=bind({physics:'rust'});E.setDispatchMode(a.w,'rule');E.setDispatchMode(b.w,'rule');
  while(a.w.part.location!=='carried'&&a.w.tick<400){E.step(a.w,a.physics);E.step(b.w,b.physics)}
  assert.equal(a.w.part.location,'carried');const saved=E.snapshot(a.w);
  refusal(()=>a.driver.run(()=>{E.fault(a.w);assert.equal(a.w.part.location,'ground');throw Error('host failure after native cargo drop')}),'host failure after native cargo drop');
  assert.deepEqual(E.snapshot(a.w),saved);E.fault(a.w);E.fault(b.w);
  while(!a.w.done&&a.w.tick<600){E.step(a.w,a.physics);E.step(b.w,b.physics);assert.deepEqual(E.snapshot(a.w),E.snapshot(b.w))}
  assert(a.w.done&&!a.w.failed);assert.equal(a.w.asset.condition,'operational');a.close();b.close();
 }
 {
  const a=bind({physics:'rust'}),before=E.snapshot(a.w);
  refusal(()=>a.driver.run(()=>{E.setDispatchMode(a.w,'rule');while(!a.w.done&&a.w.tick<600)E.step(a.w,a.physics);assert(a.w.done&&!a.w.failed);throw Error('abort completed world')}),'abort completed world');
  assert.deepEqual(E.snapshot(a.w),before);E.setDispatchMode(a.w,'rule');while(!a.w.done&&a.w.tick<600)E.step(a.w,a.physics);assert(a.w.done&&!a.w.failed);a.close();
 }
 {
  const a=bind({physics:'rust'}),bad={checkpoint(){return {free(){}}},rollback(){throw Error('rollback unavailable')}};
  const driver=Tx.create(a.w,[bad],E.snapshot,E.restoreHostState);
  assert.throws(()=>driver.run(()=>{throw Error('operation failed')}),e=>e.worldTransactionFailure&&!e.rollbackRestored&&e.rollbackErrors.length===1);
  a.close();
 }
 console.log('Opaque native checkpoints reject foreign/freed handles; full/mixed Rust, WASM physics and host state rollback preserve views, collider queries, IDs, clocks, pending acknowledgements, cargo and independent retry/completion parity');
})().catch(error=>{console.error(error);process.exitCode=1});
