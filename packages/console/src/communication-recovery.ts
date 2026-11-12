/** Evidence retained in the displayed global snapshot, not a live-link health claim. */
export type RecoveryActions={move:number;work_task:number;execute_task:number;charge:number;scan:number;rescue:number};
export type RecoveryRow={key:string;agentId:string;startedTick:number;untilTick:number;restoredTick:number|null;completedActions:RecoveryActions;completed:number;report:null|{capturedTick:number;receivedTick:number;stale:boolean|null};unavailableNow:boolean|null};
export type CommunicationRecoveryView={tick:number;available:boolean;finished:boolean;reportingActive:boolean;total:number;rows:RecoveryRow[]};
const time=(n:any):n is number=>Number.isSafeInteger(n)&&n>=0&&n<=10001000;
const id=(n:any):n is string=>typeof n==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(n)&&!['__proto__','constructor','prototype'].includes(n);
const actionTypes=['move','work_task','execute_task','charge','scan','rescue'] as const;
export function projectCommunicationRecovery(world:any,selected='global'):CommunicationRecoveryView|null{
 // A device observation does not carry the global interruption/event history.
 if(selected!=='global')return null;
 const tick=time(world?.tick)?world.tick:0,base:CommunicationRecoveryView={tick,available:false,finished:world?.done===true,reportingActive:world?.dispatchMode==='networked_reported',total:0,rows:[]};
 if(!Array.isArray(world?.events))return null;
 if(!world.events.some((e:any)=>e?.kind==='communication_interrupted'))return null;
 if(!time(world.tick)||!Array.isArray(world.agents)||!Array.isArray(world.actions))return base;
 const agents=new Map<string,any>();for(const a of world.agents){if(!id(a?.id)||agents.has(a.id))return base;agents.set(a.id,a)}
 const pending=new Map<string,RecoveryRow>(),rows:RecoveryRow[]=[];let previousSeq=0,previousTick=0,total=0;
 for(const e of world.events){
  if(e?.kind!=='communication_interrupted'&&e?.kind!=='communication_restored')continue;
  if(!id(e.agentId)||!agents.has(e.agentId)||!time(e.tick)||e.tick>tick||!time(e.seq)||e.seq<=previousSeq||e.tick<previousTick)return base;
  previousSeq=e.seq;previousTick=e.tick;
  if(e.kind==='communication_interrupted'){
   if(!time(e.untilTick)||e.untilTick<=e.tick||e.untilTick-e.tick>1000||pending.has(e.agentId))return base;
   const row:RecoveryRow={key:e.agentId+':'+e.seq,agentId:e.agentId,startedTick:e.tick,untilTick:e.untilTick,restoredTick:null,completedActions:{move:0,work_task:0,execute_task:0,charge:0,scan:0,rescue:0},completed:0,report:null,unavailableNow:typeof agents.get(e.agentId).disabled==='boolean'?agents.get(e.agentId).disabled:null};pending.set(e.agentId,row);rows.push(row);total++;if(rows.length>20)rows.shift();
  }else{
   const row=pending.get(e.agentId);if(!row||e.tick<=row.untilTick)return base;row.restoredTick=e.tick;pending.delete(e.agentId);
  }
 }
 const reporting=world.communication?.reporting;
 for(let i=0;i<rows.length;i++){
  const row=rows[i],end=Math.min(tick,row.untilTick),next=rows.slice(i+1).find(r=>r.agentId===row.agentId),seen=new Set<string>();
  for(const a of world.actions){
   if(a?.agentId!==row.agentId||a.status!=='completed'||!actionTypes.includes(a.type))continue;
   if(!id(a.requestId)||!time(a.submittedTick)||!time(a.updatedTick)||a.submittedTick>a.updatedTick||a.updatedTick>tick||seen.has(a.requestId))return base;seen.add(a.requestId);
   // Completion earlier in the same tick preceded the administrative outage.
   if(a.updatedTick>row.startedTick&&a.updatedTick<=end){row.completedActions[a.type as keyof RecoveryActions]++;row.completed++}
  }
  const p=reporting?.reports?.[row.agentId];
  // Only a post-restoration sample received before a later interruption proves
  // this episode. A cached receipt from another episode must not fill the gap.
  if(row.restoredTick!==null&&p?.id===row.agentId&&time(p.capturedTick)&&time(p.receivedTick)&&p.capturedTick>=row.restoredTick&&p.capturedTick<=p.receivedTick&&p.receivedTick<=tick&&(!next||p.receivedTick<=next.startedTick))row.report={capturedTick:p.capturedTick,receivedTick:p.receivedTick,stale:time(reporting.maxAge)&&reporting.maxAge>0?tick-p.capturedTick>reporting.maxAge:null};
 }
 return {...base,available:true,total,rows:rows.reverse()};
}
