'use strict';
const assert=require('node:assert/strict'),H=require('../src/elevation'),W=require('../server/physics'),{PhysicsWorld}=require('../rust/physics/target/release/box_physics.node');
const near=(a,b,e=1e-4)=>assert(Math.abs(a-b)<=e,`${a} != ${b}`);
(async()=>{await W.initialize();const h=H.normalize({rows:2,cols:2,heights:[0,10,0,10]}),a={id:'one',role:'rover',x:10,y:50},state={heightfield:h,agents:[a],obstacles:[]},w=W.createPhysics(state),n=new PhysicsWorld(JSON.stringify(state));
 try{
  assert.deepEqual(w.surface(40,30),n.surface(40,30));let point={...a};for(const dx of [20,30,-10,-40]){const m=w.move(point,dx,0),native=n.move('one',point.x,point.y,dx,0);near(m.x,native[0]);near(m.y,native[1]);assert.equal(m.contacts,0);point.x+=m.x;point.y+=m.y;w.bodyPosition('one').forEach((v,i)=>near(v,n.bodyPosition('one')[i]));near(w.bodyPosition('one')[2],H.proxyHeight(h,point.x,point.y))}
  const wp=w.checkpoint(),np=n.checkpoint(),before=w.bodyPosition('one'),barrier=[{id:'road-1',x:40,y:40,w:10,h:20,height:4}];w.syncRoadblocks(barrier);n.syncRoadblocks(JSON.stringify(barrier));const moved=w.move(point,80,0),native=n.move('one',point.x,point.y,80,0);assert(moved.x<30&&moved.x>20&&moved.contacts>0);near(moved.x,native[0],.04);w.rollback(wp);n.rollback(np);assert.deepEqual(w.bodyPosition('one'),before);assert.deepEqual(n.bodyPosition('one'),before);wp.free();np.free();w.correctPosition(point,70,50);n.correctPosition('one',70,50);w.bodyPosition('one').forEach((v,i)=>near(v,n.bodyPosition('one')[i]));
 }finally{w.free();n.free()}
 const ridge=H.normalize({rows:3,cols:7,heights:Array.from({length:3},()=>[0,0,0,10,0,0,0]).flat(),maxSlopeDegrees:20}),ground={id:'g',role:'rover',x:10,y:25},air={id:'a',role:'drone',x:10,y:75},world=W.createPhysics({heightfield:ridge,agents:[ground,air],obstacles:[]});try{assert.deepEqual(world.move(ground,80,0),{x:0,y:0,contacts:0});near(world.move(air,80,0).x,80);near(world.bodyPosition('a')[2],16)}finally{world.free()}
 for(const field of [null,{...h,rows:99},{...h,heights:[NaN,0,0,0]}])assert.throws(()=>W.createPhysics({heightfield:field,obstacles:[],agents:[]}));
 const old=W.createPhysics({obstacles:[],agents:[a]});try{assert.deepEqual(old.bodyPosition('one'),[10,50,1]);near(old.move(a,2,0).x,2)}finally{old.free()}
 console.log('WASM/native heightfield physics: grounded ramp movement, flat legacy behavior, conservative elevated barriers, checkpoint/rollback/correction, steep-cell refusal and independent air crossing passed');
})().catch(e=>{console.error(e);process.exitCode=1});
