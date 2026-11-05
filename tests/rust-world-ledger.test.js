'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Rules=require('../server/rust-task-rules'),Ledger=require('../server/rust-world-ledger'),{WorldLedger}=require('../rust/physics/target/release/box_physics.node');
const initial={tick:0,done:false,failed:false,events:[]};
function native(value=initial){return new WorldLedger(JSON.stringify(value))}
for(const change of [x=>x.tick=-1,x=>x.tick=.5,x=>x.tick=10000001,x=>x.failed=true,x=>x.other=1,x=>x.events=[{seq:2,tick:0,message:'gap',type:'info'}],x=>x.events=[{seq:1,tick:1,message:'future',type:'info'}],x=>x.events=[{seq:1,tick:0,message:'bad',type:'other'}]]){const value=structuredClone(initial);change(value);assert.throws(()=>native(value),/invalid world ledger/)}
{
 const a=native(),b=native();assert.equal(a.advance(0),1);assert.equal(b.tick,0);
 const before=a.snapshot();for(const value of [0,1.5,-1,NaN,Infinity])assert.throws(()=>a.advance(value),/invalid world ledger/);assert.equal(a.snapshot(),before);
 for(const payload of [{message:'bad',type:'info',seq:1},{message:'bad',type:'info',tick:1},{message:'x'.repeat(501),type:'info'},{message:'bad',type:'danger'}])assert.throws(()=>a.append(JSON.stringify(payload)),/invalid world ledger/);
 assert.equal(a.snapshot(),before);const event=JSON.parse(a.append(JSON.stringify({message:'hello',type:'info',nested:{ids:['one']}})));assert.equal(event.seq,1);assert.equal(event.tick,1);event.nested.ids[0]='changed';assert.equal(JSON.parse(a.snapshot()).events[0].nested.ids[0],'one');
 a.finish(false);assert(a.done&&!a.failed);a.finish(false);assert.throws(()=>a.finish(true),/immutable/);assert.throws(()=>a.advance(1),/finished/);a.append('{"message":"cleanup","type":"info"}');assert.equal(a.tick,1);assert.equal(JSON.parse(a.snapshot()).events.length,2);
 a.free();a.free();for(const operation of [()=>a.tick,()=>a.done,()=>a.failed,()=>a.snapshot(),()=>a.append('{}'),()=>a.finish(false),()=>a.advance(1)])assert.throws(operation,/closed/);assert.equal(b.tick,0);b.free();
}
{
 const world=E.create(42),ledger=Ledger.create(world);E.bindWorldLedger(world,ledger);for(const [key,value] of [['tick',1],['done',true],['failed',true],['events',[]]]){assert.throws(()=>world[key]=value,TypeError);assert.throws(()=>Object.defineProperty(world,key,{value}),TypeError)}
 assert.throws(()=>world.events.push({}),TypeError);assert.throws(()=>E.bindWorldLedger(E.create(42),ledger),/unavailable/);ledger.append({message:'protected',type:'info',ids:['one']});assert.throws(()=>world.events[0].ids[0]='changed',TypeError);assert.equal(ledger.snapshot().events[0].ids[0],'one');
 const copy=E.snapshot(world);copy.events[0].message='changed';assert.equal(world.events[0].message,'protected');E.disposeWorld(world);E.disposeWorld(world);assert.throws(()=>E.snapshot(world),/closed/);
}
for(const sceneId of ['industrial-park-v1','industrial-park-parallel-v1','lunar-base-v1','lunar-terrain-v1','lunar-sampling-v1','shore-coordination-v1'])for(const seed of [42,43]){
 const a=E.create(seed,'nearest',E.getScene(sceneId)),b=E.snapshot(a);E.bindTaskRules(b,Rules);const ledger=Ledger.create(b);E.bindWorldLedger(b,ledger);let faulted=false;
 while(!a.done&&a.tick<1000){if(!faulted&&a.tick>=3&&a.tasks.some(t=>t.status==='active')){E.fault(a);E.fault(b);faulted=true}E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a),`${sceneId}:${seed}:${a.tick}`)}
 assert(a.done);assert.deepEqual(E.metrics(b),E.metrics(a));assert.deepEqual(ledger.snapshot(),{tick:b.tick,done:b.done,failed:b.failed,events:b.events});const tick=b.tick;E.step(b);assert.equal(b.tick,tick);
 // A restored ledger owns its own independent prefix and cannot alter its source.
 const restored=E.snapshot(b),fork=Ledger.create(restored);E.bindWorldLedger(restored,fork);assert.deepEqual(E.snapshot(restored),E.snapshot(b));assert.throws(()=>fork.finish(!b.failed),error=>error.message==='world_step_failed'&&error.status===503&&error.worldLedgerFailure===true);E.disposeWorld(restored);assert.equal(b.tick,tick);E.disposeWorld(b);
}
{
 const a=E.create(7,'nearest',E.getScene('industrial-park-parallel-v1'),{dispatchMode:'external'});E.step(a);const b=E.snapshot(a),ledger=Ledger.create(b);E.bindTaskRules(b,Rules,true);E.bindWorldLedger(b,ledger);const source=E.snapshot(a);E.step(b);assert.equal(b.tick,2);assert.equal(a.tick,1);assert.deepEqual(E.snapshot(a),source);E.disposeWorld(b);
}
console.log('Rust-owned clock, immutable terminal state and event prefix; protected JS views, independent restores and six-scene parity passed');
