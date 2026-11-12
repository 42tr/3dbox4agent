import {coordinatorBlock,coordinatorMessage,type CoordinatorContext,type CoordinatorDraft,type CoordinatorResult} from './task-coordination';

export type PlanRow={id:number;taskId:string;taskName:string;agentId:string;agentName:string;target?:[number,number];capability?:string;priority?:number;deadline?:number;reportAge?:number;stage:'draft'|'reviewed'|'submitting'|'accepted'|'pending'|'rejected'|'failed'|'unknown'|'blocked'|'skipped';requestId?:string;reason?:string;currentStatus?:string};
export type PlanView={key:string;id:string;version:number;phase:'draft'|'reviewed'|'submitting'|'submitted'|'stopped';rows:PlanRow[];review?:{tick:number;worldRevision:number;mode:string;executionMode:string};reviewValid:boolean;stopRequested:boolean;notice?:string};
type State=PlanView&{signature?:string};
export type PlanOperation={kind:'add';taskId:string;agentId:string}|{kind:'remove';rowId:number}|{kind:'review'}|{kind:'confirm';planId:string;version:number}|{kind:'stop';planId:string}|{kind:'discard'};
export type PlanResult={ok:boolean;reason?:string};
export const planBlock=(c:CoordinatorContext)=>coordinatorBlock(c)||(c.remote&&c.decisionPreconditions!==true?'unsupported_service':c.running!==false?'pause_required':!Number.isSafeInteger(c.revision)||(c.revision??-1)<0?'invalid_revision':null);
const initial=(key:string):State=>({key,id:'',version:0,phase:'draft',rows:[],reviewValid:false,stopRequested:false});
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
function choice(c:CoordinatorContext,taskId:string,agentId:string){const task=c.tasks.find(t=>t.id===taskId),agent=task?.candidates.find(a=>a.id===agentId);return task&&agent?{task,agent}:null}
function row(c:CoordinatorContext,taskId:string,agentId:string,id:number):PlanRow|null{
 const found=choice(c,taskId,agentId);if(!found)return null;const {task,agent}=found;
 return {id,taskId,taskName:task.name,agentId,agentName:agent.name,stage:'draft',...(task.target?{target:[...task.target] as [number,number]}:{}),...(task.capability?{capability:task.capability}:{}),...(task.priority!==undefined?{priority:task.priority}:{}),...(task.deadline!==undefined?{deadline:task.deadline}:{}),...(agent.age!==undefined?{reportAge:agent.age}:{})};
}
function stamp(c:CoordinatorContext,rows:PlanRow[]){return JSON.stringify({key:c.key,revision:c.revision,tick:c.tick,mode:c.mode,executionMode:c.executionMode,remote:c.remote,connection:c.connection||null,rows:rows.map(r=>row(c,r.taskId,r.agentId,r.id))})}
type Environment={read:()=>CoordinatorContext;setPending:(key:string,value:boolean)=>void;changed:()=>void;submit:(key:string,draft:CoordinatorDraft)=>Promise<CoordinatorResult>};
/** Local review is not a world transaction. Only the protocol submit callback writes. */
export function createPlanReviewController(env:Environment){
 let state:State|null=null,serial=0,rowSerial=0;const pending=new Set<string>();
 const notify=(s:State)=>{if(state===s&&env.read().key===s.key)env.changed()};
 function view(c:CoordinatorContext):PlanView{
  if(c.observer||c.focused||c.imported||!c.latest)return initial(c.key);
  const s=state?.key===c.key?state:initial(c.key),copy=clone(s);delete (copy as Partial<State>).signature;
  copy.reviewValid=s.phase==='reviewed'&&!planBlock(c)&&s.signature===stamp(c,s.rows);
  for(const r of copy.rows){if(!r.requestId)continue;const current=c.records.find(x=>x.kind==='decision'&&x.requestId===r.requestId&&x.taskId===r.taskId&&x.agentId===r.agentId);if(current)r.currentStatus=current.status}
  return copy;
 }
 async function act(key:string,op:PlanOperation):Promise<PlanResult>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};
  if(op.kind==='stop'){
   const s=state;if(!s||s.key!==key||s.id!==op.planId||!pending.has(key))return {ok:false,reason:'plan_changed'};
   const blocked=coordinatorBlock({...c,busy:false});if(blocked)return {ok:false,reason:blocked};s.stopRequested=true;s.notice='stop_requested';notify(s);return {ok:true};
  }
  if(op.kind==='discard'){
   const hidden=c.observer?'read_only':c.focused?'agent_view':c.imported?'imported_replay':!c.latest?'history_view':null;
   if(hidden||pending.has(key))return {ok:false,reason:hidden||'busy'};state=null;env.changed();return {ok:true};
  }
  const block=planBlock(c);if(block||pending.has(key))return {ok:false,reason:block||'busy'};
  let s=state?.key===key?state:null;
  if(!s){if(op.kind!=='add')return {ok:false,reason:'empty_plan'};s={...initial(key),id:'local-plan-'+(++serial)};state=s}
  if(s.phase==='submitted'||s.phase==='stopped')return {ok:false,reason:'clear_required'};
  if(op.kind==='add'){
   if(s.rows.length>=8)return {ok:false,reason:'plan_limit'};
   if(s.rows.some(r=>r.taskId===op.taskId))return {ok:false,reason:'duplicate_task'};if(s.rows.some(r=>r.agentId===op.agentId))return {ok:false,reason:'duplicate_agent'};
   const next=row(c,op.taskId,op.agentId,++rowSerial);if(!next)return {ok:false,reason:'selection_changed'};
   s.rows.push(next);s.phase='draft';delete s.review;delete s.signature;s.version++;s.rows.forEach(r=>r.stage='draft');notify(s);return {ok:true};
  }
  if(op.kind==='remove'){
   if(!s.rows.some(r=>r.id===op.rowId))return {ok:false,reason:'plan_changed'};s.rows=s.rows.filter(r=>r.id!==op.rowId);s.phase='draft';delete s.review;delete s.signature;s.version++;s.rows.forEach(r=>r.stage='draft');notify(s);return {ok:true};
  }
  if(!s.rows.length)return {ok:false,reason:'empty_plan'};
  if(op.kind==='review'){
   const refreshed=s.rows.map(r=>row(c,r.taskId,r.agentId,r.id));if(refreshed.some(r=>!r))return {ok:false,reason:'selection_changed'};
   s.rows=refreshed as PlanRow[];s.rows.forEach(r=>r.stage='reviewed');s.review={tick:c.tick,worldRevision:c.revision!,mode:c.mode,executionMode:c.executionMode};s.signature=stamp(c,s.rows);s.phase='reviewed';s.version++;s.notice=undefined;notify(s);return {ok:true};
  }
  if(op.kind!=='confirm'||s.phase!=='reviewed'||s.id!==op.planId||s.version!==op.version)return {ok:false,reason:'plan_changed'};
  if(s.signature!==stamp(c,s.rows))return {ok:false,reason:'review_stale'};
  const approved=s.review!,identity=JSON.stringify({remote:c.remote,connection:c.connection||null});let expectedRevision=c.revision!;
  pending.add(key);s.phase='submitting';s.stopRequested=false;s.version++;
  const stop=(reason:string,start:number)=>{s!.phase='stopped';s!.notice=reason;for(const r of s!.rows.slice(start))if(r.stage==='reviewed'){r.stage='skipped';r.reason=reason}};
  try{
   env.setPending(key,true);notify(s);
   for(let i=0;i<s.rows.length;i++){
    const now=env.read();if(s.stopRequested){stop('stop_requested',i);break}
    const blocked=planBlock(now);if(now.key!==key||blocked){stop(now.key!==key?'context_changed':blocked!,i);break}
    if(now.tick!==approved.tick||now.mode!==approved.mode||now.executionMode!==approved.executionMode||now.revision!==expectedRevision||JSON.stringify({remote:now.remote,connection:now.connection||null})!==identity){stop('review_stale',i);break}
    const current=s.rows[i];if(!choice(now,current.taskId,current.agentId)){stop('selection_changed',i);break}
    current.stage='submitting';notify(s);let result:CoordinatorResult,threw=false;
    try{result=await env.submit(key,{kind:'decision',taskId:current.taskId,agentId:current.agentId})}catch{threw=true;result={ok:false,reason:'request_failed'}}
    if(result.requestId&&/^[A-Za-z0-9_-]{1,64}$/.test(result.requestId))current.requestId=result.requestId;
    const valid=current.requestId&&result.taskId===current.taskId&&['accepted','pending','rejected','failed'].includes(result.status||'');
    current.stage=valid?result.status as PlanRow['stage']:result.requestRejected?'blocked':result.requestId||threw||result.ok?'unknown':'blocked';if(result.reason)current.reason=result.reason;
    if(!valid||!result.ok||result.refreshPending){stop(result.refreshPending?'refresh_required':result.reason||'request_failed',i+1);break}
    expectedRevision++;
    const after=env.read();if(after.key!==key||planBlock(after)||after.revision!==expectedRevision||after.tick!==approved.tick){stop(after.key!==key?'context_changed':'review_stale',i+1);break}
   }
   if(s.phase==='submitting')s.phase='submitted';notify(s);return s.phase==='submitted'?{ok:true}:{ok:false,reason:s.notice};
  }finally{pending.delete(key);env.setPending(key,false);notify(s)}
 }
 return {view,act};
}
const messages:Record<string,string>={unsupported_service:'当前服务未声明支持计划版本与暂停校验，请使用更新的本地服务。',pause_required:'请先暂停世界，再整理并确认计划。',invalid_revision:'尚无可核对的世界版本，请同步当前运行。',empty_plan:'请先选择任务与设备，加入草稿。',plan_limit:'每份计划最多8项当前可分配任务。',duplicate_task:'该任务已在草稿中。',duplicate_agent:'同一份计划中，一台设备只分配一项任务。',plan_changed:'草稿已变化，请重新查看当前计划。',review_stale:'世界或候选已变化，请重新审阅，确认后再提交。',clear_required:'这份计划已结束提交；核对记录并清除本地计划后，可新建草稿。',stop_requested:'已停止后续提交；当前请求与已发送指令仍需按记录核对。',refresh_required:'已有指令被接受，状态同步未完成；后续条目未发送。',request_failed:'本次提交结果未确认，后续条目未发送；请核对请求编号及世界记录。'};
export const planMessage=(reason?:string)=>Object.prototype.hasOwnProperty.call(messages,reason||'')?messages[reason!]:coordinatorMessage(reason);
