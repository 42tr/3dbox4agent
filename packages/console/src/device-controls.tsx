import React,{useEffect,useRef,useState} from 'react';
import {BatteryCharging,CaretRight,Robot,Scan} from '@phosphor-icons/react';
import {DeviceReportControls} from './device-report-controls';
import {DeviceProcessControls} from './device-process-controls';
import type {CredentialResult} from './device-credentials';
import type {ReportDraft,ReportResult} from './device-reports';
import {workLabels,canDeviceScan,deviceBlock,taskActionBlock,deviceTaskMovePoint,deviceMessage,deviceReason,type Device,type DeviceAction,type DeviceAvailability,type DeviceContext,type DeviceDraft,type DeviceResult,type FlightLimits,type FlightOperation} from './device-actions';
type Props={context?:DeviceContext;submit:(key:string,agentId:string,draft:DeviceDraft)=>Promise<DeviceResult>;live:()=>void} & (
 {inspectorName:string;availability:DeviceAvailability[];select?:never;reportSubmit?:never;credentialIssue?:never}|
 {inspectorName?:undefined;availability?:undefined;reportSubmit:(key:string,agentId:string,draft:ReportDraft)=>Promise<ReportResult>;credentialIssue:(key:string,agentId:string,rescueSearch?:boolean)=>Promise<CredentialResult>;select:(agentId:string)=>void}
);
const kinds:Record<string,string>={move:'移动',scan:'扫描周边',charge:'返站补能',execute_task:'执行任务',work_task:'当前位置作业',rescue:'现场救援'};
const states:Record<string,string>={pending:'等待执行',accepted:'执行中',completed:'已完成',rejected:'已拒绝',failed:'已失败',cancelled:'已取消'};
const flightNames:Record<FlightOperation,string>={takeoff:'起飞',land:'着陆',hover:'悬停'};
const flightStates:Record<FlightLimits['state'],string>={airborne:'空中',low_altitude:'低空',landed:'已着陆'};
const sections={target:'移动目标',direction:'定向移动',flight:'飞行控制',survey:'地形扫描',task:'已分配任务',rescue:'现场救援'};
type ControlSection=keyof typeof sections;

function actionLabel(action:DeviceAction){
 if(action.operation)return workLabels[action.operation]??action.operation;
 if(action.flight){
  if(action.flight.control)return flightNames[action.flight.control.mode];
  return action.flight.deltaM===undefined?'三维航点':action.flight.deltaM>0?'上升':'下降';
 }
 if(action.direction)return '定向移动';
 if(action.survey?.mode==='terrain_scan')return '地形扫描';
 if(action.survey?.mode==='mark_access_point')return '标记通行点';
 return kinds[action.type]||'设备意图';
}

function actionDetails(action:DeviceAction,actor?:Device){
 const details=[`目标 T+${action.targetTick}`];
 const {flight,direction,result}=action;
 if(action.status==='accepted'){
  if(action.phase==='travel')details.push('返程');
  if(action.phase==='charging')details.push('补能中');
 }
 if(action.type==='rescue'&&action.progress!==undefined)details.push(`作业 ${action.progress}/${actor?.rescueWorkTicks}`);
 if(flight&&!Array.isArray(result?.position)&&result?.position?.z!==undefined)details.push(`高度 ${result.position.z.toFixed(1)} m`);
 if(flight?.control?.mode==='hover'&&result?.heldTicks!==undefined){
  details.push(`已悬停 ${result.heldTicks} / ${flight.control.durationTicks} 步`);
 }else if(flight&&result?.remainingM!==undefined){
  details.push(`剩余 ${result.remainingM.toFixed(1)} m`);
 }
 if(direction&&result?.completedM!==undefined)details.push(`已移动 ${result.completedM.toFixed(1)} / ${direction.distanceM} m`);
 if(action.operation&&action.progress!==undefined)details.push(`作业 ${action.progress} 步`);
 if(result?.quantity!==undefined)details.push(`备件 ${result.quantity} 件`);
 if(result?.consumed!==undefined)details.push(`消耗 ${result.consumed} 件`);
 if(result?.passed)details.push('自检通过');
 if((result?.kind==='access_point'||result?.sampleId)&&Array.isArray(result.position)){
  details.push(`位置 ${result.position.map(n=>n.toFixed(1)).join(' / ')} m`);
 }
 if(action.reason)details.push(deviceReason(action.reason));
 return details.join(' · ');
}

