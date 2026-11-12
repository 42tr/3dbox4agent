'use strict';
const {WorldLedger}=require('../native/physics/target/release/box_physics.node');
function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value)}return value}
function guarded(operation){try{return operation()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldLedgerFailure:true})}}
function create(world){
 const initial={tick:world.tick,done:world.done,failed:world.failed,events:world.events},native=new WorldLedger(JSON.stringify(initial));
 let events=freeze(JSON.parse(JSON.stringify(initial.events)));
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);events=freeze(JSON.parse(native.snapshot()).events)})},
  get tick(){return native.tick},get done(){return native.done},get failed(){return native.failed},get events(){return events},
  advance(){return guarded(()=>native.advance(native.tick))},finish(failed){guarded(()=>native.finish(failed))},
  control(world){return require('./rust-world-control').create(world,native,this)},
  append(payload){guarded(()=>{const event=freeze(JSON.parse(native.append(JSON.stringify(payload))));events=Object.freeze([...events,event])})},
  snapshot(){return JSON.parse(native.snapshot())},free(){native.free();events=Object.freeze([])}
 },'ledger',native,()=>{events=freeze(JSON.parse(native.snapshot()).events)});
}
module.exports={create};
