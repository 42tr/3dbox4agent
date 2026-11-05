'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),R=require('../src/replay');
const {createServer}=require('../server/world-server');
function advance(s,n){for(let i=0;i<n;i++)E.step(s)}
(async()=>{
 const old=E.getScene();for(const k of ['statusInterval','statusMaxAge','decisionMaxAge'])delete old.communication[k];
 assert.deepEqual([E.normalizeScene(old).communication.statusInterval,E.normalizeScene(old).communication.statusMaxAge,E.normalizeScene(old).communication.decisionMaxAge],[5,20,5]);
 for(const k of ['statusInterval','statusMaxAge','decisionMaxAge']){const bad=structuredClone(old);bad.communication[k]=0;assert.throws(()=>E.normalizeScene(bad))}
 const scene=E.withLinkProfile(old,'long');scene.communication.lossRate=0;assert.equal(old.communication.delay,3);assert.throws(()=>E.withLinkProfile(old,'invalid'));
 const s=E.create(42,'nearest',scene,{dispatchMode:'networked_reported'}),frames=[E.snapshot(s)];advance(s,12);let obs=E.coordinatorObservation(s);assert.equal(obs.reporting.fresh,15);assert.equal(obs.reporting.interval,10);assert.equal(obs.tasks[0].candidates[0].age,12);
 const decision={requestId:'long',taskId:obs.tasks[0].id,agentId:obs.tasks[0].candidates[0].id,observedTick:obs.tick};assert.equal(E.submitExternalDecision(s,decision).decision.status,'pending');advance(s,12);assert.equal(s.decisions[0].status,'accepted');frames.push(E.snapshot(s));assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));
 const short=structuredClone(scene);short.communication.decisionMaxAge=5;const t=E.create(42,'nearest',short,{dispatchMode:'networked_external'});obs=E.coordinatorObservation(t);assert.equal(E.submitExternalDecision(t,{...decision,observedTick:0,agentId:obs.tasks[0].candidates[0].id}).decision.status,'pending');advance(t,12);assert.equal(t.decisions[0].reason,'stale_observation');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;try{let response=await fetch(url+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({linkProfile:'long',dispatchMode:'networked_reported'})});assert.equal(response.status,201);const session=await response.json();assert.equal(session.scene.communication.delay,12);assert.equal(session.world.communication.reporting.maxAge,60);response=await fetch(url+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({linkProfile:'bad'})});assert.equal(response.status,400)}finally{server.close()}
 console.log('configurable long-delay link tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
