import React,{useEffect,useRef,useState} from 'react';
import type {CoordinatorContext} from './task-coordination';
import {planBlock,planMessage,type PlanOperation,type PlanResult,type PlanView} from './plan-review';
type Props={context?:CoordinatorContext;view?:PlanView;act:(key:string,op:PlanOperation)=>Promise<PlanResult>;pause:()=>void};
const labels:Record<string,string>={draft:'草稿',reviewed:'已审阅',submitting:'请求处理中',accepted:'提交回执：已接受',pending:'提交回执：在途',rejected:'提交回执：被拒绝',failed:'提交回执：失败',unknown:'本次响应未确认',blocked:'未提交',skipped:'未发送'};
export function PlanReviewControls({context:c,view:v,act,pause}:Props){
 const [taskId,setTaskId]=useState(''),[agentId,setAgentId]=useState(''),[pending,setPending]=useState(false),[feedback,setFeedback]=useState(''),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 if(!c||!v||v.key!==c.key)return null;
 const block=planBlock(c),hidden=c.observer||c.focused||c.imported||!c.latest;
 if(hidden)return <section id="command-plan" className="mc-plan-review" aria-label="任务分配计划审阅"><h2 tabIndex={-1}>任务分配计划审阅</h2><p>{planMessage(block||undefined)}</p></section>;
 const ended=v.phase==='submitted'||v.phase==='stopped',tasks=c.tasks.filter(t=>!v.rows.some(r=>r.taskId===t.id)),task=taskId?tasks.find(t=>t.id===taskId):tasks[0],agents=task?.candidates.filter(a=>!v.rows.some(r=>r.agentId===a.id))||[],agent=agentId?agents.find(a=>a.id===agentId):agents[0];
 const run=async(op:PlanOperation)=>{if(pending&&op.kind!=='stop')return;if(op.kind!=='stop')setPending(true);setFeedback(op.kind==='confirm'?'正在逐条提交已审阅计划…':'');try{const result=await act(c.key,op);if(!alive.current)return;
  setFeedback(result.ok?op.kind==='confirm'?'提交阶段已结束，请查看各条指令的实际送达和执行记录。':op.kind==='review'?'已生成审阅快照；确认后才会发送指令。':op.kind==='discard'?'本地计划已清除；已发送的世界记录保持不变。':op.kind==='stop'?planMessage('stop_requested'):'草稿已更新，世界状态未改变。':planMessage(result.reason));if(result.ok&&op.kind==='add'){setTaskId('');setAgentId('')}
 }catch{if(alive.current)setFeedback(planMessage('request_failed'))}finally{if(op.kind!=='stop'&&alive.current)setPending(false)}};
 return <section id="command-plan" className="mc-plan-review" aria-label="任务分配计划审阅"><h2 tabIndex={-1}>任务分配计划审阅</h2><p>先将当前可分配的任务加入本地草稿，暂停后审阅并确认。每份最多8项，每台设备只安排一项；未来依赖任务需待条件满足后另行规划。每条指令仍由世界独立校验。</p>
  {block&&block!=='busy'&&<p>{planMessage(block)}{block==='pause_required'&&<button className="mc-pill" onClick={pause}>暂停世界</button>}</p>}
  {!hidden&&<>
   <p role="status" aria-live="polite">{feedback||v.notice&&planMessage(v.notice)}</p>
   {!ended&&<form onSubmit={e=>{e.preventDefault();if(task&&agent)void run({kind:'add',taskId:task.id,agentId:agent.id})}}><fieldset disabled={!!block||pending||v.phase==='submitting'}><label>草稿任务<select aria-label="草稿任务" value={task?.id||''} onChange={e=>{setTaskId(e.target.value);setAgentId('')}}><option value="">请选择当前可分配任务</option>{tasks.map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</select></label><label>草稿执行设备<select aria-label="草稿执行设备" value={agent?.id||''} onChange={e=>setAgentId(e.target.value)}><option value="">请选择候选设备</option>{agents.map(a=><option value={a.id} key={a.id}>{a.name} · {a.id}{a.age!==undefined?' · '+a.age+'步前报告':''}</option>)}</select></label><button className="mc-pill" disabled={!task||!agent||v.rows.length>=8}>加入本地草稿</button></fieldset></form>}
   <ol className="mc-plan-rows">{v.rows.map(r=><li key={r.id}><div><strong>{r.taskName} → {r.agentName}</strong><small>{r.taskId} · {r.agentId}{r.target?' · 目标 '+r.target.join(' / '):''}{r.capability?' · 能力 '+r.capability:''}{r.priority!==undefined?' · 优先级 '+r.priority:''}{r.deadline!==undefined?' · 截止T+'+r.deadline:''}{r.reportAge!==undefined?' · 报告年龄 '+r.reportAge+'步':''}</small><span>{labels[r.stage]}</span>{r.requestId&&<small>请求 {r.requestId} · 当前世界记录：{r.currentStatus?labels[r.currentStatus]?.replace('提交回执：','')||r.currentStatus:'尚未匹配到保留记录'}</small>}{r.reason&&<small>{planMessage(r.reason)}</small>}</div>{!ended&&v.phase!=='submitting'&&<button className="mc-pill" disabled={!!block||pending} onClick={()=>void run({kind:'remove',rowId:r.id})}>移除 {r.taskName}</button>}</li>)}</ol>
   {v.review&&<p>审阅快照 T+{v.review.tick} · 世界版本 {v.review.worldRevision} · {v.review.mode} · {v.review.executionMode} · 草稿版本 {v.version}{v.phase==='reviewed'&&!v.reviewValid?' · 已变化，需重新审阅':''}</p>}
   <div className="mc-plan-actions">{!ended&&v.phase!=='submitting'&&<><button className="mc-pill" disabled={!!block||pending||!v.rows.length} onClick={()=>void run({kind:'review'})}>生成审阅快照</button><button className="mc-pill violet" disabled={!!block||pending||!v.reviewValid} onClick={()=>void run({kind:'confirm',planId:v.id,version:v.version})}>确认并逐条提交 {v.rows.length} 项</button></>}
    {v.phase==='submitting'&&<button className="mc-pill" disabled={v.stopRequested} onClick={()=>void run({kind:'stop',planId:v.id})}>停止后续提交</button>}
    <button className="mc-pill" disabled={pending||v.phase==='submitting'||!v.rows.length} onClick={()=>void run({kind:'discard'})}>{ended?'清除本地计划':'撤销未提交草稿'}</button></div>
   <p>确认后逐条提交；出现变化、失败或结果未确认时停止后续条目。停止按钮不会撤回当前请求或已接受的任务；已接受分配请到“任务指挥”按当前分配版本撤回。在途回执表示指令已排队，实际送达与执行仍需查看世界记录。</p>
  </>}
 </section>;
}
