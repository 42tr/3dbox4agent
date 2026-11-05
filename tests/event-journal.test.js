'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process'),{createServer}=require('../server/world-server'),Journal=require('../server/event-journal');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-journal-'));
 async function start(options){const s=createServer(options);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s}
 function base(s){return `http://127.0.0.1:${s.address().port}`}
 async function call(s,p,method='GET',data,token){const r=await fetch(base(s)+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
 let server;
 try{
  server=await start({journalDir:dir,maxHistoryBytes:20000});
  const [,created]=await call(server,'/sessions','POST',{seed:42}),root='/sessions/'+created.sessionId,token=created.adminToken,journal='/event-journals/'+created.sessionId;
  assert(created.journal.enabled&&created.journal.healthy);assert.equal(created.journal.eventCount,0);
  const [,agent]=await call(server,root+'/agents/drone-1/credentials','POST',{},token),[,coord]=await call(server,root+'/coordinator/credentials','POST',{},token);
  assert.equal((await call(server,journal,'GET',undefined,agent.agentToken))[0],401);
  assert.equal((await call(server,journal,'GET',undefined,coord.coordinatorToken))[0],401);
  assert.equal((await call(server,journal+'?after=-1','GET',undefined,token))[0],400);
  const [,advanced]=await call(server,root+'/step','POST',{count:90},token);assert(advanced.world.events.length>2);
  const [,history]=await call(server,root+'/history?after=-1','GET',undefined,token);assert(history.truncated);
  let after=0,all=[],read;
  do{let [status,page]=await call(server,journal+`?after=${after}&limit=2`,'GET',undefined,token);assert.equal(status,200);assert(page.active&&page.healthy&&!page.closed&&!page.partialTail);read=page;all.push(...page.events);after=page.nextAfter}while(after!==null);
  assert.deepEqual(all.map(x=>x.event),advanced.world.events);assert.equal(read.eventCount,advanced.world.events.length);assert(all.every((e,i)=>e.event.seq===i+1));
  const raw=fs.readFileSync(path.join(dir,created.sessionId+'.jsonl'),'utf8');assert(!raw.includes(token));
  assert.equal((await call(server,root,'DELETE',undefined,token))[0],200);
  let [,saved]=await call(server,journal+'?limit=500','GET',undefined,token);assert(saved.closed&&!saved.active&&saved.closeReason==='deleted');assert.deepEqual(saved.events.map(x=>x.event),advanced.world.events);
  const [,live]=await call(server,'/sessions','POST',{seed:43});await call(server,'/sessions/'+live.sessionId+'/step','POST',{count:3},live.adminToken);
  await new Promise(r=>server.close(r));server=await start({journalDir:dir});
  [,saved]=await call(server,journal+'?limit=500','GET',undefined,token);assert(saved.closed&&!saved.active);assert.deepEqual(saved.events.map(x=>x.event),advanced.world.events);
  const [,shutdown]=await call(server,'/event-journals/'+live.sessionId,'GET',undefined,live.adminToken);assert(shutdown.closed&&shutdown.closeReason==='server_shutdown');
  // Simulate a process crash and a torn final write, retaining the verified prefix.
  const filename=path.join(dir,created.sessionId+'.jsonl'),lines=fs.readFileSync(filename,'utf8').trimEnd().split('\n');lines.pop();fs.writeFileSync(filename,lines.join('\n')+'\n');
  [,saved]=await call(server,journal,'GET',undefined,token);assert(!saved.partialTail&&!saved.closed&&!saved.active);
  fs.appendFileSync(filename,'{"partial"');[,saved]=await call(server,journal,'GET',undefined,token);assert(saved.partialTail&&!saved.closed);
  fs.appendFileSync(filename,'\n');assert.equal((await call(server,journal,'GET',undefined,token))[0],500);
  await new Promise(r=>server.close(r));server=null;
  // SIGTERM in the executable closes active journals before process exit.
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const child=spawn(process.execPath,['server/world-server.js'],{env:{...process.env,WORLD_PORT:String(port),BOX_EVENT_JOURNAL_DIR:dir},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
  try{
   await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('child startup timeout')),5000);child.stdout.on('data',()=>{if(output.includes('World API:')){clearTimeout(timeout);resolve()}});child.on('error',reject);child.on('exit',code=>{if(!output.includes('World API:'))reject(Error(`early exit ${code}: ${errors}`))})});
   const r=await fetch(`http://127.0.0.1:${port}/sessions`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert(r.ok);const signalSession=await r.json();child.kill('SIGTERM');const exit=await new Promise(r=>child.once('exit',r));assert.equal(exit,0);
   server=await start({journalDir:dir});const [,signalLog]=await call(server,'/event-journals/'+signalSession.sessionId,'GET',undefined,signalSession.adminToken);assert(signalLog.closed&&signalLog.closeReason==='server_shutdown');await new Promise(r=>server.close(r));server=null;
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
  // A failed append freezes the session, returns 503, and prevents later mutations.
  const failure={create(...args){const journal=Journal.create(...args);return {...journal,append(revision,events){if(events.length)throw Error('disk full');return journal.append(revision,events)}}},read:Journal.read};
  server=await start({journalDir:dir,journalApi:failure});const [,broken]=await call(server,'/sessions','POST',{seed:42}),broot='/sessions/'+broken.sessionId;
  await call(server,broot+'/coordinators/node-1/credentials','POST',{},broken.adminToken);
  const [code]=await call(server,broot+'/step','POST',{count:2},broken.adminToken);assert.equal(code,503);
  const [,state]=await call(server,broot,'GET',undefined,broken.adminToken);assert(!state.running&&!state.journal.healthy);assert.equal((await call(server,broot+'/step','POST',{count:1},broken.adminToken))[0],503);assert.equal((await call(server,broot+'/coordinators/node-1/credentials','DELETE',undefined,broken.adminToken))[0],503);
  assert.equal((await call(server,broot,'DELETE',undefined,broken.adminToken))[0],200);const [,incomplete]=await call(server,'/event-journals/'+broken.sessionId,'GET',undefined,broken.adminToken);assert(!incomplete.closed&&incomplete.eventCount===0);
  const [,timed]=await call(server,'/sessions','POST',{seed:42}),troot='/sessions/'+timed.sessionId;
  assert.equal((await call(server,troot+'/run','POST',{speed:1},timed.adminToken))[0],200);
  let stopped;for(let i=0;i<100;i++){[,stopped]=await call(server,troot,'GET',undefined,timed.adminToken);if(!stopped.journal.healthy)break;await new Promise(r=>setTimeout(r,10))}
  assert(!stopped.journal.healthy&&!stopped.running);assert.equal((await call(server,troot+'/step','POST',{count:1},timed.adminToken))[0],503);
  console.log('durable event journal, scoped access, pagination, restart and failure handling passed');
 }finally{if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