function FlightControlForm({actor,limits,worldSize,disabled,send,unavailable}:{
 actor:Device;limits:FlightLimits;worldSize:number;disabled:boolean;send:(draft:DeviceDraft)=>Promise<void>;unavailable?:(name:string)=>string|undefined;
}){
 const [operation,setOperation]=useState<FlightOperation|null>(null);
 const [height,setHeight]=useState(String(limits.takeoffHeight.default)),[ticks,setTicks]=useState('5');
 const [x,setX]=useState<string|null>(null),[y,setY]=useState<string|null>(null);
 const mode=operation??(limits.state==='landed'?'takeoff':'land');
 const landingX=x??String(actor.x),landingY=y??String(actor.y);
 const needsChange=mode==='takeoff'?limits.state==='airborne':limits.state==='landed';
 const reason=unavailable?.(mode);
 const blocked=disabled||needsChange||!!reason;
 return <form onSubmit={event=>{
  event.preventDefault();
  if(blocked)return;
  if(mode==='takeoff')void send({type:'move',flightControl:{mode,heightM:height}});
  else if(mode==='land')void send({type:'move',flightControl:{mode,x:landingX,y:landingY}});
  else void send({type:'move',flightControl:{mode,durationTicks:ticks}});
 }}>
  <h3>起降与悬停</h3>
  <div className="mc-coordinates">
   <label>飞行操作<select aria-label="飞行操作" value={mode} disabled={disabled} onChange={e=>setOperation(e.target.value as FlightOperation)}>
    <option value="land">着陆</option><option value="takeoff">起飞</option><option value="hover">悬停</option>
   </select></label>
   {mode==='takeoff'&&<label>离地高度（m）<input type="number" min={limits.takeoffHeight.minimum} max={limits.takeoffHeight.maximum} step="any" required value={height} disabled={blocked} onChange={e=>setHeight(e.target.value)}/></label>}
   {mode==='land'&&<>
    <label>落点 X<input type="number" min="0" max={worldSize} step="any" required value={landingX} disabled={blocked} onChange={e=>setX(e.target.value)}/></label>
    <label>落点 Y<input type="number" min="0" max={worldSize} step="any" required value={landingY} disabled={blocked} onChange={e=>setY(e.target.value)}/></label>
   </>}
   {mode==='hover'&&<label>悬停时长（步）<input type="number" min={limits.hoverDuration.minimum} max={limits.hoverDuration.maximum} step="1" required value={ticks} disabled={blocked} onChange={e=>setTicks(e.target.value)}/></label>}
   <button type="submit" className="mc-pill violet" disabled={blocked}>提交{flightNames[mode]}</button>
  </div>
  <p>{reason?deviceReason(reason):needsChange?(mode==='takeoff'?'设备已在空中。':'设备已着陆，请先起飞。')
   :mode==='land'?'选择平坦、空旷的地面落点。'
   :mode==='hover'?'按仿真步计时，完成后保持在原位置。'
   :`垂直飞至离地 ${limits.takeoffHeight.minimum}–${limits.takeoffHeight.maximum} m。`}</p>
 </form>;
}

