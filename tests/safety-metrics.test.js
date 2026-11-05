'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),X=require('../src/experiments');
function world(){return E.create(42,'nearest',E.scene,{dispatchMode:'external'})}
function check(s,agent,request){const events=s.events.filter(e=>e.kind==='energy_depleted');assert.equal(events.length,1);assert.equal(events[0].agentId,agent.id);assert.equal(events[0].actionId,request);assert.equal(E.metrics(s).energyDepletions,1);assert.equal(s.actions.find(a=>a.requestId===request).reason,'energy_depleted');for(let i=0;i<3;i++)E.step(s);assert.equal(E.metrics(s).energyDepletions,1)}
{
 const s=world(),a=s.agents.find(a=>a.role==='drone');a.x=0;a.y=0;a.battery=5.01;
 assert(E.submitAction(s,a.id,{requestId:'move-empty',type:'move',target:{x:99,y:99},targetTick:1,expiresTick:10}).ok);
 for(let i=0;i<100&&!a.disabled;i++)E.step(s);check(s,a,'move-empty');
}
{
 const s=world(),a=s.agents.find(a=>a.role==='drone');a.x=99;a.y=99;a.battery=1;
 assert(E.submitAction(s,a.id,{requestId:'charge-empty',type:'charge',targetTick:1,expiresTick:10}).ok);
 for(let i=0;i<100&&!a.disabled;i++)E.step(s);check(s,a,'charge-empty');
}
{
 const s=world(),a=s.agents.find(a=>a.role==='drone');
 assert(E.submitAction(s,a.id,{requestId:'scan-empty',type:'scan',targetTick:1,expiresTick:10}).ok);E.step(s);a.battery=.01;E.step(s);check(s,a,'scan-empty');
}
const summary=X.summarize([{policy:'nearest',status:'failed',metrics:{ticks:2,distance:1,energyUsed:1,replans:0,deadlineMissed:0,energyDepletions:1},faultInjected:false}],['nearest'])[0];assert.equal(summary.energyDepletionRuns,1);assert.equal(summary.energyDepletions.mean,1);assert.equal(summary.collisionDetection,'not_simulated');
console.log('energy exhaustion and safety summary tests passed');
