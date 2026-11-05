'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),D=require('../src/relay'),Init=require('../server/rust-world-initialization'),Motion=require('../server/rust-world-motion'),Rules=require('../server/rust-task-rules'),C=require('../server/native-components'),{WorldMotion}=require('../rust/physics/target/release/box_physics.node'),{fixture}=require('./relay-support');
for(const mutate of [s=>s.agents[0].deployableRelay=null,s=>s.agents[0].deployableRelay=false,s=>s.agents[0].mobility='air',s=>s.agents[0].capabilities=['inspect'],s=>s.tasks[0].capability='inspect']){const s=fixture();mutate(s);assert.throws(()=>Init.create(42,'nearest',s));assert.throws(()=>E.create(42,'nearest',s))}
const motionKeys=['id','x','y','battery','initialBattery','distance'];
for(const state of [null,{},[],{deployed:false,taskId:null},{deployed:true},{deployed:true,taskId:'deploy',assignmentId:1,deployedTick:0,position:[0,0]}]){
 const w=E.create(42,'nearest',fixture()),n=new WorldMotion(JSON.stringify(w.agents.map(a=>Object.fromEntries(motionKeys.map(k=>[k,a[k]])))));const agents=w.agents.map(a=>Object.fromEntries(Object.entries(a).filter(([k])=>!motionKeys.slice(1).includes(k))));agents[0].relayState=state;assert.throws(()=>n.bindExecution(JSON.stringify({tick:0,agents})));n.free();
}
// Partial binding exercises the legacy native pure-rule/host completion path,
// separately from the fully owned native world-step tests.
const scene=fixture(),w=E.create(42,'nearest',scene,{dispatchMode:'external'}),motion=Motion.create(w);E.bindWorldMotion(w,motion);const execution=motion.execution(w);E.bindWorldExecution(w,execution);E.bindTaskRules(w,Rules);
try{assert(E.assign(w,'deploy','relay-1').ok);for(let i=0;i<100&&!w.agents[0].relayState.deployed;i++)E.step(w);D.validateWorld(w);assert.equal(w.agents[0].status,'deployed');const n=C.reference(execution,'execution').native,before=n.snapshotExecution(),positions=n.snapshot(),a=w.agents[0];
 for(const patch of [{relayState:{deployed:false},status:'idle'},{relayState:{...a.relayState,assignmentId:a.relayState.assignmentId+1}},{status:'working'},{route:[[50,50]]},{deployableRelay:false}]){assert.throws(()=>n.updateExecution(0,JSON.stringify(patch)));assert.equal(n.snapshotExecution(),before)}
 assert.throws(()=>n.commit(0,a.x+1,a.y,a.battery,a.distance+1));assert.equal(n.snapshot(),positions);assert.throws(()=>n.commit(0,a.x,a.y,a.battery,a.distance+1));assert.equal(n.snapshot(),positions);assert.throws(()=>{a.relayState.deployed=false},TypeError);assert.equal(n.snapshotExecution(),before);
}finally{E.disposeWorld(w)}
console.log('Native relay schema and partial binding: strict configuration/state, actual pure-rule completion, immutable deployment identity and projection, fixed position/travel distance and unchanged state after refusals passed');
