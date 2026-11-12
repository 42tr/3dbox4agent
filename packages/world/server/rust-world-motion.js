'use strict';
const {WorldMotion}=require('../native/physics/target/release/box_physics.node');
const fields=Object.freeze(['x','y','battery','initialBattery','distance']);
function guarded(operation){try{return operation()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldMotionFailure:true})}}
function create(world){
 const native=new WorldMotion(JSON.stringify(world.agents.map(a=>Object.fromEntries(['id',...fields].map(key=>[key,a[key]])))));
 return Object.freeze({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);})},
  read(index,field){return guarded(()=>native.read(index,field))},
  apply(index,patch){return guarded(()=>{
   if(!patch||Object.keys(patch).some(key=>!['x','y','battery','distance'].includes(key)))throw Error('invalid motion update');
   const value=key=>Object.hasOwn(patch,key)?patch[key]:native.read(index,key);
   native.commit(index,value('x'),value('y'),value('battery'),value('distance'));
  })},
  snapshot(){return guarded(()=>JSON.parse(native.snapshot()))},free(){native.free()},
  execution(world){return require('./rust-world-execution').create(native,world)}
 });
}
module.exports={create,fields};
