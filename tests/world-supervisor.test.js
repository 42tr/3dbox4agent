'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),WebSocket=require('ws');
const {createSupervisor}=require('../server/world-supervisor'),Replay=require('../src/replay'),Protobuf=require('../src/stream-protobuf');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-process-worlds-')),native=process.argv.includes('--native'),clients=[],pids=[];
 const worldOptions={journalDir:path.join(dir,'journals'),replayJournal:true,catalogPath:path.join(dir,'catalog.sqlite3'),...(native?{physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust'}:{})};
 let server,base;
 async function start(){server=createSupervisor({maxWorkers:2,requestTimeoutMs:1200,worldOptions});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`}
 async function waitFor(test){const end=Date.now()+7000;while(!test()){if(Date.now()>end)throw Error('worker state deadline');await new Promise(r=>setTimeout(r,15))}}
 async function stop(){const list=server.inspectWorkers();pids.push(...list.map(x=>x.pid));await new Promise(r=>server.close(r));for(const worker of list)assert.throws(()=>process.kill(worker.pid,0),{code:'ESRCH'})}
 async function req(route,method='GET',body,token,extra={}){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});return [r.status,await r.json()]}
 async function ok(...args){const [code,v]=await req(...args);assert(code>=200&&code<300,JSON.stringify({route:args[0],code,error:v.error}));return v}
 async function open(token,sid,afterRevision){const ws=new WebSocket(base.replace('http:','ws:')+'/stream',{headers:{origin:base}}),queue=[],waiting=[];clients.push(ws);ws.on('error',()=>{});ws.on('message',(bytes,binary)=>{const v=binary?Protobuf.decode(bytes):JSON.parse(bytes.toString());if(waiting.length){const w=waiting.shift();clearTimeout(w.timer);w.resolve(v)}else queue.push(v)});const closed=new Promise(r=>ws.once('close',r));await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});ws.send(JSON.stringify({type:'subscribe',token,sessionId:sid,afterRevision,encoding:'protobuf-v2'}));return {ws,closed,next:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>waiting.push({resolve,timer:setTimeout(()=>reject(Error('proxy stream deadline')),4000)}))}}
 try{
  await start();const health=await ok('/health');assert.equal(health.features.worldProcessIsolation,1);assert.equal(health.runtimeScope,'supervisor');
  assert.equal((await req('/health','GET',undefined,undefined,{origin:'https://invalid.invalid'}))[0],403);assert.equal(await new Promise((resolve,reject)=>{const r=http.get(base+'/health',{headers:{host:'bad@host'}},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject)}),403);
  assert.equal((await fetch(base+'/')).status,200);
  // Abort a request while a real worker is starting, then prove the slot is reclaimed.
  const pending=http.request(base+'/sessions',{method:'POST',headers:{'content-type':'application/json'}},r=>r.resume());pending.on('error',()=>{});pending.end('{}');await waitFor(()=>server.inspectWorkers().some(w=>!w.sessionId));pending.destroy();await waitFor(()=>!server.inspectWorkers().length);
  assert.equal((await req('/sessions','POST',{seed:-1}))[0],400);await waitFor(()=>!server.inspectWorkers().length);
  const a=await ok('/sessions','POST',{seed:42,physicsMode:'rapier'}),b=await ok('/sessions','POST',{seed:43,physicsMode:'rapier'}),aroot='/sessions/'+a.sessionId,broot='/sessions/'+b.sessionId;
  const workers=server.inspectWorkers();assert.equal(workers.length,2);assert.notEqual(workers[0].pid,workers[1].pid);assert(workers.every(w=>w.pid!==process.pid));
  assert.notEqual(a.recordingContext.runtime.instanceId,b.recordingContext.runtime.instanceId);assert.notEqual(a.recordingContext.runtime.instanceId,health.runtime.instanceId);
  assert.equal((await req('/sessions','POST',{}))[0],429);assert.equal((await req(broot,'GET',undefined,a.adminToken))[0],401);
  // Authentication can respond before the caller has finished uploading its body.
  const rejected=await new Promise((resolve,reject)=>{const pending=http.request(base+aroot+'/step',{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(43),'content-type':'application/json','transfer-encoding':'chunked'}},response=>{response.resume();pending.end('1}');resolve(response.statusCode)});pending.on('error',reject);pending.write('{"count":')});assert.equal(rejected,401);
  // A slow download must not turn client backpressure into a world failure.
  const large=await ok(aroot+'/catalog/import?label=slow-client','POST',{format:'3dbox-transport-test-v1',padding:'x'.repeat(10*1024*1024)},a.adminToken);
  const download=await new Promise((resolve,reject)=>{const request=http.get(base+aroot+'/catalog/'+large.report.id,{headers:{authorization:'Bearer '+a.adminToken}},response=>{assert.equal(response.statusCode,200);response.pause();resolve({request,response})});request.on('error',reject)});
  await new Promise(r=>setTimeout(r,1500));assert.equal((await ok(aroot,'GET',undefined,a.adminToken)).world.tick,0);download.response.destroy();download.request.destroy();
  const observer=(await ok(aroot+'/observer/credentials','POST',{},a.adminToken)).observerToken,agent=(await ok(aroot+'/agents/drone-1/credentials','POST',{},a.adminToken)).agentToken;
  assert.equal((await req(aroot+'/step','POST',{count:1},observer))[0],403);assert.equal((await req(aroot,'GET',undefined,agent))[0],403);
  assert.equal((await ok(aroot+'/observer','GET',undefined,observer)).role,'observer');
  const adminStream=await open(a.adminToken,a.sessionId,0),viewStream=await open(observer,a.sessionId,0);assert.equal((await adminStream.next()).role,'admin');assert.equal((await viewStream.next()).role,'observer');
  await ok(aroot+'/step','POST',{count:1},a.adminToken);assert.deepEqual(await adminStream.next(),await viewStream.next());
  await ok(aroot+'/step','POST',{count:4},a.adminToken);await ok(broot+'/step','POST',{count:7},b.adminToken);
  const saved=await ok(aroot+'/catalog','POST',{label:'isolated process'},a.adminToken),archive=await ok(aroot+'/catalog/'+saved.report.id,'GET',undefined,a.adminToken);assert.deepEqual(archive.recordingContext,a.recordingContext);Replay.validateArchive(archive);
  const dead=workers.find(w=>w.sessionId===a.sessionId);process.kill(dead.pid,'SIGKILL');await waitFor(()=>server.inspectWorkers().find(w=>w.sessionId===a.sessionId)?.exited);
  assert.equal(await adminStream.closed,1011);assert.equal(await viewStream.closed,1011);assert.equal((await req(aroot,'GET',undefined,a.adminToken))[1].error,'world_process_exited');
  assert.equal((await ok(broot+'/step','POST',{count:2},b.adminToken)).world.tick,9);assert.equal((await ok('/health')).worldProcesses.failed,1);
  const old=await ok('/event-journals/'+a.sessionId+'/replay?after=-1&limit=10','GET',undefined,a.adminToken);assert(!old.active);assert(!old.closed);assert.equal(old.metadata.runtime.instanceId,a.recordingContext.runtime.instanceId);assert.equal(old.frames.at(-1).revision,5);
  assert.equal((await req(aroot,'DELETE',undefined,observer))[0],401);await ok(aroot,'DELETE',undefined,a.adminToken);
  const fork=await ok('/event-journals/'+a.sessionId+'/fork','POST',{revision:5},a.adminToken),froot='/sessions/'+fork.sessionId;
  assert.equal(fork.recordingContext.forkedFrom.sessionId,a.sessionId);assert.notEqual(fork.recordingContext.runtime.instanceId,a.recordingContext.runtime.instanceId);assert.deepEqual(await ok(froot+'/catalog/'+saved.report.id,'GET',undefined,fork.adminToken),archive);
  // Freeze one world's entire event loop; the supervisor and another world remain responsive.
  const slow=server.inspectWorkers().find(w=>w.sessionId===b.sessionId);process.kill(slow.pid,'SIGSTOP');const blocked=req(broot,'GET',undefined,b.adminToken);
  assert.equal((await ok(froot+'/step','POST',{count:2},fork.adminToken)).world.tick,7);assert.equal((await blocked)[0],504);await waitFor(()=>server.inspectWorkers().find(w=>w.sessionId===b.sessionId)?.exited);assert.equal((await req(broot,'GET',undefined,b.adminToken))[1].error,'world_process_exited');
  await ok(broot,'DELETE',undefined,b.adminToken);await ok(froot+'/','DELETE',undefined,fork.adminToken);await waitFor(()=>!server.inspectWorkers().length);await stop();
  // Routing is in memory, journals survive the supervisor and worker processes.
  await start();assert.equal((await req(aroot,'GET',undefined,a.adminToken))[0],404);const restarted=await ok('/event-journals/'+a.sessionId+'/fork','POST',{revision:5},a.adminToken);assert.equal(restarted.world.tick,5);await ok('/sessions/'+restarted.sessionId,'DELETE',undefined,restarted.adminToken);await waitFor(()=>!server.inspectWorkers().length);
  console.log(`isolated ${native?'Rust':'WASM'} workers: credentials, Protobuf, quota, startup cancellation, crash/hang isolation, persistent replay/catalog and restart fork passed`);
 }finally{for(const c of clients)c.terminate();if(server?.listening)await stop();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
