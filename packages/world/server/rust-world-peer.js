'use strict';
const {WorldPeer}=require('../native/physics/target/release/box_physics.node');
const fields=['config','nextId','queue','inboxes','sentTick','sentBy','outages','messageRequests'];
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
function guarded(operation){try{return operation()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldPeerFailure:true})}}
function devices(world){return world.agents.map(a=>({id:a.id,x:a.x,y:a.y,disabled:a.disabled,...(a.deployableRelay?{relayReady:a.relayState.deployed&&a.battery>5}:{})}))}
function create(world){
 const peer=Object.fromEntries(fields.filter(key=>world.communication[key]!==undefined).map(key=>[key,world.communication[key]]));
 const native=new WorldPeer(JSON.stringify({tick:world.tick,seed:world.seed,agents:world.agents.map(a=>({id:a.id,...(a.deployableRelay!==undefined?{deployableRelay:a.deployableRelay}:{}),...(a.communicationRange!==undefined?{communicationRange:a.communicationRange}:{}),...(a.communicationBytesPerTick!==undefined?{communicationBytesPerTick:a.communicationBytesPerTick}:{})})),peer}));
 let cache=freeze(JSON.parse(native.snapshot())),closed=false;
 function commit(operation){return guarded(()=>{if(closed)throw Error('closed');const result=operation();cache=freeze(JSON.parse(native.snapshot()));return result})}
 function events(context,operation){
  const {reference}=require('./native-components'),refs=['execution','environment','control','ledger'].map(k=>reference(context[k],k));
  const result=JSON.parse(operation(...refs.map(r=>r.native)));for(const r of refs)r.refresh();Object.defineProperty(result,'published',{value:true});return result;
 }
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=freeze(JSON.parse(native.snapshot()))})},
  read(key){return guarded(()=>{if(closed||!fields.includes(key))throw Error('unavailable');return cache[key]})},
  send(input,world,context){return commit(()=>context?events(context,(...refs)=>native.sendEvents(JSON.stringify(input),world.tick,...refs)):JSON.parse(native.send(JSON.stringify({...input,done:world.done,agents:devices(world)}),world.tick)))},
  interrupt(agentId,duration,tick,context){return commit(()=>context?events(context,(...refs)=>native.interruptEvents(agentId,duration,tick,...refs)):native.interrupt(agentId,duration,tick))},
  restore(tick){commit(()=>native.restore(tick))},
  advance(world,obstructions,context){return commit(()=>context?events(context,(...refs)=>native.advanceEvents(world.tick,...refs)):JSON.parse(native.advance(JSON.stringify({agents:devices(world),obstructions}),world.tick)))},
  cancel(tick){commit(()=>native.cancel(tick))},
  snapshot(){return guarded(()=>JSON.parse(native.snapshot()))},
  free(){native.free();closed=true;cache=null}
 },'peer',native,()=>{cache=freeze(JSON.parse(native.snapshot()))});
}
module.exports={create,fields};
