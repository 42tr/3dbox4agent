'use strict';
const {WorldPerceptions}=require('../native/physics/target/release/box_physics.node');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
function guarded(fn){try{return fn()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldPerceptionsFailure:true})}}
const target=t=>({id:t.id,target:t.target});
const block=b=>({x:b.x,y:b.y,w:b.w,h:b.h,height:b.height});
function create(world,physics=null){
 const ray=world.sensorModel==='rapier-ray-v1';
 if(ray&&['refreshPerceptions','syncRoadblocks'].some(key=>typeof physics?.[key]!=='function'))throw Error('native perception ray backend unavailable');
 const native=new WorldPerceptions(JSON.stringify({tick:world.tick,worldSize:world.worldSize,ray,...(world.heightfield?{heightfield:world.heightfield}:{}),agents:world.agents.map(a=>({id:a.id,role:a.role,height:(a.mobility??(a.role==='drone'?'air':'ground'))==='air'?16:1.5,range:a.sensorRange??world.sensorRange})),targets:world.tasks.map(target),obstacles:world.obstacles.map(block),perceptions:world.perceptions}));
 let cache=freeze(JSON.parse(native.snapshot())),closed=false;
 function active(){if(closed)throw Error('closed')}
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=freeze(JSON.parse(native.snapshot()))})},
  read(){return guarded(()=>{active();return cache})},
  refresh(s){guarded(()=>{active();const input=JSON.stringify({tick:s.tick,agents:s.agents.map(a=>({id:a.id,x:a.x,y:a.y,status:a.status,disabled:a.disabled,...(a.faultGeneration!==undefined?{faultGeneration:a.faultGeneration}:{})})),roadblocks:(s.roadblocks||[]).map(block)});if(ray){physics.syncRoadblocks(s.roadblocks||[]);physics.refreshPerceptions(native,input)}else native.refresh(input);cache=freeze(JSON.parse(native.snapshot()))})},
  register(t,tick){guarded(()=>{active();native.register(JSON.stringify(target(t)),tick)})},
  snapshot(){return guarded(()=>{active();return JSON.parse(native.snapshot())})},
  free(){native.free();closed=true;cache=null}
 },'perceptions',native,()=>{cache=freeze(JSON.parse(native.snapshot()))});
}
module.exports={create};
