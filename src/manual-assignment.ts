/** Manual controls use the displayed snapshot for choices; the world admits commands. */
export type AssignmentTask={id:string;name:string;status:string;behavior?:string;capability?:string;dependsOn?:string[]};
export type AssignmentAgent={id:string;name:string;status:string;disabled:boolean;battery:number;deployableRelay?:boolean;capabilities?:string[]};
export type AssignmentContext={key:string;observer:boolean;imported:boolean;focused:boolean;latest:boolean;running:boolean;busy:boolean;done:boolean;failed:boolean;tasks:AssignmentTask[];agents:AssignmentAgent[]};
export type AssignmentResult={ok:boolean;reason?:string;refreshPending?:boolean};
export function assignmentBlock(c:AssignmentContext):string|null{
 if(c.observer)return 'read_only';if(c.imported)return 'imported_replay';if(c.focused)return 'agent_view';if(!c.latest)return 'history_view';if(c.failed)return 'session_stopped';if(c.done)return 'world_finished';if(c.running)return 'pause_required';if(c.busy)return 'busy';return null;
}
export function assignmentTasks(tasks:AssignmentTask[]):AssignmentTask[]{return tasks.filter(t=>t.status==='pending'&&(t.dependsOn||[]).every(id=>tasks.some(d=>d.id===id&&d.status==='done')))}
export function assignmentAgents(agents:AssignmentAgent[],task:AssignmentTask|undefined):AssignmentAgent[]{return task?.capability?agents.filter(a=>!a.disabled&&a.status==='idle'&&a.battery>5&&a.capabilities?.includes(task.capability!)&&(task.behavior!=='deploy'||a.deployableRelay===true)):[]}
/** Keep an explicit selection empty when it becomes stale; never silently pick another. */
export function assignmentSelection(c:AssignmentContext,taskId:string,agentId:string){const tasks=assignmentTasks(c.tasks),task=taskId?tasks.find(t=>t.id===taskId):tasks[0],agents=assignmentAgents(c.agents,task),agent=agentId?agents.find(a=>a.id===agentId):agents[0];return {tasks,task,agents,agent}}
const messages:Record<string,string>=Object.assign(Object.create(null),{read_only:'当前为只读观察，不能分配任务。',imported_replay:'导入回放不可修改，请返回新的运行后操作。',agent_view:'请返回全局视图后分配任务。',history_view:'当前显示历史快照，请返回实时视图。',session_stopped:'当前会话无法继续控制，请重新连接后操作。',world_finished:'本次运行已结束，请重新开始后分配任务。',pause_required:'请先暂停世界，再分配任务。',busy:'正在处理其他操作，请稍候。',selection_changed:'任务或设备状态已变化，请重新选择。',context_changed:'运行已切换，本次结果不用于当前运行。',world_step_failed:'世界执行失败，已保留最后提交状态，请重新连接后检查。',unknown_task:'该任务已不在当前运行中，请重新选择。',unknown_agent:'该设备已不在当前运行中，请重新选择。',task_not_ready:'任务已被分配，或前置任务尚未完成，请查看最新状态。',agent_unavailable:'设备当前不可用，请选择其他设备。',low_battery:'设备电量不足，请先补能或选择其他设备。',missing_capability:'设备缺少该任务所需能力。',part_unavailable:'备件当前不可用，请检查资源状态。',materials_unavailable:'耗材不足或已被其他任务预留，请检查任务耗材库存。',anomaly_unconfirmed:'请先确认设施故障，再分配维修任务。',repair_required:'设施尚未修复，暂时不能复核。',unreachable_target:'当前路线不可达，请检查道路、风险区域和备件位置。',unauthorized:'管理员凭据已失效，请重新连接。',forbidden:'当前凭据没有分配权限，请使用管理员会话。'});
export function assignmentMessage(reason?:string):string{return messages[reason||'']||'分配结果未确认，请检查最新状态后再操作。'}
type AssignmentEnvironment={read:()=>AssignmentContext;setBusy:(busy:boolean)=>void;assign:(taskId:string,agentId:string)=>AssignmentResult|Promise<AssignmentResult>;refresh:()=>void|Promise<void>;onError?:(error:unknown)=>void};
export function createAssignmentController(env:AssignmentEnvironment){
 let pending=false;
 return async function submit(key:string,taskId:string,agentId:string):Promise<AssignmentResult>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};
  const block=assignmentBlock(c);if(block)return {ok:false,reason:block};if(pending)return {ok:false,reason:'busy'};
  const task=assignmentTasks(c.tasks).find(t=>t.id===taskId);if(!task||!assignmentAgents(c.agents,task).some(a=>a.id===agentId))return {ok:false,reason:'selection_changed'};
  const current=()=>env.read().key===key;pending=true;
  try{
   env.setBusy(true);
   const result=await env.assign(taskId,agentId);if(!current())return {ok:false,reason:'context_changed'};
   if(!result.ok)return result;
   try{await env.refresh()}catch(error){if(current())env.onError?.(error);return current()?{ok:true,refreshPending:true}:{ok:false,reason:'context_changed'}}
   return current()?{ok:true}:{ok:false,reason:'context_changed'};
  }catch(error){
   if(!current())return {ok:false,reason:'context_changed'};
   const e=error as {message?:string;status?:number};if(e.status!==409&&e.status!==400)env.onError?.(error);
   if(!current())return {ok:false,reason:'context_changed'};
   // Refresh a rejected/stale choice, without retrying the mutation.
   try{await env.refresh()}catch(refreshError){if(current())env.onError?.(refreshError)}
   return current()?{ok:false,reason:messages[e.message||'']?e.message:'request_failed'}:{ok:false,reason:'context_changed'};
  }finally{pending=false;if(current())env.setBusy(false)}
 };
}
