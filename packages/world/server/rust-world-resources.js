'use strict';
const {WorldResources}=require('../../../rust/physics/target/release/box_physics.node');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
function guarded(fn){try{return fn()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldResourcesFailure:true})}}
function task(t){return {id:t.id,behavior:t.behavior,role:t.role,capability:t.capability,target:t.target,status:t.status,assignee:t.assignee,...(t.assignmentId!==undefined?{assignmentId:t.assignmentId}:{}),...(t.buildSite!==undefined?{buildSite:t.buildSite}:{}),...(t.materialCost!==undefined?{materialCost:t.materialCost}:{})}}
function create(world){
 const native=new WorldResources(JSON.stringify({tick:world.tick,state:{asset:world.asset,part:world.part,...(world.construction!==undefined?{construction:world.construction}:{}),...(world.materials!==undefined?{materials:world.materials}:{})},warehouse:world.chargingStation,agents:world.agents.map(a=>({id:a.id,role:a.role,capabilities:a.capabilities})),tasks:world.tasks.map(task)}));let cache=freeze(JSON.parse(native.snapshot())),closed=false;
 function read(group,key){return guarded(()=>{if(closed)throw Error('closed');return cache[group][key]})}
 function view(group){const result={};for(const key of Object.keys(cache[group]))Object.defineProperty(result,key,{enumerable:true,get:()=>read(group,key)});return Object.freeze(result)}
 const asset=view('asset'),part=view('part');
 function commit(fn){return guarded(()=>{if(closed)throw Error('closed');const result=fn();cache=freeze(JSON.parse(native.snapshot()));return result})}
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  readConstruction(){return guarded(()=>{if(closed)throw Error('closed');return cache.construction})},
  readMaterials(){return guarded(()=>{if(closed)throw Error('closed');return cache.materials})},
  rollback(point){guarded(()=>{native.rollback(point);cache=freeze(JSON.parse(native.snapshot()))})},asset,part,
  command(kind,t,a,tick){return commit(()=>JSON.parse(native.command(JSON.stringify({kind,taskId:t.id,agentId:a.id,assignmentId:t.assignmentId,...(!['assign','finish'].includes(kind)?{position:[a.x,a.y]}:{})}),tick)))},
  register(t,tick){commit(()=>native.register(JSON.stringify(task(t)),tick))},
  snapshot(){return guarded(()=>JSON.parse(native.snapshot()))},
  free(){native.free();closed=true;cache=null}
 },'resources',native,()=>{cache=freeze(JSON.parse(native.snapshot()))});
}
module.exports={create};
