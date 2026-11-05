'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createServer}=require('../server/world-server'),Replay=require('../src/replay'),Journal=require('../server/event-journal');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-replay-journal-'));let server;
 async function start(options){const s=createServer(options);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s}
 async function req(p,method='GET',data,token){const r=await fetch(`http://127.0.0.1:${server.address().port}`+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
 try{
  // Object key order can change without a semantic change; the snapshot hash remains stable.
  const keyId='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64),w0={tick:0,events:[],data:{a:1,b:2}},w1={tick:1,events:[],data:{b:2,a:1}};
  const keyJournal=Journal.create(dir,keyId,hash,{},[],{initialWorld:w0});keyJournal.append(1,[],w1);keyJournal.close(1,'deleted');const keyReplay=Journal.replay(dir,keyId,hash,-1,5,null);assert.deepEqual(keyReplay.frames[1].world,w1);
  assert.throws(()=>createServer({journalDir:null,replayJournal:true}),/requires/);
  server=await start({journalDir:dir,replayJournal:true,maxHistoryBytes:20000});
  let [code,s]=await req('/sessions','POST',{seed:42});assert.equal(code,201);assert(s.journal.snapshots);const root='/sessions/'+s.sessionId,journal='/event-journals/'+s.sessionId,token=s.adminToken,frames=[s.world];
  const [,agent]=await req(root+'/agents/drone-1/credentials','POST',{},token);assert.equal((await req(journal+'/replay','GET',undefined,agent.agentToken))[0],401);
  let [,action]=await req(root+'/message','POST',{from:'drone-1',to:'drone-2',text:'回放'} ,token);frames.push(action.world);
  for(let i=0;i<70;i++){let [status,step]=await req(root+'/step','POST',{count:1},token);assert.equal(status,200);frames.push(step.world)}
  const [,history]=await req(root+'/history?after=-1','GET',undefined,token);assert(history.truncated&&history.frames[0].revision>0);
  let [status,first]=await req(journal+'/replay?after=-1&limit=7','GET',undefined,token);assert.equal(status,200);assert.equal(first.through,71);assert.equal(first.nextAfter,6);assert.equal(first.metadata.scene.id,s.scene.id);
  let [,later]=await req(root+'/step','POST',{count:2},token);assert.equal(later.revision,73);
  const collected=[...first.frames];let cursor=first.nextAfter;
  while(cursor!==null){let [st,page]=await req(journal+`/replay?after=${cursor}&limit=7&through=${first.through}`,'GET',undefined,token);assert.equal(st,200);assert.equal(page.through,71);collected.push(...page.frames);cursor=page.nextAfter}
  assert.equal(collected.length,frames.length);assert.deepEqual(collected.map(x=>x.world),frames);assert(collected.every((x,i)=>x.revision===i));
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:s.scene.id,scene:s.scene},coverage:{start:'complete',end:frames.at(-1).done?'finished':'unfinished',revisionRange:[0,71]},frames};assert(Replay.validateArchive(archive));
  assert.equal((await req(journal+'/replay?after=-2','GET',undefined,token))[0],400);assert.equal((await req(journal+'/replay?after=80&through=1','GET',undefined,token))[0],400);
  const file=path.join(dir,s.sessionId+'.jsonl'),rows=fs.readFileSync(file,'utf8').trimEnd().split('\n').map(x=>JSON.parse(x));assert.equal(rows[0].payload.version,2);assert(rows.some(x=>x.payload.type==='frame'&&x.payload.encoding==='delta'));assert(rows.some(x=>x.payload.type==='frame'&&x.payload.revision===64&&x.payload.encoding==='full'));
  await req(root,'DELETE',undefined,token);await new Promise(r=>server.close(r));server=await start({journalDir:dir});
  let [,saved]=await req(journal+'/replay?after=-1&limit=1','GET',undefined,token);assert(saved.closed&&saved.snapshots&&saved.through===73);assert.deepEqual(saved.frames[0].world,frames[0]);
  const lines=fs.readFileSync(file,'utf8').trimEnd().split('\n');lines.pop();fs.writeFileSync(file,lines.join('\n')+'\n{"torn"');[,saved]=await req(journal+'/replay?after=-1&limit=1','GET',undefined,token);assert(saved.partialTail&&!saved.closed&&saved.through===73);
  // A forged but internally rehashed state checksum must fail during reconstruction.
  const records=lines.map(JSON.parse);records[1].payload.worldHash='0'.repeat(64);let previous='0'.repeat(64);for(const item of records){item.previous=previous;item.hash=crypto.createHash('sha256').update(previous+'\n'+JSON.stringify(item.payload)).digest('hex');previous=item.hash}fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
  assert.equal((await req(journal+'/replay?after=-1&limit=1','GET',undefined,token))[0],500);
  // Version 1 event-only journals remain readable but have no replay.
  await new Promise(r=>server.close(r));server=await start({journalDir:dir});let [,legacy]=await req('/sessions','POST',{seed:5});await req('/sessions/'+legacy.sessionId+'/step','POST',{count:1},legacy.adminToken);assert.equal((await req('/event-journals/'+legacy.sessionId+'/replay','GET',undefined,legacy.adminToken))[0],409);
  await new Promise(r=>server.close(r));server=null;
  const failure={...Journal,create(...args){const j=Journal.create(...args);return {...j,append(revision,events,world){if(revision===2)throw Error('disk full');return j.append(revision,events,world)}}}};
  server=await start({journalDir:dir,replayJournal:true,journalApi:failure});const [,broken]=await req('/sessions','POST',{seed:42}),broot='/sessions/'+broken.sessionId,bjournal='/event-journals/'+broken.sessionId;
  assert.equal((await req(broot+'/step','POST',{count:1},broken.adminToken))[0],200);assert.equal((await req(broot+'/step','POST',{count:1},broken.adminToken))[0],503);
  let [,partial]=await req(bjournal+'/replay?after=-1','GET',undefined,broken.adminToken);assert.equal(partial.through,1);assert.equal(partial.healthy,false);assert(!partial.closed&&partial.frames.length===2);
  await req(broot,'DELETE',undefined,broken.adminToken);[,partial]=await req(bjournal+'/replay?after=-1','GET',undefined,broken.adminToken);assert(!partial.closed&&partial.through===1);
  console.log('persistent replay checkpoints, pagination, restart, corruption and legacy compatibility passed');
 }finally{if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
