import {projectMaterials} from './material-view';
import {projectEchelons,type EchelonView} from './echelon-view';
import {layout} from '@42tr/3dbox4agent-world/task-graph';
import {taskAttempts} from './task-execution';
export type TaskReadiness='done'|'active'|'assigned'|'queued'|'ready'|'waiting'|'ended'|'unknown';
export type TaskDependency={id:string;name:string;status:string;known:boolean};
export type TaskNode={materials?:{kind:'cost'|'reserved';items:{id:string;name:string;amount:number}[]};id:string;name:string;status:string;readiness:TaskReadiness;level:number|null;dependencies:TaskDependency[]|null;successors:{id:string;name:string}[]|null;target:[number,number]|null;assignee:{id:string;name:string}|null;queue:{id:number;agentId:string;dueTick:number;expiresTick:number}|null;role?:string;capability?:string;behavior?:string;phase?:string|null;duration?:number;priority?:number;deadline?:number;deadlineResult?:'met'|'missed'|'overdue'|'pending'|'unknown';assignmentId?:number;waypoint?:[number,number]|null;approachPoint?:[number,number]|null;withinReach?:boolean;attempt:null|{status:string;assignedTick:number|null;startedTick:number|null;endedTick:number|null;elapsed:number|null};recordedAttempts:number;events:{tick:number;message:string}[]};
export type TaskChainView={tick:number;scope:string|null;kind:'graph'|'list'|'scoped'|'unavailable';nodes:TaskNode[];done:boolean;echelons?:EchelonView};
const point=(v:any):[number,number]|null=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)?[v[0],v[1]]:null;
const list=(v:any):any[]=>Array.isArray(v)?v:[];
const time=(v:any)=>Number.isSafeInteger(v)&&v>=0;
export const readinessLabels:Record<TaskReadiness,string>={done:'已完成',active:'执行中',assigned:'等待设备启动',queued:'指令在途',ready:'依赖已满足',waiting:'等待前置',ended:'运行结束 · 未完成',unknown:'信息不足'};
/** Read the displayed frame only. Scoped tasks never inherit global metadata. */
export function projectTaskChain(world:any,observation:any,selected='global',scene?:unknown):TaskChainView{
 const tick=world.tick,scope=selected==='global'?null:selected,base:TaskChainView={tick,scope,kind:scope?'scoped':'graph',nodes:[],done:false};
 if(scope&&(!observation||observation.self?.id!==scope||observation.tick!==tick))return {...base,kind:'unavailable'};
 const materials=projectMaterials(world,observation,selected);
 const tasks=scope?list(observation.assignedTasks):list(world.tasks),done=scope?!!observation.done:!!world.done;let levels=new Map<string,number>();
 if(!scope){try{levels=new Map(layout(tasks).nodes.map(n=>[n.id,n.level]))}catch{base.kind='list'}}
 const byId=new Map(tasks.map(t=>[t.id,t])),agents=scope?[]:list(world.agents),events=scope?[]:list(world.events).filter(e=>time(e.tick)&&e.tick<=tick),packets=scope?[]:list(world.communication?.dispatchQueue),attempts=scope?[]:taskAttempts(tasks,events,tick);
 const nodes:TaskNode[]=tasks.map(t=>{
  const dependencies=scope||!Array.isArray(t.dependsOn)?null:t.dependsOn.map((id:string)=>{const d=byId.get(id);return {id,name:d?.name||id,status:d?.status||'unknown',known:!!d}}),agentId=scope?scope:t.assignee,agent=scope?observation.self:agents.find(a=>a.id===agentId),packet=packets.find(p=>p.taskId===t.id),records=attempts.filter(a=>a.taskId===t.id),last=records[records.length-1];
  const readiness:TaskReadiness=t.status==='done'?'done':done?'ended':t.status==='active'?(agent?.status==='assigned'?'assigned':'active'):t.status!=='pending'?'unknown':packet?'queued':dependencies===null?'unknown':dependencies.every((d:TaskDependency)=>d.known&&d.status==='done')?'ready':'waiting';
  const node:TaskNode={id:t.id,name:t.name,status:t.status,readiness,level:scope?null:levels.get(t.id)??null,dependencies,successors:scope?null:tasks.filter(d=>Array.isArray(d.dependsOn)&&d.dependsOn.includes(t.id)).map(d=>({id:d.id,name:d.name})),target:point(t.target),assignee:agentId?{id:agentId,name:scope?scope:agent?.name||agentId}:null,queue:packet?{id:packet.id,agentId:packet.agentId,dueTick:packet.dueTick,expiresTick:packet.expiresTick}:null,attempt:last?{status:last.status,assignedTick:last.assignedTick,startedTick:last.startedTick,endedTick:last.endedTick,elapsed:last.elapsed}:null,recordedAttempts:records.filter(r=>r.source==='events').length,events:events.filter(e=>e.taskId===t.id).slice(-6).map(e=>({tick:e.tick,message:e.message}))};
  // The observation protocol exposes only a subset, even if an input is contaminated.
  if(!scope){for(const k of ['role','capability','behavior','phase'] as const)if(t[k]!==undefined)node[k]=t[k];for(const k of ['duration','priority','deadline','assignmentId'] as const)if(Number.isFinite(t[k]))node[k]=t[k];
   if(t.deadline!==undefined)node.deadlineResult=t.status==='done'?(last?.status==='completed'&&last.endedTick!==null?(last.endedTick<=t.deadline?'met':'missed'):'unknown'):(tick>t.deadline?'overdue':'pending');
  }else if(observation.executionMode==='primitive'&&t.status==='active'){if(typeof t.behavior==='string')node.behavior=t.behavior;if(t.phase!==undefined)node.phase=t.phase;if(t.waypoint!==undefined)node.waypoint=point(t.waypoint);if(t.approachPoint!==undefined){const p=point(t.approachPoint);node.approachPoint=p&&p.every(n=>n>=0&&n<=100)?p:null}if(typeof t.withinReach==='boolean')node.withinReach=t.withinReach}
  if(!scope&&Array.isArray(t.materialCost)&&t.materialCost.length<=8&&t.materialCost.every((x:any)=>typeof x?.id==='string'&&Number.isSafeInteger(x.amount)&&x.amount>0))node.materials={kind:'cost',items:t.materialCost.map((x:any)=>({id:x.id,name:materials?.rows.find(r=>r.id===x.id)?.name||x.id,amount:x.amount}))};
  if(scope&&materials?.kind==='own'){const lease=materials.leases.find(r=>r.taskId===t.id);if(lease)node.materials={kind:'reserved',items:lease.items.map(x=>({...x}))}}
  return node;
 });
 const echelons=!scope&&base.kind==='graph'?projectEchelons(scene,world,nodes):undefined;
 return {...base,done,nodes,...(echelons?{echelons}:{})};
}
export type TaskFilter='all'|'ready'|'active'|'pending'|'done';
export function taskMatches(node:TaskNode,query:string,status:TaskFilter){const q=query.trim().toLocaleLowerCase(),matchesStatus=status==='all'||(status==='ready'?node.readiness==='ready':node.status===status);return matchesStatus&&(!q||[node.id,node.name,node.assignee?.id,node.assignee?.name].some(s=>s?.toLocaleLowerCase().includes(q)))}
export function taskColumns(view:TaskChainView,query:string,status:TaskFilter){const nodes=view.nodes.filter(n=>taskMatches(n,query,status)),columns=new Map<number,TaskNode[]>();for(const n of nodes){const col=view.kind==='graph'?n.level??0:0;if(!columns.has(col))columns.set(col,[]);columns.get(col)!.push(n)}return [...columns.entries()].sort((a,b)=>a[0]-b[0]).map(([level,nodes])=>({level,nodes}));}
