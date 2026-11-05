/** Derive task attempts from the displayed snapshot only. Missing history stays unknown. */
export type ExecutionEvent={seq?:number;tick:number;kind?:string;taskId?:string;agentId?:string;assignmentId?:number;message:string;type?:string};
export type ExecutionTask={id:string;name:string;status:string;assignee?:string|null;assignmentId?:number;phase?:string|null;behavior?:string};
export type TaskAttempt={key:string;taskId:string;name:string;agentId:string|null;assignmentId:number|null;assignedTick:number|null;startedTick:number|null;endedTick:number|null;status:'assigned'|'running'|'completed'|'interrupted'|'unknown';events:ExecutionEvent[];lastIndex:number;source:'events'|'snapshot';elapsed:number|null;phase:string|null;behavior:string|null};
const interrupted=new Set(['device_fault','energy_depleted','low_energy_replan','task_revoked']);
export function taskAttempts(tasks:ExecutionTask[],events:ExecutionEvent[],tick:number,scopeAgent:string|null=null):TaskAttempt[]{
 const taskById=new Map(tasks.map(t=>[t.id,t])),attempts:TaskAttempt[]=[],open=new Map<string,TaskAttempt>();
 const create=(task:ExecutionTask,event:ExecutionEvent|null,index:number):TaskAttempt=>{const item:TaskAttempt={key:task.id+':'+(event?.seq??index),taskId:task.id,name:task.name,agentId:event?(event.agentId??null):(task.assignee??scopeAgent),assignmentId:event?.assignmentId??null,assignedTick:null,startedTick:null,endedTick:null,status:'unknown',events:[],lastIndex:index,source:event?'events':'snapshot',elapsed:null,phase:task.phase??null,behavior:task.behavior??null};attempts.push(item);open.set(task.id,item);return item};
 for(let i=0;i<events.length;i++){
  const e=events[i],t=e.taskId?taskById.get(e.taskId):null;if(!t||!e.kind||!Number.isFinite(e.tick)||e.tick>tick)continue;
  let item=open.get(t.id);
  if(e.kind==='task_assigned'){
   if(item){item.status='interrupted';open.delete(t.id)}
   item=create(t,e,i);item.assignedTick=e.tick;item.status='assigned';
  }else if(e.kind==='task_work_started'){
   if(item&&((e.assignmentId!==undefined&&item.assignmentId!==null&&e.assignmentId!==item.assignmentId)||(e.agentId&&item.agentId&&e.agentId!==item.agentId))){item.status='interrupted';open.delete(t.id);item=undefined}
   item=item??create(t,e,i);item.startedTick=e.tick;item.status='running';
  }else if(e.kind==='task_completed'){
   // Completion records do not carry assignmentId in the current protocol.
   // Never attach completion to an open attempt for a different device.
   if(item&&e.agentId&&item.agentId&&e.agentId!==item.agentId){item.status='interrupted';open.delete(t.id);item=undefined}
   item=item??create(t,e,i);item.endedTick=e.tick;item.status='completed';open.delete(t.id);
  }else if(interrupted.has(e.kind)){
   if(!item||e.agentId&&item.agentId&&e.agentId!==item.agentId)continue;
   if(e.assignmentId!==undefined&&item.assignmentId!==null&&e.assignmentId!==item.assignmentId)continue;
   item.endedTick=e.tick;item.status='interrupted';open.delete(t.id);
  }else if(!item)continue;
  if(item){item.events.push(e);item.lastIndex=i}
 }
 // Old or scope-limited snapshots may have task state without assignment events.
 // They can describe current state, but cannot prove when execution began.
 for(const task of tasks){if(!['active','done'].includes(task.status)||attempts.some(x=>x.taskId===task.id))continue;const item=create(task,null,events.length+attempts.length);item.assignmentId=task.assignmentId??null;item.status=task.status==='done'?'completed':task.phase?'running':'unknown';open.delete(task.id)}
 for(const item of attempts){if(item.startedTick!==null){const end=item.endedTick??(['assigned','running'].includes(item.status)?tick:null);if(end!==null&&end>=item.startedTick)item.elapsed=end-item.startedTick}const task=taskById.get(item.taskId);if(task?.assignee&&task.assignee===item.agentId&&(!task.assignmentId||task.assignmentId===item.assignmentId))item.phase=task.phase??null}
 return attempts.sort((a,b)=>a.lastIndex-b.lastIndex);
}
