'use strict';
const {WorldEnvironment}=require('../native/physics/target/release/box_physics.node');
const fields=['surfaceDomain','obstacles','riskZones','terrain','heightfield','navigation','riskNavigation','chargingStation','sensorRange','roadblocks','terrainEffects'];
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
function guarded(fn){try{return fn()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldEnvironmentFailure:true})}}
function create(world){
 const lastRoadblockEvent=world.events.reduce((last,e)=>e.kind==='roadblock_started'&&/^roadblock-[1-9][0-9]*$/.test(e.id)?Math.max(last,Number(e.id.slice(10))):last,0);
 const native=new WorldEnvironment(JSON.stringify({tick:world.tick,state:{...Object.fromEntries(fields.map(k=>[k,world[k]])),worldSize:world.worldSize},agents:world.agents.map(a=>({id:a.id,air:(a.mobility??(a.role==='drone'?'air':'ground'))==='air',...(a.mobility==='water'?{water:true}:{})})),lastRoadblockEvent}));
 let cache,terrain,closed=false;function active(){if(closed)throw Error('closed')}
 function refresh(){cache=freeze(JSON.parse(native.snapshot()));terrain=freeze(JSON.parse(native.effectiveTerrain()))}refresh();
 function commit(fn){return guarded(()=>{active();const result=JSON.parse(fn());refresh();return result})}
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);refresh()})},
  route(motion,index,physics,context){return guarded(()=>{active();const input=JSON.stringify(context);return JSON.parse(physics?physics.advanceRoute(motion,index,input,native):motion.advanceRoute(index,input,native))})},
  disturbancePlanningVersion:1,
  disturb(input,tick,context){return guarded(()=>{active();const C=require('./native-components'),refs=[['execution',context.execution],['tasks',context.tasks],['actions',context.actions],['resources',context.resources],['control',context.control],['ledger',context.ledger]].map(([kind,store])=>C.reference(store,kind));const result=JSON.parse(native.injectEvents(JSON.stringify(input),tick,...refs.map(r=>r.native)));refresh();for(const ref of refs)ref.refresh();Object.defineProperty(result,'published',{value:true});return result})},
  read(key){return guarded(()=>{active();return cache[key]})},
  effectiveTerrain(){return guarded(()=>{active();return terrain})},
  due(tick){return guarded(()=>{active();return JSON.parse(native.due(tick))})},
  roadblock(rect,duration,s){return commit(()=>native.roadblock(JSON.stringify({rect:{x:rect.x,y:rect.y,w:rect.w,h:rect.h},duration,eventId:s.events.length+1,agents:s.agents.map(a=>({id:a.id,x:a.x,y:a.y}))}),s.tick))},
  effect(zoneId,duration,speedFactor,energyFactor,tick){return commit(()=>native.effect(JSON.stringify({zoneId,duration,speedFactor,energyFactor}),tick))},
  expireRoadblocks(tick){return commit(()=>native.expireRoadblocks(tick))},
  expireTerrain(tick){return commit(()=>native.expireTerrain(tick))},
  snapshot(){return guarded(()=>{active();return JSON.parse(native.snapshot())})},
  free(){native.free();closed=true;cache=null;terrain=null}
 },'environment',native,refresh);
}
module.exports={create,fields};
