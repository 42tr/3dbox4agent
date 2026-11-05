'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const E=require('../src/engine'),Nav=require('../src/navigation'),NativeNav=require('../server/rust-navigation');
const Physics=require('../server/rust-physics'),C=require('../server/native-components'),Replay=require('../src/replay');
const order=['execution','environment','tasks','actions','resources','peer','reports','perceptions','dispatch','requests','ledger'];
let reads=0,frames=0,hostPlans=0,scenarios=0;
const outcomes=[];
function bind(w,p,coordinator=true){
 const stores={},participants=[];
 function add(name,method,value){const s=value||require('../server/rust-world-'+name).create(w,name==='perceptions'?p:undefined);stores[name]=s;E[method](w,s);participants.push(s);return s}
 add('environment','bindWorldEnvironment');const ledger=add('ledger','bindWorldLedger');add('control','bindWorldControl',ledger.control(w));
 const motion=require('../server/rust-world-motion').create(w);E.bindWorldMotion(w,motion);add('execution','bindWorldExecution',motion.execution(w));
 for(const name of ['tasks','actions','peer','reports','dispatch','resources','perceptions','requests'])add(name,'bindWorld'+name[0].toUpperCase()+name.slice(1));
 E.bindNavigation(w,NativeNav);E.bindTaskRules(w,require('../server/rust-task-rules'));E.bindCommunicationRules(w,require('../server/rust-communication'));
 assert(E.bindWorldAgentObservations(w));if(coordinator)assert(E.bindWorldCoordinatorObservations(w));
 E.bindWorldTransaction(w,require('../server/world-transaction').create(w,[...participants,...(p?[p]:[])],E.snapshot,E.restoreHostState));return stores;
}
function raw(s){return Object.fromEntries([...order,'control'].map(k=>[k,C.reference(s[k],k).native]))}
function hashes(s){return Object.entries(raw(s)).map(([k,n])=>[k,crypto.createHash('sha256').update(k==='execution'?n.snapshot()+n.snapshotExecution():n.snapshot()).digest('hex')])}
function observation(w){const old=NativeNav.plan,js=Nav.plan;NativeNav.plan=Nav.plan=()=>{hostPlans++;throw Error('Native coordinator reads must not call host route planners')};try{reads++;return E.coordinatorObservation(w)}finally{NativeNav.plan=old;Nav.plan=js}}
function compare(w){const view=observation(w);assert.deepEqual(view,E.coordinatorObservation(E.snapshot(w)),`${w.sceneId}/${w.dispatchMode}/${w.executionMode}/${w.tick}`);frames++;return view}
function command(w,a,type,extra={}){assert(E.submitAction(w,a.id,{requestId:`bot-${type}-${a.id}-${w.tick}`,type,targetTick:w.tick+1,expiresTick:w.tick+100,...extra}).ok)}
function bot(w){if(w.executionMode==='auto')return;for(const a of w.agents){if(a.status!=='assigned'||a.disabled||w.actions.some(x=>x.agentId===a.id&&['pending','accepted'].includes(x.status)))continue;const t=E.observe(w,a.id).assignedTasks.find(t=>t.status==='active');if(!t)continue;if(w.executionMode==='agent')command(w,a,'execute_task',{taskId:t.id});else if(t.withinReach)command(w,a,'work_task',{taskId:t.id});else if(t.waypoint)command(w,a,'move',{target:{x:t.waypoint[0],y:t.waypoint[1]}})}}
function allocate(w){if(!['external','networked_external','networked_reported'].includes(w.dispatchMode))return;for(const task of observation(w).tasks){const current=observation(w).tasks.find(t=>t.id===task.id),a=current?.candidates[0];if(!a)continue;const requestId=`dispatch-${task.id}-${w.tick}`;const result=E.withCoordinator(w,'ops',requestId,()=>E.submitExternalDecision(w,{requestId,taskId:task.id,agentId:a.id,observedTick:w.tick}));assert(result.ok,JSON.stringify(result))}}
function fixture(metric){
 const s=E.getScene('lunar-outpost-v1');s.obstacles=[{id:'shed',x:40,y:35,w:5,h:15,height:8}];s.navigation=metric;
 s.riskNavigation='avoid';s.riskZones=[{id:'risk',name:'Risk',x:50,y:0,w:4,h:15}];s.terrain=[{id:'soil',name:'Soil',x:20,y:20,w:40,h:40,speedFactor:.7,energyFactor:1.4}];
 s.agents=[{role:'worker',label:'Worker',count:3,mobility:'ground',capabilities:['inspect','confirm','sample','deliver','repair','verify'],speed:3},{role:'scout',label:'Scout',count:1,mobility:'air',capabilities:['inspect'],speed:4}];s.resource={warehouse:[20,80],site:[75,50]};s.chargingStation=[90,90];
 s.tasks=[['inspect','detect','inspect',[],[75,50]],['sample','sample','sample',['inspect'],[80,70]],['confirm','confirm','confirm',['inspect'],[75,50]],['deliver','deliver','deliver',['confirm'],[75,50]],['repair','repair','repair',['deliver'],[75,50]],['verify','verify','verify',['repair'],[75,50]]].map(([id,behavior,capability,dependsOn,target])=>({id,name:id,role:'worker',behavior,capability,dependsOn,target,duration:3}));
 Object.assign(s.communication,{range:500,delay:3,ttl:40,lossRate:0,bytesPerTick:4096});return s;
}
for(const metric of ['distance','time','energy'])for(const executionMode of ['auto','agent','primitive'])for(const dispatchMode of ['rule','networked','external','networked_external','networked_reported']){
 const ray=metric==='energy',scene=fixture(metric),w=E.create(42,'nearest',scene,{dispatchMode,executionMode,physicsMode:ray?'rapier':'kinematic'}),p=ray?Physics.createPhysics(w):null;if(p)E.bindRaySensors(w,p);
 const stores=bind(w,p),history=[E.snapshot(w)];try{
  compare(w);command(w,w.agents[0],'scan');
  for(let i=0;i<600&&!w.done;i++){
   if(i===5){const mode=w.dispatchMode;E.setDispatchMode(w,'external');assert(E.withCoordinator(w,'ops','extra',()=>E.proposeSurvey(w,{requestId:'extra',observedTick:w.tick,task:{id:'extra',name:'Extra survey',role:'worker',target:[60,70],duration:2,dependsOn:['inspect'],priority:10,deadline:1000}})).ok);E.setDispatchMode(w,mode)}
   if(i===8)assert(E.injectTerrainEffect(w,'soil',7).ok);if(i===12)assert(E.interruptCommunication(w,'worker-2',5).ok);if(i===20)assert(E.injectRoadblock(w,{x:92,y:0,w:4,h:10},5).ok);
   const scan=w.actions.find(a=>a.type==='scan'&&a.status==='completed');if(scan&&!w.evidenceReports?.some(r=>r.scanRequestId===scan.requestId))assert(E.submitEvidence(w,scan.agentId,{requestId:'scan-evidence',scanRequestId:scan.requestId}).ok);
   for(const sample of w.events.filter(e=>e.kind==='sample_collected'))if(!w.sampleReports?.some(r=>r.agentId===sample.agentId&&r.taskId===sample.taskId))assert(E.submitSampleReport(w,sample.agentId,{requestId:'sample-'+sample.taskId,taskId:sample.taskId}).ok);
   allocate(w);bot(w);E.step(w,p);compare(w);history.push(E.snapshot(w));
  }
  assert(w.done&&!w.failed,`${dispatchMode}/${executionMode}/${metric} must complete`);assert.equal(w.tasks.filter(t=>t.status==='done').length,7);
  assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:history}));
  const before=hashes(stores),view=observation(w);view.knownTasks[0].name='forged';view.decisions.length=0;view.proposals.push({private:'forged'});compare(w);assert.deepEqual(hashes(stores),before);
  outcomes.push({metric,executionMode,dispatchMode,tick:w.tick});scenarios++;
 }finally{E.disposeWorld(w);p?.free()}
}
for(const sceneId of ['industrial-park-fixed-sensor-v1','lunar-outpost-v1','shore-coordination-v1']){
 const scene=E.getScene(sceneId),w=E.create(713,'battery',scene,{dispatchMode:'rule',physicsMode:'rapier'}),p=Physics.createPhysics(w);E.bindRaySensors(w,p);bind(w,p);
 try{compare(w);for(let i=0;i<1000&&!w.done;i++){E.step(w,p);if(i%7===0||w.done)compare(w)}assert(w.done);scenarios++}finally{E.disposeWorld(w);p.free()}
}
{
 const w=E.create(42,'nearest',fixture('energy'),{dispatchMode:'external'}),s=bind(w,null,false),r=raw(s),args=order.map(k=>r[k]),before=hashes(s);
 assert.equal(r.control.coordinatorObservationsBound(),false);assert.throws(()=>r.control.coordinatorObservation(0,...args));r.control.bindCoordinatorObservations(...args);assert.equal(r.control.coordinatorObservationsBound(),true);assert.deepEqual(hashes(s),before);compare(w);
 for(const expected of [NaN,Infinity,-1,.5,1])assert.throws(()=>r.control.coordinatorObservation(expected,...args));
 const other=E.create(42,'nearest',fixture('energy'),{dispatchMode:'external'}),o=bind(other),foreign=raw(o);
 try{for(let i=0;i<order.length;i++){const values=args.slice();values[i]=foreign[order[i]];assert.throws(()=>r.control.coordinatorObservation(0,...values));assert.throws(()=>r.control.bindCoordinatorObservations(...values));assert.deepEqual(hashes(s),before)}}finally{E.disposeWorld(other)}
 const point=r.ledger.checkpoint();r.ledger.append(JSON.stringify({message:'unacknowledged',type:'info',kind:'fixture'}));assert.throws(()=>observation(w));r.ledger.rollback(point);point.free();assert.deepEqual(hashes(s),before);
 assert(E.submitAction(w,'worker-2',{requestId:'private-scan',type:'scan',targetTick:1,expiresTick:40}).ok);assert(!JSON.stringify(observation(w)).includes('private-scan'));
 assert(E.assign(w,'inspect','worker-1').ok);const task=w.tasks.find(t=>t.id==='inspect'),requestsPoint=r.requests.checkpoint();
 const input={requestId:'lease',taskId:task.id,agentId:task.assignee,assignmentId:task.assignmentId,observedTick:w.tick},context={done:false,mode:'external',task:{id:task.id,status:'active',assignee:task.assignee,assignmentId:task.assignmentId},agent:{id:task.assignee,blockedSince:null}};
 const lease=JSON.parse(r.requests.prepareRevocation(JSON.stringify(input),JSON.stringify(context),w.tick)),preparedHashes=hashes(s);compare(w);assert.deepEqual(hashes(s),preparedHashes);
 r.requests.commitRevocation(lease.ticket,JSON.stringify({task:{...context.task,status:'pending',assignee:null},agent:{id:task.assignee,idle:true,route_empty:true,work:0,unsettled_actions:false},event:{kind:'task_revoked',tick:w.tick,requestId:input.requestId,taskId:input.taskId,agentId:input.agentId,assignmentId:input.assignmentId,reason:null}}),w.tick);
 r.requests.rollback(requestsPoint);requestsPoint.free();compare(w);E.disposeWorld(w);assert.throws(()=>r.control.coordinatorObservation(w.tick,...args));
}
{
 const scene=fixture('distance');scene.communication.statusMaxAge=6;scene.tasks=[...scene.tasks.slice(0,1),...['zeta','Alpha','alpha'].map(id=>({id,name:id,behavior:'survey',capability:'inspect',role:'worker',target:[25,25],duration:2,dependsOn:[],priority:5,deadline:1000}))];
 scene.agents=['zRole','ARole','aRole'].map(role=>({role,label:role,count:1,mobility:'ground',capabilities:['inspect'],speed:3}));for(const task of scene.tasks)task.role='zRole';
 const w=E.create(42,'nearest',scene,{dispatchMode:'networked_reported'});bind(w);try{compare(w);for(let i=0;i<4;i++)E.step(w);const v=compare(w);assert.deepEqual(v.tasks.slice(0,3).map(t=>t.id),['zeta','Alpha','alpha']);assert.deepEqual(v.tasks[0].candidates.map(a=>a.id),['zRole-1','ARole-1','aRole-1']);for(let i=0;i<25;i++){if(i===0)for(const a of w.agents)assert(E.interruptCommunication(w,a.id,25).ok);E.step(w);compare(w)}assert(observation(w).reporting.fresh<observation(w).reporting.known)}finally{E.disposeWorld(w)}
}
assert.equal(hostPlans,0);console.log(JSON.stringify({scenarios,pairedFrames:frames,nativeReads:reads,hostPlans,outcomes}));
console.log('Native coordinator reads: v1 wire parity across five dispatch modes, three execution modes/metrics, air/ground and real rays, resources, proposals, decisions, scan/sample/fixed sources, stable task ties and mixed-case report arrival ordering; detached/read-pure DTOs, private-state exclusion, identity/clock/prefix/closed guards and preserved revocation lease passed');
