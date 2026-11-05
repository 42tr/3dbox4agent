'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),P=require('../server/rust-physics'),Env=require('../server/rust-world-environment'),Motion=require('../server/rust-world-motion');
const Native=require('../rust/physics/target/release/box_physics.node');
function bind(w){const env=Env.create(w),motion=Motion.create(w);E.bindWorldEnvironment(w,env);E.bindWorldMotion(w,motion);const execution=motion.execution(w);E.bindWorldExecution(w,execution);return {env,motion,execution}}
function same(a,b,label){assert.deepEqual(E.snapshot(b),E.snapshot(a),label)}
let frames=0;
for(const physicsMode of ['kinematic','rapier'])for(const seed of [1,42,713])for(const kind of ['empty','terrain','overlap','effects','risk']){
 const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];
 if(kind==='empty')scene.terrain=[];
 if(kind==='overlap')scene.terrain.push({...scene.terrain[0],id:'overlap',x:20,y:20,w:65,h:65,speedFactor:.7,energyFactor:1.6});
 if(kind==='risk')scene.riskZones=[{id:'diagonal',name:'Diagonal',x:30,y:30,w:15,h:15}];
 const a=E.create(seed,'nearest',scene,{physicsMode,dispatchMode:'external'}),b=E.snapshot(a);a.agents=a.agents.slice(0,1);b.agents=b.agents.slice(0,1);bind(b);const pa=physicsMode==='rapier'?P.createPhysics(a):null,pb=physicsMode==='rapier'?P.createPhysics(b):null;
 try{
  if(kind==='effects'){assert(E.injectTerrainEffect(a,'soft-regolith',12,.4,2).ok);assert(E.injectTerrainEffect(b,'soft-regolith',12,.4,2).ok)}
  const actor=a.agents[0].id,input={requestId:'route',type:'move',target:{x:84.1234567890123,y:46.000000123456},targetTick:1,expiresTick:100};
  const ra=E.submitAction(a,actor,input),rb=E.submitAction(b,actor,input);assert(ra.ok);assert.deepEqual(rb,ra);
  for(let i=0;i<130;i++){
   E.step(a,pa);E.step(b,pb);same(a,b,`${physicsMode}/${seed}/${kind}/${i}`);frames++;
   if(a.actions[0].status==='completed')break;
  }
  assert.equal(a.actions[0].status,'completed');
 }finally{E.disposeWorld(b);pa?.free();pb?.free()}
}
// Decimal/scientific waypoint keys, energy exhaustion and coincident waypoints.
for(const target of [[1e-8,40],[0,0],[99.99999999999999,1e-7],[16.000000000000004,24.000000000000004]]){
 const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];scene.terrain=[];
 const a=E.create(42,'nearest',scene,{dispatchMode:'external'}),b=E.snapshot(a);bind(b);
 const action={requestId:'edge',type:'move',target:{x:target[0],y:target[1]},targetTick:1,expiresTick:100};
 E.submitAction(a,a.agents[0].id,action);E.submitAction(b,b.agents[0].id,action);
 for(let i=0;i<90;i++){E.step(a);E.step(b);same(a,b,'numeric target '+target+'/'+i);frames++;if(a.actions[0].status==='completed')break}
 E.disposeWorld(b);
}
{
 const w=E.create(42),fields=Motion.fields,n=new Native.WorldMotion(JSON.stringify(w.agents.map(a=>Object.fromEntries(['id',...fields].map(k=>[k,a[k]])))));
 n.bindExecution(JSON.stringify({tick:0,agents:w.agents.map(a=>Object.fromEntries(Object.entries(a).filter(([k])=>!fields.includes(k))))}));
 const makeEnv=()=>new Native.WorldEnvironment(JSON.stringify({tick:0,state:Object.fromEntries(Env.fields.map(k=>[k,w[k]])),agents:w.agents.map(a=>({id:a.id,air:a.role==='drone'})),lastRoadblockEvent:0}));
 const env=makeEnv(),foreign=makeEnv(),context={tick:0,delivery:false,loaded:false,boundary:true,footprint:true,risks:true,exposures:[]};
 n.updateExecution(0,JSON.stringify({route:[[1e-8,40]],status:'manual'}));n.advanceRoute(0,JSON.stringify(context),env);assert.equal(JSON.parse(n.snapshotExecution())[0].progressWaypoint,[1e-8,40].join(','));const motion=n.snapshot(),execution=n.snapshotExecution();
 for(const [i,c,e] of [[-1,context,env],[0,{...context,tick:1},env],[0,{...context,loaded:'yes'},env],[0,{...context,exposures:[['unknown',0]]},env],[0,context,foreign]]){
  assert.throws(()=>n.advanceRoute(i,JSON.stringify(c),e));assert.equal(n.snapshot(),motion);assert.equal(n.snapshotExecution(),execution);
 }
 const p=new Native.PhysicsWorld(JSON.stringify(w));assert.throws(()=>n.advanceRouteRapier(0,JSON.stringify(context),env,p));assert.equal(n.snapshot(),motion);
 env.free();assert.throws(()=>n.advanceRoute(0,JSON.stringify(context),env));n.free();foreign.free();p.free();
}
{
 // The existing f32 position-consistency guard can fail only after traversing
 // many valid short segments. Neither the real collider nor native components
 // may retain the successful prefix from that failed phase.
 const w=E.create(42);w.obstacles=[];w.agents=[{...w.agents[0],x:80,y:50,speed:100}];const a=w.agents[0],fields=Motion.fields;
 const n=new Native.WorldMotion(JSON.stringify(w.agents.map(a=>Object.fromEntries(['id',...fields].map(k=>[k,a[k]])))));
 n.bindExecution(JSON.stringify({tick:0,agents:w.agents.map(a=>Object.fromEntries(Object.entries(a).filter(([k])=>!fields.includes(k))))}));
 n.updateExecution(0,JSON.stringify({status:'manual',route:Array.from({length:4096},(_,i)=>[80+(i+1)*.001,50])}));
 const env=new Native.WorldEnvironment(JSON.stringify({tick:0,state:Object.fromEntries(Env.fields.map(k=>[k,w[k]])),agents:[{id:a.id,air:true}],lastRoadblockEvent:0})),physics=new Native.PhysicsWorld(JSON.stringify(w));
 const motion=n.snapshot(),execution=n.snapshotExecution();
 assert.throws(()=>n.advanceRouteRapier(0,JSON.stringify({tick:0,delivery:false,loaded:false,boundary:true,footprint:true,risks:true,exposures:[]}),env,physics),/physics and world positions diverged/);
 assert.equal(n.snapshot(),motion);assert.equal(n.snapshotExecution(),execution);assert(physics.move(a.id,80,50,.25,0)[0]>0);
 n.free();env.free();physics.free();
}
console.log('Native full route phase matches browser movement in '+frames+' frames; terrain overlap/effects, risks, physical contacts, numeric waypoints, typed rejection, instance/time fencing and atomic state preservation passed');
