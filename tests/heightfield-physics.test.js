'use strict';
const assert=require('node:assert/strict'),H=require('../src/elevation'),{PhysicsWorld}=require('../rust/physics/target/release/box_physics.node');
const near=(a,b,e=1e-4)=>assert(Math.abs(a-b)<=e,`${a} != ${b}`),agent=(id,x,y,mobility='ground')=>({id,x,y,role:mobility==='air'?'drone':'rover',mobility});
const ramp=H.normalize({rows:2,cols:2,heights:[0,10,0,10]}),world=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[agent('ground',10,50)],heightfield:ramp}));
try{
 for(const [x,y] of [[0,0],[100,100],[25,70],[70,25],[100,0],[0,100]]){const native=world.surface(x,y),js=H.surface(ramp,x,y);[js.height,js.dx,js.dy,js.slopeDegrees].forEach((n,i)=>near(native[i],n,1e-10))}
 near(world.bodyPosition('ground')[2],H.proxyHeight(ramp,10,50));let moved=world.move('ground',10,50,80,0);near(moved[0],80);near(moved[1],0);assert.equal(moved[2],0);near(world.bodyPosition('ground')[2],H.proxyHeight(ramp,90,50));moved=world.move('ground',90,50,-80,0);near(moved[0],-80);near(world.bodyPosition('ground')[2],H.proxyHeight(ramp,10,50));
 const saved=world.checkpoint(),before=world.bodyPosition('ground');world.syncRoadblocks(JSON.stringify([{id:'road-1',x:40,y:40,w:10,h:20,height:4}]));moved=world.move('ground',10,50,80,0);assert(moved[0]<30&&moved[0]>20);assert(moved[2]>0);assert.equal(world.visible(30,50,7,60,50,7),false);world.rollback(saved);assert.deepEqual(world.bodyPosition('ground'),before);assert.equal(world.visible(30,50,7,60,50,7),true);saved.free();world.correctPosition('ground',70,50);near(world.bodyPosition('ground')[2],H.proxyHeight(ramp,70,50));
}finally{world.free()}
assert.throws(()=>world.surface(2,2));assert.throws(()=>world.bodyPosition('ground'));
const ridge=H.normalize({rows:3,cols:7,heights:Array.from({length:3},()=>[0,0,0,10,0,0,0]).flat(),maxSlopeDegrees:20}),cliff=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[agent('ground',10,25),agent('air',10,75,'air')],heightfield:ridge}));
try{assert.equal(H.traversable(ridge,[10,25],[90,25]),false);assert.deepEqual(cliff.move('ground',10,25,80,0),[0,0,0]);near(cliff.bodyPosition('ground')[0],10);near(cliff.move('air',10,75,80,0)[0],80);near(cliff.bodyPosition('air')[2],16);assert.equal(cliff.visible(10,25,1.5,90,25,1.5),false);assert.equal(cliff.visible(10,25,16,90,25,16),true);assert.equal(cliff.visible(10,25,-5,90,25,-5),true)}finally{cliff.free()}
// Independent geometry implementation versus the real native triangle collider.
const field=H.normalize({rows:5,cols:7,heights:Array.from({length:35},(_,i)=>Math.sin(i%7*.9)*Math.cos(Math.floor(i/7)*.8)*5),maxSlopeDegrees:40}),rays=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[],heightfield:field}));let seed=42;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};let blocked=0;
try{for(let i=0;i<512;i++){const from={x:2+random()*96,y:2+random()*96},to={x:2+random()*96,y:2+random()*96};from.z=i%4===0?16:H.height(field,from.x,from.y)+1.5;to.z=i%7===0?16:H.height(field,to.x,to.y)+1.5;const expected=H.visible(field,from,to),actual=rays.visible(from.x,from.y,from.z,to.x,to.y,to.z);assert.equal(actual,expected,JSON.stringify({i,from,to}));if(!actual)blocked++;const at=rays.surface(from.x,from.y),js=H.surface(field,from.x,from.y);near(at[0],js.height,1e-10);near(at[3],js.slopeDegrees,1e-10)}}finally{rays.free()}assert(blocked>0);
for(const bad of [null,{rows:1,cols:2,heights:[0,0]}, {...ramp,heights:[0,11,0,0]},{...ramp,extra:1}])assert.throws(()=>new PhysicsWorld(JSON.stringify({obstacles:[],agents:[],heightfield:bad})));
const old=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[agent('one',10,20)]}));try{assert.deepEqual(old.bodyPosition('one'),[10,20,1]);assert.deepEqual(old.surface(5,5),[0,0,0,0]);near(old.move('one',10,20,2,0)[0],2)}finally{old.free()}
console.log('Native heightfield physics: exact surface gradients, real triangle-mesh512 ray parity, uphill/downhill grounded movement, steep-cell ground refusal/air crossing, elevated wall collision, checkpoint/rollback/correction, invalid map rejection and unchanged flat-world behavior passed '+JSON.stringify({rays:512,blocked}));
// The installed Parry triangle cast reports t=0 on an infinite face plane
// outside that finite triangle. Preserve finite-face and thin-mesh truth.
const pyramid=H.normalize({rows:3,cols:3,heights:[0,0,0,0,10,0,0,0,0]}),grazing=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[],heightfield:pyramid}));
try{
 for(const [a,b,clear]of [
  [[10,50,18],[90,50,3],true],[[10,50,18],[90,50,-5],false],
  [[55,55,8],[70,55,5],false],[[55,55,8],[55,55,8],false],
  [[55,55,8.5],[55,55,8.5],true],[[10,50,-5],[90,50,-5],true]
 ]){assert.equal(grazing.visible(...a,...b),clear,JSON.stringify({a,b}));assert.equal(H.visible(pyramid,{x:a[0],y:a[1],z:a[2]},{x:b[0],y:b[1],z:b[2]}),clear)}
}finally{grazing.free()}
const depression=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[{id:'ground',role:'worker',x:20,y:50}],heightfield:{rows:2,cols:2,heights:[-10,-10,-10,-10]}}));try{assert.equal(depression.lidar('ground',-8.5,8,20).length,8);assert.deepEqual(depression.lidar('ground',-10,8,20),Array(8).fill(0));}finally{depression.free()}
console.log('Finite actual-mesh ray regression: false zero-distance face-extension hit rejected, later real hit retained, coplanar/point surface hits retained, below-surface thin mesh and negative-ground lidar passed');
