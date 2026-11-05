'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),R=require('../src/replay');
const scene=E.getScene();scene.obstacles=[];scene.sensorRange=100;scene.communication.lossRate=0;
function setup(normal=false){const s=E.create(42,'nearest',scene,{dispatchMode:'external'});if(normal)s.asset.condition='operational';assert(E.submitAction(s,'drone-1',{requestId:'scan',type:'scan',targetTick:1,expiresTick:10}).ok);for(let i=0;i<3;i++)E.step(s);assert(E.submitEvidence(s,'drone-1',{requestId:'report',scanRequestId:'scan'}).ok);return s}
function propose(s,id,options={}){return {requestId:'r-'+id,observedTick:s.tick,evidenceId:1,task:{id,name:'证据复勘',role:'drone',target:[75,37],duration:5,dependsOn:[]},...options}}
let s=setup(),frames=[E.snapshot(s)],p=propose(s,'pending');assert.equal(E.proposeSurvey(s,p).proposal.reason,'evidence_unavailable');assert(!s.tasks.some(t=>t.id==='pending'));frames.push(E.snapshot(s));
for(let i=0;i<3;i++)E.step(s);assert.equal(E.coordinatorObservation(s).evidence.length,1);
let old=propose(s,'old',{observedTick:3});assert.equal(E.proposeSurvey(s,old).proposal.reason,'evidence_unavailable');let mismatch=propose(s,'wrong');mismatch.task.target=[74,37];assert.equal(E.proposeSurvey(s,mismatch).proposal.reason,'evidence_mismatch');
let missing=propose(s,'missing',{evidenceId:999});assert.equal(E.proposeSurvey(s,missing).proposal.reason,'evidence_unavailable');assert.equal(E.proposeSurvey(s,propose(s,'invalid',{evidenceId:null})).reason,'invalid_proposal');
let good=propose(s,'bound');let result=E.proposeSurvey(s,good);assert.equal(result.proposal.status,'accepted');assert.equal(result.proposal.evidenceId,1);assert(E.proposeSurvey(s,good).duplicate);assert.equal(E.proposeSurvey(s,{...good,evidenceId:2}).reason,'request_id_conflict');assert(s.events.some(e=>e.kind==='task_proposed'&&e.evidenceId===1));frames.push(E.snapshot(s));
while(s.tick<64)E.step(s);assert.equal(E.proposeSurvey(s,propose(s,'stale')).proposal.reason,'evidence_stale');frames.push(E.snapshot(s));
const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames};assert(R.validateArchive(archive));const forged=structuredClone(archive);forged.frames.at(-1).proposals.find(x=>x.status==='accepted').evidenceId=999;assert.throws(()=>R.validateArchive(forged));
s=setup(true);for(let i=0;i<3;i++)E.step(s);assert.equal(E.coordinatorObservation(s).evidence[0].result.kind,'normal');assert.equal(E.proposeSurvey(s,propose(s,'normal')).proposal.reason,'evidence_mismatch');
console.log('evidence-bound proposal provenance and replay tests passed');
