import type {CoordinatorMeta} from './task-coordination';
import {coordinatorCommand} from './coordinator-credentials';
import {describe as describeControlEvents} from '@42tr/3dbox4agent-world/control-events';

export type NodeRecord={kind:'decision'|'proposal'|'revocation';requestId:string;nodeKey:string;taskId:string;taskName:string;agentId?:string;status:string;tick:number};
export type CommandNode={key:string;id:string|null;name:string;accepted:number;pending:number;rejected:number;proposals:number;revocations:number;lastTick:number;active:{id:string;name:string;agentId:string;assignmentId:number}[]};
export type NodeView={kind:'global'|'scoped';tick:number;nodes:CommandNode[];records:NodeRecord[];omittedNodes:number;omittedRecords:number;unattributedActive:number;management?:{text:string}|{invalid:true}};
const named=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const list=(v:any):any[]=>Array.isArray(v)?v:[];
const nodeKey=(id:unknown)=>named(id)?'named:'+id:'unnamed';
/** Provenance in the displayed snapshot, never a process-health or credential claim. */
export function projectCommandNodes(world:any,selected='global',report?:unknown,revision:number|null=null):NodeView{
 const empty:NodeView={kind:selected==='global'?'global':'scoped',tick:world.tick,nodes:[],records:[],omittedNodes:0,omittedRecords:0,unattributedActive:0};
 if(selected!=='global')return empty;
 try{const text=describeControlEvents(report,world.tick,revision);if(text)empty.management={text}}catch{empty.management={invalid:true}}
 const tasks=list(world.tasks),taskNames=new Map(tasks.map(t=>[t.id,t.name])),records:NodeRecord[]=[],nodes=new Map<string,CommandNode>();
 for(const [kind,rows]of [['decision',world.decisions],['proposal',world.proposals],['revocation',world.revocations]]as const)for(const r of list(rows)){
  if(kind==='decision'&&r.actor!=='external')continue;
  const tick=r.appliedTick??r.submittedTick??r.observedTick;
  if(!integer(tick)||tick>world.tick||!['accepted','pending','rejected','failed'].includes(r.status)||typeof r.requestId!=='string')continue;
  const key=nodeKey(r.coordinatorId),taskId=r.taskId||r.task?.id||'',id=named(r.coordinatorId)?r.coordinatorId:null;
  const record:NodeRecord={kind,requestId:r.requestId,nodeKey:key,taskId,taskName:r.task?.name||taskNames.get(taskId)||taskId,...(typeof r.agentId==='string'?{agentId:r.agentId}:{}),status:r.status,tick};records.push(record);
  let n=nodes.get(key);if(!n){n={key,id,name:id||'未命名指挥入口',accepted:0,pending:0,rejected:0,proposals:0,revocations:0,lastTick:tick,active:[]};nodes.set(key,n)}
  n.lastTick=Math.max(n.lastTick,tick);if(kind==='decision'){if(r.status==='accepted')n.accepted++;else if(r.status==='pending')n.pending++;else n.rejected++}else if(kind==='proposal')n.proposals++;else n.revocations++;
 }
 const events=list(world.events).filter(e=>integer(e.tick)&&e.tick<=world.tick),decisions=new Map(records.filter(r=>r.kind==='decision'&&r.status==='accepted').map(r=>[r.requestId,r]));
 let unattributedActive=0;
 for(const t of tasks.filter(t=>t.status==='active')){
  // An accepted decision lacks assignmentId. Bind through the exact assignment
  // event and its immediately following acceptance, so an older same-tick lease
  // cannot claim a later manual/replanned assignment to the same device.
  const index=events.findIndex(e=>e.kind==='task_assigned'&&e.taskId===t.id&&e.agentId===t.assignee&&e.assignmentId===t.assignmentId),assignment=events[index],receipt=events[index+1],record=receipt&&decisions.get(receipt.requestId);
  const matches=index>=0&&receipt?.kind==='decision_accepted'&&receipt.actor==='external'&&receipt.tick===assignment.tick&&receipt.taskId===t.id&&receipt.agentId===t.assignee&&record?.nodeKey===nodeKey(receipt.coordinatorId)&&record.taskId===t.id&&record.agentId===t.assignee;
  if(matches)nodes.get(record!.nodeKey)!.active.push({id:t.id,name:t.name,agentId:t.assignee,assignmentId:t.assignmentId});else unattributedActive++;
 }
 const sorted=[...nodes.values()].sort((a,b)=>b.lastTick-a.lastTick||a.key.localeCompare(b.key)),recent=records.sort((a,b)=>b.tick-a.tick||a.nodeKey.localeCompare(b.nodeKey)||a.requestId.localeCompare(b.requestId));
 return {...empty,nodes:sorted.slice(0,32),records:recent.slice(0,100),omittedNodes:Math.max(0,sorted.length-32),omittedRecords:Math.max(0,recent.length-100),unattributedActive};
}

