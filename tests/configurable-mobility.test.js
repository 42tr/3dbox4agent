'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),S=require('../src/sensors'),R=require('../src/replay'),P=require('../server/physics');
const scene=require('../examples/scenes/custom-air-scout.json');
(async()=>{
 assert.equal(E.normalizeScene(scene).agents[0].mobility,'air');const invalid=structuredClone(scene);invalid.agents[0].mobility='hover';assert.throws(()=>E.validateScene(invalid),/invalid agent type/);
 const s=E.create(42,'nearest',scene),scout=s.agents.find(a=>a.role==='scout');assert(S.isAir(scout));assert.equal(S.position(scout).z,16);assert.equal(E.observe(s,scout.id).self.mobility,'air');const frames=[E.snapshot(s)];while(!s.done&&s.tick<1000){E.step(s);frames.push(E.snapshot(s))}assert(!s.failed&&s.done);assert(s.tasks.every(t=>t.status==='done'));
 const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene:E.normalizeScene(scene)},frames};assert(R.validateArchive(archive));const altered=structuredClone(archive);altered.frames[0].agents.find(a=>a.id===scout.id).mobility='ground';assert.throws(()=>R.validateArchive(altered));
 const inverse=structuredClone(scene);inverse.agents[0].role='drone';inverse.agents[0].mobility='ground';const g=E.create(42,'nearest',inverse,{dispatchMode:'external'}).agents.find(a=>a.role==='drone');assert(!S.isAir(g));assert.equal(S.position(g).z,1.5);assert(S.isAir({role:'drone'}));assert(!S.isAir({role:'rover'}));
 const w=E.create(42,'nearest',scene,{dispatchMode:'external',physicsMode:'rapier'}),a=w.agents.find(a=>a.role==='scout');a.x=45;a.y=15;await P.initialize();const physics=P.createPhysics(w);try{assert(E.submitAction(w,a.id,{requestId:'cross-building',type:'move',target:{x:90,y:15},targetTick:1,expiresTick:10}).ok);for(let i=0;i<30&&w.actions[0].status!=='completed';i++)E.step(w,physics);assert.equal(w.actions[0].status,'completed');assert(a.x>85)}finally{physics.free()}
 console.log('configurable mobility, full mission, replay and Rapier tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
