'use strict';
const {WorldActions}=require('../native/physics/target/release/box_physics.node');
const runtimeFields=new Set(['status','updatedTick','reason','resumeTaskId','progress','phase','energyAdded','result']);
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
function guarded(operation){try{return operation()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldActionsFailure:true})}}
function create(world){
 const native=new WorldActions(JSON.stringify({tick:world.tick,worldSize:world.worldSize,agents:world.agents.map(a=>a.id),actions:world.actions}));
 let cache=JSON.parse(native.snapshot()).map(freeze),closed=false;
 function view(index){const projection=Object.fromEntries(Object.entries(cache[index]).filter(([key])=>!runtimeFields.has(key)));for(const key of runtimeFields)Object.defineProperty(projection,key,{enumerable:true,get:()=>guarded(()=>{if(closed)throw Error('world actions is closed');return cache[index][key]})});return Object.freeze(projection)}
 let views=Object.freeze(cache.map((_,index)=>view(index)));
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=JSON.parse(native.snapshot()).map(freeze);views=Object.freeze(cache.map((row,i)=>views[i]&&Object.keys(row).filter(k=>!runtimeFields.has(k)).every(k=>JSON.stringify(views[i][k])===JSON.stringify(row[k]))?views[i]:view(i)))})},
  get views(){return guarded(()=>{if(closed)throw Error('world actions is closed');return views})},
  append(action,tick){return guarded(()=>{const result=JSON.parse(native.submit(JSON.stringify(action),tick));if(!result.duplicate){cache.push(freeze(JSON.parse(native.action(result.index))));views=Object.freeze([...views,view(result.index)])}return views[result.index]})},
  activate(index,execution,environment,resources,tasks,control,ledger,tick){return guarded(()=>{
   if(closed)throw Error('closed');const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),t=reference(tasks,'tasks'),c=reference(control,'control'),l=reference(ledger,'ledger');
   const result=JSON.parse(native.activatePlannedEvents(index,tick,e.native,env.native,r.native,t.native,c.native,l.native));cache[index]=freeze(JSON.parse(native.action(index)));e.refresh();c.refresh();l.refresh();Object.defineProperty(result,'published',{value:true});return result;
  })},
  lifecycle(kind,index,execution,environment,resources,tasks,control,ledger,tick){return guarded(()=>{
   if(closed)throw Error('closed');const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),t=reference(tasks,'tasks'),c=reference(control,'control'),l=reference(ledger,'ledger');
   const args=[e.native,env.native,r.native,t.native,c.native,l.native];let result;
   if(kind==='cancel')result=JSON.parse(native.cancelIntentEvents(index,tick,...args));else if(kind==='travel')result=JSON.parse(native.settleTravelEvents(index,tick,...args));else if(kind==='run')result=JSON.parse(native.cancelRunEvents(tick,...args));else throw Error('unknown lifecycle operation');
   c.refresh();l.refresh();Object.defineProperty(result,'published',{value:true});
   if(kind==='run')cache=JSON.parse(native.snapshot()).map(freeze);else cache[index]=freeze(JSON.parse(native.action(index)));
   e.refresh();if(kind==='travel'&&result.some(effect=>effect.kind==='energy_depleted'&&effect.taskId))r.refresh();return result;
  })},
  stationary(index,execution,environment,resources,tasks,physics,context,control,ledger){return guarded(()=>{
   if(closed)throw Error('closed');const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),t=reference(tasks,'tasks');let result;
   if(control&&ledger&&(!physics||typeof physics.stationaryActionEvents==='function')){
    const c=reference(control,'control'),l=reference(ledger,'ledger'),args=[native,index,context.tick,e.native,env.native,r.native,t.native,c.native,l.native];
    result=JSON.parse(physics?physics.stationaryActionEvents(...args):native.advanceStationaryEvents(...args.slice(1)));c.refresh();l.refresh();Object.defineProperty(result,'published',{value:true});
   }else{const input=JSON.stringify(context);result=JSON.parse(physics?physics.stationaryActions(native,index,input,e.native,env.native,r.native,t.native):native.advanceStationary(index,input,e.native,env.native,r.native,t.native));}
   cache[index]=freeze(JSON.parse(native.action(index)));e.refresh();return result;
  })},
  update(index,patch,tick){guarded(()=>{if(closed)throw Error('world actions is closed');cache[index]=freeze(JSON.parse(native.update(index,JSON.stringify(patch),tick)))})},
  snapshot(){return guarded(()=>JSON.parse(native.snapshot()))},
  free(){native.free();closed=true;cache=[];views=Object.freeze([])}
 },'actions',native,()=>{cache=JSON.parse(native.snapshot()).map(freeze)});
}
module.exports={create};
