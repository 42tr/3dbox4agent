'use strict';
const {WorldDispatch}=require('../native/physics/target/release/box_physics.node');
const fields=['dispatchQueue','dispatchAvoid','nextDispatchId'],runtime=new Set(['status','appliedTick','reason']);
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
function guarded(fn){try{return fn()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldDispatchFailure:true})}}
function create(world){
 const c=world.communication.config,native=new WorldDispatch(JSON.stringify({tick:world.tick,seed:world.seed,agents:world.agents.map(a=>a.id),tasks:world.tasks.map(t=>t.id),config:{delay:c.delay,ttl:c.ttl,lossRate:c.lossRate,decisionMaxAge:c.decisionMaxAge},state:{decisions:world.decisions,...Object.fromEntries(fields.map(k=>[k,world.communication[k]]))}}));let cache=freeze(JSON.parse(native.snapshot())),closed=false;
 function view(index){const v=Object.fromEntries(Object.entries(cache.decisions[index]).filter(([k])=>!runtime.has(k)));for(const k of runtime)Object.defineProperty(v,k,{enumerable:true,get:()=>guarded(()=>{if(closed)throw Error('closed');return cache.decisions[index][k]})});return Object.freeze(v)}
 let views=Object.freeze(cache.decisions.map((_,i)=>view(i)));
 function commit(fn){return guarded(()=>{if(closed)throw Error('closed');const result=fn();cache=freeze(JSON.parse(native.snapshot()));while(views.length<cache.decisions.length)views=Object.freeze([...views,view(views.length)]);return result})}
 function published(result){const assigned=result.assigned===true;delete result.assigned;Object.defineProperty(result,'assigned',{value:assigned});Object.defineProperty(result,'published',{value:true});return result}
 function events(context,operation,changed=[0,2,3,7,8]){const C=require('./native-components'),refs=['execution','environment','tasks','resources','actions','peer','reports','control','ledger'].map(k=>C.reference(context[k],k));const result=JSON.parse(operation(...refs.map(r=>r.native)));for(const i of changed)refs[i].refresh();return published(result)}
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=freeze(JSON.parse(native.snapshot()));views=Object.freeze(cache.decisions.map((row,i)=>views[i]&&Object.keys(row).filter(k=>!runtime.has(k)).every(k=>JSON.stringify(views[i][k])===JSON.stringify(row[k]))?views[i]:view(i)))})},
  get views(){return guarded(()=>{if(closed)throw Error('closed');return views})},
  read(key){return guarded(()=>{if(closed||!fields.includes(key))throw Error('closed');return cache[key]})},
  immediate(input,tick){return commit(()=>JSON.parse(native.immediate(JSON.stringify(input),tick)))},
  automaticEvents(tick,context){return commit(()=>events(context,(...refs)=>native.automaticEvents(tick,...refs)))},
  immediateEvents(input,tick,context){return commit(()=>events(context,(...refs)=>native.immediateEvents(JSON.stringify(input),tick,...refs)))},
  externalEvents(input,tick,context){return commit(()=>events(context,(...refs)=>native.externalEvents(JSON.stringify(input),tick,...refs),[7,8]))},
  enqueueEvents(input,tick,context){return commit(()=>events(context,(...refs)=>native.enqueueEvents(JSON.stringify(input),tick,...refs),[7,8]))},
  readyEvents(world,context){return commit(()=>published(events(context,(...refs)=>native.readyEvents(world.tick,...refs),[]).map(o=>o.state)))},
  settleEvents(id,tick,context){return commit(()=>events(context,(...refs)=>native.settleEvents(id,tick,...refs)))},
  cancelEvents(reason,tick,context){return commit(()=>events(context,(...refs)=>native.cancelEvents(reason,tick,...refs),[7,8]))},
  external(input,tick){return commit(()=>JSON.parse(native.external(JSON.stringify(input),tick)))},
  enqueue(input,tick){return commit(()=>JSON.parse(native.enqueue(JSON.stringify(input),tick)))},
  registerTask(id,tick){commit(()=>native.registerTask(id,tick))},
  ready(world){return commit(()=>JSON.parse(native.ready(JSON.stringify({agents:world.agents.map(a=>({id:a.id,disabled:a.disabled})),outages:world.communication.outages||[]}),world.tick)).map(o=>o.state))},
  settle(id,reason,tick){commit(()=>native.settle(id,reason??undefined,tick))},
  cancel(reason,tick){commit(()=>native.cancel(reason,tick))},
  snapshot(){return guarded(()=>JSON.parse(native.snapshot()))},
  free(){native.free();closed=true;cache=null;views=Object.freeze([])}
 },'dispatch',native,()=>{cache=freeze(JSON.parse(native.snapshot()));while(views.length<cache.decisions.length)views=Object.freeze([...views,view(views.length)])});
}
module.exports={create,fields};
