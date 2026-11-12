'use strict';
const {WorldReports}=require('../native/physics/target/release/box_physics.node');
const fields=['reporting','fixedSensors','fixedSensorState','evidenceReports','sampleReports'];
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
function guarded(fn){try{return fn()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldReportsFailure:true})}}
function environment(world){return {agents:world.agents.map(a=>({id:a.id,disabled:a.disabled})),outages:world.communication.outages||[]}}
function create(world){
 const c=world.communication.config,state=Object.fromEntries(fields.map(key=>[key,key==='reporting'?world.communication.reporting:world[key]]).filter(([,v])=>v!==undefined));
 const native=new WorldReports(JSON.stringify({tick:world.tick,seed:world.seed,config:{delay:c.delay,ttl:c.ttl,lossRate:c.lossRate,statusInterval:c.statusInterval,statusMaxAge:c.statusMaxAge},site:world.part.site,agents:world.agents.map(a=>({id:a.id,role:a.role,capabilities:a.capabilities})),state}));
 let cache=freeze(JSON.parse(native.snapshot())),closed=false;
 function commit(fn){return guarded(()=>{if(closed)throw Error('closed');const result=fn();cache=freeze(JSON.parse(native.snapshot()));return result})}
 function events(context,operation){const C=require('./native-components'),refs=['execution','environment','tasks','actions','resources','peer','control','ledger'].map(k=>C.reference(context[k],k));const result=JSON.parse(operation(...refs.map(r=>r.native)));refs[6].refresh();refs[7].refresh();Object.defineProperty(result,'published',{value:true});return result}
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=freeze(JSON.parse(native.snapshot()))})},
  read(key){return guarded(()=>{if(closed||!fields.includes(key))throw Error('closed');return cache[key]})},
  evidence(source,tick,context){return commit(()=>context?events(context,(...refs)=>native.submitEvents('evidence',JSON.stringify({agentId:source.agentId,requestId:source.requestId,scanRequestId:source.scanRequestId}),tick,...refs)):JSON.parse(native.evidence(JSON.stringify(source),tick)))},
  sample(source,tick,context){return commit(()=>context?events(context,(...refs)=>native.submitEvents('sample',JSON.stringify({agentId:source.agentId,requestId:source.requestId,taskId:source.taskId}),tick,...refs)):JSON.parse(native.sample(JSON.stringify(source),tick)))},
  schedule(sources,tick,context){return commit(()=>context?events(context,(...refs)=>native.scheduleEvents(tick,...refs)):native.schedule(JSON.stringify(sources),tick))},
  advance(channel,world,context){return commit(()=>context?events(context,(...refs)=>native.advanceEvents(channel,world.tick,...refs)):JSON.parse(native.advance(channel,JSON.stringify(environment(world)),world.tick)))},
  fixed(world,sight,context){return commit(()=>context?events(context,(...refs)=>context.physics?context.physics.fixedReportEvents(native,world.tick,...refs):native.fixedEvents(world.tick,...refs)):JSON.parse(native.fixed(JSON.stringify({environment:environment(world),sight,anomaly:world.asset.condition==='fault'}),world.tick)))},
  cancel(channel,world,clearCache=false){return commit(()=>JSON.parse(native.cancel(channel,clearCache,world.tick)))},
  snapshot(){return guarded(()=>JSON.parse(native.snapshot()))},
  free(){native.free();closed=true;cache=null}
 },'reports',native,()=>{cache=freeze(JSON.parse(native.snapshot()))});
}
module.exports={create,fields};
