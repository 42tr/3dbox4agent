import {deviceBlock,type DeviceContext} from './device-actions';

export type ReportKind='scan'|'sample';
export type ReportSource={agentId:string;id:string;tick:number;label:string;position?:number[]};
export type DeviceReport={kind:ReportKind;id:number;agentId:string;requestId:string;sourceId:string;submittedTick:number;dueTick:number;expiresTick:number;status:string;appliedTick?:number;reason?:string};
export type ReportData={scans:ReportSource[];samples:ReportSource[];records:DeviceReport[]};
type RawReport=Omit<DeviceReport,'kind'|'sourceId'>;
type ReportObservation={self:{id:string};actions:{agentId:string;requestId:string;type:string;status:string;result?:{observedTick:number;kind:string;position?:number[]}}[];assignedTasks:{id:string;name:string}[];samples?:{taskId:string;position:number[];collectedTick:number}[];evidenceReports?:(RawReport&{scanRequestId:string})[];sampleReports?:(RawReport&{taskId:string})[]};
const scanLabels:Record<string,string>=Object.assign(Object.create(null),{anomaly:'发现异常',normal:'状态正常',not_detected:'未探测到目标'});
export function projectDeviceReports(o:ReportObservation|null|undefined,id:string):ReportData{
 if(!o||o.self.id!==id)return {scans:[],samples:[],records:[]};
 const records=(rows:RawReport[],kind:ReportKind)=>rows.filter(r=>r.agentId===id).map(r=>({kind,id:r.id,agentId:r.agentId,requestId:r.requestId,sourceId:kind==='scan'?(r as RawReport&{scanRequestId:string}).scanRequestId:(r as RawReport&{taskId:string}).taskId,submittedTick:r.submittedTick,dueTick:r.dueTick,expiresTick:r.expiresTick,status:r.status,...(r.appliedTick!==undefined?{appliedTick:r.appliedTick}:{}),...(r.reason?{reason:r.reason}:{})}));
 return {scans:o.actions.filter(a=>a.agentId===id&&a.type==='scan'&&a.status==='completed'&&a.result).map(a=>({agentId:a.agentId,id:a.requestId,tick:a.result!.observedTick,label:scanLabels[a.result!.kind]||'扫描完成',...(a.result!.position?{position:a.result!.position.slice()}:{} )})).reverse(),samples:(o.samples||[]).map(s=>({agentId:id,id:s.taskId,tick:s.collectedTick,label:o.assignedTasks.find(t=>t.id===s.taskId)?.name||s.taskId,position:s.position.slice()})).reverse(),records:[...records(o.evidenceReports||[],'scan'),...records(o.sampleReports||[],'sample')]};
}
export type ReportDraft={kind:ReportKind;sourceId:string};
export type ReportInput={requestId:string;scanRequestId:string}|{requestId:string;taskId:string};
export type ReportResult={ok:boolean;reason?:string;requestId?:string;refreshPending?:boolean};
export function reportSources(c:DeviceContext,kind:ReportKind):ReportSource[]{return (kind==='scan'?c.reports?.scans:c.reports?.samples)?.filter(s=>s.agentId===c.selected)||[]}
export function reportChoices(c:DeviceContext,kind:ReportKind):ReportSource[]{return reportSources(c,kind).filter(s=>!c.reports?.records.some(r=>r.agentId===c.selected&&r.kind===kind&&r.sourceId===s.id&&['pending','delivered'].includes(r.status)))}
export function reportBlock(c:DeviceContext):string|null{return deviceBlock(c)||(!c.agents.some(a=>a.id===c.selected)?'selection_changed':c.agents.find(a=>a.id===c.selected)?.disabled?'agent_unavailable':null)}
const messages:Record<string,string>=Object.assign(Object.create(null),{read_only:'当前为只读观察，不能提交设备报告。',imported_replay:'导入回放不能提交设备报告。',history_view:'当前为历史快照，请返回实时视图后上报。',session_stopped:'当前会话已停止，请重新连接后上报。',world_finished:'本次运行已结束，不能再提交报告。',busy:'正在处理其他操作，请稍候。',selection_changed:'所选设备已变化，请检查当前设备。',context_changed:'运行已切换，旧报告结果不用于当前运行。',source_unavailable:'该来源已在途、已送达或不再可用，请查看最新报告记录。',agent_unavailable:'设备当前不可用，不能上报。',invalid_report:'报告标识无效，请重新操作。',scan_not_available:'已完成扫描不再可用，请查看最新状态。',sample_not_available:'采集记录不再可用，请查看最新状态。',scan_already_reported:'该扫描已有在途或已送达报告。',sample_already_reported:'该采集已有在途或已送达报告。',request_id_conflict:'报告请求标识已被使用，请检查最新记录。',report_limit:'本次运行的设备报告已达上限。',evidence_limit:'本次运行的扫描报告已达上限。',sample_report_limit:'本次运行的采样报告已达上限。',invalid_evidence_request:'扫描来源或报告标识无效。',invalid_sample_report:'采集来源或报告标识无效。',unknown_agent:'设备已不在当前运行中。',unauthorized:'管理员凭据已失效，请重新连接。',forbidden:'当前凭据没有设备报告权限。'});
export function reportMessage(reason?:string):string{return messages[reason||'']||'报告结果尚未确认，请检查最新报告记录后操作。'}
const reasons:Record<string,string>=Object.assign(Object.create(null),{expired:'超过有效期',unavailable:'设备不可用',interrupted:'通信中断',dropped:'链路丢包',run_ended:'运行结束'});
export function reportReason(reason:string):string{return reasons[reason]||'具体原因请查看事件记录'}
type Environment={read:()=>DeviceContext;id:()=>string;setBusy:(value:boolean)=>void;send:(agentId:string,kind:ReportKind,input:ReportInput)=>{ok:boolean;reason?:string}|Promise<{ok:boolean;reason?:string}>;refresh:()=>void|Promise<void>;onError?:(error:unknown)=>void};
export function createDeviceReportController(env:Environment){
 const pending=new Set<string>();
 return async function submit(key:string,agentId:string,draft:ReportDraft):Promise<ReportResult>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};const block=reportBlock(c);if(block)return {ok:false,reason:block};if(pending.has(key))return {ok:false,reason:'busy'};
  if(c.selected!==agentId)return {ok:false,reason:'selection_changed'};
  if(!draft||!['scan','sample'].includes(draft.kind))return {ok:false,reason:'invalid_report'};
  if(!reportChoices(c,draft.kind).some(s=>s.id===draft.sourceId))return {ok:false,reason:'source_unavailable'};
  const requestId=env.id();if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(requestId))return {ok:false,reason:'invalid_report'};
  const input:ReportInput=draft.kind==='scan'?{requestId,scanRequestId:draft.sourceId}:{requestId,taskId:draft.sourceId},current=()=>env.read().key===key;
  pending.add(key);
  try{
   env.setBusy(true);const result=await env.send(agentId,draft.kind,input);if(!current())return {ok:false,reason:'context_changed'};
   if(!result.ok){try{await env.refresh()}catch(error){if(current())env.onError?.(error)}return current()?{ok:false,reason:result.reason,requestId}:{ok:false,reason:'context_changed'}}
   try{await env.refresh()}catch(error){if(current())env.onError?.(error);return current()?{ok:true,requestId,refreshPending:true}:{ok:false,reason:'context_changed'}}
   return current()?{ok:true,requestId}:{ok:false,reason:'context_changed'};
  }catch(error){
   if(!current())return {ok:false,reason:'context_changed'};const e=error as {status?:number;message?:string};if(e.status!==400&&e.status!==409)env.onError?.(error);if(!current())return {ok:false,reason:'context_changed'};
   try{await env.refresh()}catch(refreshError){if(current())env.onError?.(refreshError)}return current()?{ok:false,reason:messages[e.message||'']?e.message:'request_failed',requestId}:{ok:false,reason:'context_changed'};
  }finally{pending.delete(key);if(current())env.setBusy(false)}
 };
}
