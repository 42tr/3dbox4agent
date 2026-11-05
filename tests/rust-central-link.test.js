'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Rules=require('../server/rust-communication');
function pair(sceneId,seed,mode,loss=0,config={}){const scene=E.getScene(sceneId);Object.assign(scene.communication,{lossRate:loss,...config});const worlds=[E.create(seed,'nearest',scene,{dispatchMode:mode}),E.create(seed,'nearest',scene,{dispatchMode:mode})];E.bindCommunicationRules(worlds[1],Rules);return worlds}
function step(worlds){for(const s of worlds)E.step(s);assert.deepEqual(E.snapshot(worlds[1]),E.snapshot(worlds[0]),`tick ${worlds[0].tick} seed ${worlds[0].seed}`)}
for(const mode of ['networked','networked_reported'])for(const loss of [0,.4,1])for(let seed=0;seed<4;seed++){
 const worlds=pair('industrial-park-fixed-sensor-v1',seed,mode,loss);let failed=false;
 for(let t=0;t<120&&!worlds[0].done;t++){
  if(t===10)for(const s of worlds)assert(E.interruptCommunication(s,'drone-1',12).ok);
  if(mode==='networked_reported'){const observation=E.coordinatorObservation(worlds[0]),candidate=observation.tasks.find(x=>x.candidates.length);if(candidate){const decision={requestId:'d'+t,taskId:candidate.id,agentId:candidate.candidates[0].id,observedTick:observation.tick};for(const s of worlds)E.submitExternalDecision(s,decision)}}
  step(worlds);if(!failed&&worlds[0].tick>30&&worlds[0].tasks.some(x=>x.status==='active')){const a=E.fault(worlds[0]),b=E.fault(worlds[1]);assert.equal(a,b);failed=true}
 }
 assert(worlds[0].fixedSensorState.sent>0);assert(worlds[0].fixedSensorState.delivered+worlds[0].fixedSensorState.failed>0);if(mode==='networked_reported')assert(worlds[0].communication.reporting.sent>0);else assert(worlds[0].events.some(e=>e.kind==='dispatch_sent'));
}
for(const kind of ['normal','dropped','interrupted','unavailable','expired']){
 const worlds=pair('industrial-park-v1',42,'external',kind==='dropped'?1:0,kind==='expired'?{ttl:1}:{});for(const s of worlds){const a=s.agents[0];[a.x,a.y]=s.part.site;assert(E.submitAction(s,a.id,{requestId:'scan',type:'scan',targetTick:1,expiresTick:10}).ok)}for(let i=0;i<3;i++)step(worlds);
 for(const s of worlds){assert(E.submitEvidence(s,'drone-1',{requestId:'report',scanRequestId:'scan'}).ok);if(kind==='interrupted')assert(E.interruptCommunication(s,'drone-1',8).ok);if(kind==='unavailable')s.agents[0].disabled=true}for(let i=0;i<5;i++)step(worlds);assert.equal(worlds[0].evidenceReports[0].status,kind==='normal'?'delivered':'failed');if(kind!=='normal')assert.equal(worlds[0].evidenceReports[0].reason,kind);
}
{const worlds=pair('lunar-sampling-v1',42,'rule');let submitted=false;for(let i=0;i<500&&!worlds[0].done;i++){step(worlds);const sample=worlds[0].events.find(e=>e.kind==='sample_collected');if(sample&&!submitted){for(const s of worlds)assert(E.submitSampleReport(s,sample.agentId,{requestId:'sample',taskId:sample.taskId}).ok);submitted=true}}assert(submitted);assert(worlds[0].sampleReports.some(r=>r.status==='delivered'))}
{const s=E.create(42,'nearest'),p=[{id:1,dueTick:10,expiresTick:2,unavailable:true,interrupted:true},{id:2,dueTick:10,expiresTick:20,unavailable:true,interrupted:true},{id:3,dueTick:1,expiresTick:20,unavailable:true,interrupted:true},{id:4,dueTick:1,expiresTick:20,unavailable:false,interrupted:true},{id:5,dueTick:1,expiresTick:20,unavailable:false,interrupted:false}];s.tick=3;assert.deepEqual(Rules.central(s,p,1000000).map(x=>x.state),['expired','waiting','unavailable','interrupted','delivered'])}
for(const central of [()=>{throw Error('native central failure')},()=>[]]){const s=E.create(42,'nearest',E.getScene('industrial-park-fixed-sensor-v1'),{dispatchMode:'external'});E.bindCommunicationRules(s,{...Rules,central});while(!s.fixedSensorState.queue.length)E.step(s);const before=structuredClone(s.fixedSensorState.queue);assert.throws(()=>E.step(s),/native central failure|invalid native central link result/);assert.deepEqual(s.fixedSensorState.queue,before)}
console.log('Rust central link parity: commands, status, sensors, evidence and samples passed');
