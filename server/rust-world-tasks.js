'use strict';
const {WorldTasks}=require('../rust/physics/target/release/box_physics.node');
const runtimeFields=Object.freeze(['status','assignee','assignmentId','startedAssignmentId','phase']);
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
function guarded(operation){try{return operation()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldTasksFailure:true})}}
function create(world){
 const native=new WorldTasks(JSON.stringify({tick:world.tick,tasks:world.tasks,agents:world.agents.map(a=>({id:a.id,role:a.role,capabilities:a.capabilities}))}));
 function view(task){
  const taskId=task.id;
  const projection=Object.fromEntries(Object.entries(task).filter(([key])=>!runtimeFields.includes(key)).map(([key,value])=>[key,freeze(value)]));
  for(const key of runtimeFields)Object.defineProperty(projection,key,{enumerable:true,get:()=>guarded(()=>{const encoded=native.read(taskId,key);return encoded==null?undefined:JSON.parse(encoded)})});
  return Object.freeze(projection);
 }
 let views=Object.freeze(JSON.parse(native.snapshot()).map(view)),closed=false;
 return require('./native-components').expose({
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);views=Object.freeze(JSON.parse(native.snapshot()).map((row,i)=>views[i]&&Object.keys(row).filter(k=>!runtimeFields.includes(k)).every(k=>JSON.stringify(views[i][k])===JSON.stringify(row[k]))?views[i]:view(row)))})},
  get views(){return guarded(()=>{if(closed)throw Error('world tasks is closed');return views})},
  command(taskId,kind,detail={}){guarded(()=>native.command(JSON.stringify({kind,taskId,...detail})))},
  interrupt(input,execution,environment,resources,actions,control,ledger,tick){return guarded(()=>{
   if(closed)throw Error('closed');const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),a=reference(actions,'actions'),c=reference(control,'control'),l=reference(ledger,'ledger');
   const result=JSON.parse(native.interrupt(JSON.stringify(input),tick,e.native,env.native,r.native,a.native,c.native,l.native));if(result.ok){e.refresh();r.refresh();a.refresh()}return result;
  })},
  assign(taskId,agentId,execution,environment,resources,control,ledger,tick){return guarded(()=>{
   if(closed)throw Error('closed');const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),c=reference(control,'control'),l=reference(ledger,'ledger');
   const result=JSON.parse(native.assignPlannedEvents(JSON.stringify({taskId:taskId??null,agentId:agentId??null}),tick,e.native,env.native,r.native,c.native,l.native));if(result.ok){e.refresh();r.refresh();c.refresh();l.refresh()}return result;
  })},
  start(taskId,execution,environment,resources,actions,control,ledger,tick){return guarded(()=>{const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),a=reference(actions,'actions'),c=reference(control,'control'),l=reference(ledger,'ledger');const result=native.startEvents(taskId,tick,e.native,env.native,r.native,a.native,c.native,l.native);c.refresh();l.refresh();return result})},
  work(taskId,execution,environment,resources,actions,context,route,control,ledger){return guarded(()=>{
   if(closed)throw Error('closed');const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),a=reference(actions,'actions'),input=JSON.stringify(context);
   let result;if(control&&ledger&&route===undefined){const c=reference(control,'control'),l=reference(ledger,'ledger');result=JSON.parse(native.advanceWorkEvents(taskId,input,e.native,env.native,r.native,a.native,c.native,l.native));c.refresh();l.refresh()}else result=route===undefined?JSON.parse(native.advanceWork(taskId,input,e.native,env.native,r.native,a.native)):native.finishLoading(taskId,input,JSON.stringify(route),e.native,env.native,r.native,a.native);
   e.refresh();r.refresh();a.refresh();return result;
  })},
  append(task){guarded(()=>{native.append(JSON.stringify(task));const saved=JSON.parse(native.snapshot()).at(-1);views=Object.freeze([...views,view(saved)])})},
  snapshot(){return guarded(()=>JSON.parse(native.snapshot()))},
  free(){native.free();closed=true;views=Object.freeze([])}
 },'tasks',native,()=>{views=Object.freeze(JSON.parse(native.snapshot()).map((row,i)=>views[i]&&Object.keys(row).filter(k=>!runtimeFields.includes(k)).every(k=>JSON.stringify(views[i][k])===JSON.stringify(row[k]))?views[i]:view(row)))});
}
module.exports={create};