export type CoordinatorRoster={version:1;sessionId:string;rosterRevision:number;worldRevision:number;tick:number;legacyCredentialActive:boolean;named:{id:string}[]};
const keys=(v:any,allowed:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k));
export function parseCoordinatorRoster(value:any,sessionId:string):CoordinatorRoster|null{
 if(!keys(value,['version','sessionId','rosterRevision','worldRevision','tick','legacyCredentialActive','named'])||value.version!==1||value.sessionId!==sessionId||!integer(value.rosterRevision)||!integer(value.worldRevision)||!integer(value.tick)||typeof value.legacyCredentialActive!=='boolean'||!Array.isArray(value.named)||value.named.length>16||value.named.some((n:any)=>!keys(n,['id'])||!named(n.id))||new Set(value.named.map((n:any)=>n.id)).size!==value.named.length)return null;
 return {version:1,sessionId,rosterRevision:value.rosterRevision,worldRevision:value.worldRevision,tick:value.tick,legacyCredentialActive:value.legacyCredentialActive,named:value.named.map((n:any)=>({id:n.id}))};
}
export const nodeRegistryBlock=(c:CoordinatorMeta,write=false)=>c.observer?'read_only':c.focused?'agent_view':c.imported?'imported_replay':!c.latest?'history_view':c.failed?'session_stopped':!c.remote||!c.connection?'needs_service':write&&c.done?'world_finished':c.busy?'busy':null;
export type RegistryOperation={kind:'read'}|{kind:'issue';id:string;rosterRevision:number;shardCount:number;shardIndex:number}|{kind:'revoke';id:string;rosterRevision:number};
export type RegistryResult={ok:boolean;reason?:string;roster?:CoordinatorRoster;command?:string;changedId?:string};
type Environment={read:()=>CoordinatorMeta;setBusy:(v:boolean)=>void;request:(method:'GET'|'POST'|'DELETE',id?:string,input?:object)=>Promise<any>;onError?:(e:unknown)=>void};
export function createNodeRegistryController(env:Environment){
 const pending=new Set<string>();return async(key:string,op:RegistryOperation):Promise<RegistryResult>=>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};const block=nodeRegistryBlock(c,op.kind!=='read');if(block||pending.has(key))return {ok:false,reason:block||'busy'};
  if(op.kind!=='read'&&(!named(op.id)||!integer(op.rosterRevision)))return {ok:false,reason:'invalid_node'};
  if(op.kind==='issue'&&(!Number.isInteger(op.shardCount)||op.shardCount<1||op.shardCount>16||!Number.isInteger(op.shardIndex)||op.shardIndex<0||op.shardIndex>=op.shardCount))return {ok:false,reason:'invalid_shard'};
  const connection={...c.connection!};if(!coordinatorCommand(connection,'a'.repeat(43)))return {ok:false,reason:'invalid_response'};
  const same=()=>{const now=env.read();return now.key===key&&now.connection?.origin===connection.origin&&now.connection?.sessionId===connection.sessionId&&!nodeRegistryBlock({...now,busy:false},op.kind!=='read')};pending.add(key);
  try{
   env.setBusy(true);const response=await env.request(op.kind==='read'?'GET':op.kind==='issue'?'POST':'DELETE',op.kind==='read'?undefined:op.id,op.kind==='read'?undefined:{expectedRosterRevision:op.rosterRevision});if(!same())return {ok:false,reason:'context_changed'};
   if(op.kind==='read'){const roster=parseCoordinatorRoster(response,connection.sessionId);return roster?{ok:true,roster}:{ok:false,reason:'invalid_response'}}
   if(response?.coordinatorId!==op.id||response?.rosterRevision!==op.rosterRevision+1)return {ok:false,reason:'invalid_response'};
   if(op.kind==='revoke')return response.revoked===true?{ok:true,changedId:op.id}:{ok:false,reason:'invalid_response'};
   const command=coordinatorCommand(connection,response.coordinatorToken);return command?{ok:true,changedId:op.id,command:command+' --shard-count '+op.shardCount+' --shard-index '+op.shardIndex}:{ok:false,reason:'invalid_response'};
  }catch(e){if(!same())return {ok:false,reason:'context_changed'};const error=e as {status?:number;message?:string};if(![400,404,409].includes(error.status||0))env.onError?.(e);return {ok:false,reason:error.status===409&&error.message==='coordinator_roster_changed'?'roster_changed':error.status===404?'node_not_found':'request_failed'}}finally{pending.delete(key);if(env.read().key===key)env.setBusy(false)}
 };
}
const messages:Record<string,string>={read_only:'只读观察不提供凭据管理。',agent_view:'返回全局视图后查看指挥节点。',imported_replay:'导入回放仅展示快照记录。',history_view:'历史快照不读取当前凭据；返回实时视图后刷新名单。',session_stopped:'服务会话已停止。',needs_service:'连接本地世界服务后可读取当前凭据名单。',world_finished:'运行已经结束。',busy:'正在处理请求。',context_changed:'显示范围或会话已改变，请重新操作。',invalid_node:'节点标识需为1–40位字母、数字、下划线或短横线。',invalid_shard:'分片数需为1–16，索引从0开始且小于分片数。',roster_changed:'凭据名单已改变，请先刷新再操作。',node_not_found:'节点或服务接口不存在，请刷新名单并核对服务版本。',invalid_response:'响应未通过校验，请刷新名单核对结果。',request_failed:'请求结果未确认，请刷新名单核对后再操作。'};
export const nodeRegistryMessage=(reason?:string)=>Object.prototype.hasOwnProperty.call(messages,reason||'')?messages[reason!]:messages.request_failed;
