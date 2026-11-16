import React,{useState} from 'react';
import {Lightning,LockKey,Play} from '@phosphor-icons/react';
import {deviceBlock,deviceMessage,type DeviceContext,type DeviceDraft,type DeviceResult} from './device-actions';

type DeviceCardAgent={id:string;capabilities?:string[];disabled?:boolean};
type MissionTask={id:string;name?:string;status?:string;capability?:string;behavior?:string;assignee?:string};
type Props={agent:DeviceCardAgent;tasks?:MissionTask[];context?:DeviceContext;invoke:(agentId:string,draft:DeviceDraft)=>Promise<DeviceResult>};

const labels:Record<string,string>={inspect:'巡检',confirm:'确认',scan:'扫描',charge:'补能',sample:'采样',deliver:'运输',repair:'维修',verify:'复核',relay:'中继',build:'建造',rescue:'救援'};
const simpleCapabilities=new Set(['inspect','confirm','scan','charge']);

function taskFor(agent:DeviceCardAgent,capability:string,tasks:MissionTask[],mode:string|undefined){
 if(!['agent','primitive'].includes(mode||''))return null;
 return tasks.find(task=>task.status==='active'&&task.assignee===agent.id&&(task.capability===capability||task.behavior===capability))||null;
}

function actionFor(agent:DeviceCardAgent,capability:string,tasks:MissionTask[],mode:string|undefined):{draft:DeviceDraft;detail:string}|null{
 if(simpleCapabilities.has(capability))return {draft:{type:capability==='charge'?'charge':'scan'},detail:capability==='charge'?'补能意图':'扫描意图'};
 const task=taskFor(agent,capability,tasks,mode);
 if(task)return {draft:{type:mode==='primitive'?'work_task':'execute_task',taskId:task.id},detail:task.name?`执行「${task.name}」`:'执行任务'};
 return null;
}

export function DeviceCapabilities({agent,tasks=[],context:c,invoke}:Props){
 const [pending,setPending]=useState<string|null>(null),[feedback,setFeedback]=useState<{capability:string;text:string}|null>(null);
 const capabilities=[...(agent.capabilities||[])];
 if(!capabilities.length)return <div className="mc-capabilities mc-capabilities-empty"><span className="mc-capability-label">CAP</span><span>未声明可调用能力</span></div>;
 const blocked=c?deviceBlock(c):'context_changed';
 const mode=c?.mode;
 const call=async(capability:string,draft:DeviceDraft)=>{
  if(blocked||pending)return;
  setPending(capability);setFeedback({capability,text:'正在提交…'});
  try{
   const result=await invoke(agent.id,draft);
   setFeedback({capability,text:result.ok?`已提交 · ${actionFor(agent,capability,tasks,mode)?.detail||'已调用'}`:deviceMessage(result.reason)});
  }catch{setFeedback({capability,text:deviceMessage()})}finally{setPending(null)}
 };
 return <div className="mc-capabilities" aria-label={`${agent.id} 可调用能力`} onClick={event=>event.stopPropagation()}>
  <div className="mc-capabilities-heading"><span className="mc-capability-label">CAP</span><span>可调用能力</span><small>{capabilities.length}</small></div>
  <div className="mc-capability-list">
   {capabilities.map(capability=>{
    const action=actionFor(agent,capability,tasks,mode),label=labels[capability]||capability,waiting=pending===capability;
    if(!action)return <span className="mc-capability-chip needs-args" key={capability} data-capability={capability} title="该能力需要参数，已跳过参数输入"><LockKey size={10}/><span>{label}</span><code>{capability}</code><small>需参数</small></span>;
    return <button type="button" className="mc-capability-chip callable" key={capability} data-capability={capability} disabled={!!blocked||!!pending||!!agent.disabled} title={`调用${label} · ${action.detail}`} onKeyDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();void call(capability,action.draft)}}>{waiting?<Play size={10} weight="fill"/>:<Lightning size={10} weight="fill"/>}<span>{label}</span><code>{capability}</code></button>;
   })}
  </div>
  {feedback&&feedback.capability&&<p className="mc-capability-feedback" role="status" aria-live="polite">{feedback.text}</p>}
 </div>;
}
