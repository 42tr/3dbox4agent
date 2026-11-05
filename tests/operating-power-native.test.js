'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),R=require('../src/replay'),PB=require('../src/stream-protobuf'),M=require('../src/materials'),{bind}=require('./native-task-frame-support'),{fixture}=require('./operating-power-support'),F=require('./fleet-fault-support');
let checked=0,totalFrames=0;
function bindPower(w,p,mode){
 if(mode==='motion'||mode==='tasks'){
  const motion=require('../server/rust-world-motion').create(w);E.bindWorldMotion(w,motion);E.bindWorldExecution(w,motion.execution(w));
  if(mode==='tasks'){E.bindWorldLedger(w,require('../server/rust-world-ledger').create(w));E.bindWorldTasks(w,require('../server/rust-world-tasks').create(w));E.bindTaskRules(w,require('../server/rust-task-rules'))}return;
 }
 bind(w,p,{batch:mode!=='mixed',actionBatch:mode!=='mixed',worldBatch:mode==='whole'});
}
for(const physicsMode of ['kinematic','rapier'])for(const mode of ['motion','tasks','mixed','frames','whole'])for(const kind of ['pending','construction','cargo','charge-gain','charge-loss','thermal','resident','rescue']){
 // Mechanical fault generation/restoration requires the coupled native control.
 if(kind==='rescue'&&(mode==='motion'||mode==='tasks'))continue;
 const scene=fixture(kind),options={physicsMode,dispatchMode:'external'},a=E.create(42,'nearest',scene,options),b=Init.create(42,'nearest',scene,options),ws=[a,b],ps=ws.map(w=>physicsMode==='rapier'?P.createPhysics(w):null),frames=[E.snapshot(a)];assert.deepEqual(b,a);bindPower(b,ps[1],mode);
 function equal(){assert.deepEqual(E.snapshot(b),E.snapshot(a),physicsMode+'/'+mode+'/'+kind+'/'+b.tick);for(const actor of a.agents){const own=E.observe(b,actor.id);assert.deepEqual(own,E.observe(a,actor.id));assert.deepEqual(PB.decode(PB.encode(own,2)),own);assert(!own.nearby.some(c=>Object.hasOwn(c,'operatingState')||Object.hasOwn(c,'operatingEnergyPerTick')))}frames.push(E.snapshot(b));totalFrames++}
 function both(fn){const result=ws.map(fn);assert.deepEqual(result[1],result[0]);equal();return result[0]}
 function step(){ws.forEach((w,i)=>E.step(w,ps[i]));equal()}
 try{
  if(kind==='pending'){assert(both(w=>E.injectLowEnergy(w,'endpoint-1',1)).ok);assert(both(w=>E.submitAction(w,'endpoint-1',{requestId:'future',type:'move',target:{x:50,y:50},targetTick:1,expiresTick:40})).ok);step();assert.equal(b.actions[0].reason,'energy_depleted');assert.equal(b.faults+b.replans,0)}
  if(kind==='construction'||kind==='cargo'){
   const actor=b.agents[0],task=b.tasks[0];assert(both(w=>E.assign(w,task.id,actor.id)).ok);if(kind==='construction')assert.equal(M.metrics(b.materials)[0].reserved,1);let carrying=false;
   for(let i=0;i<30&&!actor.disabled;i++){if(b.part.location==='carried')carrying=true;step()}
   assert(actor.disabled);assert.equal(actor.faultGeneration,0);assert.equal(task.status,'pending');assert.equal(b.replans,1);assert.equal(b.faults,0);assert(b.events.some(e=>e.kind==='energy_depleted'&&e.source==='operating'&&e.taskId===task.id));
   if(kind==='construction'){assert.equal(M.metrics(b.materials)[0].reserved,0);assert.equal(M.metrics(b.materials)[0].consumed,0)}else{assert(carrying);assert.equal(b.part.location,'ground');assert.deepEqual(b.part.position,[actor.x,actor.y]);assert.equal(b.part.reservedBy,null)}
  }
  if(kind.startsWith('charge-')){assert(both(w=>E.injectLowEnergy(w,'worker-1',5)).ok);assert(both(w=>E.submitAction(w,'worker-1',{requestId:'charge',type:'charge',targetTick:1,expiresTick:40})).ok);for(let i=0;i<3;i++)step();if(kind==='charge-gain'){assert.equal(b.agents[0].battery,8);assert.equal(b.agents[0].operatingState.energySpent,3);assert.equal(b.actions[0].energyAdded,6)}else{assert(b.agents[0].disabled);assert.equal(b.agents[0].battery,0);assert.equal(b.agents[0].operatingState.energySpent,9);assert.equal(b.actions[0].energyAdded,4);assert.equal(b.actions[0].reason,'energy_depleted')}}
  if(kind==='thermal'){const charge=b.agents[0].battery;for(let i=0;i<3;i++)step();assert.equal(b.agents[0].battery,charge-3);assert.equal(b.agents[0].operatingState.energySpent,3);assert(b.agents[0].thermalState.protected);assert.equal(b.agents[0].thermalState.peakC,55);assert(Math.abs(b.agents[0].thermalState.temperatureC-51.4)<1e-9)}
  if(kind==='rescue'){
   assert(both(w=>E.injectFault(w,F.faultInput(w,'relay-1'))).ok);const helper=b.agents.find(a=>a.id==='rescuer-1'),target=b.agents.find(a=>a.id==='relay-1'),distance=Math.hypot(helper.x-target.x,helper.y-target.y),point={x:target.x+(helper.x-target.x)*3/distance,y:target.y+(helper.y-target.y)*3/distance};
   assert(both(w=>E.submitAction(w,helper.id,F.intent(w,'move',{target:point},'approach'))).ok);for(let i=0;i<20&&b.actions[0].status!=='completed';i++)step();assert.equal(b.actions[0].status,'completed');
   while(helper.battery>30.5)step();assert(helper.battery>5);assert(both(w=>E.submitAction(w,helper.id,F.rescueIntent(w,helper.id,target.id,'reset'))).ok);
   let actualWork=false;for(let i=0;i<8&&!helper.disabled;i++){step();if(b.actions[1].progress>0)actualWork=true}
   assert(actualWork);assert(helper.disabled);assert.equal(helper.faultGeneration,0);assert.equal(b.actions[1].status,'failed');assert.equal(b.actions[1].reason,'energy_depleted');assert(b.actions[1].progress<6);assert(target.disabled);assert.equal(target.faultGeneration,1);assert(!b.events.some(e=>e.kind==='rescue_completed'));assert.equal(b.faults,1);
  }
  if(kind==='resident'){
   assert(both(w=>E.assign(w,'deploy','relay-1')).ok);for(let i=0;i<100&&b.tasks[0].status!=='done';i++)step();assert.equal(b.tasks[0].status,'done');const relay=b.agents.find(a=>a.id==='relay-1'),deployment=structuredClone(relay.relayState),pose=[relay.x,relay.y],kit=structuredClone(M.metrics(b.materials)[0]);const delivered=both(w=>E.sendMessage(w,'endpoint-1','endpoint-2','while powered',['relay-1'],'operating-online'));assert(delivered.ok);step();step();assert(b.communication.inboxes['endpoint-2'].some(m=>m.id===delivered.messageId));
   for(let i=0;i<250&&relay.battery>5.5;i++)step();assert(relay.battery>5&&relay.battery<=5.5);const sentTick=b.tick,packet=both(w=>E.sendMessage(w,'endpoint-1','endpoint-2','power boundary',['relay-1'],'operating-boundary'));assert(packet.ok);step();assert(relay.battery<=5&&!relay.disabled);assert(b.events.some(e=>e.kind==='message_failed'&&e.messageId===packet.messageId&&e.tick===sentTick+1&&e.reason==='unavailable'));
   for(let i=0;i<15&&!relay.disabled;i++)step();assert(relay.disabled);assert.equal(relay.battery,0);assert.equal(relay.faultGeneration,0);assert.deepEqual(relay.relayState,deployment);assert.deepEqual([relay.x,relay.y],pose);assert.deepEqual(M.metrics(b.materials)[0],kit);assert.equal(b.replans,0);assert.equal(b.faults,0);const spent=relay.operatingState.energySpent;step();assert.equal(relay.operatingState.energySpent,spent);
  }
  assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));checked++;
 }finally{ws.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log(JSON.stringify({cases:checked,pairedFrames:totalFrames,physicsModes:2,nativeModes:3,partialOwnerLayouts:2,privateOwnCountersAndBinaryV2:true,taskLeaseCargoAndChargeConstraints:true,thermalSeparateBaseDraw:true,residentPowerThresholdPrecedesPacketDelivery:true,depletedRescuerCannotCompleteMechanicalReset:true,allArchivesValidated:true}));
