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
console.log('Kinematic agent collision: same-layer bodies stop at the 1.6-unit proxy diameter and replan around parked devices');
