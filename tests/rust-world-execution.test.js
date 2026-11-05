'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Motion=require('../server/rust-world-motion'),Tasks=require('../server/rust-world-tasks'),Ledger=require('../server/rust-world-ledger'),Rules=require('../server/rust-task-rules'),Physics=require('../server/rust-physics'),{WorldMotion}=require('../rust/physics/target/release/box_physics.node');
const numeric=['x','y','battery','initialBattery','distance'],initial=E.create(42),payload=w=>structuredClone({tick:w.tick,agents:w.agents.map(a=>Object.fromEntries(Object.entries(a).filter(([k,v])=>!numeric.includes(k)&&v!==undefined)))});
function native(w=initial){return new WorldMotion(JSON.stringify(w.agents.map(a=>Object.fromEntries(['id',...numeric].map(k=>[k,a[k]])))))}
for(const mutate of [v=>v.agents[0].status='other',v=>v.agents[0].disabled=true,v=>v.agents[0].work=-1,v=>v.agents[0].route=[[101,0]],v=>v.agents[0].activity.idle=1,v=>v.agents[0].roadblockWaitTicks=1,v=>v.agents[0].terrainDistance=1,v=>v.agents[0].speed=101,v=>v.agents[0].unknown=1,v=>v.agents[0].boundaryLastTick=1]){const n=native(),value=payload(initial);mutate(value);assert.throws(()=>n.bindExecution(JSON.stringify(value)),/invalid world execution/);assert.throws(()=>n.snapshotExecution(),/not bound/);n.free()}
{
 const n=native(),value=payload(initial);n.bindExecution(JSON.stringify(value));assert.throws(()=>n.bindExecution(JSON.stringify(value)),/already bound/);let before=n.snapshotExecution();
 for(const patch of [{work:2},{work:.5},{route:[[0,-1]]},{route:Array.from({length:4097},()=>[0,0])},{disabled:true},{status:'fault'},{speed:3},{work:null},{activity:{...value.agents[0].activity,idle:2}},{terrainDistance:1},{deliveryTravel:{emptyDistance:1,loadedDistance:0,emptyTicks:1,loadedTicks:0}},{unknown:1},{}]){assert.throws(()=>n.updateExecution(0,JSON.stringify(patch)),/invalid world execution/);assert.equal(n.snapshotExecution(),before)}
 for(const index of [-1,.5,NaN,50])assert.throws(()=>n.updateExecution(index,'{"work":1}'));
 n.updateExecution(0,'{"work":1}');n.updateExecution(0,'{"work":2}');before=n.snapshotExecution();assert.throws(()=>n.updateExecution(0,'{"work":1}'),/invalid world execution/);assert.equal(n.snapshotExecution(),before);n.updateExecution(0,'{"work":0}');
 const a=initial.agents[0];n.commit(0,a.x,a.y,a.battery,10);n.updateExecution(0,'{"terrainDistance":5}');before=n.snapshotExecution();for(const patch of [{terrainDistance:4},{terrainDistance:11}]){assert.throws(()=>n.updateExecution(0,JSON.stringify(patch)),/invalid world execution/);assert.equal(n.snapshotExecution(),before)}
 n.updateExecution(0,JSON.stringify({activity:{...value.agents[0].activity,idle:1}}));n.updateExecution(0,'{"disabled":true,"status":"fault","route":[]}');before=n.snapshotExecution();assert.throws(()=>n.updateExecution(0,'{"disabled":false,"status":"idle"}'),/invalid world execution/);assert.equal(n.snapshotExecution(),before);
 n.free();n.free();for(const op of [()=>n.snapshotExecution(),()=>n.updateExecution(0,'{"work":0}'),()=>n.read(0,'x')])assert.throws(op,/closed/);n.freeExecution();
}
function bind(w){const motion=Motion.create(w);E.bindWorldMotion(w,motion);const execution=motion.execution(w);E.bindWorldExecution(w,execution);E.bindWorldLedger(w,Ledger.create(w));E.bindWorldTasks(w,Tasks.create(w));E.bindTaskRules(w,Rules,w.tick!==0);return execution}
{
 const w=E.create(42),saved=E.snapshot(w),execution=bind(w);for(const [key,value] of [['route',[]],['status','working'],['work',1],['disabled',true],['roadblockWait',{}],['name','other'],['speed',5]])assert.throws(()=>w.agents[0][key]=value,TypeError);
 assert.throws(()=>w.agents[0].route.push([1,1]),TypeError);assert.throws(()=>w.agents[0].activity.idle++,TypeError);assert.throws(()=>w.agents[0].capabilities.push('new'),TypeError);assert.throws(()=>w.agents[0].unknown=1,TypeError);assert.deepEqual(E.snapshot(w),saved);assert.deepEqual(execution.snapshot(),payload(w).agents);E.disposeWorld(w);E.disposeWorld(w);assert.throws(()=>execution.read(0,'status'),e=>e.worldExecutionFailure&&e.status===503);
}
for(const sceneId of ['industrial-park-v1','industrial-park-parallel-v1','industrial-park-priority-v1','lunar-base-v1','lunar-terrain-v1','lunar-sampling-v1','lunar-outpost-v1','shore-coordination-v1'])for(const seed of [42,43]){
 const a=E.create(seed,'nearest',E.getScene(sceneId)),b=E.snapshot(a);const execution=bind(b);let fork=null;
 while(!a.done&&a.tick<1000){if(a.tick===3){E.fault(a);E.fault(b);fork=E.snapshot(b);bind(fork)}if(a.tick===10&&(a.terrain||[]).length){E.injectTerrainEffect(a,a.terrain[0].id,8);E.injectTerrainEffect(b,b.terrain[0].id,8);if(fork)E.injectTerrainEffect(fork,fork.terrain[0].id,8)}E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a),`${sceneId}:${seed}:${a.tick}`);if(fork){E.step(fork);assert.deepEqual(E.snapshot(fork),E.snapshot(b))}}
 assert(a.done);assert.deepEqual(E.metrics(b),E.metrics(a));assert.deepEqual(execution.snapshot(),payload(b).agents);E.disposeWorld(b);if(fork)E.disposeWorld(fork);
}
{
 const scene=E.getScene();scene.obstacles=[];const a=E.create(42,'nearest',scene,{dispatchMode:'external'}),b=E.snapshot(a);bind(b);const both=fn=>{const x=fn(a),y=fn(b);assert.deepEqual(y,x);assert.deepEqual(E.snapshot(b),E.snapshot(a));return x};
 for(const w of [a,b])assert(E.submitAction(w,'vehicle-1',{requestId:'drive',type:'move',target:{x:80,y:88},targetTick:1,expiresTick:100}).ok);both(w=>E.step(w).tick);assert(both(w=>E.injectRoadblock(w,{x:42,y:0,w:8,h:100},8)).ok);assert(a.agents.find(x=>x.id==='vehicle-1').roadblockWait);for(let i=0;i<150&&a.actions[0].status!=='completed';i++)both(w=>E.step(w).tick);assert.equal(a.actions[0].status,'completed');assert(a.agents.find(x=>x.id==='vehicle-1').roadblockWaitTicks>0);E.disposeWorld(b);
}
{
 const a=E.create(42,'nearest',E.getScene('lunar-outpost-v1'),{physicsMode:'rapier'}),b=E.snapshot(a),pa=Physics.createPhysics(a),pb=Physics.createPhysics(b);E.bindTaskRules(a,Rules);bind(b);let faulted=false;
 try{while(!a.done&&a.tick<1000){if(!faulted&&a.part.location==='carried'){E.fault(a);E.fault(b);faulted=true}E.step(a,pa);E.step(b,pb);assert.deepEqual(E.snapshot(b),E.snapshot(a),`Rapier:${a.tick}`)}assert(faulted&&a.done&&!a.failed)}finally{pa.free();pb.free();E.disposeWorld(b)}
}
console.log('Shared native motion/execution owner, atomic rejection, immutable full-agent projections, eight-scene parity, terrain perturbations, restores, roadblock waits and actual Rapier cargo fault passed');
