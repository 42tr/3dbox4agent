'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),D=require('../src/relay'),M=require('../src/materials'),P=require('../server/rust-physics'),R=require('../src/replay'),{bind,hashes}=require('./native-task-frame-support'),{fixture}=require('./relay-support');
for(const physicsMode of ['kinematic','rapier']){
 const scene=fixture(),a=E.create(42,'nearest',scene,{physicsMode,dispatchMode:'external'}),b=E.snapshot(a),worlds=[a,b],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null);let fail=false,debitSeen=false;
 const stores=bind(b,ps[1],{batch:true,actionBatch:true,worldBatch:true,worldProbe(w,s,c,args){const r=c.advanceWorldStep(...args);if(fail){assert.equal(w.tasks[0].status,'done');assert.equal(w.agents[0].status,'deployed');assert.equal(M.metrics(w.materials)[0].consumed,1);debitSeen=true;fail=false;throw Error('after actual relay deployment')}return r}}),frames=[E.snapshot(b)];
 const both=fn=>{const x=fn(a),y=fn(b);assert.deepEqual(y,x);assert.deepEqual(E.snapshot(b),E.snapshot(a));D.validateWorld(b);frames.push(E.snapshot(b));return x};
 const step=()=>{E.step(a,ps[0]);E.step(b,ps[1]);assert.deepEqual(E.snapshot(b),E.snapshot(a));D.validateWorld(b);frames.push(E.snapshot(b))};
 try{
  assert.deepEqual(both(w=>E.sendMessage(w,'worker-1','worker-2','before',['relay-1'],'before')),{ok:false,reason:'relay_unavailable'});
  assert(both(w=>E.assign(w,'deploy','relay-1')).ok);
  for(let i=0;i<100;i++){
   E.step(a,ps[0]);
   if(a.tasks[0].status!=='done'){E.step(b,ps[1]);assert.deepEqual(E.snapshot(b),E.snapshot(a));frames.push(E.snapshot(b));continue}
   const before=E.snapshot(b),raw=hashes(stores,ps[1],b);fail=true;assert.throws(()=>E.step(b,ps[1]),e=>e.rollbackRestored&&e.cause?.message==='after actual relay deployment');assert(debitSeen);assert.deepEqual(E.snapshot(b),before);assert.deepEqual(hashes(stores,ps[1],b),raw);E.step(b,ps[1]);assert.deepEqual(E.snapshot(b),E.snapshot(a));frames.push(E.snapshot(b));break;
  }
  assert(debitSeen);assert(D.ready(b.agents[0]));const deployed=structuredClone(b.agents[0].relayState);
  assert(both(w=>E.sendMessage(w,'worker-1','worker-2','direct',[],'direct')).ok);for(let i=0;i<3;i++)step();assert.equal(b.events.findLast(e=>e.kind==='message_failed').reason,'out_of_range');
  const sent=both(w=>E.sendMessage(w,'worker-1','worker-2','through deployed relay',['relay-1'],'via'));assert(sent.ok);assert.equal(both(w=>E.sendMessage(w,'worker-1','worker-2','through deployed relay',['relay-1'],'via')).duplicate,true);for(let i=0;i<6;i++)step();assert.equal(b.communication.inboxes['worker-2'].at(-1).id,sent.messageId);assert(b.events.some(e=>e.kind==='message_relayed'&&e.relay==='relay-1'));
  assert(both(w=>E.interruptCommunication(w,'relay-1',6)).ok);const blocked=both(w=>E.sendMessage(w,'worker-1','worker-2','outage',['relay-1'],'outage'));assert(blocked.ok);for(let i=0;i<3;i++)step();assert.equal(b.events.findLast(e=>e.kind==='message_failed').reason,'interrupted');for(let i=0;i<6;i++)step();const recovered=both(w=>E.sendMessage(w,'worker-1','worker-2','restored',['relay-1'],'restored'));for(let i=0;i<6;i++)step();assert.equal(b.communication.inboxes['worker-2'].at(-1).id,recovered.messageId);
  const tick=b.tick;assert(both(w=>E.submitAction(w,'relay-1',{requestId:'leave',type:'move',target:{x:80,y:80},targetTick:w.tick+1,expiresTick:w.tick+20})).ok);step();assert.equal(b.actions.at(-1).status,'rejected');assert.equal(b.actions.at(-1).reason,'agent_unavailable');assert.deepEqual(b.agents[0].relayState,deployed);assert.equal(b.agents[0].x,deployed.position[0]);
  const inFlight=both(w=>E.sendMessage(w,'worker-1','worker-2','power lost in flight',['relay-1'],'power-flight'));assert(inFlight.ok);
  assert(both(w=>E.injectLowEnergy(w,'relay-1',3)).ok);assert.equal(b.agents[0].status,'deployed');assert(!D.ready(b.agents[0]));assert.deepEqual(both(w=>E.sendMessage(w,'worker-1','worker-2','low',['relay-1'],'low')),{ok:false,reason:'relay_unavailable'});for(let i=0;i<3;i++)step();assert.equal(b.events.find(e=>e.kind==='message_failed'&&e.messageId===inFlight.messageId).reason,'unavailable');
  assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));
  console.log(JSON.stringify({physicsMode,tick:b.tick,actualDebitRollback:true,directOutOfRange:true,deployedHopDelivered:true,outageFailedAndRecovered:true,stationaryActionRejected:true,lowEnergyStopsRelay:true}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log('Relay lifecycle: actual deployment and kit debit rollback, participant hashes and retry, direct range refusal versus true native relay hops, idempotency, outage/recovery, immutable residence and low-power refusal passed');
