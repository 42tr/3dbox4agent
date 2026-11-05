'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),Replay=require('../src/replay'),Rescue=require('../src/rescue'),Relay=require('../src/relay'),Surface=require('../src/surface-domain'),PB=require('../src/stream-protobuf'),{bind}=require('./native-task-frame-support');

// Fault injection is a test administrator operation. The rescue controller below
// receives only one agent's own observation and never reads the fault fixture.
function ownDecision(own,sequence){
 const target=own.nearby.find(c=>c.status==='fault'&&c.faultGeneration>0),live=own.actions.find(a=>['pending','accepted'].includes(a.status));
 if(live)return live.type==='move'&&target&&Math.hypot(own.self.x-target.x,own.self.y-target.y)<=3.8?{cancel:live.requestId}:null;
 if(!target||own.self.status!=='idle'||own.self.battery<=5)return null;
 const due=own.tick+1,base={requestId:'shore-recovery-'+sequence,targetTick:due,expiresTick:due+40},dx=own.self.x-target.x,dy=own.self.y-target.y,d=Math.hypot(dx,dy);
 return d<=3.8?{action:{...base,type:'rescue',targetAgentId:target.id,observedTick:target.observedTick,faultGeneration:target.faultGeneration}}:{action:{...base,type:'move',target:{x:target.x+3.2*dx/d,y:target.y+3.2*dy/d}}};
}
let totalFrames=0;
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy'])for(const autoRescue of [false,true]){
 const scene=E.getScene('shore-rescue-v1');scene.navigation=navigation;
 const a=E.create(42,'nearest',scene,{physicsMode}),b=Init.create(42,'nearest',scene,{physicsMode}),worlds=[a,b],ps=worlds.map(w=>physicsMode==='rapier'?P.createPhysics(w):null),initial=E.snapshot(a),frames=[E.snapshot(b)],helpers=a.agents.filter(x=>x.rescue).map(x=>x.id);
 let incident=null,before=null,sequence=0;
 const both=fn=>{const results=worlds.map(fn);assert.deepEqual(results[1],results[0]);assert.deepEqual(E.snapshot(b),E.snapshot(a));return results[0]};
 try{
  assert.deepEqual(b,E.snapshot(a));bind(b,ps[1],{batch:true,actionBatch:true,worldBatch:true});
  for(let i=0;i<800&&!b.done;i++){
   const resident=a.agents.find(x=>x.relayState?.deployed);
   if(resident&&!incident){
    before=structuredClone({id:resident.id,battery:resident.battery,position:[resident.x,resident.y],relayState:resident.relayState});
    assert(both(w=>E.injectFault(w,{agentId:resident.id,expectedFaultGeneration:0})).ok);
    incident=a.events.findLast(e=>e.kind==='device_fault');frames.push(E.snapshot(b));
    assert.deepEqual(both(w=>E.sendMessage(w,'drone-1','boat-1','offline',[resident.id],'offline')),{ok:false,reason:'relay_unavailable'});
   }
   if(autoRescue)for(const id of helpers){
    const own=E.observe(a,id);assert.deepEqual(E.observe(b,id),own);assert.deepEqual(PB.decode(PB.encode(own,2)),own);assert(!Object.hasOwn(own,'world'));assert(!Object.hasOwn(own,'echelons'));
    const decision=ownDecision(own,++sequence);if(decision?.cancel)assert(both(w=>E.cancelAction(w,id,decision.cancel)).ok);if(decision?.action)assert(both(w=>E.submitAction(w,id,decision.action)).ok);
   }
   worlds.forEach((w,i)=>E.step(w,ps[i]));assert.deepEqual(E.snapshot(b),E.snapshot(a),JSON.stringify({physicsMode,navigation,autoRescue,tick:b.tick}));
   for(const agent of b.agents)assert(Surface.bodyFree(b.surfaceDomain,agent.mobility,[agent.x,agent.y]));Rescue.validateWorld(b,initial);Relay.validateWorld(b);frames.push(E.snapshot(b));
  }
  assert(incident);assert(b.done&&!b.failed);assert.equal(E.metrics(b).completed,9);assert.equal(b.materials.stock[0].remaining,0);
  const resident=b.agents.find(x=>x.id===before.id),resets=b.events.filter(e=>e.kind==='rescue_completed');
  assert.deepEqual(resident.relayState,before.relayState);assert.deepEqual([resident.x,resident.y],before.position);assert.equal(resident.battery,before.battery);assert.equal(resident.faultGeneration,1);assert.equal(b.events.filter(e=>e.kind==='relay_deployed').length,1);
  if(autoRescue){
   assert.equal(resets.length,1);assert.equal(resets[0].faultSeq,incident.seq);assert.equal(resets[0].targetAgentId,before.id);assert.equal(resident.status,'deployed');assert(!resident.disabled);assert(Relay.ready(resident));
   const completed=b.actions.find(x=>x.type==='rescue'&&x.status==='completed');assert(completed);assert.equal(completed.progress,6);assert.equal(completed.faultGeneration,1);
   assert(both(w=>E.sendMessage(w,'drone-1','boat-1','online',[resident.id],'online')).ok===false,'finished worlds do not admit new traffic');
  }else {assert.equal(resets.length,0);assert(resident.disabled);assert.equal(resident.status,'fault');assert(!Relay.ready(resident))}
  assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));totalFrames+=frames.length;
  console.log(JSON.stringify({physicsMode,navigation,autoRescue,tick:b.tick,completed:9,mechanicalResets:resets.length,residentRestored:Relay.ready(resident),kitConsumed:1,frames:frames.length,poseBatteryAndDeploymentPreserved:true}));
 }finally{worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())}
}
console.log(JSON.stringify({passed:true,cases:12,totalFrames,scope:'actual shoreline resident failure; six scoped-rescue and six no-rescue controls, exact JS/native frames, legal bodies, own protobuf observations and replay; task completion is separate from relay recovery'}));
