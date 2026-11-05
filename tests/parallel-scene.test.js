'use strict';
const assert = require('node:assert/strict');
const E = require('../src/engine');
const P = require('../server/physics');
const R = require('../src/replay');
const X = require('../src/experiments');
const {createServer} = require('../server/world-server');

(async()=>{
 const id='industrial-park-parallel-v1', scene=E.getScene(id);
 assert.notEqual(scene,E.getScene(id));
 assert.throws(()=>E.getScene('missing'));
 await P.initialize();
 for(const mode of ['kinematic','rapier'])for(let seed=40;seed<45;seed++){
  const s=E.create(seed,'nearest',scene,{physicsMode:mode}),physics=mode==='rapier'?P.createPhysics(s):null,frames=[E.snapshot(s)];
  try{
   E.step(s,physics);frames.push(E.snapshot(s));const active=s.tasks.filter(t=>t.status==='active');
   assert.equal(active.length,2);assert.notEqual(active[0].assignee,active[1].assignee);
   assert.equal(s.tasks.find(t=>t.id==='confirm').status,'pending');
   assert(E.fault(s));frames.push(E.snapshot(s));
   while(!s.done&&s.tick<1000){E.step(s,physics);frames.push(E.snapshot(s));
    if(s.tasks.find(t=>t.id==='confirm').status!=='pending')assert(['inspect','survey'].every(id=>s.tasks.find(t=>t.id===id).status==='done'));
   }
   assert(s.done&&!s.failed,`${mode}/${seed}`);assert.equal(s.asset.condition,'operational');assert.equal(s.replans,1);
   assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed,policy:'nearest',sceneId:id},frames}));
   assert.throws(()=>R.validateArchive({format:'3dbox-prototype-v1',config:{seed,policy:'nearest',sceneId:E.scene.id},frames}));
  }finally{physics?.free()}
 }
 const config={startSeed:42,count:2,maxTicks:1000,faultTick:null,policies:['nearest','battery'],sceneId:id};
 const report=X.runBatch(config);assert.equal(report.scene,id);assert(report.runs.every(x=>x.status==='completed'));
 const resilience=X.runResilienceBatch({startSeed:42,count:1,policy:'nearest',maxTicks:1000,outageTick:1,outageDuration:10,target:'first_dispatch',sceneId:id});
 assert.equal(resilience.scene,id);assert(resilience.pairs[0].outage.outageInjected);assert.equal(resilience.pairs[0].outage.status,'completed');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 try{
  let response=await fetch(url+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sceneId:id,dispatchMode:'external'})});assert.equal(response.status,201);
  let created=await response.json();assert.equal(created.world.sceneId,id);assert.equal(created.world.tasks.length,6);
  response=await fetch(url+'/sessions/'+created.sessionId+'/coordinator/observation',{headers:{authorization:'Bearer '+created.adminToken}});const observation=await response.json();assert.equal(observation.tasks.length,2);
  response=await fetch(url+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sceneId:'unknown'})});assert.equal(response.status,400);
  console.log('parallel scenario tests passed');
 }finally{server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
