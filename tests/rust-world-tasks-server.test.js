'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Tasks=require('../server/rust-world-tasks'),{createServer}=require('../server/world-server');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-tasks-failure-')),original=Tasks.create;let inject=false,rejected=false;
 Tasks.create=world=>{const store=original(world);return {checkpoint:store.checkpoint,rollback:p=>store.rollback(p),get views(){return store.views},snapshot:()=>store.snapshot(),free:()=>store.free(),append:task=>store.append(task),command:(id,kind,detail)=>{if(inject){rejected=true;return store.command(id,kind,{...detail,assignmentId:0})}return store.command(id,kind,detail)}}};
 const server=createServer({physicsBackend:'rust',taskBackend:'rust',journalDir:dir,replayJournal:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function req(p,method='GET',data,token){const r=await fetch(base+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});return [r.status,await r.json()]}
 try{
  const [,health]=await req('/health');assert.equal(health.runtime.worldTasksBackend,'rust');assert.equal(health.features.worldTasks,1);
  const [,a]=await req('/sessions','POST',{sceneId:'lunar-outpost-v1',physicsMode:'rapier'}),[,b]=await req('/sessions','POST',{dispatchMode:'external'}),root='/sessions/'+a.sessionId;assert.equal(a.recordingContext.runtime.worldTasksBackend,'rust');
  const [,saved]=await req(root+'/step','POST',{count:2},a.adminToken);assert.equal(saved.world.tick,2);inject=true;const [status,error]=await req(root+'/fault','POST',{},a.adminToken);inject=false;
  assert(rejected);assert.equal(status,503);assert.deepEqual(error,{error:'world_step_failed'});const [,frozen]=await req(root,'GET',undefined,a.adminToken);assert.equal(frozen.sessionError,'world_step_failed');assert.equal(frozen.revision,saved.revision);assert.deepEqual(frozen.world,saved.world);assert.equal((await req(root+'/step','POST',{count:1},a.adminToken))[0],503);
  const [,history]=await req(root+'/history?after=-1','GET',undefined,a.adminToken);assert.deepEqual(history.frames.at(-1).world,saved.world);const [,fork]=await req('/event-journals/'+a.sessionId+'/fork','POST',{revision:saved.revision},a.adminToken);assert(fork.sessionId);assert.deepEqual(fork.world,saved.world);assert.equal(fork.recordingContext.runtime.worldTasksBackend,'rust');
  const forkRoot='/sessions/'+fork.sessionId;const [ok,continued]=await req(forkRoot+'/step','POST',{count:5},fork.adminToken);assert.equal(ok,200);assert.equal(continued.world.tick,7);assert.deepEqual((await req(root,'GET',undefined,a.adminToken))[1].world,saved.world);
  inject=true;const [assignStatus,assignError]=await req('/sessions/'+b.sessionId+'/assign','POST',{taskId:'inspect',agentId:'drone-1'},b.adminToken);inject=false;assert.equal(assignStatus,503);assert.deepEqual(assignError,{error:'world_step_failed'});assert.deepEqual((await req('/sessions/'+b.sessionId,'GET',undefined,b.adminToken))[1].world,b.world);
  const [healthy,next]=await req(forkRoot+'/step','POST',{count:1},fork.adminToken);assert.equal(healthy,200);assert.equal(next.world.tick,8);
  for(const s of [a,b,fork])assert.equal((await req('/sessions/'+s.sessionId,'DELETE',undefined,s.adminToken))[0],200);
  console.log('Native task command rejection after fault mutations and during assignment rolls back committed frames, preserves journals, restores independent task graphs and isolates worlds');
 }finally{inject=false;Tasks.create=original;await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
