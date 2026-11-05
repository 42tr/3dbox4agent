'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),R=require('../src/rescue'),Archive=require('../src/replay'),{bind}=require('./native-task-frame-support'),{fixture,intent}=require('./rescue-support');
for(const physicsMode of ['kinematic','rapier'])for(const batch of [false,true]){
 const scene=fixture(),a=E.create(42,'nearest',scene,{physicsMode}),b=Init.create(42,'nearest',scene,{physicsMode}),worlds=[a,b],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);
 try{assert.deepEqual(a,b);bind(b,ps[1],{batch,actionBatch:batch,worldBatch:batch});const frames=[E.snapshot(b)];
  function equal(){assert.deepEqual(E.snapshot(b),E.snapshot(a),physicsMode+'/'+batch+'/'+b.tick);for(const id of a.agents.map(x=>x.id))assert.deepEqual(E.observe(b,id),E.observe(a,id));frames.push(E.snapshot(b))}
  function step(){worlds.forEach((w,i)=>E.step(w,ps[i]));equal()}
  function both(fn){const x=worlds.map(fn);assert.deepEqual(x[0],x[1]);equal();return x[0]}
  step();assert(both(w=>E.fault(w)));step();assert(!b.done);const target=b.agents[0],helper=b.agents[1],charge=target.battery,pose=[target.x,target.y];
  function approach(){const move=intent(b,'move',{target:{x:target.x,y:target.y}});assert(both(w=>E.submitAction(w,helper.id,move)).ok);for(let i=0;i<60&&Math.hypot(b.agents[1].x-target.x,b.agents[1].y-target.y)>3.8;i++)step();if(['pending','accepted'].includes(b.actions.at(-1).status))assert(both(w=>E.cancelAction(w,helper.id,move.requestId)).ok)}
  approach();
  const rescue=intent(b,'rescue',{targetAgentId:target.id,observedTick:b.tick});assert(both(w=>E.submitAction(w,helper.id,rescue)).ok);for(let i=0;i<6;i++)step();
  assert.equal(b.actions.at(-1).status,'completed');assert(!target.disabled);assert.equal(target.battery,charge);assert.deepEqual([target.x,target.y],pose);assert(R.validateWorld(b,Init.create(42,'nearest',scene,{physicsMode})));assert(both(w=>E.submitAction(w,helper.id,rescue)).duplicate);
  step();assert(both(w=>E.fault(w)));assert(both(w=>E.submitAction(w,helper.id,rescue)).duplicate);assert(target.disabled);step();assert(!b.done);approach();
  const again=intent(b,'rescue',{targetAgentId:target.id,observedTick:b.tick});assert(both(w=>E.submitAction(w,helper.id,again)).ok);step();assert(both(w=>E.cancelAction(w,helper.id,again.requestId)).ok);assert(target.disabled);
  const retry=intent(b,'rescue',{targetAgentId:target.id,observedTick:b.tick});assert(both(w=>E.submitAction(w,helper.id,retry)).ok);for(let i=0;i<6;i++)step();assert(!target.disabled);
  for(let i=0;i<150&&!b.done;i++)step();assert(b.done&&!b.failed);assert.equal(b.events.filter(e=>e.kind==='rescue_completed').length,2);assert(Archive.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));console.log(JSON.stringify({physicsMode,batch,tick:b.tick,resets:2,frames:frames.length}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log('Native field rescue: exact JS/owned Rust every-frame parity, full mission completion, cancellation, repeated faults, episode receipts and archive validation passed');
