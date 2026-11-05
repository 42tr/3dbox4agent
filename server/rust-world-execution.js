'use strict';
const fields=Object.freeze(['operatingState','faultGeneration','relayState','thermalState','status','disabled','work','route','deliveryTravel','activity','roadblockWaitTicks','taskNeedsRoute','roadblockWait','boundaryActive','boundaryLastTick','collisionActive','collisionReplans','blockedTicks','progressWaypoint','bestWaypointDistance','terrainDistance','terrainEffectDistance']);
const motionFields=new Set(['x','y','battery','initialBattery','distance']);
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
function guarded(operation){try{return operation()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldExecutionFailure:true})}}
function create(native,world){
 guarded(()=>native.bindExecution(JSON.stringify({tick:world.tick,agents:world.agents.map(a=>Object.fromEntries(Object.entries(a).filter(([key])=>!motionFields.has(key))))})));
 // Cached values are immutable projections returned by Rust after its commit.
 // Neither engine code nor callers can mutate this cache or bypass native validation.
 let cache=JSON.parse(native.snapshotExecution()).map(freeze),closed=false;
 return require('./native-components').expose({
  operatingTick(now){return guarded(()=>{const depleted=JSON.parse(native.advanceOperatingState(now));cache=JSON.parse(native.snapshotExecution()).map(freeze);return depleted})},
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=JSON.parse(native.snapshotExecution()).map(freeze)})},
  route(index,environment,physics,context,resources,tasks,actions,control,ledger){return guarded(()=>{
   if(closed)throw Error('closed');let events;
   if(resources&&tasks&&actions&&control&&ledger&&(!physics||typeof physics.advanceRouteEvents==='function')){
    const C=require('./native-components'),refs=[['environment',environment],['resources',resources],['tasks',tasks],['actions',actions],['control',control],['ledger',ledger]].map(([kind,store])=>C.reference(store,kind));
    const args=[native,index,context.tick,...refs.map(r=>r.native)];
    events=JSON.parse(physics?physics.advanceRouteEvents(...args):native.advanceRouteEvents(...args.slice(1)));
    refs[4].refresh();refs[5].refresh();Object.defineProperty(events,'published',{value:true});
   }else events=environment.route(native,index,physics,context);
   cache[index]=freeze(JSON.parse(native.snapshotExecution())[index]);return events;
  })},
  replan(index,environment,resources,tasks,actions,control,ledger,tick){return guarded(()=>{
   if(closed)throw Error('closed');const C=require('./native-components'),refs=[['environment',environment],['resources',resources],['tasks',tasks],['actions',actions],['control',control],['ledger',ledger]].map(([kind,store])=>C.reference(store,kind));
   const result=JSON.parse(native.replanCollisionEvents(index,tick,...refs.map(r=>r.native)));cache[index]=freeze(JSON.parse(native.snapshotExecution())[index]);refs[4].refresh();refs[5].refresh();Object.defineProperty(result,'published',{value:true});return result;
  })},
  read(index,key){return guarded(()=>{if(closed||!cache[index])throw Error('world execution is closed');return cache[index][key]})},
  update(index,patch){guarded(()=>{if(closed)throw Error('world execution is closed');cache[index]=freeze(JSON.parse(native.updateExecution(index,JSON.stringify(patch))))})},
  finishThermals(tick){return guarded(()=>{if(closed)throw Error('closed');const events=JSON.parse(native.finishThermals(tick));cache=JSON.parse(native.snapshotExecution()).map(freeze);return events})},
  snapshot(){return guarded(()=>JSON.parse(native.snapshotExecution()))},
  free(){native.freeExecution();closed=true;cache=[]}
 },'execution',native,()=>{cache=JSON.parse(native.snapshotExecution()).map(freeze)});
}
module.exports={create,fields};
