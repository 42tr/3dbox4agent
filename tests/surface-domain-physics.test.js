'use strict';
const assert=require('node:assert/strict'),D=require('../src/surface-domain'),Wasm=require('../server/physics'),Native=require('../server/rust-physics'),{PhysicsWorld}=require('../rust/physics/target/release/box_physics.node');
const agent=(id,x,y,mobility)=>({id,role:'platform',x,y,mobility}),domain={water:[{id:'sea',name:'Sea',x:40,y:0,w:60,h:100}]};
const near=(a,b,e=.03)=>assert(Math.abs(a-b)<=e,`${a} != ${b}`);
(async()=>{
 await Wasm.initialize();
 for(const [name,P]of [['native',Native],['wasm',Wasm]]){
  const agents=[agent('boat',60,20,'water'),agent('rover',20,70,'ground'),agent('aircraft',20,90,'air')],p=P.createPhysics({obstacles:[],agents,surfaceDomain:domain});
  try{
   const point=p.checkpoint(),positions=agents.map(a=>({...a}));
   let m=p.move(agents[0],-40,0);near(agents[0].x+m.x,40.82);assert(m.contacts>0);assert(D.free(domain,'water',[60+m.x,20+m.y],.79));
   m=p.move(agents[1],60,0);near(20+m.x,39.18);assert(m.contacts>0);
   m=p.move(agents[2],60,0);near(m.x,60);assert.equal(m.contacts,0);
   p.rollback(point);if(p.bodyPosition)for(const a of positions)near(p.bodyPosition(a.id)[0],a.x);
   m=p.move(agents[0],200,0);near(60+m.x,99.18);assert(m.contacts>0);p.rollback(point);
   m=p.move(agents[1],-200,0);near(20+m.x,.82);p.rollback(point);
   m=p.move(agents[0],-40,20);near(60+m.x,40.82);assert(m.y>10);p.rollback(point);
   assert.throws(()=>p.correctPosition(agents[0],20,20));assert.throws(()=>p.correctPosition(agents[1],60,70));
   p.correctPosition(agents[0],80,20);p.move({...agents[0],x:80},-50,0);p.rollback(point);
   p.syncRoadblocks([{id:'road-1',x:48,y:15,w:2,h:10,height:4}]);m=p.move(agents[0],-30,0);near(60+m.x,50.82);p.rollback(point);m=p.move(agents[0],-30,0);near(60+m.x,40.82);point.free();
   console.log(name+' selective domain masks: own boundary, opposite-domain exclusion, aircraft, swept collision/slide, world perimeter, roadblocks, correction and checkpoint passed');
  }finally{p.free()}
  for(const state of [
   {obstacles:[],agents:[agent('boat',60,20,'water')]},
   {obstacles:[],agents:[agent('boat',20,20,'water')],surfaceDomain:domain},
   {obstacles:[],agents:[agent('boat',40.799,20,'water')],surfaceDomain:domain},
   {obstacles:[],agents:[agent('rover',60,20,'ground')],surfaceDomain:domain},
   {obstacles:[],agents:[],surfaceDomain:null},
   {obstacles:[],agents:[],surfaceDomain:domain,heightfield:{rows:2,cols:2,heights:[0,0,0,0]}},
  ])assert.throws(()=>P.createPhysics(state));
 }
 const rays=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[agent('boat',60,20,'water')],surfaceDomain:domain}));
 try{assert(rays.visible(20,50,1.5,80,50,1.5));assert.deepEqual(rays.lidar('boat',1.5,8,100),Array(8).fill(-1));const saved=rays.checkpoint();rays.syncRoadblocks(JSON.stringify([{id:'barrier',x:48,y:10,w:2,h:20,height:4}]));assert(!rays.visible(20,20,1.5,80,20,1.5));assert(rays.lidar('boat',1.5,8,100).some(d=>d>=0));rays.rollback(saved);assert(rays.visible(20,20,1.5,80,20,1.5));assert.deepEqual(rays.lidar('boat',1.5,8,100),Array(8).fill(-1));saved.free()}finally{rays.free()}
 const seam={water:[{id:'one',name:'One',x:10,y:10,w:40,h:80},{id:'two',name:'Two',x:50,y:10,w:40,h:80}]};
 for(const P of [Native,Wasm]){const a=agent('boat',20,50,'water'),p=P.createPhysics({obstacles:[],agents:[a],surfaceDomain:seam});try{const m=p.move(a,60,0);near(m.x,60);assert.equal(m.contacts,0)}finally{p.free()}}
 const ring={water:[{id:'n',name:'N',x:20,y:20,w:60,h:10},{id:'s',name:'S',x:20,y:70,w:60,h:10},{id:'w',name:'W',x:20,y:30,w:10,h:40},{id:'e',name:'E',x:70,y:30,w:10,h:40}]};
 for(const P of [Native,Wasm]){const a=agent('boat',25,50,'water'),p=P.createPhysics({obstacles:[],agents:[a],surfaceDomain:ring});try{const m=p.move(a,50,0);near(a.x+m.x,29.18);assert(m.contacts>0)}finally{p.free()}}
 // Constrained colliders must never bind to a legacy authoritative map that
 // knows nothing of their domain, even when all initial poses remain legal.
 const E=require('../src/engine'),{bind}=require('./native-task-frame-support'),w=E.create(42,'nearest',E.getScene('lunar-outpost-v1'),{physicsMode:'rapier'}),p=Native.createPhysics({...w,surfaceDomain:{water:[{id:'far',name:'Far',x:92,y:92,w:5,h:5}]}});
 try{E.bindRaySensors(w,p);assert.throws(()=>bind(w,p,{batch:true,actionBatch:true,worldBatch:true}));assert.equal(w.tick,0)}finally{E.disposeWorld(w);p.free()}
 console.log('Native sensing: domain boundaries invisible to LOS and lidar, real temporary obstacle still occludes, rollback restores both; touching water regions have no physical seam');
})().catch(e=>{console.error(e);process.exitCode=1});
