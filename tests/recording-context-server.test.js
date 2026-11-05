'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../src/recording-context'),R=require('../src/replay'),{createServer}=require('../server/world-server');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-recording-'));let server,base;
 async function start(options={}){server=createServer({journalDir:dir,replayJournal:true,catalogPath:path.join(dir,'catalog.sqlite3'),...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`}
 async function stop(){if(server?.listening)await new Promise(r=>server.close(r))}
 async function request(route,method='GET',body,token){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return [r.status,await r.json()]}
 async function required(...args){const [status,value]=await request(...args);assert(status>=200&&status<300,JSON.stringify({route:args[0],status,error:value.error}));return value}
 try{
  for(const backend of ['js','rust']){
   const options=backend==='rust'?{physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust'}:{};
   await start(options);const health=await required('/health');
   const created=await required('/sessions','POST',{seed:42,physicsMode:'rapier'}),root='/sessions/'+created.sessionId,token=created.adminToken,ctx=C.fromSession(created);
   assert.equal(ctx.sessionId,created.sessionId);assert.equal(ctx.runtime.instanceId,health.runtime.instanceId);assert.equal(ctx.runtime.navigationBackend,backend);assert.equal(ctx.runtime.worldLedgerBackend,backend);assert.equal(ctx.runtime.worldMotionBackend,backend);assert.equal(ctx.runtime.worldTasksBackend,backend);assert.equal(ctx.runtime.worldExecutionBackend,backend);assert.equal(ctx.runtime.worldActionsBackend,backend);assert.equal(health.features.worldActions,backend==='rust'?1:0);assert.equal(health.features.worldExecution,backend==='rust'?1:0);assert.equal(health.features.worldTasks,backend==='rust'?1:0);assert.equal(health.features.worldMotion,backend==='rust'?1:0);assert.equal(health.features.worldLedger,backend==='rust'?1:0);assert.equal(ctx.runtime.physicsBackend,backend==='rust'?'rust':'wasm');assert(ctx.runtime.sourceSha256['src/recording-context.js']);assert(!JSON.stringify(ctx).includes(token));
   const adminRead=await required(root+'/recording-context','GET',undefined,token);assert.deepEqual(C.fromSession(adminRead),ctx);
   assert.equal((await request(root+'/recording-context'))[0],401);
   const agent=await required(root+'/agents/drone-1/credentials','POST',{},token),coordinator=await required(root+'/coordinator/credentials','POST',{},token);
   for(const credential of [agent.agentToken,coordinator.coordinatorToken])assert.equal((await request(root+'/recording-context','GET',undefined,credential))[0],403);
   const saved=await required(root+'/catalog','POST',{label:'runtime context'},token),archive=await required(root+'/catalog/'+saved.report.id,'GET',undefined,token);assert.deepEqual(archive.recordingContext,ctx);assert(R.validateArchive(archive));assert.equal(archive.coverage.start,'complete');
   const fork=await required('/event-journals/'+created.sessionId+'/fork','POST',{revision:0},token),forkRoot='/sessions/'+fork.sessionId,branch=C.fromSession(fork);
   assert.equal(branch.forkedFrom.sessionId,created.sessionId);assert.equal(branch.forkedFrom.revision,0);assert.equal(branch.runtime.instanceId,ctx.runtime.instanceId);assert.notEqual(branch.sessionId,ctx.sessionId);assert(!JSON.stringify(branch).includes(fork.adminToken));
   const branchSave=await required(forkRoot+'/catalog','POST',{label:'branch context'},fork.adminToken),branchArchive=await required(forkRoot+'/catalog/'+branchSave.report.id,'GET',undefined,fork.adminToken);assert.equal(branchArchive.frames[0].tick,0);assert.equal(branchArchive.coverage.start,'partial');assert.deepEqual(branchArchive.recordingContext,branch);assert(R.validateArchive(branchArchive));
   const page=await required('/event-journals/'+created.sessionId+'/replay?after=-1&limit=1','GET',undefined,token);assert.deepEqual(C.fromJournal(created.sessionId,page.metadata),ctx);
   await required(root,'DELETE',undefined,token);await stop();await start(options);
   const restored=await required('/event-journals/'+created.sessionId+'/fork','POST',{revision:0},token),restoredContext=C.fromSession(restored);assert.notEqual(restoredContext.runtime.instanceId,ctx.runtime.instanceId);assert.equal(restoredContext.forkedFrom.sessionId,created.sessionId);
   const oldPage=await required('/event-journals/'+created.sessionId+'/replay?after=-1&limit=1','GET',undefined,token);assert.deepEqual(C.fromJournal(created.sessionId,oldPage.metadata),ctx);await stop();
  }
  await start({maxHistoryBytes:1});const created=await required('/sessions','POST',{seed:45}),root='/sessions/'+created.sessionId;await required(root+'/step','POST',{count:3},created.adminToken);const saved=await required(root+'/catalog','POST',{label:'partial'},created.adminToken),archive=await required(root+'/catalog/'+saved.report.id,'GET',undefined,created.adminToken);assert.equal(archive.coverage.start,'partial');assert.equal(archive.frames.length,1);assert.equal(archive.recordingContext.sessionId,created.sessionId);assert(R.validateArchive(archive));
  console.log('session-bound runtimes, admin access, persistent catalog, restart and branch provenance passed');
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
