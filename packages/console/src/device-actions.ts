import type {DeviceConnection} from './device-credentials';
import type {ReportData} from './device-reports';
/** User intentions are queued; only the world decides execution outcomes. */
export type RescueContact={faultGeneration:number;id:string;role:string;x:number;y:number;observedTick:number};
export type Device={flightZ?:number;maxSpeedMPerTick?:number;operatingEnergyPerTick?:number;operatingState?:{energySpent:number;tick:number};rescueWorkTicks?:number;capabilities?:string[];id:string;name:string;x:number;y:number;battery:number;disabled:boolean;status:string;mobility?:string};
export type WorkOperation={operation:string;label:string;durationTicks:number;completed:string|null;reason:string|null};
export const workLabels:Record<string,string>={dock_pickup:'取货对接',load:'装货',dock_delivery:'卸货对接',unload:'卸货',handoff:'交接',
 diagnose:'现场诊断',remove:'拆卸故障部件',install:'安装备件',self_test:'维修自检',collect_sample:'定点采样'};
export type DeviceTask={id:string;name:string;status:string;capability?:string;behavior?:string;assignee?:string;waypoint?:number[]|null;approachPoint?:number[]|null;withinReach?:boolean;workOperation?:WorkOperation};
export type FlightOperation='takeoff'|'land'|'hover';
export type FlightControlInput={mode:'takeoff';heightM:number}|{mode:'land';x:number;y:number}|{mode:'hover';durationTicks:number};
type FlightControlDraft={mode:'takeoff';heightM:string}|{mode:'land';x:string;y:string}|{mode:'hover';durationTicks:string};
type Range={minimum:number;maximum:number};
export type FlightLimits={altitudeRange:Range;minimumDeltaM:number;ascendM:number;descendM:number;state:'airborne'|'low_altitude'|'landed';takeoffHeight:Range&{default:number};hoverDuration:Range};
type SurveyMark={mode:'mark_access_point';scanRequestId:string;pointIndex:number};
type SurveyInput={mode:'terrain_scan';bearingDeg:number;radiusM:number}|SurveyMark;
type SurveyDraft={mode:'terrain_scan';bearingDeg:string;radiusM:string}|SurveyMark;
export type SurveyPoint={position:[number,number];elevationM:number;slopeDeg:number;traversable:boolean};
type SurveyConfig={range:Range;sampleCapacity?:number};
export type DeviceAction={agentId:string;requestId:string;type:string;status:string;targetTick:number;expiresTick:number;submittedTick:number;updatedTick?:number;taskId?:string;operation?:string;reason?:string;phase?:string;progress?:number;energyAdded?:number;direction?:{bearingDeg:number;distanceM:number};survey?:SurveyInput;flight?:{deltaM?:number;control?:FlightControlInput};result?:{position?:{z?:number}|[number,number];kind?:string;observedTick?:number;points?:SurveyPoint[];elevationM?:number;sampleId?:string;completedM?:number;remainingM?:number;heldTicks?:number;remainingTicks?:number;quantity?:number;consumed?:number;passed?:boolean}};
export type DeviceContext={roverSurvey?:SurveyConfig;flight?:FlightLimits;directionRange?:{minimum:number;maximum:number};worldSize?:number;key:string;observer:boolean;imported:boolean;latest:boolean;failed:boolean;done:boolean;busy:boolean;running:boolean;remote:boolean;connection?:DeviceConnection;speed?:number;tick:number;mode:string;selected:string;rescueContacts?:RescueContact[];agents:Device[];tasks:DeviceTask[];actions:DeviceAction[];reports?:ReportData};
export type DeviceDraft={type:'move';x:string;y:string;z?:string}|{type:'move';flightControl:FlightControlDraft}|{type:'move';deltaM:string}|{type:'move';bearingDeg:string;distanceM:string}|{type:'scan';survey:SurveyDraft}|{type:'scan'|'charge'}|{type:'execute_task'|'work_task';taskId:string;operation?:string}|{type:'rescue';targetAgentId:string;observedTick:number;faultGeneration:number}|{type:'cancel';requestId:string};
export type DeviceIntent={requestId:string;type:'move'|'scan'|'charge'|'execute_task'|'work_task'|'rescue';targetTick:number;expiresTick:number;target?:{x:number;y:number;z?:number};survey?:SurveyInput;vertical?:{deltaM:number};flightControl?:FlightControlInput;direction?:{bearingDeg:number;distanceM:number};taskId?:string;operation?:string;targetAgentId?:string;observedTick?:number;faultGeneration?:number};
export type DeviceResult={ok:boolean;reason?:string;requestId?:string;targetTick?:number;cancelled?:boolean;refreshPending?:boolean};
const token=(s:string)=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
export function deviceBlock(c:DeviceContext):string|null{if(c.observer)return 'read_only';if(c.imported)return 'imported_replay';if(!c.latest)return 'history_view';if(c.failed)return 'session_stopped';if(c.done)return 'world_finished';if(c.busy)return 'busy';return null}
export function canDeviceScan(device:Pick<Device,'capabilities'>):boolean{
 return device.capabilities?.some(capability=>capability==='inspect'||capability==='confirm')??false;
}
export function deviceTaskMovePoint(task:DeviceTask|undefined,worldSize=100):[number,number]|null{if(!task)return null;const p=Object.prototype.hasOwnProperty.call(task,'approachPoint')?task.approachPoint:task.waypoint;return Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=0&&n<=worldSize)?[p[0],p[1]]:null}
export function taskActionBlock(c:DeviceContext,taskId:string):string|null{
 const agent=c.agents.find(a=>a.id===c.selected);
 const task=c.tasks.find(t=>t.id===taskId&&t.status==='active'&&(t.assignee===undefined||t.assignee===c.selected));
 return assignedTaskActionBlock(c.mode,agent,task,c.actions);
}
export function assignedTaskActionBlock(mode:string,agent:Device|undefined,task:DeviceTask|undefined,actions:DeviceAction[]):string|null{
 if(mode!=='agent'&&mode!=='primitive')return 'execution_mode';
 if(!task||agent?.status!=='assigned')return 'task_not_assigned';
 if(actions.some(a=>a.agentId===agent.id&&a.taskId===task.id&&['execute_task','work_task'].includes(a.type)&&['pending','accepted'].includes(a.status)))return 'action_pending';
 if(mode==='primitive'&&!task.withinReach)return 'out_of_reach';
 return task.workOperation?.reason??null;
}
function numeric(text:string){return typeof text==='string'&&text.trim()?Number(text):NaN}
function inRange(value:number,{minimum,maximum}:Range){return Number.isFinite(value)&&value>=minimum&&value<=maximum}
function prepareFlightControl(c:DeviceContext,draft:FlightControlDraft):{control?:FlightControlInput;reason?:string}{
 const limits=c.flight;
 if(!limits)return {reason:'flight_motion_unavailable'};
 if(draft.mode==='takeoff'){
  if(limits.state==='airborne')return {reason:'already_airborne'};
  const heightM=numeric(draft.heightM);
  return inRange(heightM,limits.takeoffHeight)?{control:{mode:draft.mode,heightM}}:{reason:'flight_height_limit'};
 }
 if(limits.state==='landed')return {reason:'takeoff_required'};
 if(draft.mode==='land'){
  const range={minimum:0,maximum:c.worldSize??100},x=numeric(draft.x),y=numeric(draft.y);
  return inRange(x,range)&&inRange(y,range)?{control:{mode:draft.mode,x,y}}:{reason:'invalid_target'};
 }
 const durationTicks=numeric(draft.durationTicks);
 return Number.isInteger(durationTicks)&&inRange(durationTicks,limits.hoverDuration)
  ?{control:{mode:'hover',durationTicks}}:{reason:'invalid_hover_duration'};
}
export function prepareDeviceIntent(c:DeviceContext,agentId:string,draft:DeviceDraft,requestId:string):{intent?:DeviceIntent;reason?:string}{
 if(c.selected!==agentId||!c.agents.some(a=>a.id===agentId))return {reason:'selection_changed'};
 if(!token(requestId))return {reason:'invalid_action'};
 if(draft.type==='cancel')return {reason:'invalid_action'};
 const targetTick=Math.min(10_000_000,c.tick+(c.remote&&c.running?10*([1,2,5].includes(c.speed||1)?c.speed||1:1):1)),expiresTick=Math.min(10_000_000,targetTick+40);
 if(!Number.isSafeInteger(c.tick)||c.tick<0||targetTick<=c.tick)return {reason:'invalid_schedule'};
 const intent:DeviceIntent={requestId,type:draft.type,targetTick,expiresTick};
 if(draft.type==='move'&&'flightControl' in draft){
  const result=prepareFlightControl(c,draft.flightControl);
  if(!result.control)return {reason:result.reason};
  intent.flightControl=result.control;
 }else if(draft.type==='move'&&'bearingDeg' in draft){
  const range=c.directionRange;
  if(!range)return {reason:'directional_motion_unavailable'};
  if(typeof draft.bearingDeg!=='string'||typeof draft.distanceM!=='string'||!draft.bearingDeg.trim()||!draft.distanceM.trim())return {reason:'invalid_direction'};
  const bearingDeg=Number(draft.bearingDeg),distanceM=Number(draft.distanceM);
  if(!Number.isFinite(bearingDeg)||bearingDeg<0||bearingDeg>=360||!Number.isFinite(distanceM)||distanceM<range.minimum||distanceM>range.maximum)return {reason:'invalid_direction'};
  intent.direction={bearingDeg,distanceM};
 }else if(draft.type==='move'&&'deltaM' in draft){
  const limits=c.flight;
  if(!limits)return {reason:'flight_motion_unavailable'};
  const deltaM=typeof draft.deltaM==='string'&&draft.deltaM.trim()?Number(draft.deltaM):NaN;
  const maximum=deltaM>=0?limits.ascendM:limits.descendM;
  if(!Number.isFinite(deltaM)||Math.abs(deltaM)<limits.minimumDeltaM||Math.abs(deltaM)>maximum)return {reason:'flight_height_limit'};
  intent.vertical={deltaM};
 }else if(draft.type==='move'){
  if(typeof draft.x!=='string'||typeof draft.y!=='string'||!draft.x.trim()||!draft.y.trim())return {reason:'invalid_target'};const x=Number(draft.x),y=Number(draft.y);
  if(![x,y].every(n=>Number.isFinite(n)&&n>=0&&n<=(c.worldSize??100)))return {reason:'invalid_target'};
  intent.target={x,y};
  if(draft.z!==undefined&&draft.z!==''){
   const range=c.flight?.altitudeRange;
   if(!range)return {reason:'flight_motion_unavailable'};
   const z=typeof draft.z==='string'&&draft.z.trim()?Number(draft.z):NaN;
   if(!Number.isFinite(z)||z<range.minimum||z>range.maximum)return {reason:'flight_height_limit'};
   intent.target.z=z;
  }
 }else if(draft.type==='scan'&&'survey' in draft){
  if(!c.roverSurvey)return {reason:'rover_survey_unavailable'};
  const survey=draft.survey;
  if(survey.mode==='terrain_scan'){
   const bearingDeg=numeric(survey.bearingDeg),radiusM=numeric(survey.radiusM);
   if(!Number.isFinite(bearingDeg)||bearingDeg<0||bearingDeg>=360||!inRange(radiusM,c.roverSurvey.range))return {reason:'invalid_survey_range'};
   intent.survey={mode:survey.mode,bearingDeg,radiusM};
  }else{
   const scan=c.actions.find(a=>a.agentId===agentId&&a.requestId===survey.scanRequestId&&a.result?.kind==='terrain_scan');
   if(!scan?.result?.points?.[survey.pointIndex]?.traversable)return {reason:'survey_point_unavailable'};
   intent.survey=survey;
  }
 }else if(draft.type==='rescue'){
  if(!c.agents.find(a=>a.id===agentId)?.rescueWorkTicks)return {reason:'missing_capability'};if(!c.rescueContacts?.some(t=>t.id===draft.targetAgentId&&t.observedTick===draft.observedTick&&t.faultGeneration===draft.faultGeneration))return {reason:'fault_not_observed'};intent.targetAgentId=draft.targetAgentId;intent.observedTick=draft.observedTick;intent.faultGeneration=draft.faultGeneration;
 }else if(draft.type==='execute_task'||draft.type==='work_task'){
  const reason=taskActionBlock(c,draft.taskId);if(reason)return {reason};
  if(draft.type!==(c.mode==='primitive'?'work_task':'execute_task'))return {reason:'execution_mode'};
  const work=c.tasks.find(t=>t.id===draft.taskId)?.workOperation;
  if(draft.operation!==undefined){
   if(draft.type!=='work_task'||draft.operation!==work?.operation)return {reason:'operation_out_of_order'};
   intent.operation=draft.operation;
  }else if(work?.completed)return {reason:'operation_required'};
  intent.taskId=draft.taskId;
 }
 return {intent};
}
const text:Record<string,string>=Object.assign(Object.create(null),{sample_slots_full:'采样仓已满，请选择有空槽的设备。',rover_survey_unavailable:'当前设备或仿真后端没有开放地形扫描。',invalid_survey_range:'请填写小于 360° 的非负方位角及设备允许的扫描半径。',survey_point_unavailable:'请选择本机扫描得到的通行点。',survey_point_out_of_range:'该通行点超出本机当前扫描范围。',survey_point_blocked:'前往该点的直线路线已受阻，请重新扫描。',task_operations_unavailable:'工序操作需要使用支持该能力的分步仿真。',operation_out_of_order:'工序已变化，请查看任务当前步骤。',operation_not_supported:'当前任务不支持这个工序。',operation_required:'请提交任务当前显示的工序。',assignment_changed:'任务已重新分配，请查看当前执行设备。',part_unavailable:'当前工序所需的备件不可用。',anomaly_unconfirmed:'设备故障尚未确认。',takeoff_required:'设备需要先起飞。',already_airborne:'设备已在空中，可通过垂直飞行调整高度。',takeoff_site_unavailable:'当前位置的起飞通道受阻。',landing_site_unavailable:'落点无法安全着陆，请选择地面平坦且无遮挡的位置。',invalid_hover_duration:'悬停时长须为 1–60 个仿真步。',flight_motion_unavailable:'当前设备或仿真后端没有开放三维飞行。',flight_height_limit:'高度超出允许范围，请查看当前可飞行高度。',directional_motion_unavailable:'当前仿真后端没有开放定向移动。',invalid_direction:'请填写小于 360° 的非负方位角及设备允许的距离。',pose_changed:'设备已离开提交意图时的位置，请查看当前位置后重试。',movement_blocked:'直线通行受阻，已保留实际移动进度。',fault_not_observed:'本机尚无该设备的机械故障记录，请先接近并重新观测。',fault_changed:'故障已变化，请重新观测后提交。',not_recoverable:'该设备不支持现场复位。',target_low_battery:'目标电量过低，现场复位无法恢复供电。',rescue_in_progress:'已有设备正在处理本次故障。',read_only:'当前为只读观察，不能发送设备意图。',imported_replay:'导入回放不可控制设备。',history_view:'当前为历史快照，请返回实时视图后操作。',session_stopped:'当前会话无法继续控制，请重新连接。',world_finished:'本次运行已结束，请重新开始后操作。',busy:'正在处理其他操作，请稍候。',selection_changed:'设备或任务状态已变化，请重新选择。',context_changed:'运行已切换，旧操作结果不用于当前运行。',invalid_action:'意图格式无效，请重新填写。',invalid_target:'移动目标须为0到100之间的有效坐标。',invalid_schedule:'意图的目标步已失效，请暂停世界并查看最新状态后重新提交。',execution_mode:'当前执行模式不支持此任务操作。',task_not_assigned:'当前没有可启动的已分配任务。',action_pending:'该任务已有待处理意图，请查看动作记录。',out_of_reach:'尚未到达作业地点，请先移动。',unknown_agent:'设备已不在当前运行中。',unknown_action:'该动作已不在当前运行中。',action_not_cancellable:'该动作已结束，无法取消。',request_id_conflict:'请求标识已用于其他意图，请查看动作记录。',action_limit:'本次运行的意图数量已达上限。',agent_unavailable:'设备当前不可用。',low_battery:'设备电量不足。',missing_capability:'设备缺少所需能力。',battery_sufficient:'设备无需补能。',task_not_ready:'任务状态已变化。',unreachable_target:'目标路线不可达。',expired:'意图已超过有效期。',collision_blocked:'设备移动受阻。',energy_depleted:'设备电量已耗尽。',cancelled:'动作已取消。',cancelled_by_client:'动作已取消。',cancel_requested:'已按请求取消。',run_ended:'运行结束，动作已取消。',task_revoked:'任务已撤回。',unauthorized:'管理员凭据已失效，请重新连接。',forbidden:'当前凭据没有设备控制权限。',world_step_failed:'世界执行失败，已保留最后提交状态。'});
export function deviceMessage(reason?:string):string{return text[reason||'']||'结果尚未确认，请检查最新动作记录后操作。'}
export function deviceReason(reason:string):string{return text[reason]||'具体原因请查看事件记录。'}
type Environment={read:()=>DeviceContext;id:()=>string;setBusy:(busy:boolean)=>void;send:(agentId:string,intent:DeviceIntent)=>{ok:boolean;reason?:string}|Promise<{ok:boolean;reason?:string}>;cancel:(agentId:string,requestId:string)=>{ok:boolean;reason?:string}|Promise<{ok:boolean;reason?:string}>;refresh:()=>void|Promise<void>;onError?:(error:unknown)=>void};
export function createDeviceController(env:Environment){
 const pending=new Set<string>();
 return async function submit(key:string,agentId:string,draft:DeviceDraft):Promise<DeviceResult>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};const block=deviceBlock(c);if(block)return {ok:false,reason:block};if(pending.has(key))return {ok:false,reason:'busy'};
  if(!draft||!['move','scan','charge','execute_task','work_task','rescue','cancel'].includes(draft.type))return {ok:false,reason:'invalid_action'};
  if(c.selected!==agentId||!c.agents.some(a=>a.id===agentId))return {ok:false,reason:'selection_changed'};
  let intent:DeviceIntent|undefined,requestId:string;
  if(draft.type==='cancel'){
   if(!c.actions.some(a=>a.agentId===agentId&&a.requestId===draft.requestId&&['pending','accepted'].includes(a.status)))return {ok:false,reason:'action_not_cancellable'};requestId=draft.requestId;
  }else{const prepared=prepareDeviceIntent(c,agentId,draft,env.id());if(!prepared.intent)return {ok:false,reason:prepared.reason};intent=prepared.intent;requestId=intent.requestId}
  const current=()=>env.read().key===key;pending.add(key);
  try{
   env.setBusy(true);const result=draft.type==='cancel'?await env.cancel(agentId,requestId):await env.send(agentId,intent!);if(!current())return {ok:false,reason:'context_changed'};if(!result.ok)return result;
   const accepted:DeviceResult={ok:true,requestId,...(intent?{targetTick:intent.targetTick}:{cancelled:true})};
   try{await env.refresh()}catch(error){if(current())env.onError?.(error);return current()?{...accepted,refreshPending:true}:{ok:false,reason:'context_changed'}}return current()?accepted:{ok:false,reason:'context_changed'};
  }catch(error){if(!current())return {ok:false,reason:'context_changed'};const e=error as {message?:string;status?:number};if(e.status!==400&&e.status!==409)env.onError?.(error);if(!current())return {ok:false,reason:'context_changed'};try{await env.refresh()}catch(refreshError){if(current())env.onError?.(refreshError)}return current()?{ok:false,reason:text[e.message||'']?e.message:'request_failed',requestId}:{ok:false,reason:'context_changed'};
  }finally{pending.delete(key);if(current())env.setBusy(false)}
 };
}
