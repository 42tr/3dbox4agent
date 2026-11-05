'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Init=require('../server/rust-world-initialization'),P=require('../server/rust-physics'),D=require('../src/surface-domain'),Replay=require('../src/replay'),{bind}=require('./native-task-frame-support');
const base=require('../examples/scenes/shore-sea-state.json'),plan=require('../examples/experiments/shore-sea-state.json');
let compared=0;const results=[];
function pair(config,options){const worlds=[E.create(42,'nearest',config,options),Init.create(42,'nearest',config,options)],ps=worlds.map(w=>options.physicsMode==='rapier'?P.createPhysics(w):null);if(ps[0]){E.bindRaySensors(worlds[0],ps[0]);Init.finishRay(worlds[1],ps[1]);E.bindRaySensors(worlds[1],ps[1],true)}bind(worlds[1],ps[1],{batch:true,actionBatch:true,worldBatch:true});return {worlds,ps,close(){worlds.forEach(E.disposeWorld);ps.forEach(p=>p?.free())},step(){worlds.forEach((w,i)=>E.step(w,ps[i]));assert.deepEqual(E.snapshot(worlds[1]),E.snapshot(worlds[0]));for(const a of worlds[1].agents){assert(D.bodyFree(worlds[1].surfaceDomain,a.mobility,[a.x,a.y]));assert.deepEqual(E.observe(worlds[1],a.id),E.observe(worlds[0],a.id))}compared++}}}
for(const physicsMode of ['kinematic','rapier'])for(const navigation of ['distance','time','energy'])for(const weather of [false,true]){
 const config={...structuredClone(base),navigation},p=pair(config,{physicsMode}),w=p.worlds[1],history=[E.snapshot(w)];
 try{
  while(!w.done&&w.tick<1000){
   if(weather)for(const intervention of plan.interventions.filter(e=>e.tick===w.tick)){
    const replies=p.worlds.map(s=>E.injectTerrainEffect(s,intervention.zoneId,intervention.duration,intervention.speedFactor,intervention.energyFactor));assert(replies.every(r=>r.ok));assert.deepEqual(replies[0],replies[1]);assert.deepEqual(E.snapshot(p.worlds[0]),E.snapshot(w));history.push(E.snapshot(w));
   }
   p.step();history.push(E.snapshot(w));
  }
  assert(w.done&&!w.failed);assert.equal(w.tasks.filter(t=>t.status==='done').length,7);const m=E.metrics(w);
  assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{scene:config,sceneId:config.id,seed:42,policy:'nearest'},frames:history}));
  if(weather){assert(m.terrainEffectDistance>0);const exposed=w.events.filter(e=>e.kind==='terrain_effect_exposure');assert(exposed.length);assert(exposed.every(e=>w.agents.find(a=>a.id===e.agentId).mobility==='water'));assert(w.events.some(e=>e.kind==='terrain_effect_ended'&&e.zoneId==='north-sea'&&e.tick===91));if(navigation!=='distance')assert(w.events.some(e=>e.kind==='terrain_route_assessed'&&e.agentId.startsWith('boat-')))}else assert.equal(m.terrainEffectDistance,0);
  results.push({physicsMode,navigation,weather,tick:w.tick,energy:m.energyUsed,exposure:m.terrainEffectDistance,replans:m.terrainReplans});
 }finally{p.close()}
}
for(const mode of ['kinematic','rapier'])for(const metric of ['distance','time','energy']){const get=weather=>results.find(r=>r.physicsMode===mode&&r.navigation===metric&&r.weather===weather);assert(get(true).tick>get(false).tick);assert(get(true).energy>get(false).energy)}