function RoverSurveyControls({context,actor,disabled,send}:{
 context:DeviceContext;actor:Device;disabled:boolean;send:(draft:DeviceDraft)=>Promise<void>;
}){
 const [bearing,setBearing]=useState('90'),[radius,setRadius]=useState<string>();
 const [selection,setSelection]=useState<{scanId:string;index:number}>();
 const survey=context.roverSurvey!;
 const scan=context.actions.filter(a=>a.agentId===actor.id&&a.result?.kind==='terrain_scan')
  .sort((a,b)=>(b.updatedTick??0)-(a.updatedTick??0))[0];
 const points=scan?.result?.points??[];
 const selected=selection?.scanId===scan?.requestId?selection?.index:undefined;
 const index=selected??points.findIndex(p=>p.traversable);
 const point=points[index];
 const unavailable=actor.status!=='idle'||actor.battery<=5;
 const blocked=disabled||unavailable;
 return <div className="mc-task-control" role="group" aria-label="地形扫描">
  <h3>地形扫描</h3>
  <form onSubmit={e=>{e.preventDefault();void send({type:'scan',survey:{mode:'terrain_scan',bearingDeg:bearing,radiusM:radius??String(Math.min(12,survey.range.maximum))}})}}>
   <div className="mc-coordinates">
    <label>扫描方位角（°）<input type="number" min="0" max="360" step="any" required value={bearing} disabled={blocked} onChange={e=>setBearing(e.target.value)}/></label>
    <label>扫描半径（m）<input type="number" min={survey.range.minimum} max={survey.range.maximum} step="any" required value={radius??Math.min(12,survey.range.maximum)} disabled={blocked} onChange={e=>setRadius(e.target.value)}/></label>
    <button type="submit" className="mc-pill violet" disabled={blocked||survey.range.maximum<survey.range.minimum}>扫描地形</button>
   </div>
  </form>
  <p>{unavailable?'勘察车需空闲且电量高于 5%。':'正北 0°，正东 90°，扫描方位左右各 30°。'}</p>
  {scan&&<>
   <p>T+{scan.result?.observedTick} 测得 {points.length} 个观测点，其中 {points.filter(p=>p.traversable).length} 个可直线通行。</p>
   {points.length>0&&<>
    <label>扫描观测点<select value={index} onChange={e=>setSelection({scanId:scan.requestId,index:Number(e.target.value)})}>
     {index===-1&&<option value={-1}>选择观测点</option>}
     {points.map((p,i)=><option value={i} key={i}>{p.position.map(n=>n.toFixed(1)).join(' / ')} m · {p.traversable?'可通行':'不可通行'}</option>)}
    </select></label>
    {point&&<p>高程 {point.elevationM.toFixed(1)} m · 坡度 {point.slopeDeg.toFixed(1)}°</p>}
    <div className="mc-device-action-buttons"><button type="button" className="mc-pill" disabled={blocked||!point?.traversable}
     onClick={()=>void send({type:'scan',survey:{mode:'mark_access_point',scanRequestId:scan.requestId,pointIndex:index}})}>标记通行点</button></div>
   </>}
  </>}
 </div>;
}

