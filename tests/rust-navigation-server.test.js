'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const E=require('../src/engine'),Replay=require('../src/replay'),Rust=require('../server/rust-navigation'),{createServer}=require('../server/world-server');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-native-navigation-'));let server,base;
 const options={physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust',journalDir:dir,replayJournal:true};
 async function start(extra={}){server=createServer({...options,...extra});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`}
 async function stop(){if(server?.listening)await new Promise(r=>server.close(r))}
 async function request(route,method='GET',body,token){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return [r.status,await r.json()]}
 async function required(...args){const [status,value]=await request(...args);assert(status>=200&&status<300,JSON.stringify({route:args[0],status,value}));return value}
 function scene(target=[80,50]){const s=E.getScene();s.id='native-navigation';s.navigation='energy';s.resource={warehouse:[20,50],site:[80,50]};s.obstacles=[{id:'wall',x:40,y:20,w:20,h:50,height:5}];s.agents=[{role:'carrier',label:'巡检车',count:1,mobility:'ground',capabilities:['inspect'],speed:3}];s.tasks=[{id:'survey',name:'巡检',behavior:'survey',role:'carrier',capability:'inspect',target,duration:2,dependsOn:[]}];s.terrain=[{id:'rough',name:'地表',x:60,y:10,w:15,h:80,speedFactor:.5,energyFactor:2}];return s}
 let saved,checkpoint,sourceRoot;
 try{
  await start();const runtime=(await required('/health')).runtime;assert.equal(runtime.navigationBackend,'rust');assert(runtime.sourceSha256['rust/physics/src/navigation.rs']);assert(runtime.sourceSha256['server/rust-navigation.js']);
  saved=await required('/sessions','POST',{scene:scene(),physicsMode:'rapier',sensorMode:'rapier',dispatchMode:'external'});sourceRoot='/sessions/'+saved.sessionId;
  await required(sourceRoot+'/assign','POST',{taskId:'survey',agentId:'carrier-1'},saved.adminToken);
  await required(sourceRoot+'/roadblock','POST',{rect:{x:50,y:0,w:8,h:100},duration:5},saved.adminToken);
  await required(sourceRoot+'/terrain-effect','POST',{zoneId:'rough',duration:9,speedFactor:.5,energyFactor:1.8},saved.adminToken);
  checkpoint=await required(sourceRoot+'/step','POST',{count:3},saved.adminToken);assert(checkpoint.world.agents[0].roadblockWait);
  const agent=await required(sourceRoot+'/agents/carrier-1/credentials','POST',{},saved.adminToken);
  assert((await required(sourceRoot+'/observations/carrier-1','GET',undefined,agent.agentToken)).self.returnEnergyEstimate>0);
  const result=await required(sourceRoot+'/step','POST',{count:150},saved.adminToken);assert(result.world.done&&!result.world.failed);
  const history=await required(sourceRoot+'/history?after=-1','GET',undefined,saved.adminToken);
  Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:saved.scene.id,scene:saved.scene},frames:history.frames.map(f=>f.world)});
  await required(sourceRoot,'DELETE',undefined,saved.adminToken);await stop();
  await start({navigationBackend:'js'});let [status,error]=await request('/event-journals/'+saved.sessionId+'/fork','POST',{revision:checkpoint.revision},saved.adminToken);assert.equal(status,409);assert.equal(error.error,'fork_runtime_mismatch');await stop();
  await start();const fork=await required('/event-journals/'+saved.sessionId+'/fork','POST',{revision:checkpoint.revision},saved.adminToken);assert.deepEqual(fork.world,checkpoint.world);
  const completed=await required('/sessions/'+fork.sessionId+'/step','POST',{count:150},fork.adminToken);assert(completed.world.done&&!completed.world.failed);
  await required('/sessions/'+fork.sessionId,'DELETE',undefined,fork.adminToken);

  // Native activation also owns its initial route now. A failing host adapter
  // must not prevent the real native move from being accepted.
  const broken=await required('/sessions','POST',{scene:scene([80,50]),physicsMode:'rapier',dispatchMode:'external'});
  const healthy=await required('/sessions','POST',{scene:scene([80,60]),physicsMode:'rapier',dispatchMode:'external'});
  for(const [s,target]of [[broken,[80,50]],[healthy,[80,60]]])await required('/sessions/'+s.sessionId+'/agents/carrier-1/actions','POST',{requestId:'independent-move',type:'move',target:{x:target[0],y:target[1]},targetTick:1,expiresTick:100},s.adminToken);
  const original=Rust.plan;let failedHostCalls=0;Rust.plan=(start,target,...rest)=>{if(target[0]===80&&target[1]===50){failedHostCalls++;throw Error('injected native navigation failure')}return original(start,target,...rest)};
  try{
   const native=await required('/sessions/'+broken.sessionId+'/step','POST',{count:1},broken.adminToken);assert.equal(native.world.actions[0].status,'accepted');assert(!native.sessionError);assert.equal(failedHostCalls,0);
   const advanced=await required('/sessions/'+healthy.sessionId+'/step','POST',{count:5},healthy.adminToken);assert.equal(advanced.world.tick,5);assert(!advanced.sessionError);
  }finally{Rust.plan=original}
  // Mixed task ownership still uses the host adapter. Keep its original
  // failure-isolation assertion instead of dropping the negative path.
  await stop();await start({taskBackend:'js'});
  const mixedBroken=await required('/sessions','POST',{scene:scene([80,50]),physicsMode:'rapier',dispatchMode:'external'}),mixedHealthy=await required('/sessions','POST',{scene:scene([80,60]),physicsMode:'rapier',dispatchMode:'external'});
  for(const [s,target]of [[mixedBroken,[80,50]],[mixedHealthy,[80,60]]])await required('/sessions/'+s.sessionId+'/agents/carrier-1/actions','POST',{requestId:'mixed-move',type:'move',target:{x:target[0],y:target[1]},targetTick:1,expiresTick:100},s.adminToken);
  const beforeMixed=await required('/sessions/'+mixedBroken.sessionId,'GET',undefined,mixedBroken.adminToken);
  Rust.plan=(start,target,...rest)=>{if(target[0]===80&&target[1]===50){failedHostCalls++;throw Error('injected mixed navigation failure')}return original(start,target,...rest)};
  try{
   [status,error]=await request('/sessions/'+mixedBroken.sessionId+'/step','POST',{count:1},mixedBroken.adminToken);assert.equal(status,503);assert.equal(error.error,'world_step_failed');assert(failedHostCalls>0);
   const failed=await required('/sessions/'+mixedBroken.sessionId,'GET',undefined,mixedBroken.adminToken);assert.equal(failed.sessionError,'world_step_failed');assert.deepEqual(failed.world,beforeMixed.world);
   const advanced=await required('/sessions/'+mixedHealthy.sessionId+'/step','POST',{count:5},mixedHealthy.adminToken);assert.equal(advanced.world.tick,5);assert(!advanced.sessionError);
  }finally{Rust.plan=original}
  await stop();await start({physicsBackend:'wasm',taskBackend:'js',communicationBackend:'js'});
  const independent=(await required('/health')).runtime;assert.equal(independent.navigationBackend,'rust');assert.equal(independent.taskBackend,'js');assert.equal(independent.physicsBackend,'wasm');
  const plain=await required('/sessions','POST',{scene:scene(),physicsMode:'kinematic'});
  const plainDone=await required('/sessions/'+plain.sessionId+'/step','POST',{count:150},plain.adminToken);assert(plainDone.world.done&&!plainDone.world.failed);
  console.log('Rust navigation with Rapier/rays, terrain and roadblocks, history, backend-specific forks, native activation without host planning and mixed-backend planner failure isolation passed');
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
