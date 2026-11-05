'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),Nav=require('../src/navigation'),C=require('../server/native-components');
const keys=['execution','environment','resources','tasks','actions','control','ledger'];let frames=0,starts=0,hostPlans=0;const outcomes=[];
function hashes(stores){return keys.map(k=>{const n=C.reference(stores[k],k).native;return crypto.createHash('sha256').update(k==='execution'?n.snapshot()+n.snapshotExecution():n.snapshot()).digest('hex')})}
function bind(w){const stores={};for(const[name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources']]){const s=require('../server/rust-world-'+name).create(w);stores[name]=s;if(name==='actions'){E[method](w,{...s,get views(){return s.views},activate(...args){assert.equal(args.length,8);E.bindNavigation(w,{plan(){hostPlans++;throw Error('host activation planner invoked')}},true);try{const result=s.activate(...args,()=>{hostPlans++;throw Error('host activation callback invoked')});assert(result.published);starts++;return result}finally{E.bindNavigation(w,{plan:Nav.plan},true)}}})}else E[method](w,s);if(name==='ledger'){stores.control=s.control(w);E.bindWorldControl(w,stores.control)}if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}}return stores}
function config(kind,metric,air){const scene=E.getScene('lunar-outpost-v1');scene.navigation=metric;scene.obstacles=[{id:'static',x:45,y:25,w:6,h:40,height:8}];scene.riskNavigation='avoid';scene.riskZones=[{id:'risk',name:'Risk',x:62,y:20,w:7,h:35}];scene.terrain=[{id:'slow',name:'Slow terrain',x:30,y:10,w:18,h:75,speedFactor:.5,energyFactor:2}];scene.agents=[{role:'worker',label:'Worker',count:1,mobility:air?'air':'ground',capabilities:['inspect','deliver'],speed:2}];scene.tasks=[{id:'work',name:'Work',role:'worker',capability:kind==='delivery'?'deliver':'inspect',behavior:kind==='delivery'?'deliver':'survey',target:[80,70],duration:3,dependsOn:[]}];scene.resource={warehouse:[75,20],site:[80,70]};if(kind==='permanent')scene.obstacles=[{id:'closed',x:55,y:0,w:4,h:100,height:8}];return scene}
(async()=>{
 for(const metric of ['distance','time','energy'])for(const air of [false,true])for(const kind of ['move','charge','assigned-charge','resume','delivery','wait','permanent','effect']){
  const scene=config(kind,metric,air),mode=['resume','delivery','assigned-charge'].includes(kind)?'agent':'auto',a=E.create(42,'nearest',scene,{dispatchMode:'external',executionMode:mode});Object.assign(a.agents[0],{x:20,y:40,battery:50,initialBattery:50});
  if(['resume','delivery','assigned-charge'].includes(kind)){assert(E.assign(a,'work','worker-1').ok);if(kind!=='assigned-charge')Object.assign(a.agents[0],{taskNeedsRoute:true,route:[]})}
  if(['wait','permanent'].includes(kind))assert(E.injectRoadblock(a,{x:72,y:0,w:4,h:100},7).ok);
  if(kind==='effect')assert(E.injectTerrainEffect(a,'slow',7,.4,2).ok);
  const b=E.snapshot(a),stores=bind(b);try{
   for(const w of [a,b]){E.bindTaskRules(w,require('../server/rust-task-rules'));const type=['charge','assigned-charge'].includes(kind)?'charge':['resume','delivery'].includes(kind)?'execute_task':'move';assert(E.submitAction(w,'worker-1',{requestId:'intent',type,targetTick:1,expiresTick:100,...(type==='move'?{target:{x:80,y:70}}:type==='execute_task'?{taskId:'work'}:{})}).ok)}
   for(let n=0;n<4;n++){E.step(a);E.step(b);frames++;assert.deepEqual(E.snapshot(b),E.snapshot(a),[kind,metric,air,n].join('/'));assert.deepEqual(E.observe(b,'worker-1'),E.observe(a,'worker-1'))}
   const action=b.actions[0];assert.equal(action.status,kind==='permanent'&&!air?'rejected':'accepted');if(kind==='permanent'&&!air)assert.equal(action.reason,'unreachable_target');if(kind==='wait')assert.equal(!!b.agents[0].roadblockWait,!air);if(kind==='delivery')assert.equal(b.tasks[0].phase,'to_pickup');if(kind==='assigned-charge')assert.equal(action.resumeTaskId,'work');
   const raw=Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native])),refs=keys.slice(0,4).map(k=>raw[k]).concat([raw.control,raw.ledger]),before=hashes(stores);assert.throws(()=>raw.actions.activatePlannedEvents(0,b.tick,...refs));assert.deepEqual(hashes(stores),before);
   outcomes.push({kind,metric,air,status:action.status,wait:!!b.agents[0].roadblockWait});
  }finally{E.disposeWorld(b)}
 }
 // Keep a real public preparation lease live while native planning/commit
 // fails late. The old API must still reach its ledger gate, proving that the
 // failed private preparation did not overwrite the caller's lease identity.
 {
  const a=E.create(42,'nearest',config('move','distance',false),{dispatchMode:'external'});Object.assign(a.agents[0],{x:20,y:40});const stores=bind(a);
  try{
   assert(E.submitAction(a,'worker-1',{requestId:'lease',type:'move',target:{x:80,y:70},targetTick:1,expiresTick:100}).ok);
   stores.ledger.advance();stores.environment.expireRoadblocks(1);stores.environment.expireTerrain(1);
   const raw=Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native])),refs=[raw.execution,raw.environment,raw.resources,raw.tasks,raw.control,raw.ledger],invoke=(i=0,tick=1,r=refs)=>raw.actions.activatePlannedEvents(i,tick,...r),before=hashes(stores);
   for(const i of [-1,.5,99,NaN]){assert.throws(()=>invoke(i));assert.deepEqual(hashes(stores),before)}
   for(const tick of [-1,0,1.5,2,NaN,Infinity]){assert.throws(()=>invoke(0,tick));assert.deepEqual(hashes(stores),before)}
   const ledgerPoint=stores.ledger.checkpoint();raw.ledger.append(JSON.stringify({message:'unacknowledged',type:'info'}));const pending=hashes(stores);assert.throws(()=>invoke());assert.deepEqual(hashes(stores),pending);stores.ledger.rollback(ledgerPoint);ledgerPoint.free();
   for(let n=JSON.parse(raw.ledger.snapshot()).events.length;n<200000;n++){const e=JSON.parse(raw.ledger.append(JSON.stringify({message:'capacity',type:'info'})));raw.control.observe(e.seq,raw.ledger)}
   const ticket=raw.actions.prepareActivation(0,1,...refs),lease=ticket.plan(),padded=hashes(stores),route=Nav.plan([20,40],[80,70],a.obstacles.concat(a.riskZones));
   try{for(let retry=0;retry<2;retry++){assert.throws(()=>invoke(),/invalid world ledger input/);assert.deepEqual(hashes(stores),padded);assert.equal(ticket.plan(),lease);assert.throws(()=>raw.actions.commitActivationEvents(ticket,JSON.stringify({route,wait:false}),...refs),/invalid world ledger input/);assert.deepEqual(hashes(stores),padded);assert.equal(ticket.plan(),lease)}}finally{ticket.free()}
  }finally{E.disposeWorld(a)}
 }
 assert.equal(hostPlans,0);assert.equal(starts,48);assert.equal(outcomes.length,48);console.log(JSON.stringify({scenarios:outcomes.length,pairedFrames:frames,nativeStarts:starts,hostPlans,outcomes}));
})().catch(e=>{console.error(e);process.exitCode=1});
