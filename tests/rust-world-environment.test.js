'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),R=require('../src/replay'),N=require('../server/rust-world-environment'),{WorldEnvironment}=require('../rust/physics/target/release/box_physics.node');
function initial(w=E.create(42,'nearest',E.getScene('lunar-outpost-v1'))){return {tick:w.tick,lastRoadblockEvent:0,agents:w.agents.map(a=>({id:a.id,air:(a.mobility??(a.role==='drone'?'air':'ground'))==='air'})),state:Object.fromEntries(N.fields.map(k=>[k,w[k]]))}}
const native=v=>new WorldEnvironment(JSON.stringify(v)),effect=(n,zoneId,duration=2,speedFactor=.5,energyFactor=1.8,tick=0)=>JSON.parse(n.effect(JSON.stringify({zoneId,duration,speedFactor,energyFactor}),tick));
const add=(n,eventId=1,rect={x:90,y:0,w:4,h:10},tick=0,agents)=>JSON.parse(n.roadblock(JSON.stringify({eventId,rect,duration:2,agents:agents||initial().agents.map(a=>({id:a.id,x:10,y:10}))}),tick));
for(const mutate of [v=>v.tick=-1,v=>v.agents=[],v=>v.agents.push(v.agents[0]),v=>v.state.obstacles.push(v.state.obstacles[0]),v=>v.state.obstacles[0].height=0,v=>v.state.terrain[0].speedFactor=.1,v=>v.state.terrain[0].name='长'.repeat(101),v=>v.state.chargingStation=[101,0],v=>v.state.navigation='invalid',v=>v.state.sensorRange=0,v=>v.state.terrainEffects=[{zoneId:'unknown',startedTick:0,untilTick:2,speedFactor:.5,energyFactor:2}],v=>v.state.roadblocks=[{id:'roadblock-1',x:90,y:0,w:4,h:4,height:4,startedTick:0,untilTick:2}]]){const v=initial();mutate(v);assert.throws(()=>native(v),/invalid world environment/)}
{
 const v=initial();v.state.terrain[0].name='界'.repeat(100);v.state.riskZones=[{id:'emoji',name:'🌕'.repeat(50),x:0,y:0,w:1,h:1}];const n=native(v);assert.equal(JSON.parse(n.snapshot()).terrain[0].name,v.state.terrain[0].name);n.free();
}
{
 const v=initial(),n=native(v),before=n.snapshot(),zone=v.state.terrain[0].id;
 for(const args of [['unknown'],[zone,0],[zone,1001],[zone,2,.1],[zone,2,.5,6],[zone,2,.5,2,-1],[zone,2,.5,2,.5]]){assert.throws(()=>effect(n,...args));assert.equal(n.snapshot(),before)}
 for(const rect of [{x:0,y:0,w:1,h:2},{x:99,y:0,w:4,h:4},{x:9,y:9,w:3,h:3}]){assert.throws(()=>add(n,1,rect));assert.equal(n.snapshot(),before)}
 const agents=initial().agents.map(a=>({id:a.id,x:10,y:10}));agents[1].id=agents[0].id;assert.throws(()=>add(n,1,undefined,0,agents));assert.equal(n.snapshot(),before);
 const e=effect(n,zone);assert.equal(e.untilTick,2);const applied=JSON.parse(n.effectiveTerrain()).find(t=>t.id===zone),base=v.state.terrain.find(t=>t.id===zone);assert.equal(applied.speedFactor,base.speedFactor*.5);assert.equal(applied.energyFactor,base.energyFactor*1.8);const saved=n.snapshot();assert.throws(()=>effect(n,zone));assert.equal(n.snapshot(),saved);
 const b=add(n);assert.equal(b.id,'roadblock-1');assert.equal(b.height,4);assert.equal(JSON.parse(n.due(2)).terrain.length,0);assert.deepEqual(JSON.parse(n.expireRoadblocks(2)),[]);assert.deepEqual(JSON.parse(n.expireTerrain(2)),[]);assert.equal(JSON.parse(n.snapshot()).roadblocks.length,1);
 assert.equal(JSON.parse(n.expireRoadblocks(3)).length,1);assert.equal(JSON.parse(n.snapshot()).terrainEffects.length,1,'terrain survives road reopening until its own transition');assert.equal(JSON.parse(n.effectiveTerrain())[0].speedFactor,base.speedFactor*.5);assert.equal(JSON.parse(n.expireTerrain(3)).length,1);assert.equal(JSON.parse(n.effectiveTerrain())[0].speedFactor,base.speedFactor);assert.throws(()=>add(n,1,undefined,3));assert.equal(add(n,2,undefined,3).id,'roadblock-2');
 const committed=n.snapshot();for(const fn of [()=>n.expireRoadblocks(2),()=>n.expireTerrain(NaN),()=>n.due(1),()=>n.expireTerrain(10000001)]){assert.throws(fn);assert.equal(n.snapshot(),committed)}n.free();n.free();assert.throws(()=>n.snapshot(),/closed/);assert.throws(()=>n.effectiveTerrain(),/closed/);assert.throws(()=>n.due(3),/closed/);
}
{
 const v=initial();delete v.state.terrainEffects;const n=native(v);n.expireRoadblocks(1);n.expireTerrain(1);assert(!Object.hasOwn(JSON.parse(n.snapshot()),'terrainEffects'));n.free();
}
// Native occupancy uses the existing two-unit navigation clearance, includes
// faulted ground devices, and excludes air devices from ground containment.
{
 const v=initial();v.agents=[{id:'air',air:true},{id:'ground',air:false}];const n=native(v),agents=[{id:'air',x:91,y:5},{id:'ground',x:87.999,y:5}];assert.equal(add(n,1,undefined,0,agents).id,'roadblock-1');const before=n.snapshot();agents[1].x=88;assert.throws(()=>add(n,2,undefined,0,agents));assert.equal(n.snapshot(),before);agents[1].x=1;assert.throws(()=>add(n,2,undefined,0,agents));n.free();
}
function bind(w){E.bindWorldEnvironment(w,N.create(w))}
function both(worlds,fn){const result=fn(worlds[0]),actual=fn(worlds[1]);assert.deepEqual(actual,result);assert.deepEqual(E.snapshot(worlds[1]),E.snapshot(worlds[0]));return result}
for(const policy of ['distance','time','energy']){
 const scene=E.getScene();scene.obstacles=[];scene.navigation=policy;scene.terrain=[{id:'crossing',name:'通行区域',x:30,y:40,w:40,h:20,speedFactor:1,energyFactor:1}];scene.tasks[0].deadline=4;Object.assign(scene.communication,{range:1000,delay:4,ttl:20,lossRate:0});
 const a=E.create(42,'nearest',scene,{dispatchMode:'external'}),b=E.snapshot(a),worlds=[a,b];worlds.forEach(w=>{w.agents.find(a=>a.id==='vehicle-1').x=10;w.agents.find(a=>a.id==='vehicle-1').y=50;E.refreshPerceptions(w)});bind(b);const before=E.snapshot(b);
 for(const mutate of [()=>b.roadblocks=[],()=>b.obstacles.push({}),()=>b.chargingStation[0]=0,()=>b.sensorRange=1,()=>b.terrain[0].speedFactor=0,()=>b.navigation='energy',()=>b.riskZones=[]])assert.throws(mutate,TypeError);assert.deepEqual(E.snapshot(b),before);
 assert(both(worlds,w=>E.submitAction(w,'vehicle-1',{requestId:'move',type:'move',target:{x:90,y:50},targetTick:1,expiresTick:100})).ok);both(worlds,w=>E.step(w).tick);const estimate=E.observe(b,'vehicle-1').self.returnEnergyEstimate;
 assert(both(worlds,w=>E.injectTerrainEffect(w,'crossing',3,.2,5)).ok);assert.equal(both(worlds,w=>E.injectRoadblock(w,{x:50,y:0,w:4,h:100},3)).waiting,1);assert.equal(E.observe(b,'vehicle-1').self.returnEnergyEstimate,estimate);assert(both(worlds,w=>E.interruptCommunication(w,'drone-2',3)).ok);assert(both(worlds,w=>E.sendMessage(w,'drone-1','drone-2','恢复后送达')).ok);
 const fork=E.snapshot(b);bind(fork);const frames=[E.snapshot(b)];
 for(let i=0;i<4;i++){both(worlds,w=>E.step(w).tick);E.step(fork);assert.deepEqual(E.snapshot(fork),E.snapshot(b));frames.push(E.snapshot(b));if(b.tick===4){assert.equal(b.roadblocks.length,1);assert.equal(b.terrainEffects.length,1)}if(b.tick===5){const kinds=b.events.filter(e=>e.tick===5).map(e=>e.kind);assert.deepEqual(kinds.filter(k=>['roadblock_ended','terrain_effect_ended','deadline_missed','communication_restored','message_delivered'].includes(k)),['roadblock_ended','terrain_effect_ended','deadline_missed','communication_restored','message_delivered']);assert(!b.roadblocks.length&&!b.terrainEffects.length);if(policy!=='distance')assert(b.events.some(e=>e.tick===5&&e.kind==='terrain_route_replanned'&&e.transition==='ended'))}}
 assert(both(worlds,w=>E.injectTerrainEffect(w,'crossing',2)).ok);assert.equal(both(worlds,w=>E.injectTerrainEffect(w,'crossing',2)).reason,'zone_already_affected');assert.equal(fork.terrainEffects.length,0,'reconstructed native environment is independent');for(let i=0;i<80&&a.actions[0].status==='accepted';i++){both(worlds,w=>E.step(w).tick);frames.push(E.snapshot(b))}assert.equal(b.actions[0].status,'completed');assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames}));E.disposeWorld(fork);E.disposeWorld(b);
}
{
 const scene=E.getScene();scene.obstacles=[];const w=E.create(42,'nearest',scene,{dispatchMode:'external'}),a=w.agents.find(a=>a.id==='vehicle-1');a.x=35;a.y=88;a.route=[[80,88]];bind(w);const before=E.snapshot(w);assert.equal(E.injectRoadblock(w,{x:50,y:0,w:8,h:100},3).reason,'route_owner_unavailable');assert.deepEqual(E.snapshot(w),before);E.bindNavigation(w,{plan(){throw Error('preview plan failure')}});assert.throws(()=>E.injectRoadblock(w,{x:50,y:0,w:8,h:100},3),/preview plan failure/);assert.deepEqual(E.snapshot(w),before);E.disposeWorld(w);
}
console.log('Native environment: typed immutable map/config, derived terrain, occupancy clearance, optional fields, inclusive expiry, stale IDs/ticks, preflight rollback, simultaneous road/terrain/deadline/outage ordering, time/energy reroutes, replay and independent forks passed');
