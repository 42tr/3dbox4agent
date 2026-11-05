'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),Nav=require('../src/navigation'),C=require('../server/native-components');
const keys=['execution','environment','resources','tasks','control','ledger'];let frames=0,admissions=0,hostPlans=0;const outcomes=[];
function raw(stores){return Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native]))}
function hashes(stores){return Object.entries(raw(stores)).map(([k,n])=>crypto.createHash('sha256').update(k==='execution'?n.snapshot()+n.snapshotExecution():n.snapshot()).digest('hex'))}
function bind(w){
 const stores={};
 for(const[name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources']]){
  const s=require('../server/rust-world-'+name).create(w);stores[name]=s;
  if(name==='tasks')E[method](w,{...s,get views(){return s.views},assign(...args){
   assert.equal(args.length,8);E.bindNavigation(w,{plan(){hostPlans++;throw Error('host assignment planner invoked')}},true);
   try{const result=s.assign(...args,()=>{hostPlans++;throw Error('host assignment callback invoked')});assert(result.published);admissions++;return result}finally{E.bindNavigation(w,{plan:Nav.plan},true)}
  }});else E[method](w,s);
  if(name==='ledger'){stores.control=s.control(w);E.bindWorldControl(w,stores.control)}
  if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}
 }
 return stores;
}
function config(behavior,metric,air,variant='normal'){
 const s=E.getScene('lunar-outpost-v1'),t=s.tasks.find(t=>t.behavior===behavior);s.navigation=metric;s.obstacles=[{id:'static',x:45,y:25,w:6,h:40,height:8}];s.riskNavigation='avoid';s.riskZones=[{id:'risk',name:'Risk',x:62,y:20,w:7,h:35}];s.terrain=[{id:'slow',name:'Slow terrain',x:30,y:10,w:18,h:75,speedFactor:.5,energyFactor:2}];
 s.agents=[{role:'worker',label:'Worker',count:1,mobility:air?'air':'ground',capabilities:[t.capability],speed:2}];s.tasks=[{...t,role:'worker',target:[80,70],duration:3,dependsOn:[]}];s.resource={warehouse:variant==='pickup-blocked'?[75,20]:[35,20],site:[80,70]};
 if(['pickup-blocked','second-blocked'].includes(variant))s.obstacles=[{id:'closed',x:55,y:0,w:4,h:100,height:8}];return s;
}
function prepare(w,behavior,variant){
 Object.assign(w.agents[0],{x:20,y:40});if(behavior==='repair'){w.asset.diagnosis='confirmed';Object.assign(w.part,{location:'site',position:w.tasks[0].target.slice()})}if(behavior==='verify'){Object.assign(w.asset,{condition:'repaired',diagnosis:'confirmed'});Object.assign(w.part,{location:'consumed',position:null})}
 if(variant==='ground')w.part.location='ground';if(variant==='closure')assert(E.injectRoadblock(w,{x:55,y:0,w:4,h:100},7).ok);if(variant==='effect')assert(E.injectTerrainEffect(w,'slow',7,.4,2).ok);
}
const matrix=[];for(const behavior of ['survey','sample','detect','confirm','deliver','repair','verify'])for(const mode of ['auto','agent','primitive'])for(const metric of ['distance','time','energy'])for(const air of [false,true])matrix.push({behavior,mode,metric,air,variant:'normal'});
for(const variant of ['ground','pickup-blocked','second-blocked','closure','effect'])for(const mode of ['pickup-blocked','second-blocked','closure'].includes(variant)?['auto','agent','primitive']:['auto'])for(const metric of ['distance','time','energy'])for(const air of [false,true])matrix.push({behavior:'deliver',mode,metric,air,variant});
for(const item of matrix){
 const{behavior,mode,metric,air,variant}=item,a=E.create(42,'nearest',config(behavior,metric,air,variant),{dispatchMode:'external',executionMode:mode});prepare(a,behavior,variant);const b=E.snapshot(a),stores=bind(b);
 try{
  const task=a.tasks[0].id,r=E.assign(b,task,'worker-1');assert.deepEqual(r,E.assign(a,task,'worker-1'));const unreachable=!air&&['pickup-blocked','second-blocked','closure'].includes(variant);assert.equal(r.ok,!unreachable);if(unreachable)assert.equal(r.reason,'unreachable_target');else{assert.equal(b.tasks[0].assignmentId,b.events.at(-1).seq);if(mode==='primitive')assert.deepEqual(b.agents[0].route,[]);else if(behavior==='deliver')assert.deepEqual(b.agents[0].route.at(-1),b.part.position)}
  assert.deepEqual(E.snapshot(b),E.snapshot(a),JSON.stringify(item));for(let n=0;n<4;n++){E.step(a);E.step(b);frames++;assert.deepEqual(E.snapshot(b),E.snapshot(a),JSON.stringify(item));assert.deepEqual(E.observe(b,'worker-1'),E.observe(a,'worker-1'))}
  outcomes.push({...item,ok:r.ok,reason:r.reason??null});
 }finally{E.disposeWorld(b)}
}
// Repeated late native refusal must preserve a public prepared lease, as well
// as serialized state. The public commit must still reach its ledger gate.
{
 const w=E.create(42,'nearest',config('survey','distance',false),{dispatchMode:'external'});prepare(w,'survey','normal');const stores=bind(w),r=raw(stores),refs=[r.execution,r.environment,r.resources,r.control,r.ledger],input=JSON.stringify({taskId:w.tasks[0].id,agentId:'worker-1'}),invoke=(tick=0,text=input,participants=refs)=>r.tasks.assignPlannedEvents(text,tick,...participants),before=hashes(stores);
 try{
  for(const tick of [-1,.5,1,NaN,Infinity]){assert.throws(()=>invoke(tick));assert.deepEqual(hashes(stores),before)}for(const text of ['{}','[]','null','{"taskId":"inspect","agentId":"worker-1","route":[[80,70]]}']){assert.throws(()=>invoke(0,text));assert.deepEqual(hashes(stores),before)}
  const lp=stores.ledger.checkpoint();r.ledger.append(JSON.stringify({message:'unacknowledged',type:'info'}));const unacked=hashes(stores);assert.throws(()=>invoke());assert.deepEqual(hashes(stores),unacked);stores.ledger.rollback(lp);lp.free();
  for(let n=0;n<200000;n++){const e=JSON.parse(r.ledger.append(JSON.stringify({message:'capacity',type:'info'})));r.control.observe(e.seq,r.ledger)}
  const ticket=r.tasks.prepareAssignment(input,0,...refs),lease=ticket.plan(),padded=hashes(stores),route=Nav.plan([20,40],[80,70],w.obstacles.concat(w.riskZones));
  try{for(let retry=0;retry<2;retry++){assert.throws(()=>invoke(),/invalid world ledger input/);assert.deepEqual(hashes(stores),padded);assert.equal(ticket.plan(),lease);assert.throws(()=>r.tasks.commitAssignmentEvents(ticket,JSON.stringify(route),...refs),/invalid world ledger input/);assert.deepEqual(hashes(stores),padded);assert.equal(ticket.plan(),lease)}}finally{ticket.free()}
 }finally{E.disposeWorld(w)}
}
assert.equal(hostPlans,0);assert.equal(admissions,192);assert.equal(outcomes.length,192);console.log(JSON.stringify({scenarios:outcomes.length,pairedFrames:frames,nativeAdmissions:admissions,hostPlans,outcomes}));
