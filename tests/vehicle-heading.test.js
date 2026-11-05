'use strict';
const assert=require('node:assert/strict');
const {yaw}=require('../src/vehicle-heading'),E=require('../src/engine');
const Camera=require('../src/vehicle-camera');
const initial={id:'rover-1',x:10,y:10,route:[]};
for(const [point,angle] of [[[20,10],0],[[10,20],-Math.PI/2],[[0,10],-Math.PI],[[10,0],Math.PI/2]]){
 const agent={...initial,route:[[10,10],point]},copy=structuredClone(agent);
 assert(Math.abs(yaw(agent,null,.7)-angle)<1e-10);assert.deepEqual(agent,copy);
}
assert.equal(yaw(initial,null,.7),.7);
assert.equal(yaw({...initial,disabled:true,route:[[20,10]]},null,.7),.7);
assert(Math.abs(yaw(initial,{...initial,x:9},.7))<1e-10);
assert.equal(yaw(initial,{...initial,id:'other',x:9},.7),.7);
assert.equal(yaw({...initial,route:[[NaN,12],[10,10]]},null,.7),.7);
const world=E.create(42,'nearest',E.getScene('lunar-outpost-v1'));let activeHeadings=0;
while(!world.done&&world.tick<1000){const before=E.snapshot(world);E.step(world);for(const a of world.agents){const angle=yaw(a,before.agents.find(p=>p.id===a.id),.7);assert(Number.isFinite(angle));const target=a.route.find(p=>Math.hypot(p[0]-a.x,p[1]-a.y)>.02);if(target&&!a.disabled){const dx=target[0]-a.x,dz=target[1]-a.y;assert((Math.cos(angle)*dx-Math.sin(angle)*dz)/Math.hypot(dx,dz)>.999999);activeHeadings++}}}
assert(world.done&&!world.failed);assert(activeHeadings>100);
const obstacles=E.getScene('lunar-outpost-v1').obstacles;
// The old fixed front/right camera was occluded by the communications dish here.
const rover={x:23.3,y:21,z:0},angle=-.1;
for(const scale of [1,1.6]){const o=Camera.offset(rover,angle,obstacles,scale);assert(Camera.clear({x:rover.x+o.x,y:rover.y+o.z,z:rover.z+o.y},{x:rover.x,y:rover.y,z:.9},obstacles));assert(o.y>0)}
for(const a of world.agents){const p={x:a.x,y:a.y,z:0},o=Camera.offset(p,0,obstacles);assert(Camera.clear({x:p.x+o.x,y:p.y+o.z,z:o.y},{...p,z:.9},obstacles))}
console.log('vehicle presentation yaw: route corners, stopped/faulted devices and complete outpost movement passed');
