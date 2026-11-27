import {RunnerPanel} from './runner-panel';
import {AgentRunLink,AgentRunPanel,AgentRunTimeline,readRunLink,useRunOperationAgent} from './agent-run-panel';
import {ConsoleAccount} from './console-session';
import {createPlanReviewController,type PlanView} from './plan-review';
import {PlanReviewControls} from './plan-review-panel';
import {projectCommandNodes,createNodeRegistryController,type NodeView} from './coordinator-nodes';
import {CommandNodesPanel,NodeRegistryControls} from './coordinator-nodes-panel';
import {projectConstruction,type ConstructionView} from './construction-view';
import {ConstructionPanel} from './construction-panel';
import {projectMaterials,type MaterialView} from './material-view';
import {MaterialPanel} from './material-panel';
import React, {useState,useRef,useEffect,useLayoutEffect,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal,flushSync} from 'react-dom';
import {Planet, Cube, Play, Pause, Crosshair, CaretDown, ArrowUp, X, SlidersHorizontal, DotsThree, Drone, Robot, Truck, Check, Broadcast} from '@phosphor-icons/react';
import styles from './mission-control.css';
import {renderCameraFrame} from '../../world/server/camera-renderer.js';
import {deviceSnapshot,fixedSensorSnapshots} from '../../world/src/device-telemetry.js';
import {DeviceObservations,projectDeviceObservations,projectSensorObservations,type FixedSensor} from './device-observations';
import {projectDataFlow,type FlowView} from './data-flow';
import {DataFlowPanel} from './data-flow-panel';
import {DeviceMessageControls} from './device-message-controls';
import {projectMessages,createMessageController,type MessageContext} from './device-messaging';
import {taskAttempts,type ExecutionEvent,type ExecutionTask,type TaskAttempt} from './task-execution';
import {projectTaskChain,type TaskChainView} from './task-chain';
import {TaskChainPanel} from './task-chain-panel';
import {createReplayNavigator,type ReplayView,type ReplayRequest} from './event-replay';
import {EventReplayPanel} from './event-replay-panel';
import {DeviceControls} from './device-controls';
import {TaskCoordinationControls} from './task-coordination-controls';
import {createCoordinatorController,projectCoordinator,coordinatorView,type CoordinatorContext} from './task-coordination';
import {createCoordinatorCredentialController} from './coordinator-credentials';
import {WorldSettingControls} from './world-setting-controls';
import {createWorldSettingsController,DEFAULT_SCENE_ID,defaultWorldSettings,previewSettingsSeed,validateSettings,settingsConnectionDisabled,configuredScene,customSettings,settingsSession,type SettingsContext} from './world-settings';
import {WorldDisturbanceControls} from './world-disturbance-controls';
import {createDisturbanceController,projectDisturbances,type DisturbanceContext} from './world-disturbances';
import {createDeviceController,deviceBlock,type DeviceAvailability,type DeviceDraft,type DeviceResult,type DeviceTask,type DeviceContext} from './device-actions';
import {createDeviceReportController,projectDeviceReports} from './device-reports';
import {createDeviceCredentialController} from './device-credentials';
import {assignmentBlock,assignmentTasks,assignmentAgents,assignmentSelection,assignmentMessage,createAssignmentController,type AssignmentContext,type AssignmentResult} from './manual-assignment';
import {DeviceCapabilities} from './device-capabilities';
import {DeviceLidar} from './device-lidar';
type ThermalState={temperatureC:number;peakC:number;protected:boolean;trips:number;protectionTicks:number;tick:number};
type CameraConfig={enabled?:boolean;mount?:number[];yaw?:number;pitch?:number;fov?:number;range?:number;updateTicks?:number;resolution?:[number,number]};
type CameraFrame={version?:number;agentId:string;tick:number;width:number;height:number;mimeType?:string;yaw?:number;pitch?:number;fov?:number;svg?:string;url?:string};
type Agent={rescue?:{workTicks:number};camera?:CameraConfig;mobility?:string;sensorRange?:number;communicationRange?:number;speed?:number;deployableRelay?:true;relayState?:{deployed:boolean;deployedTick?:number;taskId?:string;position?:[number,number]};thermal?:{limitC:number;resumeC:number};thermalState?:ThermalState;id:string;name:string;role:string;battery:number;status:string;disabled:boolean;x:number;y:number;taskId?:string;capabilities?:string[]};
type InspectorDevice={context:DeviceContext;telemetry:Parameters<typeof projectDeviceObservations>[0]&{availableActions:DeviceAvailability[]}};
type Mission={inspectDevice?:(id:string)=>InspectorDevice|undefined;fixedSensors?:FixedSensor[];cardTaskTypes?:Pick<DeviceTask,'capability'|'behavior'>[];cameraFrames?:Record<string,CameraFrame>;renderReplayCamera?:(agentId:string)=>CameraFrame|undefined;constructionConfigured?:boolean;construction?:ConstructionView|null;materials?:MaterialView|null;heightfield?:{rows:number;cols:number;heights:number[];maxSlopeDegrees:number};replay?:ReplayView;chain?:TaskChainView;messages?:MessageContext;flow?:FlowView;sceneId:string;worldSize?:number;sceneName:string;tick:number;running:boolean;manualExecuting?:boolean;speed?:number;speedDisabled?:boolean;faultDisabled?:boolean;physicsMode?:string;executionMode?:string;playLabel?:string;statusLabel?:string;dispatchMode?:string;done:boolean;failed:boolean;selected:string;agents:Agent[];tasks:ExecutionTask[];events:ExecutionEvent[];frame:number;frames:number;is3d:boolean;available3d:boolean;graphicsFailure?:{code:string;title:string;body:string;help:string}|null;obstacles?:any[];source:string;connectAvailable?:boolean;connectDisabled?:boolean;connectLabel?:string;playDisabled:boolean;resetDisabled:boolean;connectionError?:string;creationPending?:boolean;sessionCleanup?:{busy:boolean;mayBeRunning:boolean};lidarAvailable?:boolean;sceneDisabled:boolean;observer:boolean;observerRunId?:string;remoteSession?:boolean;manual?:AssignmentContext;device?:DeviceContext;disturbances?:DisturbanceContext;settings?:SettingsContext;coordination?:CoordinatorContext;commandNodes?:NodeView;planReview?:PlanView};
let snapshot:Mission={sceneId:DEFAULT_SCENE_ID,sceneName:'现代工业园区',tick:0,running:false,done:false,failed:false,selected:'global',agents:[],tasks:[],events:[],frame:0,frames:0,is3d:false,available3d:false,source:'浏览器仿真',playDisabled:true,resetDisabled:true,sceneDisabled:true,observer:false};
let actions:any={};const subscribers=new Set<()=>void>();
(window as any).SandboxMissionUI={update(next:Mission){snapshot=next;subscribers.forEach(f=>f())},setActions(next:any){actions=next},renderReplayCamera(world:{agents:Agent[]},agentId:string){
 const agent=world.agents.find(value=>value.id===agentId);
 return agent?renderCameraFrame(world,agent):undefined;
},openMessaging(){window.dispatchEvent(new Event('sandbox-message-tools'))}};
(window as any).SandboxTaskCoordination={createCoordinatorController,projectCoordinator,coordinatorView,createCoordinatorCredentialController,projectCommandNodes,createNodeRegistryController,createPlanReviewController};
(window as any).SandboxWorldSettings={createWorldSettingsController,defaultWorldSettings,previewSettingsSeed,validateSettings,settingsConnectionDisabled,configuredScene,customSettings,settingsSession};
(window as any).SandboxWorldDisturbances={createDisturbanceController,projectDisturbances};
const disturbancePanels:Record<string,string>={'设备故障':'world-disturbance-fault-card','通信中断':'world-disturbance-outage-card','低电量扰动':'world-disturbance-energy-card','地表条件扰动':'world-disturbance-terrain-card','临时道路封闭':'world-disturbance-road-card'};
const disturbanceAnchors:Record<string,string>={'world-disturbances-fault':'设备故障','section-directory-7':'通信中断','section-directory-8':'低电量扰动','section-directory-9':'地表条件扰动','section-directory-10':'临时道路封闭','world-disturbances-outage':'通信中断','world-disturbances-energy':'低电量扰动','world-disturbances-terrain':'地表条件扰动','world-disturbances-road':'临时道路封闭'};
const toolAnchors = new Map([
 ['agent-runs','Agent 任务'], ['runner','Runner 实验'], ['world-settings','场景与世界设置'], ['experiment-reports','实验报告与回放'],
 ['device-process','设备进程'], ['device-messaging','设备通信'], ['world-disturbances','扰动控制'],
 ['command-plan','计划审阅'], ['command-nodes','指挥节点'], ['task-coordination','任务指挥'],
 ['device-operations','设备操作'], ['device-rescue','现场救援'], ['device-reports','设备报告'], ['manual-assignment','人工任务分配'],
 ['replay-records','完整记录与回放'], ['service-diagnostics','记录与服务诊断'],
 ['agent-strategy','调度策略与智能体'], ['experiment-tools','实验与世界设置'],
]);
const legacyToolAnchors = new Map([
 ['dispatchcard','任务指挥'], ['section-directory-3','场景与世界设置'], ['section-directory-6','设备进程'],
 ...Object.entries(disturbanceAnchors),
]);
function readToolRoute() {
 let hash: string;
 try {hash=decodeURIComponent(location.hash.slice(1))} catch {return null}
 const title=toolAnchors.get(hash)??legacyToolAnchors.get(hash)
  ?? (/^section-directory-\d+$/.test(hash)&&hash!=='section-directory-1'?'实验与世界设置':null);
 return title?{hash,title}:null;
}
const toolSections = new Map([
 ['设备通信','.mc-device-messaging'], ['计划审阅','.mc-plan-review'], ['指挥节点','.mc-node-registry'],
 ['任务指挥','.mc-task-coordination'], ['场景与世界设置','.mc-world-settings'], ['扰动控制','.mc-disturbances'],
 ['设备操作','.mc-device-actions'], ['现场救援','.mc-device-rescue'], ['设备报告','.mc-device-reports'], ['设备进程','.mc-device-process'],
 ['人工任务分配','.mc-assignment'],
]);
(window as any).SandboxMaterialView={projectMaterials,projectConstruction};
(window as any).SandboxDataFlow={projectDataFlow};
(window as any).SandboxTaskChain={projectTaskChain};
(window as any).SandboxReplayUI={createReplayNavigator};
(window as any).SandboxMessaging={projectMessages,createMessageController};
(window as any).SandboxManualAssignment={createAssignmentController};
(window as any).SandboxDeviceActions={deviceSnapshot,fixedSensorSnapshots,createDeviceController,deviceBlock,createDeviceReportController,projectDeviceReports,createDeviceCredentialController};
const subscribe=(fn:()=>void)=>{subscribers.add(fn);return()=>{subscribers.delete(fn)}};
const act=(id:string)=>actions.click?.(id);
const select=(id:string,value:string)=>actions.select?.(id,value);
async function openLinkedRun(kind:'observer'|'report',load:()=>Promise<unknown>,signal:AbortSignal,runId:string){
 if(snapshot.remoteSession&&!snapshot.observer)throw Error('请先断开当前世界会话，或在新标签页打开观察链接。');
 if(kind==='observer'){
  const access=await load();
  if(signal.aborted)return;
  await actions.openRunnerObserver(access,signal,runId);
 }else{
  await actions.openRunnerReplay(load,signal);
 }
 if(signal.aborted)return;
 if(snapshot.selected!=='global')select('view','global');
 if(snapshot.available3d&&!snapshot.is3d)act('viewmode');
}
const deviceTypeNames=new Map([
 ['rover','勘察车'],
 ['vehicle','运输车'],
 ['robot','机器人'],
 ['drone','无人机'],
 ['relay','中继车'],
 ['boat','作业船'],
]);
const statusName:Record<string,string>={deployed:'中继驻留',idle:'就绪',working:'执行中',assigned:'已分配',manual:'执行指令',charging:'充电中',returning:'返航中',fault:'故障',disabled:'已退出'};
const traceLabels = {
 trace:'执行轨迹', attempts:'任务执行详情', agent:'Agent 过程', tasks:'任务链', nodes:'指挥节点', replay:'事件回放'
};
type TracePane = keyof typeof traceLabels;
const deviceLabels = {devices:'设备',data:'数据流',events:'动态',materials:'施工与物资'};
type DevicePane = keyof typeof deviceLabels;