// Controlled public primitive move proves the actual transient speed/energy and
// inclusive expiry, independently of the full mission's completion calendar.
for(const physicsMode of ['kinematic','rapier']){
 const config=structuredClone(base),boat=config.agents.find(a=>a.mobility==='water');boat.count=1;boat.spawnArea={x:79,y:63,w:2,h:2};config.agents=[boat];config.tasks=[{id:'later',name:'Later',behavior:'survey',role:'boat',capability:'survey',target:[90,20],duration:10,dependsOn:[]}];
 const p=pair(config,{physicsMode,dispatchMode:'external'}),w=p.worlds[1],id='boat-1',estimate=E.observe(w,id).self.returnEnergyEstimate;
 try{
  for(const s of p.worlds){assert(E.submitAction(s,id,{requestId:'sail',type:'move',target:{x:90,y:88},targetTick:1,expiresTick:40}).ok);assert(E.injectTerrainEffect(s,'south-sea',6,.5,1.8).ok);assert.equal(E.observe(s,id).self.returnEnergyEstimate,estimate);const before=E.snapshot(s);assert.equal(E.injectTerrainEffect(s,'south-sea',6).reason,'zone_already_affected');assert.deepEqual(E.snapshot(s),before)}
  const history=[E.snapshot(w)],steps=[];
  for(let i=0;i<8;i++){const a=w.agents[0],before={x:a.x,y:a.y,battery:a.battery};p.step();steps.push({tick:w.tick,distance:Math.hypot(a.x-before.x,a.y-before.y),energy:before.battery-a.battery});history.push(E.snapshot(w));assert.equal(w.terrainEffects.length,w.tick<=6?1:0)}
  const slow=steps[5],normal=steps[6];assert(Math.abs(normal.distance/slow.distance-2)<1e-5);assert(Math.abs(slow.energy/slow.distance-(boat.moveEnergyPerUnit??.045)*1.8)<1e-6);assert(Math.abs(normal.energy/normal.distance-(boat.moveEnergyPerUnit??.045))<1e-6);assert(w.events.some(e=>e.kind==='terrain_effect_ended'&&e.tick===7));assert(!('terrainEffects'in E.observe(w,id)));
  assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{scene:config,sceneId:config.id,seed:42,policy:'nearest'},frames:history}));
 }finally{p.close()}
}
// A storm starts after a real move was accepted. The destination lies near the
// southern zone edge, so its old straight route becomes more costly than a detour.
for(const physicsMode of ['kinematic','rapier']){
 const config=structuredClone(base),boat=config.agents.find(a=>a.mobility==='water');boat.count=1;boat.spawnArea={x:66,y:62,w:2,h:2};config.agents=[boat];config.tasks=[{id:'later',name:'Later',behavior:'survey',role:'boat',capability:'survey',target:[90,20],duration:10,dependsOn:[]}];
 const p=pair(config,{physicsMode,dispatchMode:'external'}),w=p.worlds[1];
 try{
  for(const s of p.worlds)assert(E.submitAction(s,'boat-1',{requestId:'detour',type:'move',target:{x:90,y:90},targetTick:1,expiresTick:40}).ok);
  p.step();const before=w.agents[0].route.map(p=>p.slice()),pose=[w.agents[0].x,w.agents[0].y];
  for(const s of p.worlds)assert(E.injectTerrainEffect(s,'south-sea',12,.2,5).ok);
  assert.deepEqual(E.snapshot(w),E.snapshot(p.worlds[0]));assert.deepEqual([w.agents[0].x,w.agents[0].y],pose);assert.notDeepEqual(w.agents[0].route,before);
  assert(w.events.some(e=>e.kind==='terrain_route_replanned'&&e.agentId==='boat-1'&&e.transition==='started'&&e.newCost<e.previousCost));
  while(w.tick<14)p.step();assert.equal(w.terrainEffects.length,0);assert(w.events.some(e=>e.kind==='terrain_effect_ended'&&e.tick===14));
 }finally{p.close()}
}
console.log(JSON.stringify({passed:true,missionCases:12,expiryCases:2,actualReplanCases:2,comparedFrames:compared,results}));
