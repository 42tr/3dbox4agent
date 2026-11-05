'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),WebSocket=require('ws'),E=require('../src/engine'),D=require('../src/surface-domain'),Replay=require('../src/replay'),PB=require('../src/stream-protobuf'),{createServer}=require('../server/world-server');
const scene=require('../examples/scenes/shore-surface.json');
async function request(base,route,method='GET',body,token){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error),{status:r.status});return v}
function live(server){return new Promise(r=>server.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+server.address().port)))}
async function sdk(base,s,agent,token,phase){const p=spawn('python3',['tests/surface_sdk_test.py'],{env:{...process.env,PYTHONPATH:'sdk/python'+(process.env.PYTHONPATH?path.delimiter+process.env.PYTHONPATH:''),URL:base,SID:s.sessionId,AGENT:agent,TOKEN:token,PHASE:phase},stdio:'inherit'});assert.equal(await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve)}),0)}
(async()=>{
 // Both full native and mixed ownership must use the configured domain.
 for(const options of [
  {physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust'},
  {physicsBackend:'rust',taskBackend:'rust',communicationBackend:'js',navigationBackend:'rust'},
  {physicsBackend:'rust',taskBackend:'js',communicationBackend:'rust',navigationBackend:'js'},
  {physicsBackend:'wasm',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust'},
 ]){
  const server=createServer(options),base=await live(server),owned=[];
  try{for(const physicsMode of ['kinematic','rapier']){
   const s=await request(base,'/sessions','POST',{sceneId:scene.id,physicsMode,sensorMode:physicsMode==='rapier'&&options.physicsBackend==='rust'?'rapier':'geometry'});owned.push(s);const root='/sessions/'+s.sessionId;
   const state=await request(base,root+'/step','POST',{count:700},s.adminToken);assert(state.world.done&&!state.world.failed);assert.equal(state.metrics.completed,7);
   const history=await request(base,root+'/history?after=-1','GET',undefined,s.adminToken);const frames=history.frames.map(f=>f.world);assert.equal(frames[0].tick,0);assert.equal(frames.at(-1).tick,state.world.tick);
   for(const w of frames)for(const a of w.agents)assert(D.bodyFree(w.surfaceDomain,a.mobility,[a.x,a.y]));assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{scene:s.scene,sceneId:scene.id,seed:42,policy:'nearest'},frames}));
   console.log(JSON.stringify({...options,physicsMode,tick:state.world.tick,completed:7,domainPreserved:true,frames:frames.length}));
  }}finally{for(const s of owned)await request(base,'/sessions/'+s.sessionId,'DELETE',undefined,s.adminToken);await new Promise(r=>server.close(r))}
 }
 // A primitive shoreline task through real scoped transports, journal fork and
 // read-only observer. The optional approach never replaces the task target.
 for(const sensorMode of ['geometry','rapier']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-surface-')),server=createServer({physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust',journalDir:dir,replayJournal:true}),base=await live(server),owned=[],sockets=[];
  try{
   const config=structuredClone(scene);config.tasks=[{id:'shore-work',name:'Shore work',behavior:'survey',role:'boat',capability:'survey',target:[45,50],duration:2,dependsOn:[]}];
   const s=await request(base,'/sessions','POST',{scene:config,physicsMode:'rapier',sensorMode,executionMode:'primitive'});owned.push(s);const root='/sessions/'+s.sessionId,post=(route,data)=>request(base,root+route,'POST',data,s.adminToken),get=()=>request(base,root,'GET',undefined,s.adminToken);
   let state=await post('/step',{count:1});const actor=state.world.tasks[0].assignee;assert(actor?.startsWith('boat-'));const credential=await post('/agents/'+actor+'/credentials',{}),observer=await post('/observer/credentials',{});
   const ownBefore=await request(base,root+'/observations/'+actor,'GET',undefined,credential.agentToken);await post('/roadblock',{rect:{x:46,y:2,w:2,h:96},duration:3});const ownAfter=await request(base,root+'/observations/'+actor,'GET',undefined,credential.agentToken);assert.deepEqual(ownAfter.assignedTasks[0].approachPoint,ownBefore.assignedTasks[0].approachPoint);assert.equal(ownAfter.self.returnEnergyEstimate,ownBefore.self.returnEnergyEstimate);
   const ws=new WebSocket(base.replace('http:','ws:')+'/stream'),packets=[];sockets.push(ws);ws.on('message',(data,binary)=>{assert(binary);packets.push(PB.decode(data))});await new Promise((resolve,reject)=>{ws.once('error',reject);ws.once('open',()=>{ws.send(JSON.stringify({type:'subscribe',sessionId:s.sessionId,token:credential.agentToken,afterRevision:-1,encoding:'protobuf-v2'}));resolve()})});
   await sdk(base,s,actor,credential.agentToken,'assigned');state=await post('/step',{count:100});assert.equal(state.world.actions[0].status,'completed');assert(!state.world.done);const original=await get();
   const branch=await request(base,'/event-journals/'+s.sessionId+'/fork','POST',{revision:state.revision},s.adminToken);owned.push(branch);assert.deepEqual(branch.world.surfaceDomain,original.world.surfaceDomain);await assert.rejects(request(base,'/sessions/'+branch.sessionId+'/observations/'+actor,'GET',undefined,credential.agentToken),e=>e.status===401);
   const branchCredential=await request(base,'/sessions/'+branch.sessionId+'/agents/'+actor+'/credentials','POST',{},branch.adminToken);await sdk(base,branch,actor,branchCredential.agentToken,'in_reach');const finishedBranch=await request(base,'/sessions/'+branch.sessionId+'/step','POST',{count:5},branch.adminToken);assert(finishedBranch.world.done&&!finishedBranch.world.failed);assert.deepEqual(await get(),original);
   await sdk(base,s,actor,credential.agentToken,'in_reach');state=await post('/step',{count:5});assert(state.world.done&&!state.world.failed);await sdk(base,s,actor,credential.agentToken,'done');
   for(const run of [s,branch]){const history=await request(base,'/sessions/'+run.sessionId+'/history?after=-1','GET',undefined,run.adminToken);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{scene:config,sceneId:config.id,seed:42,policy:'nearest'},frames:history.frames.map(f=>f.world)}))}
   const saved=await get();await assert.rejects(request(base,root+'/step','POST',{count:1},observer.observerToken),e=>e.status===403);assert.deepEqual(await get(),saved);
   if(!packets.some(p=>p.observation?.done))await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('surface stream timeout')),5000);ws.on('message',()=>{if(packets.some(p=>p.observation?.done)){clearTimeout(timer);resolve()}})});
   assert(packets.some(p=>p.observation?.assignedTasks.some(t=>t.approachPoint)));for(const p of packets.filter(p=>p.observation)){assert.equal(p.observation.self.id,actor);assert(!Object.hasOwn(p,'world'));assert(!Object.hasOwn(p.observation,'surfaceDomain'));assert(p.observation.assignedTasks.every(t=>t.id==='shore-work'))}ws.terminate();
   console.log(JSON.stringify({sensorMode,httpGrpcTypedAndBinaryOwnApproach:true,originalTargetPreserved:true,primitiveWorkCompleted:true,activeForkIsolated:true,replayValidated:true,observerReadOnly:true}));
  }finally{for(const ws of sockets)ws.terminate();for(const s of owned)await request(base,'/sessions/'+s.sessionId,'DELETE',undefined,s.adminToken).catch(()=>{});await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
