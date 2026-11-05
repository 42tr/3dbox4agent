'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Nav=require('../src/navigation'),Replay=require('../src/replay'),Wasm=require('../server/physics'),Rust=require('../server/rust-physics');
let frames=0,cases=0,replans=0;const missions=[];
function bind(w){const stores={};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources'],['peer','bindWorldPeer'],['reports','bindWorldReports'],['dispatch','bindWorldDispatch'],['perceptions','bindWorldPerceptions'],['requests','bindWorldRequests']]){const s=require('../server/rust-world-'+name).create(w);stores[name]=s;E[method](w,s);if(name==='ledger'){stores.control=s.control(w);E.bindWorldControl(w,stores.control)}if(name==='motion'){stores.execution=s.execution(w);E.bindWorldExecution(w,stores.execution)}}return stores}
function scene(behavior,air=false){const s=E.getScene('lunar-outpost-v1'),t=s.tasks.find(t=>t.behavior===behavior);s.obstacles=[];s.terrain=[];s.resource={warehouse:behavior==='deliver'?[60,50]:[20,20],site:behavior==='deliver'?[80,50]:[60,50]};s.agents=[{role:'worker',label:'Worker',count:1,mobility:'ground',capabilities:[t.capability],speed:2},{role:'parked',label:'Parked',count:1,mobility:air?'air':'ground',capabilities:['hold'],speed:1}];s.tasks=[{...t,role:'worker',target:s.resource.site.slice(),duration:2,dependsOn:[]}];return s}
function prepare(w,behavior,kind){Object.assign(w.agents[0],{x:40,y:50,battery:100,initialBattery:100});Object.assign(w.agents[1],{x:60,y:50,battery:100,initialBattery:100});if(kind==='fault')Object.assign(w.agents[1],{disabled:true,status:'fault'});if(behavior==='repair'){w.asset.diagnosis='confirmed';w.part.location='site';w.part.position=w.part.site.slice()}if(behavior==='verify'){w.asset.diagnosis='confirmed';w.asset.condition='repaired';Object.assign(w.part,{location:'consumed',position:null})}}
function equal(a,b){assert.deepEqual(E.snapshot(b),E.snapshot(a));for(const actor of a.agents)assert.deepEqual(E.observe(b,actor.id),E.observe(a,actor.id))}
function workIntent(w,mode,index){const t=w.tasks[0],a=w.agents[0];if(t.status!=='active'||a.status!=='assigned'||w.actions.some(x=>x.agentId===a.id&&['pending','accepted'].includes(x.status)))return;const info=E.observe(w,a.id).assignedTasks[0];const type=mode==='agent'?'execute_task':info.withinReach?'work_task':'move',extra=type==='move'?{target:{x:info.waypoint[0],y:info.waypoint[1]}}:{taskId:t.id};const r=E.submitAction(w,a.id,{requestId:'intent-'+index,type,targetTick:w.tick+1,expiresTick:w.tick+100,...extra});assert(r.ok,JSON.stringify({mode,tick:w.tick,type,reason:r.reason}))}
(async()=>{
 await Wasm.initialize();
 for(const physical of [Wasm,Rust])for(const behavior of ['survey','sample','detect','confirm','deliver','repair','verify'])for(const mode of ['auto','agent','primitive'])for(const kind of ['idle','fault','air']){
  const config=scene(behavior,kind==='air'),a=E.create(42,'nearest',config,{physicsMode:'rapier',dispatchMode:'external',executionMode:mode});prepare(a,behavior,kind);const b=E.snapshot(a),worlds=[a,b],physics=worlds.map(w=>physical.createPhysics(w));bind(b);let reachedWork=false;
  try{
   for(const w of worlds)assert(E.assign(w,w.tasks[0].id,w.agents[0].id).ok);equal(a,b);
   const blocker=JSON.parse(JSON.stringify(a.agents[1]));
   for(let n=0;n<220&&!a.done;n++){
    if(mode!=='auto')for(const w of worlds)workIntent(w,mode,n);
    E.step(a,physics[0]);E.step(b,physics[1]);frames++;equal(a,b);
    for(const w of worlds){const {activity,...parked}=JSON.parse(JSON.stringify(w.agents[1])),{activity:initialActivity,...initialParked}=blocker;assert.deepEqual(parked,initialParked,'parked body and equipment state must stay unchanged');assert.equal(activity[kind==='fault'?'unavailable':'idle'],w.tick);const worker=w.agents[0],target=w.tasks[0].behavior==='deliver'&&['to_pickup','loading'].includes(w.tasks[0].phase)?w.chargingStation:w.tasks[0].target;
     if(kind!=='air')assert(Math.hypot(worker.x-blocker.x,worker.y-blocker.y)>1.55,'ground bodies overlap');
     if(worker.work>0){assert(Math.hypot(worker.x-target[0],worker.y-target[1])<=4+1e-9);assert(Nav.clearSegment([worker.x,worker.y],target,w.obstacles,0));reachedWork=true}
    }
   }
   assert(a.done&&!a.failed,`${physical===Rust?'rust':'wasm'}/${behavior}/${mode}/${kind}`);assert(reachedWork);assert.equal(a.tasks[0].status,'done');assert.equal(a.events.filter(e=>e.kind==='task_completed').length,1);
   if(kind==='idle'&&mode!=='primitive'&&behavior!=='repair')assert(a.events.some(e=>e.kind==='collision_replan'),'healthy parked body needs a reachable work approach');
   if(kind==='air')assert.equal(a.events.filter(e=>e.kind==='collision_replan').length,0);
   replans+=a.events.filter(e=>e.kind==='collision_replan').length;
   assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:config.id,scene:config},frames:[E.snapshot(b)]}));cases++;
  }finally{E.disposeWorld(b);physics.forEach(p=>p.free())}
 }
 // Full lunar missions exercise shared targets among multiple healthy bodies.
 for(const physical of [Wasm,Rust])for(const policy of ['nearest','battery'])for(const dispatchMode of ['rule','networked']){
  const config=E.getScene('lunar-outpost-v1'),a=E.create(42,policy,config,{physicsMode:'rapier',dispatchMode}),b=E.snapshot(a),physics=[a,b].map(w=>physical.createPhysics(w));bind(b);
  try{for(let n=0;n<650&&!a.done;n++){E.step(a,physics[0]);E.step(b,physics[1]);frames++;equal(a,b);for(let i=0;i<a.agents.length;i++)for(let j=i+1;j<a.agents.length;j++)assert(Math.hypot(a.agents[i].x-a.agents[j].x,a.agents[i].y-a.agents[j].y)>1.55)}assert(a.done&&!a.failed,`${physical===Rust?'rust':'wasm'}/${policy}/${dispatchMode} lunar completion`);assert(a.tasks.every(t=>t.status==='done'));assert.equal(a.asset.condition,'operational');assert.equal(a.part.location,'consumed');assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy,sceneId:config.id,scene:config},frames:[E.snapshot(b)]}));missions.push({physics:physical===Rust?'rust':'wasm',policy,dispatchMode,tick:a.tick,completed:7});cases++;}finally{E.disposeWorld(b);physics.forEach(p=>p.free())}
 }
 // A standalone move still requires its exact destination; proximity to another
 // body is not permission to complete it as a task operation.
 for(const physical of [Wasm,Rust]){
  const config=scene('survey'),w=E.create(42,'nearest',config,{physicsMode:'rapier',dispatchMode:'external'});prepare(w,'survey','idle');const p=physical.createPhysics(w);try{assert(E.submitAction(w,'worker-1',{requestId:'exact-move',type:'move',target:{x:60,y:50},targetTick:1,expiresTick:100}).ok);for(let i=0;i<150&&w.actions[0].status!=='failed';i++)E.step(w,p);assert.equal(w.actions[0].reason,'collision_blocked');assert.equal(w.tasks[0].status,'pending');assert(Math.hypot(w.agents[0].x-60,w.agents[0].y-50)>1.55)}finally{p.free()}
 }
 // Static barriers still exclude unreachable work; no completion through walls.
 {const config=scene('survey');config.obstacles=[{id:'wall',x:55,y:0,w:2,h:100,height:5}];const a=E.create(42,'nearest',config,{dispatchMode:'external'});prepare(a,'survey','idle');const b=E.snapshot(a);bind(b);try{for(const w of [a,b]){const r=E.assign(w,w.tasks[0].id,'worker-1');assert(!r.ok);assert.equal(r.reason,'unreachable_target');assert.equal(w.agents[0].x,40);assert.equal(w.tasks[0].status,'pending');assert.equal(w.events.length,0)}equal(a,b)}finally{E.disposeWorld(b)}}
 console.log('Natural lunar missions '+JSON.stringify(missions));
 console.log(`Occupied task target: ${cases} scenarios, ${frames} paired frames and ${replans} collision replans; seven behaviors, auto/agent/primitive, idle/retired/air bodies, WASM and native Rapier, exact native/scoped parity, unchanged parked equipment, no overlap, work-radius/line checks, cargo/replay and strict standalone moves passed`);
})().catch(e=>{console.error(e);process.exitCode=1});
