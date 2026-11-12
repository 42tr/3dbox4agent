export type MaterialRow={id:string;name:string;initial:number;remaining:number;reserved:number;available:number;consumed:number};
export type MaterialLease={taskId:string;assignmentId:number;items:{id:string;name:string;amount:number}[]};
export type MaterialView={kind:'global'|'own'|'unavailable';tick:number;scope:string|null;rows:MaterialRow[];leases:MaterialLease[]};
const count=(x:any)=>Number.isSafeInteger(x)&&x>=0&&x<=1000000;
const id=(x:any)=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x)&&!['__proto__','constructor','prototype'].includes(x);
const label=(x:any)=>typeof x==='string'&&x.length>0&&x.length<=100;
/** Reads only the selected snapshot. Device scope never touches global stock. */
export function projectMaterials(world:any,observation:any,selected='global'):MaterialView|null{
 const scope=selected==='global'?null:selected,base:MaterialView={kind:'unavailable',tick:world.tick,scope,rows:[],leases:[]};
 if(scope){
  if(observation?.tick!==world.tick||observation.self?.id!==scope)return base;
  const leases=observation.self.materialReservations;if(leases===undefined)return null;
  if(!Array.isArray(leases)||leases.length>1)return base;
  const own:MaterialLease[]=[];for(const r of leases){if(!id(r?.taskId)||!Number.isSafeInteger(r.assignmentId)||r.assignmentId<1||!Array.isArray(r.items)||!r.items.length||r.items.length>8||r.items.some((i:any)=>!id(i?.id)||!label(i.name)||!count(i.amount)||i.amount<1)||new Set(r.items.map((i:any)=>i.id)).size!==r.items.length||!(Array.isArray(observation.assignedTasks)&&observation.assignedTasks.some((t:any)=>t?.id===r.taskId&&t.status==='active')))return base;own.push({taskId:r.taskId,assignmentId:r.assignmentId,items:r.items.map((i:any)=>({id:i.id,name:i.name,amount:i.amount}))})}
  return {...base,kind:'own',leases:own};
 }
 const state=world.materials;if(state===undefined)return null;if(!state||!Array.isArray(state.stock)||!state.stock.length||state.stock.length>8||!Array.isArray(state.reservations)||state.reservations.length>100||new Set(state.stock.map((s:any)=>s?.id)).size!==state.stock.length)return base;
 const held=new Map<string,number>();for(const r of state.reservations){if(!Array.isArray(r?.items)||!r.items.length||r.items.length>8)return base;for(const i of r.items){if(!id(i?.id)||!count(i.amount)||i.amount<1||!state.stock.some((s:any)=>s.id===i.id))return base;held.set(i.id,(held.get(i.id)||0)+i.amount)}}
 const rows:MaterialRow[]=[];for(const r of state.stock){const reserved=held.get(r?.id)||0;if(!id(r?.id)||!label(r.name)||!count(r.initial)||!count(r.remaining)||r.remaining>r.initial||reserved>r.remaining)return base;rows.push({id:r.id,name:r.name,initial:r.initial,remaining:r.remaining,reserved,available:r.remaining-reserved,consumed:r.initial-r.remaining})}
 return {...base,kind:'global',rows};
}
