'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Ledger=require('../server/rust-world-ledger'),{createServer}=require('../server/world-server');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-ledger-failure-')),original=Ledger.create;let inject=false,rejected=false;
 Ledger.create=world=>{const ledger=original(world);return {checkpoint:ledger.checkpoint,rollback:p=>ledger.rollback(p),get tick(){return ledger.tick},get done(){return ledger.done},get failed(){return ledger.failed},get events(){return ledger.events},advance:()=>ledger.advance(),finish:value=>ledger.finish(value),free:()=>ledger.free(),control(world){return ledger.control.call(this,world)},append:payload=>{if(inject){rejected=true;return ledger.append({...payload,seq:999})}return ledger.append(payload)}}};
 const server=createServer({taskBackend:'rust',physicsBackend:'rust',journalDir:dir,replayJournal:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function req(p,method='GET',data,token){const r=await fetch(base+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});return [r.status,await r.json()]}
 try{
  const [,health]=await req('/health');assert.equal(health.runtime.worldLedgerBackend,'rust');assert.equal(health.features.worldLedger,1);
  const [,a]=await req('/sessions','POST',{physicsMode:'rapier',seed:42}),[,b]=await req('/sessions','POST',{physicsMode:'rapier',seed:43}),root='/sessions/'+a.sessionId;assert.equal(a.recordingContext.runtime.worldLedgerBackend,'rust');
  const [,saved]=await req(root+'/step','POST',{count:1},a.adminToken);inject=true;const [status,error]=await req(root+'/message','POST',{from:'drone-1',to:'drone-2',text:'must not survive failure'},a.adminToken);inject=false;
  assert(rejected);assert.equal(status,503);assert.equal(error.error,'world_step_failed');assert(!JSON.stringify(error).includes('ledger'));
  const [,frozen]=await req(root,'GET',undefined,a.adminToken);assert.equal(frozen.sessionError,'world_step_failed');assert.equal(frozen.revision,saved.revision);assert.deepEqual(frozen.world,saved.world);assert.equal(frozen.world.communication.queue.length,0);
  assert.equal((await req(root+'/message','POST',{from:'drone-1',to:'drone-2',text:'blocked'},a.adminToken))[0],503);
  const [,history]=await req(root+'/history?after=-1','GET',undefined,a.adminToken);assert.deepEqual(history.frames.at(-1).world,saved.world);
  const [,fork]=await req('/event-journals/'+a.sessionId+'/fork','POST',{revision:saved.revision},a.adminToken);assert(fork.sessionId);assert.deepEqual(fork.world,saved.world);assert.equal(fork.recordingContext.runtime.worldLedgerBackend,'rust');
  const [,continued]=await req('/sessions/'+fork.sessionId+'/step','POST',{count:1},fork.adminToken);assert.equal(continued.world.tick,saved.world.tick+1);assert.deepEqual(continued.world.events.slice(0,saved.world.events.length),saved.world.events);assert(continued.world.events.every((e,i)=>e.seq===i+1));
  const [ok,other]=await req('/sessions/'+b.sessionId+'/step','POST',{count:1},b.adminToken);assert.equal(ok,200);assert.equal(other.world.tick,1);
  for(const s of [a,b,fork])assert.equal((await req('/sessions/'+s.sessionId,'DELETE',undefined,s.adminToken))[0],200);
  console.log('Rust ledger append failure after a host mutation preserves committed state, blocks further writes, isolates worlds and forks the verified journal prefix');
 }finally{inject=false;Ledger.create=original;await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
