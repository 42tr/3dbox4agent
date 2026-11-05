'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),R=require('../src/replay'),{createServer}=require('../server/world-server');
(async()=>{
 const server=createServer({maxHistoryBytes:100000});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function req(path,method='GET',data,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return r.json()}
 try{
  const created=await req('/sessions','POST',{seed:42}),root='/sessions/'+created.sessionId,token=created.adminToken;const initial=await req(root+'/history?after=-1','GET',undefined,token),startFrames=initial.frames.map(f=>f.world);let c=R.liveCoverage(startFrames,initial.revision);assert.deepEqual(c,{start:'complete',end:'unfinished',revisionRange:[0,0]});
  await req(root+'/step','POST',{count:10},token);const history=await req(root+'/history?after=-1','GET',undefined,token);assert(history.truncated);const frames=history.frames.map(f=>f.world),coverage=R.liveCoverage(frames,history.revision);assert.equal(coverage.start,'partial');assert.deepEqual(coverage.revisionRange,[history.frames[0].revision,history.revision]);
  const archive={format:'3dbox-prototype-v1',source:'server',config:{seed:42,policy:'nearest',sceneId:E.scene.id},frames,coverage};const loaded=R.unwrapArchive(archive);assert(loaded.truncated);assert.deepEqual(loaded.coverage,coverage);assert.deepEqual(R.unwrapArchive(JSON.parse(JSON.stringify(loaded.archive))).coverage,coverage);
  const forged=structuredClone(archive);forged.coverage.start='complete';assert.throws(()=>R.unwrapArchive(forged));forged.coverage.start='partial';forged.coverage.revisionRange[0]++;assert.throws(()=>R.unwrapArchive(forged));
  const old={...archive,frames:startFrames};delete old.coverage;assert.equal(R.unwrapArchive(old).coverage.start,'unknown');assert.equal(R.unwrapArchive({format:'3dbox-multiprocess-v1',historyTruncated:false,archive:old}).coverage.start,'complete');assert.equal(R.unwrapArchive({format:'3dbox-multiprocess-v1',historyTruncated:true,archive:old}).coverage.start,'partial');
  const wrong={format:'3dbox-multiprocess-v1',historyTruncated:false,archive};assert.throws(()=>R.unwrapArchive(wrong));
  console.log('replay coverage, truncation and legacy metadata tests passed');
 }finally{server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
