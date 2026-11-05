'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Power=require('../src/operating-power'),R=require('../src/replay'),{fixture}=require('./operating-power-support');
for(const value of [0,.0009,5.0001,null,NaN,Infinity,'1',{},[]]){const s=fixture('pending');s.agents.find(a=>a.role==='endpoint').operatingEnergyPerTick=value;assert.throws(()=>E.create(42,'nearest',s))}
for(const value of [.001,5]){const s=fixture('pending');s.agents.find(a=>a.role==='endpoint').operatingEnergyPerTick=value;const w=E.create(42,'nearest',s);assert.equal(w.agents.find(a=>a.id==='endpoint-1').operatingEnergyPerTick,value);assert.deepEqual(w.agents.find(a=>a.id==='endpoint-1').operatingState,{energySpent:0,tick:0})}
const legacy=E.create(42);assert(!legacy.agents.some(a=>Object.hasOwn(a,'operatingState')));assert(!Object.hasOwn(E.metrics(legacy),'operatingEnergy'));
{
 const scene=fixture('charge-gain'),probe=E.create(42,'nearest',scene),start=probe.agents[0];scene.resource.warehouse=[start.x+12,start.y];
 const powered=E.create(42,'nearest',scene),plain=structuredClone(scene);delete plain.agents[0].operatingEnergyPerTick;const original=E.create(42,'nearest',plain);
 const base=E.observe(original,'worker-1').self.returnEnergyEstimate,total=E.observe(powered,'worker-1').self.returnEnergyEstimate;assert(Math.abs(base-.012)<1e-9);assert(Math.abs(total-(base+4))<1e-9,'four travel ticks add four units of base draw');
}
for(const rate of [.001,.01,.3333,1.234567,5]){
 const actor={id:'long',operatingEnergyPerTick:rate,operatingState:{energySpent:rate*9999999*.9,tick:9999999},battery:50,disabled:false},before={tick:9999999,agents:[actor]},next={tick:10000000,agents:[{...actor,...Power.advance(actor,10000000)}]};
 assert(Power.validateTransition(before,next));const forged=structuredClone(next);forged.agents[0].operatingState.energySpent+=rate/2;assert.throws(()=>Power.validateTransition(before,forged));
}
{
 let accumulated=0;for(let tick=0;tick<10000000;tick++)accumulated+=.001;
 const actor={id:'gap',operatingEnergyPerTick:.001,battery:50,disabled:false};assert(Power.validateTransition({tick:0,agents:[{...actor,operatingState:{energySpent:0,tick:0}}]},{tick:10000000,agents:[{...actor,operatingState:{energySpent:accumulated,tick:10000000}}]}));
}
for(const intervention of ['low','fault','low-and-fault']){
 const scene=fixture('pending'),w=E.create(42,'nearest',scene,{dispatchMode:'external'}),frames=[E.snapshot(w)];if(intervention!=='fault')assert(E.injectLowEnergy(w,'endpoint-1',1).ok);if(intervention!=='low')assert(E.injectFault(w,{agentId:'endpoint-1',expectedFaultGeneration:0}).ok);E.step(w);frames.push(E.snapshot(w));
 const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames,coverage:{start:'unknown',end:'unfinished',revisionRange:null}};assert(R.validateArchive(archive));
 const forged=structuredClone(archive);forged.frames[1].agents.find(a=>a.id==='endpoint-1').operatingState.energySpent+=.005;assert.throws(()=>R.validateArchive(forged));
}
{
 const scene=fixture('pending'),w=E.create(42,'nearest',scene,{dispatchMode:'external'}),frames=[E.snapshot(w)];assert(E.injectLowEnergy(w,'endpoint-1',1).ok);frames.push(E.snapshot(w));assert(E.submitAction(w,'endpoint-1',{requestId:'future',type:'move',target:{x:50,y:50},targetTick:1,expiresTick:40}).ok);frames.push(E.snapshot(w));E.step(w);frames.push(E.snapshot(w));const actor=w.agents.find(a=>a.id==='endpoint-1');assert(actor.disabled);assert.equal(actor.battery,0);assert.equal(actor.faultGeneration,0);assert.equal(w.faults,0);assert.equal(w.replans,0);assert.equal(w.actions[0].status,'rejected');assert.equal(w.actions[0].reason,'energy_depleted');assert.equal(w.events.filter(e=>e.kind==='energy_depleted'&&e.agentId===actor.id).length,1);
 const own=E.observe(w,actor.id);own.self.operatingState.energySpent=999;assert.equal(actor.operatingState.energySpent,1);assert(Power.validateWorld(w,frames[0]));assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));
 for(const alter of [f=>f.operatingState.energySpent+=1,f=>f.operatingState.tick=0,f=>f.operatingEnergyPerTick=4]){const bad=structuredClone(frames);alter(bad.at(-1).agents.find(a=>a.id===actor.id));assert.throws(()=>R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:bad}))}
 const events=w.events.filter(e=>e.kind==='energy_depleted').length;E.step(w);assert.equal(actor.operatingState.energySpent,1);assert.equal(actor.operatingState.tick,2);assert.equal(w.events.filter(e=>e.kind==='energy_depleted').length,events);assert.throws(()=>Power.advance(actor,2));
}
console.log('Operating power JS: strict optional profiles, legacy omission, own detached counters, debit before pending activation, energy fault without mechanical generation/task replan, disabled no-draw clocks, duplicate ticks and forged replay counters rejected');