function WorkspaceMenu({label, icon, children}:{label:string;icon?:boolean;children:React.ReactNode}) {
 const menu=useRef<HTMLDetailsElement>(null);
 const trigger=useRef<HTMLElement>(null);
 const close=()=>{if(menu.current)menu.current.open=false};
 return <details ref={menu} className="mc-menu"
  onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))close()}}
  onKeyDown={e=>{if(e.key==='Escape'&&e.currentTarget.open){e.stopPropagation();close();trigger.current?.focus()}}}>
  <summary ref={trigger} aria-label={label} title={icon?label:undefined}>{icon?<DotsThree size={21} weight="bold"/>:label}</summary>
  <div className="mc-menu-items" onClick={e=>{
   if(e.target instanceof Element&&e.target.closest('button:not(:disabled)')){close();trigger.current?.focus()}
  }}>{children}</div>
 </details>;
}

function devicePriority(agent:Agent, taskAgent?:Agent) {
 if(agent.disabled||agent.thermalState?.protected||agent.battery<=5)return 0;
 if(agent.id===taskAgent?.id)return 1;
 if(agent.status==='working'||agent.status==='manual')return 2;
 return 3;
}

function deviceTitle(agent:Agent) {
 const type=agent.role==='robot'&&agent.capabilities?.includes('repair')?'维修机器人':deviceTypeNames.get(agent.role);
 const number=/-([0-9]+)$/.exec(agent.id)?.[1];
 if(type&&number)return type+' '+number;
 return agent.name||type||agent.id;
}

