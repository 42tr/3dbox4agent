'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Motion=require('../server/rust-world-motion'),Rules=require('../server/rust-task-rules'),Ledger=require('../server/rust-world-ledger'),Physics=require('../server/rust-physics'),{WorldMotion}=require('../rust/physics/target/release/box_physics.node');
const initial=[{id:'rover-1',x:0,y:100,battery:80,initialBattery:93,distance:12.5}];
function native(value=initial){return new WorldMotion(JSON.stringify(value))}
for(const change of [x=>x.length=0,x=>x.push({...x[0]}),x=>x[0].id='',x=>x[0].id='x'.repeat(65),x=>x[0].x=-1,x=>x[0].y=100.01,x=>x[0].battery=101,x=>x[0].initialBattery=-1,x=>x[0].distance=-1,x=>x[0].other=1,x=>delete x[0].battery,x=>x[0].x=null]){const value=structuredClone(initial);change(value);assert.throws(()=>native(value),/invalid world motion/)}
{
 const a=native(),b=native(),before=a.snapshot();
 for(const index of [-1,.5,1,50,NaN,Infinity]){assert.throws(()=>a.read(index,'x'),/invalid world motion/);assert.throws(()=>a.commit(index,1,99,79,13),/invalid world motion/)}
 for(const values of [[-1,1,79,13],[1,101,79,13],[1,99,-1,13],[1,99,101,13],[1,99,79,12],[NaN,99,79,13],[1,Infinity,79,13],[1,99,NaN,13],[1,99,79,Infinity]])assert.throws(()=>a.commit(0,...values),/invalid world motion/);
 assert.equal(a.snapshot(),before);assert.throws(()=>a.read(0,'other'),/invalid world motion/);a.commit(0,1,99,79,13);assert.equal(a.read(0,'x'),1);assert.equal(a.read(0,'initialBattery'),93);assert.equal(b.snapshot(),before);
 const copy=JSON.parse(a.snapshot());copy[0].x=99;assert.equal(a.read(0,'x'),1);a.free();a.free();for(const op of [()=>a.snapshot(),()=>a.read(0,'x'),()=>a.commit(0,1,1,1,20)])assert.throws(op,/closed/);b.free();
}
function bind(world){const store=Motion.create(world);E.bindWorldMotion(world,store);E.bindWorldLedger(world,Ledger.create(world));return store}
{
 const world=E.create(42),copy=E.snapshot(world),store=bind(world);assert.deepEqual(E.snapshot(world),copy);
 for(const key of Motion.fields){assert.throws(()=>world.agents[0][key]=0,TypeError);assert.throws(()=>Object.defineProperty(world.agents[0],key,{value:0}),TypeError)}
 assert.throws(()=>world.agents[0].id='other',TypeError);assert.throws(()=>world.agents=[],TypeError);assert.throws(()=>world.agents[0]={},TypeError);assert.throws(()=>world.agents.push({}),TypeError);assert.throws(()=>E.bindWorldMotion(E.create(42),store),/unavailable/);
 const detached=E.snapshot(world);detached.agents[0].x=99;assert.equal(world.agents[0].x,copy.agents[0].x);assert.throws(()=>store.apply(0,{battery:101}),e=>e.worldMotionFailure&&e.status===503);assert.deepEqual(E.snapshot(world),copy);E.disposeWorld(world);E.disposeWorld(world);
 const wrong=E.create(43),unbound=Motion.create(wrong);assert.throws(()=>E.bindWorldMotion(E.create(42),unbound),/unavailable/);unbound.free();
}
// Every committed snapshot, rather than only terminal metrics, must agree.
for(const sceneId of ['industrial-park-v1','industrial-park-parallel-v1','lunar-base-v1','lunar-terrain-v1','lunar-sampling-v1','lunar-outpost-v1','shore-coordination-v1'])for(const seed of [42,43]){
 const a=E.create(seed,'nearest',E.getScene(sceneId)),b=E.snapshot(a);E.bindTaskRules(b,Rules);const store=bind(b);let fork=null;
 while(!a.done&&a.tick<1000){if(a.tick===3){E.fault(a);E.fault(b);fork=E.snapshot(b);bind(fork);E.bindTaskRules(fork,Rules,true)}E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a),`${sceneId}:${seed}:${a.tick}`);if(fork){E.step(fork);assert.deepEqual(E.snapshot(fork),E.snapshot(b))}}
 assert(a.done);assert.deepEqual(E.metrics(b),E.metrics(a));assert.deepEqual(store.snapshot(),b.agents.map(a=>Object.fromEntries(['id',...Motion.fields].map(k=>[k,a[k]]))));E.disposeWorld(b);E.disposeWorld(fork);
}
for(const actionType of ['charge','scan']){
 const a=E.create(42,'nearest',E.getScene(),{dispatchMode:'external'}),first=a.agents[0];[first.x,first.y]=actionType==='charge'?a.chargingStation:a.part.site;first.battery=actionType==='charge'?20.07:12.345678901234;
 const b=E.snapshot(a);bind(b);E.bindTaskRules(b,Rules);for(const w of [a,b])assert(E.submitAction(w,first.id,{requestId:actionType,type:actionType,targetTick:1,expiresTick:100}).ok);
 for(let i=0;i<100&&a.actions[0].status!=='completed';i++){E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a))}assert.equal(a.actions[0].status,'completed');assert.deepEqual(E.metrics(b),E.metrics(a));E.disposeWorld(b);
}
// The authoritative component path also runs with actual native collision motion.
for(const sceneId of ['industrial-park-v1','lunar-outpost-v1']){
 const a=E.create(42,'nearest',E.getScene(sceneId),{physicsMode:'rapier'}),b=E.snapshot(a),pa=Physics.createPhysics(a),pb=Physics.createPhysics(b);E.bindTaskRules(a,Rules);E.bindTaskRules(b,Rules);bind(b);
 try{while(!a.done&&a.tick<1000){if(a.tick===3){E.fault(a);E.fault(b)}E.step(a,pa);E.step(b,pb);assert.deepEqual(E.snapshot(b),E.snapshot(a),`${sceneId}:rapier:${a.tick}`)}assert(a.done&&!a.failed)}finally{pa.free();pb.free();E.disposeWorld(b)}
}
console.log('Rust motion/energy ownership, atomic rejection, protected projections, seven-scene per-frame parity, independent forks, charge/scan and native Rapier passed');
