'use strict';
require('./native-phase-http-support')(); // Explicit leaf-phase HTTP compatibility fixture.
const acceptedFrameProbe=require('./native-commit-probe');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),E=require('../src/engine'),Replay=require('../src/replay'),Actions=require('../server/rust-world-actions'),Control=require('../server/rust-world-control'),Ledger=require('../server/rust-world-ledger'),{createServer}=require('../server/world-server');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-stationary-')),originalActions=Actions.create,originalControl=Control.create,originalLedger=Ledger.create;
 const inspectFree=new WeakSet(),restored=[],staged=[];let failKind=null;
 Actions.create=w=>{const store=originalActions(w);return {...store,get views(){return store.views},stationary(index,...args){const effects=store.stationary(index,...args),action=w.actions[index];if(action.type===failKind&&action.status==='completed'){inspectFree.add(w);staged.push(E.snapshot(w));throw Error('host failure after native stationary commit')}return effects}}};
 Ledger.create=w=>{const l=originalLedger(w);return {...l,get tick(){return l.tick},get done(){return l.done},get failed(){return l.failed},get events(){return l.events},control(world){return l.control.call(this,world)},free(){if(inspectFree.has(w))restored.push(E.snapshot(w));l.free()}}};
 const beforeActionProbe=Control.create;Control.create=(w,...args)=>acceptedFrameProbe(beforeActionProbe(w,...args),w,()=>!!failKind,(before,after)=>{if(after.actions.some((a,i)=>a.type===failKind&&a.status==='completed'&&before.actions[i].status!=='completed')){inspectFree.add(w);staged.push(E.snapshot(w));throw Error('post native stationary batch commit')}});
 const server=createServer({physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust',journalDir:dir,replayJournal:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,sessions=[];
 async function req(route,method='GET',body,token){const r=await fetch(base+route,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return [r.status,await r.json()]}
 const root=s=>'/sessions/'+s.sessionId;
 async function create(input){const [code,s]=await req('/sessions','POST',{physicsMode:'rapier',sensorMode:'rapier',dispatchMode:'external',...input});assert.equal(code,201,JSON.stringify(s));assert.equal(s.recordingContext.runtime.worldStationaryVersion,1);sessions.push(s);return s}
 async function fork(s,revision){const [code,f]=await req('/event-journals/'+s.sessionId+'/fork','POST',{revision},s.adminToken);assert.equal(code,201,JSON.stringify(f));sessions.push(f);return f}
 async function checkFrozen(s,before,view){const [,state]=await req(root(s),'GET',undefined,s.adminToken);assert.deepEqual(state.world,before.world);assert.deepEqual(restored.at(-1),before.world);assert.equal(state.revision,before.revision);assert.equal(state.simulationError,'world_step_failed');assert.deepEqual((await req(root(s)+'/observations/'+before.world.agents[0].id,'GET',undefined,s.adminToken))[1],{...view,sessionError:'world_step_failed',simulationError:'world_step_failed'});assert.equal((await req(root(s)+'/step','POST',{count:1},s.adminToken))[0],503)}
 try{
  const scene=E.getScene();scene.obstacles=[];const spawn=E.create(42).agents[0];scene.resource.site=[spawn.x+3,spawn.y];
  const scan=await create({scene}),actor=scan.world.agents[0].id;
  assert.equal((await req(root(scan)+'/agents/'+actor+'/actions','POST',{requestId:'scan',type:'scan',targetTick:1,expiresTick:100},scan.adminToken))[0],200);
  const [,before]=await req(root(scan)+'/step','POST',{count:2},scan.adminToken),[,view]=await req(root(scan)+'/observations/'+actor,'GET',undefined,scan.adminToken);failKind='scan';
  assert.equal((await req(root(scan)+'/step','POST',{count:1},scan.adminToken))[0],503);failKind=null;assert.equal(staged.at(-1).actions[0].result.kind,'anomaly');assert.equal(staged.at(-1).actions[0].status,'completed');await checkFrozen(scan,before,view);
  const scanFork=await fork(scan,before.revision),[,scanned]=await req(root(scanFork)+'/step','POST',{count:1},scanFork.adminToken);assert.equal(scanned.world.actions[0].status,'completed');assert.equal(scanned.world.actions[0].result.kind,'anomaly');
  assert.equal((await req(root(scanFork)+'/agents/'+actor+'/evidence','POST',{requestId:'evidence',scanRequestId:'scan'},scanFork.adminToken))[0],200);
  const seed=42,chargeScene=E.getScene();chargeScene.obstacles=[];chargeScene.agents[0].workEnergyPerTick=5;chargeScene.tasks.find(t=>t.id==='inspect').duration=1;const start=E.create(seed).agents[0];chargeScene.resource.warehouse=[start.x,start.y];
  const charge=await create({scene:chargeScene,seed,executionMode:'agent'}),id=charge.world.agents[0].id;
  let currentTick=0;for(let i=0;i<2;i++){assert.equal((await req(root(charge)+'/agents/'+id+'/actions','POST',{requestId:'warmup-'+i,type:'scan',targetTick:currentTick+1,expiresTick:currentTick+100},charge.adminToken))[0],200);const [code,next]=await req(root(charge)+'/step','POST',{count:3},charge.adminToken);assert.equal(code,200);currentTick=next.world.tick;}
  assert.equal((await req(root(charge)+'/assign','POST',{taskId:'inspect',agentId:id},charge.adminToken))[0],200);
  assert.equal((await req(root(charge)+'/agents/'+id+'/actions','POST',{requestId:'charge',type:'charge',targetTick:currentTick+1,expiresTick:currentTick+100},charge.adminToken))[0],200);
  let [,saved]=await req(root(charge),'GET',undefined,charge.adminToken);failKind='charge';let refused=false;
  for(let i=0;i<45;i++){const [code,next]=await req(root(charge)+'/step','POST',{count:1},charge.adminToken);if(code===503){refused=true;break}assert.equal(code,200);saved=next}
  failKind=null;assert(refused);const [,savedView]=await req(root(charge)+'/observations/'+id,'GET',undefined,charge.adminToken);
  // The failed response already carries failure flags; compare its underlying
  // scoped fields with the committed frame through a temporary independent fork.
  const chargeFork=await fork(charge,saved.revision),[,forkView]=await req(root(chargeFork)+'/observations/'+id,'GET',undefined,chargeFork.adminToken);await checkFrozen(charge,saved,forkView);assert.equal(savedView.sessionError,'world_step_failed');
  assert.equal(staged.at(-1).agents[0].battery,80);assert.equal(staged.at(-1).agents[0].status,'assigned');assert.equal(staged.at(-1).agents[0].taskNeedsRoute,true);
  const [,charged]=await req(root(chargeFork)+'/step','POST',{count:1},chargeFork.adminToken);assert.equal(charged.world.actions.find(a=>a.requestId==='charge').status,'completed');assert.equal(charged.world.agents[0].status,'assigned');assert.equal(charged.world.agents[0].taskNeedsRoute,true);
  assert.equal((await req(root(chargeFork)+'/agents/'+id+'/actions','POST',{requestId:'resume',type:'execute_task',taskId:'inspect',targetTick:charged.world.tick+1,expiresTick:charged.world.tick+100},chargeFork.adminToken))[0],200);
  const [code,worked]=await req(root(chargeFork)+'/step','POST',{count:100},chargeFork.adminToken);assert.equal(code,200);assert.equal(worked.world.tasks.find(t=>t.id==='inspect').status,'done');
  assert.equal(staged.length,2);assert.equal(restored.length,2);
  for(const s of sessions){const [,history]=await req(root(s)+'/history?after=-1','GET',undefined,s.adminToken);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:s.world.seed,policy:'nearest',sceneId:s.world.sceneId,scene:s.scene},frames:history.frames.map(f=>f.world)}));assert.equal((await req(root(s),'DELETE',undefined,s.adminToken))[0],200)}
  console.log('HTTP failures after native scan result and assigned charge completion restore raw committed/scoped state; independent journal branches scan/report, recharge/resume task and validate replay with native provenance');
 }finally{failKind=null;Actions.create=originalActions;Control.create=originalControl;Ledger.create=originalLedger;await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
