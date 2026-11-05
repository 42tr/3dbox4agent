import {normalize,type EchelonConfig} from './echelons.js';
import type {TaskNode,TaskChainView} from './task-chain';
export type EchelonGroupView={id:string;name:string;taskIds:string[];done:number;active:number;ready:number;queued:number;incoming:{id:string;name:string}[];participants:{id:string;name:string}[]};
export type EchelonView={groups:EchelonGroupView[];unclassified:string[]};
export function filterEchelonTasks(view:TaskChainView|undefined,selection:string):TaskChainView|undefined{
 if(!view||view.scope||view.kind!=='graph'||!view.echelons)return view;
 const ids=selection==='*'?view.echelons.unclassified:view.echelons.groups.find(g=>g.id===selection)?.taskIds;
 return ids?{...view,nodes:view.nodes.filter(n=>ids.includes(n.id))}:view;
}
/** Scene labels organize the displayed frame. They add no execution gate. */
export function projectEchelons(scene:any,world:any,nodes:TaskNode[]):EchelonView|undefined{
 try{
  if(!scene||scene.id!==world.sceneId||scene.echelons===undefined||!Array.isArray(scene.tasks)||!Array.isArray(world.tasks))return;
  const groups:EchelonConfig[]=normalize(scene.echelons,scene.tasks),raw=new Map<string,any>(world.tasks.map((t:any)=>[t.id,t])),byId=new Map(nodes.map(n=>[n.id,n])),membership=new Map(groups.flatMap(g=>g.taskIds.map(id=>[id,g.id] as const)));
  const immutable=['id','name','role','capability','behavior','target','duration','dependsOn','priority','deadline','materialCost','buildSite'];
  // Native JSON object order differs from JS normalization (e.g. material items).
  const encode=(v:any)=>JSON.stringify(v,(_k,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
  if(scene.tasks.some((t:any)=>!raw.has(t.id)||immutable.some(k=>encode(t[k])!==encode(raw.get(t.id)[k]))))return;
  const rows=groups.map(g=>{
   const tasks=g.taskIds.map(id=>byId.get(id));if(tasks.some(t=>!t))throw Error('missing displayed echelon task');const members=tasks as TaskNode[],incoming=new Set<string>(),participants=new Map<string,{id:string;name:string}>();
   for(const t of members){if(t.assignee)participants.set(t.assignee.id,{...t.assignee});for(const d of t.dependencies||[]){const group=membership.get(d.id);if(group&&group!==g.id)incoming.add(group)}}
   return {id:g.id,name:g.name,taskIds:g.taskIds.slice(),done:members.filter(t=>t.status==='done').length,active:members.filter(t=>['active','assigned'].includes(t.readiness)).length,ready:members.filter(t=>t.readiness==='ready').length,queued:members.filter(t=>t.readiness==='queued').length,incoming:groups.filter(p=>incoming.has(p.id)).map(p=>({id:p.id,name:p.name})),participants:[...participants.values()]};
  });
  return {groups:rows,unclassified:nodes.filter(n=>!membership.has(n.id)).map(n=>n.id)};
 }catch{return undefined}
}
