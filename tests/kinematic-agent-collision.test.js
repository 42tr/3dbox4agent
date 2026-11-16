'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine');

function fixture(){
 const scene=E.getScene('lunar-outpost-v1');
 scene.obstacles=[];scene.terrain=[];
 scene.agents=[
  {role:'worker',label:'Worker',count:1,capabilities:['inspect'],speed:3},
  {role:'blocker',label:'Blocker',count:1,capabilities:['hold'],speed:1}
 ];
 scene.tasks=[{id:'survey',behavior:'survey',name:'Survey',role:'worker',capability:'inspect',target:[45,50],duration:1,dependsOn:[]}];
 return scene;
}

const world=E.create(42,'nearest',fixture(),{physicsMode:'kinematic',dispatchMode:'external'});
Object.assign(world.agents[0],{x:20,y:50,battery:100,initialBattery:100});
Object.assign(world.agents[1],{x:30,y:50,battery:100,initialBattery:100});
assert(E.assign(world,'survey','worker-1').ok);
for(let i=0;i<30&&!world.done;i++){E.step(world);assert(Math.hypot(world.agents[0].x-world.agents[1].x,world.agents[0].y-world.agents[1].y)>=1.6-1e-8,'kinematic bodies must not overlap')}
const worker=world.agents[0],blocker=world.agents[1];
assert(world.events.some(e=>e.kind==='collision_contact'),'blocked kinematic movement records contact');
assert(world.events.some(e=>e.kind==='collision_replan'),'blocked kinematic movement replans around the device');
assert.equal(world.tasks[0].status,'done');

const escapeScene=fixture();
escapeScene.tasks[0].target=[20,50];
const touching=E.create(42,'nearest',escapeScene,{physicsMode:'kinematic',dispatchMode:'external'});
const [escaping,parked]=touching.agents;
Object.assign(escaping,{x:28.4,y:50});
Object.assign(parked,{x:30,y:50});
assert(E.assign(touching,'survey','worker-1').ok);
E.step(touching);
assert(escaping.x<28.4,'a touching body can move away on its first step');
assert(!touching.events.some(e=>e.kind==='collision_contact'));

const patrol=E.create(42,'nearest',E.scene,{physicsMode:'kinematic',dispatchMode:'external'});
assert(E.submitAction(patrol,'drone-1',{requestId:'patrol-move',type:'move',target:{x:35,y:50},targetTick:1,expiresTick:40}).ok);
for(let i=0;i<40&&['pending','accepted'].includes(patrol.actions[0].status);i++)E.step(patrol);
assert.equal(patrol.actions[0].status,'completed','standalone moves must replan around crowded targets');
assert(patrol.events.some(e=>e.kind==='collision_replan'&&e.agentId==='drone-1'));
console.log('Kinematic agent collision: same-layer bodies stop at the 1.6-unit proxy diameter, replan around parked devices, standalone moves replan too, and touching bodies can move away from contact');