function DeviceRow({agent,selected,onSelect}:{agent:Agent;selected:boolean;onSelect:()=>void}) {
 const DeviceIcon=agent.role==='drone'?Drone:agent.role==='robot'?Robot:['vehicle','rover','relay'].includes(agent.role)?Truck:Cube;
 const status=agent.disabled?'已退出':agent.thermalState?.protected?'热保护':agent.battery<=5?'低电量':statusName[agent.status]||'状态未知';
 const alert=agent.disabled||agent.thermalState?.protected||agent.battery<=5;
 return <li><button type="button" className="mc-device-row" aria-pressed={selected} onClick={onSelect}>
  <span className="mc-device-row-name"><DeviceIcon size={19} aria-hidden="true"/><span title={agent.id}>{deviceTitle(agent)}</span></span>
  <span className={alert?'mc-device-alert':undefined}>{status}</span>
  <span className="mc-device-row-power">{Math.round(agent.battery)}%</span>
 </button></li>;
}
type AssignmentRequest={key:string;taskId:string;serial:number};
function ManualAssignment({context,mode,requested}:{context?:AssignmentContext;mode?:string;requested:AssignmentRequest|null}){
 const [taskId,setTaskId]=useState(''),[agentId,setAgentId]=useState(''),[pending,setPending]=useState(false),[feedback,setFeedback]=useState('');
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{if(requested&&requested.key===context?.key){setTaskId(requested.taskId);setAgentId('');setFeedback('')}},[requested?.serial,context?.key]);
 if(!context)return null;
 const block=assignmentBlock(context),noticeBlock=block==='busy'&&pending?null:block,{tasks,task,agents,agent}=assignmentSelection(context,taskId,agentId);
 const submit=async(e:React.FormEvent)=>{
  e.preventDefault();if(block||pending||!task||!agent)return;setPending(true);setFeedback('正在提交分配…');
  try{
   const result:AssignmentResult=await actions.assignManual?.(context.key,task.id,agent.id)||{ok:false,reason:'request_failed'};
   if(!alive.current)return;
   if(result.ok)select('deviceagent',agent.id);
   setFeedback(result.ok?(result.refreshPending?'世界已接受分配，状态同步尚未完成，请检查实时视图。':`已将「${task.name}」分配给${agent.name}。`+(mode==='agent'?'请在设备操作中启动任务。':mode==='primitive'?'请在设备操作中移动到作业地点并提交作业。':'开始运行后自动执行。')):assignmentMessage(result.reason));
  }catch{if(alive.current)setFeedback(assignmentMessage())}finally{if(alive.current)setPending(false)}
 };
 return <section className="mc-assignment" aria-label="人工任务分配"><div className="mc-assignment-heading"><Crosshair size={16}/><h2>人工任务分配</h2><span>选择待执行任务与可用设备</span></div>
  {noticeBlock&&<p className="mc-assignment-notice">{assignmentMessage(noticeBlock)} {noticeBlock==='pause_required'&&<button type="button" className="mc-pill" onClick={()=>actions.pause?.()}>暂停世界</button>}{noticeBlock==='history_view'&&<button type="button" className="mc-pill" onClick={()=>act('live')}>返回实时视图</button>}{noticeBlock==='agent_view'&&<button type="button" className="mc-pill" onClick={()=>select('view','global')}>返回全局视图</button>}</p>}
  {!['read_only','imported_replay','agent_view','history_view'].includes(block||'')&&<form onSubmit={submit}><label>待分配任务<select aria-label="待分配任务" value={task?.id||''} disabled={!!block||pending||!tasks.length} onChange={e=>{setTaskId(e.target.value);setAgentId('');setFeedback('')}}>{tasks.length?<>{!task&&<option value="">原任务已失效，请重新选择</option>}{tasks.map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</>:<option value="">暂无依赖已满足的待分配任务</option>}</select></label><label>执行设备<select aria-label="执行设备" value={agent?.id||''} disabled={!!block||pending||!agents.length} onChange={e=>{setAgentId(e.target.value);setFeedback('')}}>{agents.length?<>{!agent&&<option value="">原设备已失效，请重新选择</option>}{agents.map(a=><option value={a.id} key={a.id}>{a.name} · {a.id} · {Math.round(a.battery)}%</option>)}</>:<option value="">暂无能力与电量符合要求的空闲设备</option>}</select></label><button type="submit" className="mc-pill violet" disabled={!!block||pending||!task||!agent}>{pending?'提交中…':'确认分配任务'}</button><p className="mc-assignment-hint">设备按能力、电量和状态筛选；道路与备件条件在提交时校验。</p></form>}
  {(!block||pending&&block==='busy')&&<p className="mc-assignment-feedback" role="status" aria-live="polite">{feedback}</p>}
 </section>;
}
function IconButton({label,children,onClick,active=false,disabled=false}:{label:string;children:React.ReactNode;onClick?:()=>void;active?:boolean;disabled?:boolean}){return <button type="button" className={'mc-icon '+(active?'active':'')} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>}
function relayLabel(agent:Agent){return agent.disabled?'中继不可用':agent.relayState?.deployed&&agent.battery<=5?'中继电量不足':agent.relayState?.deployed?'中继已部署':'中继待部署'}
function RelayStatus({agent}:{agent:Agent}){if(!agent.deployableRelay)return null;const r=agent.relayState,on=r?.deployed===true&&!agent.disabled&&agent.battery>5,label=relayLabel(agent);return <div className={'mc-relay '+(on?'deployed':'')} aria-label={agent.id+' · '+label} title={on?'驻留设备保持当前位置，承担显式消息路由中的中继跳转。':'到达部署位置并完成任务后才可作为中继。'}><span><Broadcast size={12}/>{label}</span><span>{r?.deployed&&Number.isInteger(r.deployedTick)?'T+'+r.deployedTick:'任务部署'}</span></div>}
function ThermalStatus({agent}:{agent:Agent}){const t=agent.thermalState,p=agent.thermal;if(!t||!p)return null;return <div className={'mc-thermal '+(t.protected?'protected':'')} aria-label={agent.id+' 热控状态 · '+t.temperatureC.toFixed(1)+'°C · '+(t.protected?'热保护，等待散热':'热控正常')} title={'抽象耗能热平衡 · 保护阈值 '+p.limitC+'°C · 恢复阈值 '+p.resumeC+'°C · 峰值 '+t.peakC.toFixed(1)+'°C'}><span>温度 <b>{t.temperatureC.toFixed(1)}°C</b></span><span>{t.protected?'热保护 · 等待散热':'热控正常'}</span></div>}
function cameraSource(frame?:CameraFrame){if(!frame)return null;if(frame.url)return frame.url;if(frame.svg)return `data:${frame.mimeType||'image/svg+xml'};charset=utf-8,${encodeURIComponent(frame.svg)}`;return null}
type CameraView={yaw:number;pitch:number};
function DeviceCamera({agent,frame,available3d,history,onFrame}:{agent:Agent;frame?:CameraFrame;available3d:boolean;history:boolean;onFrame?:(agentId:string,view:CameraView,signal:AbortSignal)=>Promise<Blob|null>}){
 const [view,setView]=useState<CameraView|null>(null),[remoteUrl,setRemoteUrl]=useState<string|null>(null),[error,setError]=useState('');
 const drag=useRef<{id:number;x:number;y:number}|null>(null),objectUrl=useRef<string|null>(null);
 const canRotate=available3d||!!onFrame;
 useEffect(()=>()=>{if(objectUrl.current)URL.revokeObjectURL(objectUrl.current)},[]);
 useEffect(()=>{
  if(!view||!onFrame)return;
  const controller=new AbortController();
  const timer=setTimeout(async()=>{
   try{
    const blob=await onFrame(agent.id,view,controller.signal);
    if(controller.signal.aborted||!blob)return;
    const next=URL.createObjectURL(blob);
    if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);
    objectUrl.current=next;
    setRemoteUrl(next);
    setError('');
   }catch{if(!controller.signal.aborted)setError('摄像头画面请求失败')}
  },120);
  return()=>{clearTimeout(timer);controller.abort()};
 },[agent.id,onFrame,frame?.tick,view]);
 const image=available3d?null:(remoteUrl||cameraSource(frame));
 const name=deviceTitle(agent);
 const label=name+' 仿真摄像头画面';
 const updatePointer=(event:React.PointerEvent)=>{
  const start=drag.current;
  if(!start||start.id!==event.pointerId)return;
  const dx=event.clientX-start.x,dy=event.clientY-start.y;
  if(!dx&&!dy)return;
  drag.current={id:start.id,x:event.clientX,y:event.clientY};
  setView(old=>({yaw:Math.max(-180,Math.min(180,(old?.yaw??agent.camera?.yaw??0)+dx*.45)),pitch:Math.max(-55,Math.min(35,(old?.pitch??agent.camera?.pitch??0)-dy*.3))}));
 };
 const endDrag=(event:React.PointerEvent)=>{if(drag.current?.id===event.pointerId)drag.current=null};
 return <div className={'mc-camera'+(view?' custom-view':'')+(canRotate?' can-rotate':'')} onPointerDown={event=>{
  event.stopPropagation();
  if(!canRotate||drag.current||event.button!==0)return;
  drag.current={id:event.pointerId,x:event.clientX,y:event.clientY};
  event.currentTarget.setPointerCapture(event.pointerId);
 }} onPointerMove={updatePointer} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onClick={event=>event.stopPropagation()}>
  {available3d?<canvas data-device-camera={agent.id} data-camera-yaw={view?.yaw} data-camera-pitch={view?.pitch} role="img" aria-label={label}/>:image?<img src={image} width="320" height="180" draggable={false} alt={label}/>:null}
  {!image&&<div className="mc-camera-placeholder">等待摄像头画面</div>}
  {available3d&&<><div className="mc-camera-corners"/><span>{name} · 仿真相机</span></>}
  <small>{error||(view?`${Math.round(view.yaw)}° / ${Math.round(view.pitch)}°`:canRotate?'拖动旋转':history&&image?'历史帧':'')}</small>
 </div>
}
function ExecutionCard({item,dispatchLabel,onSelect}:{item:TaskAttempt;dispatchLabel:string;onSelect:(id:string)=>void}){
 const status={assigned:'等待启动',running:'执行中',completed:'已完成',interrupted:'已中断',unknown:'活动中 · 起点未记录'}[item.status];
 return <article className={'mc-execution '+item.status} aria-label={item.name+' · '+status}>
  <div className="mc-execution-head"><span className="mc-execution-label">任务执行</span><span className="mc-execution-controller">{dispatchLabel}</span>{item.agentId&&<button className="mc-execution-device" onClick={()=>onSelect(item.agentId!)}><Robot size={10}/>{item.agentId}</button>}<code>{item.behavior||'task'}</code><span className="mc-execution-status">{item.status==='completed'&&<Check size={10}/>} {status}</span></div>
  <div className="mc-execution-body"><strong>{item.name}</strong><span>{item.elapsed===null?'开始时间未记录':(item.status==='completed'||item.status==='interrupted'?'推进了 ':'已推进 ')+item.elapsed+' 步'}</span></div>
  <details className="mc-execution-details"><summary>{item.source==='snapshot'?'当前快照 · 未记录执行起点':item.events.length+' 条事件 · '+(item.startedTick!==null?'T+'+String(item.startedTick).padStart(3,'0')+' 开始执行':item.assignedTick!==null?'T+'+String(item.assignedTick).padStart(3,'0')+' 分配':'起点未记录')}</summary><div>{item.events.map((e,i)=><p key={e.seq??i}><time>T+{String(e.tick).padStart(3,'0')}</time>{e.message}</p>)}<small>步数包含移动、等待与作业；不是墙钟耗时。</small></div></details>
 </article>
}
function App(){
 const [linkedRun,setLinkedRun]=useState(readRunLink);
 const s=useSyncExternalStore(subscribe,()=>snapshot);
 const [tab,setTab]=useState<DevicePane>('devices');
 const [trace,setTrace]=useState<TracePane>(linkedRun?'agent':'trace');
 const [inspected,setInspected]=useState<{world:string;id:string;kind:'device'|'sensor'}|null>(null);
 const [command,setCommand]=useState('');
 const [response,setResponse]=useState('');
 const [showCommand,setShowCommand]=useState(false);
 const [toolRoute,setToolRoute]=useState(readToolRoute);
 const [viewTools,setViewTools]=useState(false);
 const [autoFollow,setAutoFollow]=useState(true);
 const [runChange,setRunChange]=useState<'reset'|'connect'|'retry'>('reset');
 const [assignmentRequest,setAssignmentRequest]=useState<AssignmentRequest|null>(null);
 const ready=s.frames>0,toolsOpen=!!toolRoute,toolTitle=toolRoute?.title??'实验与世界设置';
 const worldSettingsOpen=toolTitle==='场景与世界设置';
 const stage=useRef<HTMLDivElement>(null),legacy=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDialogElement>(null),feed=useRef<HTMLDivElement>(null);
 const restartDialog=useRef<HTMLDialogElement>(null);
 const restartOrigin=useRef<HTMLElement|null>(null);
 const restartKey=useRef<string | undefined>(undefined);
 const deviceList=useRef<HTMLUListElement>(null);
 const positionedTool=useRef<string|null>(null);
 useLayoutEffect(()=>{
  const root=document.getElementById('legacy-root'),world=document.getElementById('map3d')?.closest('section.card');
  if(world&&stage.current){world.classList.add('mc-world');world.id='section-directory-1';stage.current.append(world)}
  if(root&&legacy.current){legacy.current.append(root);root.hidden=false}
 },[]);
 const navigateTools=()=>{
  const route=readToolRoute();
  setToolRoute(current=>current?.hash===route?.hash?current:route);
 };
 const openTools=(title:string)=>{
  const hash=[...toolAnchors].find(([,name])=>name===title)?.[0];
  const current=readToolRoute();
  if(!hash||current?.title===title)return;
  if(current)history.replaceState(history.state,'','#'+hash);
  else history.pushState({...history.state,missionTools:true},'','#'+hash);
  navigateTools();
 };
 const closeTools=()=>{
  if(!readToolRoute())return;
  if(history.state?.missionTools){
   setToolRoute(null);
   history.back();
  }else{
   history.replaceState(history.state,'',location.pathname+location.search);
   navigateTools();
  }
 };
 useLayoutEffect(()=>{
  const navigate=()=>{
   navigateTools();
   const run=readRunLink();
   if(run){setLinkedRun(run);setTrace('agent')}
  };
  window.addEventListener('popstate',navigate);
  window.addEventListener('hashchange',navigate);
  return()=>{window.removeEventListener('popstate',navigate);window.removeEventListener('hashchange',navigate)};
 },[]);
 useLayoutEffect(()=>{
  if(ready)document.getElementById('mission-ui-root')?.setAttribute('data-ready','');
 },[ready]);
 useLayoutEffect(()=>{
  const modal=dialog.current;
  if(!modal||!ready)return;
  if(!toolRoute){
   if(modal.open)modal.close();
   positionedTool.current=null;
   return;
  }
  if(positionedTool.current===toolRoute.hash)return;
  if(!modal.open)modal.showModal();
  const body=modal.querySelector<HTMLElement>(toolTitle==='Agent 任务'?'.mc-agent-tools':toolTitle==='Runner 实验'?'.mc-runner-tools':'.mc-tools-body');
  if(!body)return;
  const id=disturbancePanels[toolTitle];
  const section=toolSections.get(toolTitle);
  const panel=id?document.getElementById(id):section?body.querySelector<HTMLElement>(section)
   ??(toolTitle==='现场救援'?body.querySelector<HTMLElement>('.mc-device-actions'):null):
   toolRoute.hash.startsWith('section-directory-')?document.getElementById(toolRoute.hash):null;
  if((id||section)&&!panel)return;
  body.scrollTop=panel?panel.getBoundingClientRect().top-body.getBoundingClientRect().top+body.scrollTop
   -body.clientTop-(parseFloat(getComputedStyle(panel).scrollMarginTop)||0):0;
  const settingsContent=worldSettingsOpen?panel?.querySelector<HTMLElement>('.mc-settings-content'):null;
  if(settingsContent)settingsContent.scrollTop=0;
  const focus=(worldSettingsOpen
   ?panel?.querySelector<HTMLElement>('select[name="scenario"]:not(:disabled), .mc-settings-notice button')
   :panel?.querySelector<HTMLElement>('select:not(:disabled),input:not(:disabled),button:not(:disabled)'))
   ??panel?.querySelector<HTMLElement>('h2[tabindex],h3[tabindex]')??modal.querySelector<HTMLElement>('.mc-dialog-head button');
  focus?.focus({preventScroll:true});
  positionedTool.current=toolRoute.hash;
 });

 useLayoutEffect(()=>{const canvas=document.querySelector<HTMLCanvasElement>('[data-world-minimap]');if(!canvas)return;const c=canvas.getContext('2d');if(!c)return;const size=s.worldSize??100,sx=220/size,sy=170/size;c.clearRect(0,0,220,170);c.fillStyle='#20211fe8';c.fillRect(0,0,220,170);c.strokeStyle='#72726450';c.lineWidth=.7;for(let i=0;i<=10;i++){c.beginPath();c.moveTo(i*22,0);c.lineTo(i*22,170);c.stroke();c.beginPath();c.moveTo(0,i*17);c.lineTo(220,i*17);c.stroke()}if(s.heightfield){const h=s.heightfield,w=100/(h.cols-1),d=100/(h.rows-1);for(let r=0;r<h.rows-1;r++)for(let col=0;col<h.cols-1;col++){const i=r*h.cols+col,a=h.heights[i],b=h.heights[i+1],q=h.heights[i+h.cols],z=h.heights[i+h.cols+1],grade=Math.max(Math.hypot((b-a)/w,(q-a)/d),Math.hypot((z-q)/w,(z-b)/d)),blocked=Math.atan(grade)*180/Math.PI>h.maxSlopeDegrees+1e-9;c.fillStyle=blocked?'#d1934c88':`rgba(172,164,141,${.08+Math.min(.3,Math.abs(a)/30)})`;c.fillRect(col*w*sx,r*d*sy,w*sx,d*sy)}}if(s.sceneId==='industrial-park-v2'){const campus=(window as Window & {SandboxIndustrialCampus?:{roads:number[][];yards:number[][]}}).SandboxIndustrialCampus;if(campus){c.fillStyle='#55554b';for(const [x,y,w,h] of campus.yards)c.fillRect(x*sx,y*sy,w*sx,h*sy);c.fillStyle='#777d80';for(const [x,y,w,h] of campus.roads)c.fillRect(x*sx,y*sy,w*sx,h*sy)}}c.fillStyle='#bdb09866';for(const o of s.obstacles||[])c.fillRect(o.x*sx,o.y*sy,o.w*sx,o.h*sy);for(const a of s.agents){c.fillStyle=a.disabled?'#d4776b':a.status==='working'?'#90c8b8':'#bec3dd';c.beginPath();c.arc(a.x*sx,a.y*sy,2.5,0,Math.PI*2);c.fill()}},[s]);
 useEffect(()=>{const open=()=>openTools('设备通信');window.addEventListener('sandbox-message-tools',open);return()=>window.removeEventListener('sandbox-message-tools',open)},[]);
 const openTaskAssignment=(taskId:string)=>{if(!s.manual||assignmentBlock(s.manual)||!assignmentTasks(s.manual.tasks).some(t=>t.id===taskId))return;setAssignmentRequest(old=>({key:s.manual!.key,taskId,serial:(old?.serial||0)+1}));openTools('人工任务分配')};
 const focused=s.selected!=='global';
 const cameraHistory=s.source==='导入回放'||s.frame<s.frames-1;
 const operationAgentId=useRunOperationAgent(s.observerRunId);
 const canAutoFollow=!!s.observerRunId&&s.is3d;
 const followedAgentId=canAutoFollow&&autoFollow&&!focused&&!cameraHistory&&s.agents.some(a=>a.id===operationAgentId)?operationAgentId:'';
 const viewToolbar=viewTools&&canAutoFollow?stage.current?.querySelector('.mc-world > .toolbar'):null;
 useLayoutEffect(()=>{actions.followAgent?.(followedAgentId)},[followedAgentId]);
 const cameraMode=s.available3d?'webgl':s.remoteSession&&!cameraHistory?'remote':'still';
 const activeTask=s.tasks.find(t=>t.status==='active');
 const taskAgent=activeTask?s.agents.find(a=>a.id===activeTask.assignee):undefined;
 const stageAgentId=followedAgentId||taskAgent?.id;
 const orderedAgents=[...s.agents].sort((a,b)=>devicePriority(a,taskAgent)-devicePriority(b,taskAgent));
 const inspectorWorld=s.manual?.key||s.sceneId;
 const pinned=inspected?.world===inspectorWorld?inspected:null;
 const fixedSensors=focused?[]:s.fixedSensors??[];
 const inspectedSensor=pinned?.kind==='sensor'?fixedSensors.find(sensor=>sensor.id===pinned.id):undefined;
 const inspectedAgent=inspectedSensor?undefined:s.agents.find(a=>a.id===(focused?s.selected:pinned?.kind==='device'?pinned.id:undefined))
  ||taskAgent||orderedAgents[0];
 const inspectedId=inspectedSensor?.id??inspectedAgent?.id;
 const inspectedIndex=inspectedSensor?orderedAgents.length+fixedSensors.indexOf(inspectedSensor):orderedAgents.findIndex(agent=>agent.id===inspectedId);
 const inspector=tab==='devices'&&inspectedAgent?s.inspectDevice?.(inspectedAgent.id):undefined;
 useLayoutEffect(()=>{
  const list=deviceList.current;
  const row=list?.querySelector('[aria-pressed="true"]');
  if(!list||!row)return;
  const bounds=list.getBoundingClientRect();
  const target=row.getBoundingClientRect();
  if(target.top<bounds.top)list.scrollTop+=target.top-bounds.top;
  else if(target.bottom>bounds.bottom)list.scrollTop+=target.bottom-bounds.bottom;
 },[inspectedId,inspectedIndex,tab]);
 const inspectDevice=(id:string,kind:'device'|'sensor'='device')=>{
  setInspected({world:inspectorWorld,id,kind});
  setTab('devices');
 };
 const submitInspectorAction=(key:string,agentId:string,draft:DeviceDraft):Promise<DeviceResult>=>{
  // The steps for this action can activate an automatic task on a different device.
  if(pinned?.kind!=='device'||pinned.id!==agentId)inspectDevice(agentId);
  return actions.inspectedDeviceAction?.(key,agentId,draft)||Promise.resolve({ok:false,reason:'request_failed'});
 };
 const focusedAgent=focused?s.agents[0]:undefined;
 const status=s.statusLabel||(s.done?s.failed?'任务失败':'任务完成':s.running?'运行中':'等待运行');
 const viewLabel=focused?s.selected:followedAgentId?'跟随 '+followedAgentId:s.is3d?'全局观察':'二维观察';
 const openDeviceTools=()=>{
  if(inspectedAgent)select('deviceagent',inspectedAgent.id);
  openTools('设备操作');
 };
 const selectTrace=(next:TracePane)=>{
  setTrace(next);
  if(feed.current)feed.current.scrollTop=0;
 };
 const recentAttempts=trace==='attempts'?taskAttempts(s.tasks,s.events,s.tick,focused?s.selected:null).slice(-4):[];
 const recentEvents=s.events.slice(-3).reverse();
 const dispatchLabel=({rule:'规则调度',networked:'链路指挥',external:'外部指挥',networked_external:'外部指挥 / 链路',networked_reported:'外部指挥 / 延迟状态'} as Record<string,string>)[s.dispatchMode||'rule']||'任务调度';
 const canChangeRun=(operation:typeof runChange,current:Mission)=>operation==='reset'
  ?!current.resetDisabled&&!current.observer
  :operation==='retry'?!!current.creationPending&&!current.observer&&!current.settings?.busy:!current.connectDisabled;
 const changeRun=(operation:typeof runChange)=> {
  if(operation==='retry')actions.retryWorldCreation?.();
  else act(operation);
 };
 const requestRunChange=(operation:typeof runChange)=>{
  if(!canChangeRun(operation,s))return;
  if(s.frames<=1&&s.tick===0){changeRun(operation);return}
  const modal=restartDialog.current;
  if(!modal||modal.open)return;
  const origin=document.activeElement;
  restartOrigin.current=origin instanceof HTMLElement
   ?origin.closest('.mc-menu')?.querySelector('summary')??origin:null;
  restartKey.current=s.settings?.key;
  setRunChange(operation);
  modal.showModal();
 };
 const exportBeforeRestart=()=>{
  if(snapshot.settings?.key!==restartKey.current)return;
  if(snapshot.selected!=='global')select('view','global');
  const replay=snapshot.replay;
  if(replay?.canExport)actions.replayFile?.('export',replay.key,replay.base);
 };
 const confirmRunChange=()=>{
  restartDialog.current?.close();
  if(canChangeRun(runChange,snapshot)&&snapshot.settings?.key===restartKey.current)changeRun(runChange);
 };
 const runChangeTitle=runChange==='reset'?'重开当前运行':runChange==='retry'?'重试上次创建':
  s.observer?'断开只读观察':s.remoteSession?'切换到浏览器预览':s.connectLabel==='恢复世界会话'?'恢复世界会话':'连接世界服务';
 const runChangeNotice=runChange==='reset'?'重开后，时间轴从 T+0 开始。':
  runChange==='retry'?'将按上次提交的配置重试。确认创建后会切换到该运行。':
  s.observer?'切换后会结束本页的只读观察。':runChange==='connect'&&s.connectLabel==='恢复世界会话'
   ?'恢复后会切换到原来的服务端会话。'
   :s.remoteSession?'接下来会切换到新的运行并关闭当前服务会话。':'将使用场景设置中的下次运行配置，在世界服务从 T+0 开始。';
 const serviceFeedback=(s.connectionError||s.sessionCleanup||s.creationPending)&&<div className="mc-service-feedback">
  {s.connectionError&&<p className="mc-connection-error" role="alert">{s.connectionError}</p>}
  {s.creationPending&&<div className="mc-session-cleanup">
   <p role="status">上次创建结果尚未确认。</p>
   <button type="button" className="mc-pill" disabled={!canChangeRun('retry',s)}
    onClick={()=>requestRunChange('retry')}>重试上次创建</button>
  </div>}
  {s.sessionCleanup&&<div className="mc-session-cleanup">
   <p role="status">{s.sessionCleanup.busy?'正在关闭旧会话…':s.sessionCleanup.mayBeRunning
    ?'旧会话尚未确认关闭，可能仍在运行。':'旧会话已暂停，尚未关闭。'}</p>
   {!s.sessionCleanup.busy&&<button type="button" className="mc-pill" disabled={s.observer}
    onClick={()=>actions.closeRetiredSessions?.()}>重试关闭旧会话</button>}
  </div>}
 </div>;
 const commandSubmit=(e:React.FormEvent)=>{e.preventDefault();const text=command.trim();if(!text)return;if(['开始','运行','继续'].includes(text)){if(!s.running&&!s.playDisabled)act('play');setResponse('已请求开始运行。')}else if(['暂停','停止'].includes(text)){actions.pause?.();setResponse('已请求暂停世界。')}else if(text==='重置'){requestRunChange('reset');setResponse('')}else{const a=s.agents.find(a=>a.id===text||a.name===text);if(a){select('view',a.id);setResponse('已切换至 '+a.name+' 的有限观察。')}else setResponse('支持：开始、暂停、重置，或输入设备 ID。更多任务操作请打开实验工具。')}setCommand('')};
 const connectControl=s.connectAvailable&&<button type="button" className={'mc-pill'+(worldSettingsOpen?'':' violet')}
  title={s.connectLabel==='连接世界服务'?'在世界服务中应用下次运行配置':undefined}
  disabled={s.connectDisabled} onClick={()=>requestRunChange('connect')}>{s.connectLabel||'连接本地世界服务'}</button>;
 const speedControl=<select id="mission-speed" value={String(s.speed||1)} disabled={s.speedDisabled||s.observer}
  onChange={event=>select('speed',event.target.value)} title="影响推进速度，固定步长保持不变">
  <option value="1">1×</option><option value="2">2×</option><option value="5">5×</option>
 </select>;
 return <div className={'mission-control'+(!toolsOpen&&serviceFeedback?' has-service-feedback':'')}>
  <header className="mc-header">
   <h1 className="mc-brand"><Planet size={26} aria-hidden="true"/><span>3DBOX</span></h1>
   <nav className="mc-navigation" aria-label="主导航">
    <button type="button" aria-current={!toolsOpen?'page':undefined} onClick={()=>{closeTools();selectTrace('trace');setTab('devices')}}>工作台</button>
    <button type="button" onClick={()=>openTools('场景与世界设置')}>场景</button>
    <WorkspaceMenu label="实验">
     <button type="button" onClick={()=>openTools('Agent 任务')}>Agent 任务</button>
     <button type="button" onClick={()=>openTools('Runner 实验')}>Runner 实验</button>
     <button type="button" onClick={()=>openTools('扰动控制')}>扰动控制</button>
     <button type="button" onClick={()=>openTools('调度策略与智能体')}>调度策略与智能体</button>
     <button type="button" onClick={()=>openTools('设备进程')}>设备进程与 SDK</button>
    </WorkspaceMenu>
    <WorkspaceMenu label="记录">
     <button type="button" onClick={()=>selectTrace('replay')}>事件回放</button>
     <button type="button" onClick={()=>openTools('实验报告与回放')}>实验报告与回放</button>
     <button type="button" onClick={()=>openTools('完整记录与回放')}>完整记录与回放</button>
     <button type="button" disabled={!s.replay?.canImport} onClick={()=>act('importReplay')}>导入回放</button>
    </WorkspaceMenu>
   </nav>
   <div className="mc-header-actions">
    <div className="mc-header-account"><ConsoleAccount/></div>
    <div className="mc-run-context">
     <span className="mc-source">{s.source}</span>
     <span className={'mc-mission-state'+(s.running||s.manualExecuting?' running':'')}>{status}</span>
    </div>
    <span className="mc-tick">T+{String(s.tick).padStart(4,'0')}</span>
    <button type="button" className="mc-run" disabled={s.playDisabled} onClick={()=>act('play')}>
     {s.running||s.manualExecuting?<Pause size={16} weight="fill"/>:<Play size={16} weight="fill"/>}
     {s.playLabel||(s.running?'暂停':'运行')}
    </button>
    <WorkspaceMenu label="运行选项" icon>
     <button type="button" disabled={s.resetDisabled} onClick={()=>requestRunChange('reset')}>重开当前运行</button>
     {s.connectAvailable&&<button type="button" disabled={s.connectDisabled} onClick={()=>requestRunChange('connect')}>{s.connectLabel||'连接本地世界服务'}</button>}
    </WorkspaceMenu>
   </div>
  </header>
  {!toolsOpen&&serviceFeedback}
  <main className="mc-workspace">
   <div className="mc-left">
    <section className={'mc-stage'+(viewTools?' controls-open':'')+(s.heightfield?' has-heightfield':'')}
     aria-label="仿真场景" data-latest-frame={s.frame>=s.frames-1?true:undefined}>
     <div ref={stage} className="mc-stage-mount"/>
     <button className="mc-view-toggle" type="button" aria-label={viewTools?'隐藏视图工具':'显示视图工具'} aria-expanded={viewTools}
      onClick={()=>setViewTools(!viewTools)} title={s.is3d?'拖动旋转 / 滚轮缩放':undefined}>
      <Crosshair size={17}/>{viewLabel}<CaretDown size={12}/>
     </button>
     {viewToolbar&&createPortal(<button className="btn mc-follow-agent" type="button" aria-pressed={autoFollow}
      onClick={()=>{if(!autoFollow&&focused)select('view','global');setAutoFollow(!autoFollow)}}>自动跟随 Agent</button>,viewToolbar)}
     {s.heightfield&&<div className="mc-terrain-legend">坡度上限 {s.heightfield.maxSlopeDegrees}° · 琥珀区域禁行</div>}
     {!s.available3d&&s.graphicsFailure&&<div className="mc-graphics-note" role="status">
      <Cube size={17}/><div><b>{s.graphicsFailure.title}</b><p>{s.graphicsFailure.body}</p><small>{s.graphicsFailure.help}</small></div>
     </div>}
     {s.observer&&s.available3d&&inspectedAgent&&<div className="mc-scene-camera">
      <canvas key={inspectorWorld} data-device-camera={inspectedAgent.id}/>
      <span>{inspectedAgent.id}</span>
     </div>}
     <span className="mc-stage-agent" data-stage-agent={s.is3d&&!focused?stageAgentId:undefined} aria-hidden="true">{stageAgentId}</span>
     <div className="mc-minimap"><canvas data-world-minimap width="220" height="170" role="img" aria-label="设备位置小地图"/></div>
    </section>
    <section className="mc-console" aria-label="运行记录">
     <div className="mc-trace-header">
      <h2>{traceLabels[trace]}</h2>
      <div className="mc-pane-actions">
       <WorkspaceMenu label="记录视图" icon>
        {Object.entries(traceLabels).map(([key,label])=><button type="button" key={key} aria-pressed={trace===key} onClick={()=>selectTrace(key as TracePane)}>{label}</button>)}
       </WorkspaceMenu>
       <WorkspaceMenu label="任务工具">
        <button type="button" onClick={openDeviceTools}>设备操作</button>
        <button type="button" onClick={()=>openTools('设备通信')}>设备通信</button>
        <button type="button" onClick={()=>openTools('计划审阅')}>任务计划审阅</button>
        <button type="button" onClick={()=>openTools('任务指挥')}>任务指挥与调整</button>
        <button type="button" disabled={s.observer||s.source==='导入回放'} onClick={()=>openTools('人工任务分配')}>人工任务分配</button>
        <button type="button" onClick={()=>{selectTrace('trace');setShowCommand(value=>!value)}}>{showCommand?'隐藏控制指令':'输入控制指令'}</button>
       </WorkspaceMenu>
      </div>
     </div>
     <div className="mc-feed" ref={feed}>
      <AgentRunLink runId={linkedRun} open={openLinkedRun}/>
      {trace==='agent'?<AgentRunTimeline showEmpty={!linkedRun} focusAgent={id=>select('view',id)}/>
       :trace==='nodes'?<CommandNodesPanel view={s.commandNodes} manage={!s.observer&&!focused&&s.source!=='导入回放'&&s.frame===s.frames-1?()=>openTools('指挥节点'):undefined}/>
       :trace==='tasks'?<TaskChainPanel key={inspectorWorld+':'+s.selected} view={s.chain} history={cameraHistory} source={s.source} assignment={s.manual} assign={openTaskAssignment} observe={id=>select('view',id)}/>
       :trace==='replay'?<EventReplayPanel key={(s.replay?.key||s.sceneId)+':'+s.selected} view={s.replay} navigate={(request:ReplayRequest)=>actions.navigateReplay?.(request)} diagnostics={()=>openTools('实验报告与回放')} importFile={()=>actions.replayFile?.('import',s.replay?.key,s.replay?.base)} exportFile={()=>actions.replayFile?.('export',s.replay?.key,s.replay?.base)}/>
       :trace==='attempts'?(recentAttempts.length?recentAttempts.map(item=><ExecutionCard key={item.key} item={item} dispatchLabel={dispatchLabel} onSelect={id=>select('view',id)}/>):<p className="mc-workspace-empty">暂无任务执行记录。</p>)
       :recentEvents.length?<ul className="mc-trace-list">
        {recentEvents.map((event,i)=><li className={event.type==='warning'?'warning':undefined} key={event.seq??i}>
         <time>T+{String(event.tick).padStart(3,'0')}</time><span>{event.message}</span>
        </li>)}
       </ul>:<p className="mc-workspace-empty">{focused?'全局事件在全局观察中显示。':s.done?'暂无运行记录。':'开始运行后，最近事件会显示在这里。'}</p>}
      {trace==='trace'&&response&&<p className="mc-command-response" role="status">{response}</p>}
     </div>
     {trace==='trace'&&showCommand&&<form className="mc-composer" onSubmit={commandSubmit}>
      <input aria-label="控制指令" placeholder="开始、暂停、重置，或设备 ID" value={command} onChange={e=>setCommand(e.target.value)} autoComplete="off"/>
      <button type="submit" className="mc-submit" aria-label="执行控制指令" disabled={!command.trim()}><ArrowUp size={16}/></button>
     </form>}
    </section>
   </div>
   <aside className="mc-devices" aria-label="设备检查">
    <div className="mc-device-header">
     <h2>{deviceLabels[tab]}</h2>
     {tab==='devices'&&<span className="mc-device-count">{s.agents.length+fixedSensors.length} 台</span>}
     <WorkspaceMenu label="设备视图" icon>
      {Object.entries(deviceLabels).filter(([key])=>key!=='materials'||s.constructionConfigured||s.materials).map(([key,label])=><button key={key} type="button" aria-pressed={tab===key} onClick={()=>setTab(key as DevicePane)}>{label}</button>)}
     </WorkspaceMenu>
    </div>
    <div className="mc-device-content">
     {tab==='devices'?<>
      {focusedAgent&&<button type="button" className="mc-back-global" onClick={()=>select('view','global')}>返回全局观察</button>}
      {focused&&s.constructionConfigured&&<p className="mc-construction-scope">施工区仅显示碰撞范围；本机建设任务可在任务链中查看。</p>}
      {(orderedAgents.length>0||fixedSensors.length>0)&&<ul ref={deviceList} className="mc-device-list" aria-label="设备列表">
       {orderedAgents.map(agent=><DeviceRow key={agent.id} agent={agent} selected={inspectedAgent?.id===agent.id} onSelect={()=>inspectDevice(agent.id)}/>)}
       {fixedSensors.map(sensor=><li key={'sensor:'+sensor.id}><button type="button" className="mc-device-row"
        aria-pressed={inspectedSensor?.id===sensor.id} onClick={()=>inspectDevice(sensor.id,'sensor')}>
        <span className="mc-device-row-name"><Broadcast size={19} aria-hidden="true"/><span title={sensor.name}>{sensor.name}</span></span>
        <span>{sensor.reading?'已采集':'等待读数'}</span>
        <span className="mc-device-row-power">{sensor.reading?'T+'+sensor.reading.observedTick:'—'}</span>
       </button></li>)}
      </ul>}
      {inspectedAgent?<section className="mc-device-detail" aria-label={deviceTitle(inspectedAgent)+' 详情'}>
       <div className="mc-device-detail-heading">
        <h3>{deviceTitle(inspectedAgent)}</h3>
        {!focused&&<button type="button" className="mc-follow-device" onClick={()=>select('view',inspectedAgent.id)}><Crosshair size={15}/> 跟随观察</button>}
       </div>
       {inspectedAgent.camera?.enabled&&<>
        <p className="mc-device-camera-label">{inspectedAgent.role==='drone'?'机载视角':'车载视角'}</p>
        <DeviceCamera key={inspectorWorld+':'+cameraMode+':'+inspectedAgent.id} agent={inspectedAgent} frame={s.cameraFrames?.[inspectedAgent.id]??s.renderReplayCamera?.(inspectedAgent.id)}
         available3d={s.available3d} history={cameraHistory} onFrame={cameraMode==='remote'?actions.cameraFrame:undefined}/>
       </>}
       {inspector&&<>
        <DeviceControls key={inspectorWorld+':controls:'+inspectedAgent.id} context={inspector.context}
         inspectorName={deviceTitle(inspectedAgent)} availability={inspector.telemetry.availableActions}
         submit={submitInspectorAction} live={()=>act('live')}/>
        <DeviceObservations key={inspectorWorld+':observations:'+inspectedAgent.id} rows={projectDeviceObservations(inspector.telemetry)}>
         {s.lidarAvailable&&s.remoteSession&&<DeviceLidar
          key={inspectorWorld+':'+s.selected+':'+cameraHistory+':'+inspectedAgent.id}
          agentId={inspectedAgent.id}
          unavailable={s.observer?'只读观察期间可查看设备状态。':cameraHistory?'返回实时视图后可读取测距。':
           s.failed?'世界会话已停止。':inspectedAgent.disabled?'当前设备已退出运行。':''}
          read={(agentId,signal)=>actions.readDeviceLidar(agentId,signal)}/>}
        </DeviceObservations>
       </>}
       <details className="mc-device-extra" key={inspectorWorld+':'+inspectedAgent.id}>
        <summary>能力与遥测</summary>
        <ThermalStatus agent={inspectedAgent}/><RelayStatus agent={inspectedAgent}/>
        <dl className="mc-device-telemetry">
         <div><dt>位置</dt><dd>{inspectedAgent.x.toFixed(1)} / {inspectedAgent.y.toFixed(1)}</dd></div>
         <div><dt>感知 / 通信</dt><dd>{inspectedAgent.sensorRange??'—'} m / {inspectedAgent.communicationRange??'—'} m</dd></div>
         <div><dt>速度</dt><dd>{inspectedAgent.speed===undefined?'—':inspectedAgent.speed.toFixed(1)} u/t</dd></div>
        </dl>
        <DeviceCapabilities agent={inspectedAgent} tasks={inspector?.context.tasks??[]} taskTypes={s.cardTaskTypes} context={inspector?.context}/>
       </details>
      </section>:inspectedSensor?<section className="mc-device-detail" aria-label={inspectedSensor.name+' 详情'}>
       <div className="mc-device-detail-heading"><h3>{inspectedSensor.name}</h3></div>
       <DeviceObservations key={inspectorWorld+':sensor:'+inspectedSensor.id} rows={projectSensorObservations(inspectedSensor,s.events,s.tick)}/>
       <details className="mc-device-extra" key={inspectorWorld+':sensor:'+inspectedSensor.id}>
        <summary>能力与遥测</summary>
        <dl className="mc-device-telemetry">
         <div><dt>位置</dt><dd>{inspectedSensor.pose.x.toFixed(1)} / {inspectedSensor.pose.y.toFixed(1)} / {inspectedSensor.pose.z.toFixed(1)} m</dd></div>
         <div><dt>感知范围</dt><dd>{inspectedSensor.profile.rangeM} m</dd></div>
         <div><dt>采集间隔</dt><dd>{inspectedSensor.profile.intervalTicks} 步</dd></div>
        </dl>
       </details>
      </section>:<p className="mc-workspace-empty">当前场景没有可观察的设备。</p>}
     </>:tab==='data'?<DataFlowPanel key={s.sceneId+':'+s.selected} view={s.flow} source={s.source} frame={s.frame} frames={s.frames} physics={s.physicsMode} execution={s.executionMode} diagnostics={()=>openTools('记录与服务诊断')} messaging={()=>openTools('设备通信')}/>
      :tab==='materials'?<><ConstructionPanel view={s.construction} tasks={()=>selectTrace('tasks')} observe={id=>select('view',id)}/><MaterialPanel view={s.materials}/></>
      :<div className="mc-event-list">{s.events.length?s.events.slice(-40).reverse().map((e,i)=><div key={e.seq??i}><code>T+{e.tick}</code><p>{e.message}</p></div>):<p>{focused?'设备观察不显示全局事件。':'开始运行后显示世界事件。'}</p>}</div>}
    </div>
   </aside>
  </main>
  <dialog className={'mc-tool-dialog'+(worldSettingsOpen?' mc-world-dialog':'')} ref={dialog} aria-labelledby="mc-tool-title"
   onCancel={event=>{event.preventDefault();closeTools()}}>
   <div className="mc-dialog-head">
    <div><SlidersHorizontal size={18}/>{worldSettingsOpen
     ?<h2 id="mc-tool-title">{toolTitle}</h2>
     :<><strong id="mc-tool-title">{toolTitle}</strong><span>3DBOX WORKSPACE</span></>}</div>
    <div>
     {worldSettingsOpen&&connectControl}
     <IconButton label="关闭实验工具" onClick={closeTools}><X size={20}/></IconButton>
    </div>
   </div>
   {toolsOpen&&serviceFeedback}
   <div className="mc-runner-tools" hidden={toolTitle!=='Runner 实验'}><RunnerPanel active={toolsOpen&&toolTitle==='Runner 实验'} canObserve={!s.remoteSession} openReplay={async load=>{await actions.openRunnerReplay(load);closeTools()}} openObserver={async access=>{await actions.openRunnerObserver(access);closeTools()}}/></div>
   <div className="mc-agent-tools" hidden={toolTitle!=='Agent 任务'}><AgentRunPanel active={toolsOpen&&toolTitle==='Agent 任务'} canObserve={!s.remoteSession} observerRunId={s.observerRunId} openReplay={async load=>{await actions.openRunnerReplay(load);setTrace('agent');closeTools()}} openObserver={async (access,id)=>{await actions.openRunnerObserver(access,undefined,id);setTrace('agent');closeTools()}}/></div>
   <div className="mc-standard-tools" hidden={toolTitle==='Runner 实验'||toolTitle==='Agent 任务'}>
    {!worldSettingsOpen&&<div className="mc-tools-quickbar">
     {connectControl}<label htmlFor="mission-speed">运行速度</label>{speedControl}<span>影响推进速度，不改变固定步长</span>
     {!focused&&<button type="button" className="mc-fault-control" disabled={s.faultDisabled??true} onClick={()=>act('fault')}>注入设备退出</button>}
    </div>}
    <div className="mc-tools-body">
     <WorldSettingControls key={'settings-'+(s.settings?.key||'unavailable')} context={s.settings} standalone={worldSettingsOpen}
      runtimeControls={worldSettingsOpen&&<div className="mc-settings-runtime">
       <label htmlFor="mission-speed">运行速度</label>{speedControl}
      </div>}
      edit={(key,field,value)=>actions.editWorldSetting?.(key,field,value)||{ok:false,reason:'context_changed'}}
      submit={(key,op)=>actions.submitWorldSettings?.(key,op)||Promise.resolve({ok:false,reason:'context_changed'})}
      global={()=>select('view','global')} live={()=>act('live')}/>
     <div className="mc-other-tools" hidden={worldSettingsOpen}>
      <ManualAssignment key={'manual-'+(s.manual?.key||'unavailable')} context={s.manual} mode={s.executionMode} requested={assignmentRequest}/>
      <NodeRegistryControls key={'nodes-'+(s.coordination?.key||'unavailable')} context={s.coordination} request={(key,op)=>actions.nodeRegistry?.(key,op)||Promise.resolve({ok:false,reason:'context_changed'})}/>
      <PlanReviewControls key={'plan-'+(s.coordination?.key||'unavailable')} context={s.coordination} view={s.planReview} act={(key,op)=>actions.planReview?.(key,op)||Promise.resolve({ok:false,reason:'context_changed'})} pause={()=>actions.pause?.()}/>
      <TaskCoordinationControls key={'coordination-'+(s.coordination?.key||'unavailable')} context={s.coordination} submit={(key,draft)=>actions.coordinate?.(key,draft)||Promise.resolve({ok:false,reason:'request_failed'})} issue={key=>actions.coordinatorCredential?.(key)||Promise.resolve({ok:false,reason:'request_failed'})} global={()=>select('view','global')} live={()=>act('live')} settings={()=>openTools('场景与世界设置')}/>
      <DeviceControls key={'device-'+(s.device?.key||'unavailable')} context={s.device} submit={(key,agent,draft)=>actions.deviceAction?.(key,agent,draft)||Promise.resolve({ok:false,reason:'request_failed'})} reportSubmit={(key,agent,draft)=>actions.deviceReport?.(key,agent,draft)||Promise.resolve({ok:false,reason:'request_failed'})} credentialIssue={(key,agent,rescueSearch)=>actions.deviceCredential?.(key,agent,rescueSearch)||Promise.resolve({ok:false,reason:'request_failed'})} select={id=>select('deviceagent',id)} live={()=>act('live')}/>
      <DeviceMessageControls key={'messages-'+(s.messages?.key||'unavailable')+':'+s.messages?.selected+':'+s.messages?.focused} context={s.messages} submit={(key,from,draft)=>actions.deviceMessage?.(key,from,draft)||Promise.resolve({ok:false,reason:'context_changed'})} select={id=>select('deviceagent',id)} live={()=>act('live')} data={()=>{setTab('data');closeTools()}}/>
      <WorldDisturbanceControls key={'disturbances-'+(s.disturbances?.key||'unavailable')} context={s.disturbances} submit={(key,draft)=>actions.worldDisturbance?.(key,draft)||Promise.resolve({ok:false,reason:'request_failed'})} live={()=>act('live')} global={()=>select('view','global')}/>
      <div className="mc-legacy-mount" ref={legacy}/>
     </div>
    </div>
   </div>
  </dialog>
  <dialog className="mc-tool-dialog mc-restart-dialog" ref={restartDialog} aria-labelledby="mc-restart-title"
   aria-describedby="mc-restart-notice" onClose={()=>restartOrigin.current?.focus()}>
   <div className="mc-restart-content">
    <h2 id="mc-restart-title">{runChangeTitle}</h2>
    <p id="mc-restart-notice">{runChangeNotice}可以先导出本次回放。</p>
   </div>
   <div className="mc-restart-actions">
    <button type="button" className="mc-pill" autoFocus onClick={()=>restartDialog.current?.close()}>取消</button>
    <button type="button" className="mc-pill" disabled={!s.replay||s.replay.busy||s.replay.pending}
     onClick={exportBeforeRestart}>{focused?'返回全局并导出回放':'导出回放'}</button>
    <button type="button" className="mc-pill violet" disabled={!canChangeRun(runChange,s)} onClick={confirmRunChange}>{runChange==='reset'?'确认重开':'确认切换'}</button>
   </div>
  </dialog>
 </div>
}
const style=document.createElement('style');style.textContent=styles;document.head.append(style);
flushSync(()=>createRoot(document.getElementById('mission-ui-root')!).render(<App/>));
