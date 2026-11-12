import * as Construction from '@42tr/3dbox4agent-world/construction';
export type ConstructionRow={id:string;name:string;obstacleId:string;taskId:string;state:'planned'|'travel'|'building'|'waiting'|'built';progress:number;worker:{id:string;name:string}|null;builtTick:number|null;cost:string};
export type ConstructionView={kind:'global'|'unavailable';tick:number;total:number;built:number;sites:ConstructionRow[]};
/** Global facility state is never read to fill an individual device view. */
export function projectConstruction(world:any,selected='global'):ConstructionView|null{
 if(selected!=='global')return null;
 const raw=world.construction;if(raw===undefined)return null;
 const base:ConstructionView={kind:'unavailable',tick:world.tick,total:0,built:0,sites:[]};
 try{Construction.validateWorld(world)}catch{return base}
 const sites:ConstructionRow[]=raw.sites.map((s:any)=>{const task=world.tasks.find((t:any)=>t.behavior==='build'&&t.buildSite===s.id),a=task.assignee?world.agents.find((a:any)=>a.id===task.assignee):null,built=s.status==='built',active=task.status==='active'&&a&&!a.disabled,state=built?'built':active?(a.status==='assigned'||a.roadblockWait?'waiting':a.route.length?'travel':'building'):'planned';return {id:s.id,name:s.name,obstacleId:s.obstacleId,taskId:task.id,state,progress:built?1:active&&Number.isFinite(a.work)&&task.duration>0?Math.max(0,Math.min(1,a.work/task.duration)):0,worker:a?{id:a.id,name:a.name}:null,builtTick:built?s.builtTick:null,cost:(task.materialCost||[]).map((i:any)=>(world.materials?.stock.find((r:any)=>r.id===i.id)?.name||i.id)+' ×'+i.amount).join(' · ')}});
 return {...base,kind:'global',total:sites.length,built:sites.filter(s=>s.state==='built').length,sites};
}