export function DeviceControls({context:c,submit,reportSubmit,credentialIssue,select,live,inspectorName,availability}:Props){
 const inline=inspectorName!==undefined;
 const initialActor=inline?c?.agents.find(a=>a.id===c.selected):undefined;
 const [section,setSection]=useState<ControlSection>('target');
 const [x,setX]=useState(initialActor?.x.toFixed(1)??'48'),[y,setY]=useState(initialActor?.y.toFixed(1)??'50'),[taskId,setTaskId]=useState(''),[rescueId,setRescueId]=useState(''),[pending,setPending]=useState(false),[feedback,setFeedback]=useState<{agent:string;text:string;requestId?:string}|null>(null),[limit,setLimit]=useState(20);
 const [bearing,setBearing]=useState('90'),[distance,setDistance]=useState('5');
 const [z,setZ]=useState(''),[vertical,setVertical]=useState('ascend'),[verticalDistance,setVerticalDistance]=useState('5');
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 if(!c)return null;
 const actor=c.agents.find(a=>a.id===c.selected);
 const block=deviceBlock(c);
 const tasks=c.tasks.filter(t=>t.status==='active');
 const task=tasks.find(t=>t.id===taskId)||tasks[0];
 const taskBlock=taskActionBlock(c,task?.id||'');
 const own=c.actions.filter(a=>a.agentId===c.selected);
 const active=own.filter(a=>['pending','accepted'].includes(a.status))
  .sort((a,b)=>Number(b.status==='accepted')-Number(a.status==='accepted')||a.submittedTick-b.submittedTick);
 const recent=own.filter(a=>!['pending','accepted'].includes(a.status)).slice(-5).reverse();
 const rows=[...active.slice(0,limit),...recent];
 const disabled=!!block||pending||!actor||(inline&&actor.disabled);
 const taskPoint=deviceTaskMovePoint(task,c.worldSize);
 const work=c.mode==='primitive'?task?.workOperation:undefined;
 const verticalLimit=c.flight&&(vertical==='ascend'?c.flight.ascendM:c.flight.descendM);
 const needsTakeoff=!!c.flight&&c.flight.state!=='airborne';
 const contact=c.rescueContacts?.find(t=>t.id===rescueId)||c.rescueContacts?.[0];
 const availableSections:ControlSection[]=['target'];
 if(c.directionRange)availableSections.push('direction');
 if(c.flight)availableSections.push('flight');
 if(c.roverSurvey)availableSections.push('survey');
 if(tasks.length&&c.mode!=='auto')availableSections.push('task');
 if(actor?.rescueWorkTicks)availableSections.push('rescue');
 const currentSection=availableSections.includes(section)?section:'target';
 const show=(id:ControlSection)=>!inline||currentSection===id;
 const unavailable=(name:string)=>{
  const action=availability?.find(item=>item.name===name);
  return action&&!action.available?(action.reason||'agent_unavailable'):undefined;
 };
 const moveReason=unavailable(c.flight&&z?'move_to_3d':'move_to');
 const moveBlocked=disabled||needsTakeoff||!!moveReason||!!(c.flight&&z&&active.length);
 const directionBlock=unavailable('move_direction');
 const verticalBlock=unavailable(vertical==='ascend'?'ascend':'descend');
 const scanBlock=unavailable('scan'),chargeBlock=unavailable('charge');
 const send=async(draft:DeviceDraft)=>{
  if(disabled||!actor)return;
  const id=actor.id;
  setPending(true);
  setFeedback({agent:id,text:'正在提交…'});
  try{
   const r=await submit(c.key,id,draft);
   if(!alive.current)return;
   const text=r.ok?(r.refreshPending?'世界已接收本次请求，状态同步尚未完成，请查看实时动作记录。'
    :r.cancelled?'取消请求已处理，请查看动作终态。':`意图已提交，计划在T+${r.targetTick}处理；执行结果见动作记录。`)
    :deviceMessage(r.reason);
   setFeedback({agent:id,text,requestId:r.ok&&!r.refreshPending?r.requestId:undefined});
  }catch{
   if(alive.current)setFeedback({agent:id,text:deviceMessage()});
  }finally{
   if(alive.current)setPending(false);
  }
 };
 const showFeedback=feedback?.agent===c.selected&&(!block||pending&&block==='busy')
  &&(!inline||!feedback.requestId||!rows.some(action=>action.requestId===feedback.requestId));
 const history=<>
  {rows.length?<ul>{rows.map(a=><li key={a.requestId}>
   <div><strong>{actionLabel(a)}</strong><span className={'mc-action-state '+a.status}>{states[a.status]||a.status}</span><code>{a.requestId}</code></div>
   <p>{actionDetails(a,actor)}</p>
   {['pending','accepted'].includes(a.status)&&<button className="mc-pill" disabled={disabled}
    onClick={()=>void send({type:'cancel',requestId:a.requestId})} aria-label={'取消动作 '+a.requestId}>取消动作</button>}
  </li>)}</ul>:<p className="mc-device-action-empty">当前快照中没有该设备的动作记录。</p>}
  {active.length>limit&&<button className="mc-pill" onClick={()=>setLimit(n=>n+20)}>显示更多待处理动作</button>}
 </>;
 return <section className={inline?'mc-inline-device-actions':'mc-device-actions'} aria-label="设备操作">
  {inline?<div className="mc-inspector-heading"><h4>设备操作</h4><span>{inspectorName}</span></div>
   :<div className="mc-assignment-heading"><Robot size={16}/><h2>设备操作</h2><span>移动、扫描、补能与任务执行</span></div>}
  {block&&!(block==='busy'&&pending)&&<p className={inline?'mc-inspector-note':'mc-assignment-notice'}>{deviceMessage(block)} {block==='history_view'&&<button type="button" className="mc-pill" onClick={live}>返回设备实时视图</button>}</p>}
  {!inline&&select&&<div className="mc-device-action-select"><label>操作设备<select aria-label="操作设备" value={c.selected} disabled={pending||c.busy||!c.agents.length} onChange={e=>{select(e.target.value);setFeedback(null);setTaskId('');setZ('');setLimit(20)}}>{c.agents.length?c.agents.map(a=><option key={a.id} value={a.id}>{a.name} · {a.id}{a.disabled?' · 已退出':''}</option>):<option value="">暂无可见设备</option>}</select></label>{actor&&<span>{actor.status}{c.flight&&` · ${flightStates[c.flight.state]}`}{actor.mobility==='water'?' · 水面设备':''} · 电量{Math.round(actor.battery)}% · 位置 {actor.x.toFixed(1)} / {actor.y.toFixed(1)}{actor.flightZ!==undefined&&` / ${actor.flightZ.toFixed(1)}`} m{actor.maxSpeedMPerTick!==undefined&&` · 上限 ${actor.maxSpeedMPerTick} m/步`}</span>}</div>}
  {inline&&<>
   <div className="mc-inline-shortcuts">
    {actor&&canDeviceScan(actor)&&<button type="button" className="mc-capability-command" disabled={disabled||!!scanBlock}
      title={!block&&scanBlock?deviceReason(scanBlock):undefined} onClick={()=>void send({type:'scan'})}>
     <Scan size={15} aria-hidden="true"/>扫描周边
    </button>}
    <button type="button" className="mc-capability-command" disabled={disabled||!!chargeBlock}
      title={!block&&chargeBlock?deviceReason(chargeBlock):undefined} onClick={()=>void send({type:'charge'})}>
     <BatteryCharging size={15} aria-hidden="true"/>返站补能
    </button>
   </div>
   {availableSections.length>1&&<div className="mc-inline-modes" role="group" aria-label="操作类别">
    {availableSections.map(id=><button type="button" key={id} aria-pressed={currentSection===id}
      onClick={()=>setSection(id)}>{sections[id]}</button>)}
   </div>}
  </>}
  <div className="mc-device-action-grid">
   {show('target')&&<form onSubmit={e=>{e.preventDefault();if(!moveBlocked)void send({type:'move',x,y,z:c.flight?z:undefined})}}>
    {(!inline||availableSections.length===1)&&<h3>移动目标</h3>}
    <div className="mc-coordinates">
     <label>{inline?'X（m）':'X'}<input aria-label="移动目标 X" type="number" min="0" max={c.worldSize??100} step="any" required value={x} disabled={disabled} onChange={e=>setX(e.target.value)}/></label>
     <label>{inline?'Y（m）':'Y'}<input aria-label="移动目标 Y" type="number" min="0" max={c.worldSize??100} step="any" required value={y} disabled={disabled} onChange={e=>setY(e.target.value)}/></label>
     {c.flight&&<label>{inline?'高度（m）':'Z（m）'}<input aria-label="航点高度 Z" type="number" min={c.flight.altitudeRange.minimum} max={c.flight.altitudeRange.maximum} step="any" placeholder="保持高度" value={z} disabled={disabled} onChange={e=>setZ(e.target.value)}/></label>}
     <button type="submit" className="mc-pill violet" disabled={moveBlocked}>{c.flight&&z?'提交三维航点':inline?'提交移动':'提交移动意图'}</button>
    </div>
    {inline&&!block&&moveReason&&<p>{deviceReason(moveReason)}</p>}
   </form>}
   {show('direction')&&c.directionRange&&<form onSubmit={e=>{e.preventDefault();if(!directionBlock)void send({type:'move',bearingDeg:bearing,distanceM:distance})}}>
    {!inline&&<h3>定向移动</h3>}
    <div className="mc-coordinates">
     <label>方位角（°）<input type="number" min="0" max="360" step="any" required value={bearing} disabled={disabled} onChange={e=>setBearing(e.target.value)}/></label>
     <label>距离（m）<input type="number" min={c.directionRange.minimum} max={c.directionRange.maximum} step="any" required value={distance} disabled={disabled} onChange={e=>setDistance(e.target.value)}/></label>
     <button type="submit" className="mc-pill violet" disabled={disabled||needsTakeoff||actor?.disabled||active.length>0||!!directionBlock}>提交定向移动</button>
    </div>
    <p>{inline&&!block&&directionBlock?deviceReason(directionBlock):`正北 0°，正东 90°。单次 ${c.directionRange.minimum}–${c.directionRange.maximum} m。`}</p>
   </form>}
   {show('flight')&&c.flight&&<form onSubmit={e=>{e.preventDefault();if(!verticalBlock)void send({type:'move',deltaM:vertical==='descend'?'-'+verticalDistance:verticalDistance})}}>
    <h3>垂直飞行</h3>
    <div className="mc-coordinates">
     <label>方向<select aria-label="升降方向" value={vertical} disabled={disabled} onChange={e=>setVertical(e.target.value)}>
      <option value="ascend">上升</option><option value="descend">下降</option>
     </select></label>
     <label>升降距离（m）<input type="number" min={c.flight.minimumDeltaM} max={verticalLimit} step="any" required value={verticalDistance} disabled={disabled} onChange={e=>setVerticalDistance(e.target.value)}/></label>
     <button type="submit" className="mc-pill violet" disabled={disabled||needsTakeoff||actor?.disabled||active.length>0||!!verticalBlock||verticalLimit===undefined||verticalLimit<c.flight.minimumDeltaM}>提交{vertical==='ascend'?'上升':'下降'}</button>
    </div>
    <p>{inline&&!block&&verticalBlock?deviceReason(verticalBlock):`当前高度允许${vertical==='ascend'?'上升':'下降'}至多 ${verticalLimit?.toFixed(1)} m。`}</p>
   </form>}
   {show('flight')&&actor&&c.flight&&<FlightControlForm key={actor.id} actor={actor} limits={c.flight} worldSize={c.worldSize??100}
    disabled={disabled||actor.disabled||active.length>0} send={send} unavailable={inline&&!block?unavailable:undefined}/>}
   {!inline&&<div className={c.directionRange?'mc-task-control':undefined}><h3>感知与补能</h3><div className="mc-device-action-buttons">{actor&&canDeviceScan(actor)&&<button className="mc-pill" disabled={disabled} onClick={()=>void send({type:'scan'})}>提交扫描意图</button>}<button className="mc-pill" disabled={disabled} onClick={()=>void send({type:'charge'})}>提交补能意图</button></div><p>意图先入队，设备状态与执行条件在目标步再次校验。</p></div>}
   {show('survey')&&actor&&c.roverSurvey&&<RoverSurveyControls key={c.key+':'+actor.id} context={c} actor={actor}
    disabled={disabled||active.length>0} send={send}/>}
   {show('task')&&<div className="mc-task-control"><h3>已分配任务</h3><select aria-label="设备已分配任务" value={task?.id||''} disabled={disabled||!tasks.length} onChange={e=>setTaskId(e.target.value)}>{tasks.length?tasks.map(t=><option key={t.id} value={t.id}>{t.name}</option>):<option value="">暂无活动任务</option>}</select><div className="mc-device-action-buttons"><button className="mc-pill violet" disabled={disabled||!!taskBlock||(inline&&!!unavailable(work?.operation||(c.mode==='primitive'?'work_task':'execute_task')))} onClick={()=>task&&void send({type:c.mode==='primitive'?'work_task':'execute_task',taskId:task.id,operation:work?.operation})}>{work?('提交'+work.label):c.mode==='primitive'?'提交当前位置作业':'提交任务启动意图'}</button>{c.mode==='primitive'&&<button className="mc-pill" disabled={disabled||!taskPoint} onClick={()=>{if(taskPoint){setSection('target');setX(String(taskPoint[0]));setY(String(taskPoint[1]));setZ('');setFeedback({agent:c.selected,text:task?.approachPoint?'已填入合法接近点，请提交移动意图。':'已填入作业地点，请提交移动意图。'})}}}>{task?.approachPoint!==undefined?'填入合法接近点':'填入设备作业地点'}</button>}</div><p>{taskBlock?deviceMessage(taskBlock):work?`当前工序需要 ${work.durationTicks} 个仿真步。`:c.mode==='primitive'?'已到达作业范围，可以提交作业意图。':'任务将在接受启动意图后执行。'}</p></div>}
  </div>
  {show('rescue')&&actor?.rescueWorkTicks&&<div className="mc-task-control mc-device-rescue" aria-label="现场救援"><h3>现场救援</h3><p>接近本机观测到的故障设备，距离4米内完成{actor.rescueWorkTicks}步作业。目标电量保持原值。</p><select aria-label="救援目标" value={contact?.id||''} disabled={disabled||!c.rescueContacts?.length} onChange={e=>setRescueId(e.target.value)}>{c.rescueContacts?.length?c.rescueContacts.map(t=><option key={t.id} value={t.id}>{t.id} · 第{t.faultGeneration}次故障 · 观测于T+{t.observedTick}</option>):<option value="">本机尚未观测到故障设备</option>}</select><div className="mc-device-action-buttons"><button className="mc-pill" disabled={disabled||!contact} onClick={()=>{if(contact){setSection('target');const dx=actor.x-contact.x,dy=actor.y-contact.y,d=Math.hypot(dx,dy)||1;setX(String(Math.max(0,Math.min(100,contact.x+dx/d*3))));setY(String(Math.max(0,Math.min(100,contact.y+dy/d*3))));setFeedback({agent:c.selected,text:'已填入距观测位置3米的接近点，请提交移动意图；路径由世界校验。'})}}}>填入救援接近点</button><button className="mc-pill violet" disabled={disabled||!contact||(inline&&(!!unavailable('rescue')||Math.hypot(actor.x-contact.x,actor.y-contact.y)>4))} onClick={()=>contact&&void send({type:'rescue',targetAgentId:contact.id,observedTick:contact.observedTick,faultGeneration:contact.faultGeneration})}>提交现场救援意图</button></div></div>}
  {showFeedback&&<p className="mc-assignment-feedback" role="status">{feedback.text}</p>}
  {inline?<details className="mc-inline-action-history">
   <summary><strong>动作记录</strong><span aria-live="polite">{rows[0]?actionLabel(rows[0])+' · '+(states[rows[0].status]||rows[0].status):'暂无记录'}<CaretRight size={13} aria-hidden="true"/></span></summary>
   <div className="mc-action-history">{history}</div>
  </details>:<div className="mc-action-history"><h3>动作记录 <small>待处理{active.length} · 最近终态{recent.length}</small></h3>{history}</div>}
  {!inline&&actor?.operatingEnergyPerTick!==undefined&&<p className="mc-report-hint" aria-label="基础运行耗电">基础耗电：{actor.operatingEnergyPerTick} 电量单位/步 · 累计 {actor.operatingState?.energySpent?.toFixed(3)??'未记录'}。移动和作业另计。</p>}
  {!inline&&c.roverSurvey?.sampleCapacity!==undefined&&<p className="mc-report-hint">
   采样仓已用 {c.reports?.samples.length??0} / {c.roverSurvey.sampleCapacity} 槽 · 样本及送达状态见证据报告
  </p>}
  {!inline&&reportSubmit&&select&&<DeviceReportControls key={'reports-'+c.selected} context={c} submit={reportSubmit} select={select}/>}
  {!inline&&credentialIssue&&select&&<DeviceProcessControls key={'process-'+c.selected} context={c} issue={credentialIssue} select={select}/>}
 </section>;
}
