'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),R=require('../src/replay'),D=require('../src/delta');
const scene=E.getScene('industrial-park-risk-v1');
assert.deepEqual(E.normalizeScene(scene).riskZones,scene.riskZones);
for(const invalid of [[{id:'x',name:'x',x:99,y:0,w:2,h:1}],[{id:'x',name:'x',x:0,y:0,w:1,h:1},{id:'x',name:'y',x:0,y:0,w:1,h:1}]])assert.throws(()=>E.validateScene({...scene,riskZones:invalid}));
const s=E.create(42,'nearest',scene,{dispatchMode:'external'}),a=s.agents.find(a=>a.role==='drone');a.x=30;a.y=80;
function move(id,x){assert(E.submitAction(s,a.id,{requestId:id,type:'move',target:{x,y:80},targetTick:s.tick+1,expiresTick:s.tick+10}).ok);for(let n=0;n<30;n++){E.step(s);if(s.actions.find(v=>v.requestId===id).status==='completed')return}throw Error('move timeout')}
move('enter',40);assert.equal(E.metrics(s).riskZoneEntries,1);move('stay',45);assert.equal(E.metrics(s).riskZoneEntries,1);move('leave',30);assert.equal(E.metrics(s).riskZoneEntries,1);move('return',40);assert.equal(E.metrics(s).riskZoneEntries,2);
assert.equal(E.metrics({...s,riskMonitoringVersion:undefined}).riskZoneEntries,null);
let q=E.create(42,'nearest',scene),frames=[E.snapshot(q)];while(!q.done&&q.tick<500){E.step(q);frames.push(E.snapshot(q))}assert(q.done);assert(E.metrics(q).riskZoneEntries>0);let archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id},frames};assert.equal(R.validateArchive(structuredClone(archive)).frames.length,frames.length);const corrupt=structuredClone(archive);corrupt.frames.at(-1).riskZones[0].x=10;assert.throws(()=>R.validateArchive(corrupt));const old=structuredClone(E.create(42));delete old.riskMonitoringVersion;delete old.riskZones;assert.equal(E.metrics(old).riskZoneEntries,null);assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames:[old]}));assert.deepEqual(D.apply(frames[0],D.diff(frames[0],frames.at(-1))),frames.at(-1));

// Cross a narrow zone entirely within one movement step; old archives retain their sampled semantics.
{
 const thin=E.getScene('industrial-park-risk-v1');thin.riskZones=[{id:'thin',name:'窄带',x:40,y:79,w:.5,h:2},{id:'overlap',name:'重叠',x:40,y:79,w:.5,h:2}];
 function crossing(version,y=80){const w=E.create(42,'nearest',thin,{dispatchMode:'external'}),a=w.agents.find(x=>x.role==='drone');w.riskMonitoringVersion=version;a.x=30;a.y=y;a.speed=30;assert(E.submitAction(w,a.id,{requestId:'cross',type:'move',target:{x:60,y},targetTick:1,expiresTick:10}).ok);E.step(w);return w}
 const current=crossing(2);assert.equal(E.metrics(current).riskZoneEntries,2);assert.deepEqual(current.events.filter(e=>e.kind==='risk_zone_entered').map(e=>e.zoneId),['thin','overlap']);
 const legacy=crossing(1);assert.equal(E.metrics(legacy).riskZoneEntries,0);assert.equal(E.metrics(crossing(2,78)).riskZoneEntries,0);assert.equal(E.metrics(crossing(2,79)).riskZoneEntries,2);
 const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:thin.id,scene:thin},frames:[legacy]};assert(R.validateArchive(archive));
}
console.log('risk segment crossing, legacy sampling, replay and delta tests passed');

(async()=>{const P=require('../server/physics');await P.initialize();const w=E.create(42,'nearest',scene,{physicsMode:'rapier'}),p=P.createPhysics(w);try{while(!w.done&&w.tick<500)E.step(w,p);assert(w.done);assert(E.metrics(w).riskZoneEntries>0);assert.equal(E.metrics(w).riskZoneEntries,w.events.filter(e=>e.kind==='risk_zone_entered').length)}finally{p.free()}console.log('Rapier risk zone sampling passed')})().catch(e=>{console.error(e);process.exitCode=1});

(async()=>{const P=require('../server/physics');await P.initialize();const thin=E.getScene('industrial-park-risk-v1');thin.riskZones=[{id:'thin',name:'窄带',x:40,y:79,w:.5,h:2}];const w=E.create(42,'nearest',thin,{physicsMode:'rapier',dispatchMode:'external'}),a=w.agents.find(x=>x.id==='drone-1');a.x=30;a.y=80;a.speed=30;const p=P.createPhysics(w);try{assert(E.submitAction(w,a.id,{requestId:'cross-rapier',type:'move',target:{x:60,y:80},targetTick:1,expiresTick:10}).ok);E.step(w,p);assert(a.x>40.5);assert.equal(E.metrics(w).riskZoneEntries,1)}finally{p.free()}console.log('Rapier narrow zone crossing passed')})().catch(e=>{console.error(e);process.exitCode=1});
