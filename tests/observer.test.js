'use strict';
const assert=require('node:assert/strict'),WebSocket=require('ws');
const {createServer}=require('../server/world-server'),E=require('../src/engine'),Delta=require('../src/delta'),Protobuf=require('../src/stream-protobuf');
const Access=require('../src/observer-access');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const journalDir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-observer-'));
 const server=createServer({journalDir,replayJournal:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port,base=`http://127.0.0.1:${port}`,clients=[];
 async function req(route,method='GET',body,token){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return [r.status,await r.json()]}
 async function ok(...args){const [status,v]=await req(...args);assert(status>=200&&status<300,JSON.stringify({route:args[0],status,error:v.error}));return v}
 async function open(token,sid,encoding='protobuf-v2',afterRevision=0){
  const socket=new WebSocket(`ws://127.0.0.1:${port}/stream`),queue=[],waiting=[];clients.push(socket);
  socket.on('message',(raw,binary)=>{const v=binary?Protobuf.decode(raw):JSON.parse(raw.toString());const waiter=waiting.shift();if(waiter){clearTimeout(waiter.timer);waiter.resolve(v)}else queue.push(v)});socket.on('error',()=>{});
  const closing=new Promise(resolve=>socket.once('close',code=>resolve(code)));
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
  socket.send(JSON.stringify({type:'subscribe',sessionId:sid,token,afterRevision,encoding}));
  return {socket,closing,next:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const waiter={resolve,timer:setTimeout(()=>reject(Error('observer stream timeout')),2500)};waiting.push(waiter)})};
 }
 try{
  const created=await ok('/sessions','POST',{seed:42}),sid=created.sessionId,root='/sessions/'+sid,admin=created.adminToken;
  const agent=await ok(root+'/agents/drone-1/credentials','POST',{},admin),coordinator=await ok(root+'/coordinator/credentials','POST',{},admin);
  await ok(root+'/agents/drone-1/memory','POST',{expectedRevision:0,value:{secret:'private-observer-test-memory'}},agent.agentToken);
  const issued=await ok(root+'/observer/credentials','POST',{},admin),token=issued.observerToken;
  const access={format:'3dbox-observer-access-v1',sessionId:sid,observerToken:token};assert.deepEqual(Access.validate(access),access);
  for(const malformed of [{...access,adminToken:admin},{...access,url:'http://foreign.invalid/'},{...access,sessionId:'../other'},{...access,format:'3dbox-journal-access-v1'},{...access,observerToken:42},null,[]])assert.throws(()=>Access.validate(malformed));
  assert.equal(token.length,43);assert.notEqual(token,admin);assert.equal(issued.sessionId,sid);
  const initial=await ok(root+'/observer','GET',undefined,token),adminState=await ok(root,'GET',undefined,admin);
  assert.equal(initial.role,'observer');assert.deepEqual(initial.world,adminState.world);assert.deepEqual(initial.recordingContext,created.recordingContext);assert.deepEqual(initial.scene,created.scene);
  assert(!JSON.stringify(initial).includes(admin));assert(!JSON.stringify(initial).includes(token));assert(!JSON.stringify(initial).includes('private-observer-test-memory'));
  for(const credential of [admin,agent.agentToken,coordinator.coordinatorToken])assert.equal((await req(root+'/observer','GET',undefined,credential))[0],403);
  for(const route of ['/agents/drone-1/memory','/coordinator/observation','/observations/drone-1','/catalog','/recording-context','/observation-transport'])assert.equal((await req(root+route,'GET',undefined,token))[0],403,route);
  for(const route of ['/event-journals/'+sid,'/event-journals/'+sid+'/replay'])assert.equal((await req(route,'GET',undefined,token))[0],401,route);
  assert.equal((await req('/event-journals/'+sid+'/fork','POST',{revision:0},token))[0],401);
  for(const route of ['/step','/run','/pause','/fault','/assign','/dispatch-mode','/message','/observer/credentials','/agents/drone-1/credentials','/agents/drone-1/actions','/coordinator/decisions','/catalog'])assert.equal((await req(root+route,'POST',{},token))[0],403,route);
  for(const route of ['', '/observer/credentials'])assert.equal((await req(root+route,'DELETE',undefined,token))[0],403);
  assert.equal((await req(root+'/observer/credentials','POST',{},agent.agentToken))[0],403);
  assert.equal((await req(root+'/observer/credentials','DELETE',undefined,coordinator.coordinatorToken))[0],403);
  const other=await ok('/sessions','POST',{});assert.equal((await req('/sessions/'+other.sessionId,'GET',undefined,token))[0],401);
  const a=await open(admin,sid),b=await open(token,sid);assert.equal((await a.next()).role,'admin');assert.equal((await b.next()).role,'observer');
  let aWorld=structuredClone(initial.world),bWorld=structuredClone(initial.world),revision=0;
  for(const [action,data] of [['communication-outage',{agentId:'drone-2',duration:3}],['step',{count:1}],['step',{count:1}],['fault',{}],['step',{count:1}]]){
   const result=await ok(root+'/'+action,'POST',data,admin),am=await a.next(),bm=await b.next();
   assert.deepEqual(am,bm);assert(am.type==='frame'||am.type==='delta');
   if(am.type==='delta'){assert.equal(am.baseRevision,revision);aWorld=Delta.apply(aWorld,am.patch);bWorld=Delta.apply(bWorld,bm.patch)}else{aWorld=am.world;bWorld=bm.world}
   revision=am.revision;assert.deepEqual(aWorld,bWorld);const current=await ok(root,'GET',undefined,token);assert.deepEqual(current.world,bWorld);assert.equal(current.revision,revision);
  }
  assert.deepEqual(await ok(root+'/history?after=-1','GET',undefined,token),await ok(root+'/history?after=-1','GET',undefined,admin));
  assert(!JSON.stringify(bWorld).includes('private-observer-test-memory'));
  // A disconnected browser catches up from the authoritative retained history.
  b.socket.close();await b.closing;await ok(root+'/step','POST',{count:3},admin);
  const history=await ok(root+'/history?after='+revision,'GET',undefined,token);assert.equal(history.frames.length,3);for(const frame of history.frames){assert.equal(frame.revision,++revision);bWorld=frame.world}
  const c=await open(token,sid,'delta-v1',revision);assert.equal((await c.next()).role,'observer');await ok(root+'/step','POST',{count:1},admin);const cm=await c.next();assert.equal(cm.revision,revision+1);assert.deepEqual(cm.type==='delta'?Delta.apply(bWorld,cm.patch):cm.world,(await ok(root,'GET',undefined,admin)).world);
  const events=await open(token,sid,'events-v1',revision);assert.equal(await events.closing,1008);
  const replacement=await ok(root+'/observer/credentials','POST',{},admin);assert.equal(await c.closing,1008);assert.equal((await req(root,'GET',undefined,token))[0],401);assert.equal((await req(root,'GET',undefined,replacement.observerToken))[0],200);
  const d=await open(replacement.observerToken,sid,'full-v1',revision);await d.next();await ok(root+'/observer/credentials','DELETE',undefined,admin);assert.equal(await d.closing,1008);assert.equal((await req(root+'/history','GET',undefined,replacement.observerToken))[0],401);
  // World-step failure remains read-only and revocation still works after failure.
  const finalToken=(await ok(root+'/observer/credentials','POST',{},admin)).observerToken,watch=await open(finalToken,sid,'full-v1',revision);await watch.next();const original=E.step;E.step=()=>{throw Error('injected observer test failure')};
  try{assert.equal((await req(root+'/step','POST',{count:1},admin))[0],503)}finally{E.step=original}
  const failure=await watch.next();assert.equal(failure.type,'status');assert.equal(failure.sessionError,'world_step_failed');assert.equal((await ok(root,'GET',undefined,finalToken)).sessionError,'world_step_failed');assert.equal((await req(root+'/step','POST',{},finalToken))[0],403);await ok(root+'/observer/credentials','DELETE',undefined,admin);assert.equal(await watch.closing,1008);
  assert.equal((await req(root,'GET',undefined,admin))[0],200);await ok(root,'DELETE',undefined,admin);
  console.log('observer read-only scope, two-client authoritative deltas, catch-up, private memory, rotation, revocation and failure passed');
 }finally{for(const client of clients)client.terminate();await new Promise(r=>server.close(r));fs.rmSync(journalDir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
