'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),N=require('../src/navigation'),R=require('../src/replay');
function run(policy){
 const scene=E.getScene();scene.obstacles=[];scene.navigation=policy;scene.terrain=[{id:'crossing',name:'通行区域',x:30,y:40,w:40,h:20,speedFactor:1,energyFactor:1}];
 const s=E.create(42,'nearest',scene,{dispatchMode:'external'}),a=s.agents.find(x=>x.id==='vehicle-1');a.x=10;a.y=50;
 assert(E.submitAction(s,a.id,{requestId:'move',type:'move',target:{x:90,y:50},targetTick:1,expiresTick:90}).ok);E.step(s);assert.equal(s.actions[0].status,'accepted');assert.deepEqual(a.route,[[90,50]]);
 const frames=[E.snapshot(s)];assert(E.injectTerrainEffect(s,'crossing',15,.2,5).ok);frames.push(E.snapshot(s));
 if(policy==='distance'){assert.deepEqual(a.route,[[90,50]]);assert(!s.events.some(e=>e.kind==='terrain_route_replanned'));assert(!s.events.some(e=>e.kind==='terrain_route_assessed'))}
 else {assert(a.route.length>1);const event=s.events.find(e=>e.kind==='terrain_route_replanned');assert(event&&event.transition==='started'&&event.policy===policy);const assessment=s.events.find(e=>e.kind==='terrain_route_assessed');assert.equal(assessment.result,'changed');assert.deepEqual(assessment.zoneIds,['crossing']);assert.equal(assessment.previousCost,event.previousCost);assert.equal(assessment.newCost,event.newCost);assert(event.newCost<event.previousCost);let p=[a.x,a.y];for(const q of a.route){assert(N.clearSegment(p,q,scene.obstacles));p=q}}
 for(let i=0;i<16;i++){E.step(s);frames.push(E.snapshot(s))}
 if(policy!=='distance')assert(s.events.some(e=>e.kind==='terrain_route_replanned'&&e.transition==='ended'));
 while(s.actions[0].status==='accepted'&&s.tick<150){E.step(s);if(s.tick%10===0)frames.push(E.snapshot(s))}frames.push(E.snapshot(s));assert.equal(s.actions[0].status,'completed');assert(Math.hypot(a.x-90,a.y-50)<1e-7);
 assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));return s;
}
for(const policy of ['distance','time','energy'])run(policy);
{
 const scene=E.getScene();scene.obstacles=[];scene.navigation='time';scene.terrain=[{id:'crossing',name:'通行区域',x:30,y:40,w:40,h:20,speedFactor:1,energyFactor:1}];
 scene.tasks[0]={...scene.tasks[0],role:'vehicle',capability:'deliver',target:[90,50]};
 const s=E.create(42,'nearest',scene,{dispatchMode:'external'}),a=s.agents.find(x=>x.id==='vehicle-1');a.x=10;a.y=50;
 assert(E.assign(s,'inspect',a.id).ok);assert.deepEqual(a.route,[[90,50]]);assert(E.injectTerrainEffect(s,'crossing',15,.2,5).ok);
 assert(a.route.length>1);assert(s.events.some(e=>e.kind==='terrain_route_replanned'&&e.agentId===a.id));
 const b=s.agents.find(x=>x.id==='vehicle-2');b.x=10;b.y=52;assert(E.submitAction(s,b.id,{requestId:'new-after-effect',type:'move',target:{x:90,y:52},targetTick:1,expiresTick:90}).ok);E.step(s);assert(b.route.length>1,'newly planned route uses the current effect');
}

{
 const scene=E.getScene();scene.obstacles=[];scene.navigation='time';scene.terrain=[{id:'remote',name:'远端区域',x:70,y:70,w:10,h:10,speedFactor:1,energyFactor:1}];
 const s=E.create(42,'nearest',scene,{dispatchMode:'external'}),a=s.agents.find(x=>x.id==='vehicle-1');a.x=10;a.y=10;assert(E.submitAction(s,a.id,{requestId:'unaffected',type:'move',target:{x:40,y:10},targetTick:1,expiresTick:90}).ok);E.step(s);assert(E.injectTerrainEffect(s,'remote',2,.5,2).ok);const e=s.events.find(x=>x.kind==='terrain_route_assessed');assert.equal(e.result,'retained');assert.equal(e.newCost,e.previousCost);assert(!s.events.some(x=>x.kind==='terrain_route_replanned'));for(let i=0;i<3;i++)E.step(s);assert(s.events.some(x=>x.kind==='terrain_route_assessed'&&x.transition==='ended'&&x.zoneIds[0]==='remote'));
}
console.log('terrain transition replanning and replay tests passed');
