import React,{useState} from 'react';
import {ArrowLeft,ArrowRight,ClockCounterClockwise} from '@phosphor-icons/react';
import type {ReplayView,ReplayRequest} from './event-replay';
type Props={view?:ReplayView;navigate:(request:ReplayRequest)=>void;diagnostics:()=>void;importFile?:()=>void;exportFile?:()=>void};
export function EventReplayPanel({view,navigate,diagnostics,importFile,exportFile}:Props){
 const [query,setQuery]=useState(''),[level,setLevel]=useState('all'),[page,setPage]=useState(0),[unit,setUnit]=useState<'frame'|'tick'>('frame');
 if(!view)return <p className="mc-chain-empty">快照记录尚未载入。</p>;
 const rows=view.events.filter(e=>(level==='all'||e.level===level)&&(!query.trim()||[e.message,e.kind,e.agentId,e.taskId,String(e.seq??'')].some(s=>s?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))),pages=Math.max(1,Math.ceil(rows.length/30)),current=Math.min(page,pages-1),shown=rows.slice(current*30,(current+1)*30),disabled=view.busy||view.pending||!view.frames;
 const send=(request:any)=>navigate({key:view.key,scope:view.scope,base:view.base,...request});
 return <section className="mc-replay-panel" aria-label="事件与快照回放"><div className="mc-chain-header"><span>事件回放 <code>T+{view.tick}</code></span><small>{view.imported?'导入记录':view.observer?'只读世界记录':'当前运行记录'} · 快照 {view.frame+1}/{view.frames}</small></div>
  <div className="mc-replay-navigation"><label>步进单位<select aria-label="回放步进单位" value={unit} onChange={e=>setUnit(e.target.value as 'frame'|'tick')}><option value="frame">逐快照</option><option value="tick">逐仿真步</option></select></label><button className="mc-pill" disabled={disabled||view.frame===0} onClick={()=>send({kind:'step',direction:-1,mode:unit})}><ArrowLeft size={11}/> 上一个</button><button className="mc-pill" disabled={disabled||view.frame===view.frames-1} onClick={()=>send({kind:'step',direction:1,mode:unit})}>下一个 <ArrowRight size={11}/></button><button className="mc-pill" disabled={disabled||view.frame===view.frames-1} onClick={()=>send({kind:'latest'})}>最新快照</button><button className="mc-pill" onClick={diagnostics}>完整记录工具</button>{view.scope==='global'&&<><button className="mc-pill" disabled={!view.canImport||disabled} title={view.canImport?'导入本机JSON回放':'请先切换浏览器预览，再导入回放。'} onClick={importFile}>导入回放</button><button className="mc-pill" disabled={!view.canExport||disabled} onClick={exportFile}>导出回放</button></>}</div>
  <p className="mc-chain-hint">逐仿真步定位相邻一步的最后保留快照；同一步可能有多个版本。{view.observer?'这里只改变观察位置，不暂停服务端世界。':'运行中定位历史快照会先暂停。'}</p>
  {view.fileNotice&&view.scope==='global'&&<p className="mc-chain-hint" role="status">{view.fileNotice}</p>}
  {view.offline&&<p className="mc-replay-notice">服务不可用；仅查看已收到的保留快照。</p>}
  {view.notice&&<p className="mc-replay-notice" role="status">{view.notice}</p>}
  {view.scope!=='global'?<p className="mc-chain-empty">设备观察不提供全局事件记录；可逐快照查看本机历史，或返回全局观察。</p>:<><p className="mc-chain-hint">以下列出整段保留记录，包含晚于当前观察位置的事件。定位首个包含事件的快照；采样或缺失历史时，不等于发生瞬间。</p>
   <div className="mc-chain-filters"><label>查找<input aria-label="查找回放事件" value={query} placeholder="事件、任务或设备ID" onChange={e=>{setQuery(e.target.value);setPage(0)}}/></label><label>级别<select aria-label="回放事件级别" value={level} onChange={e=>{setLevel(e.target.value);setPage(0)}}><option value="all">全部级别</option><option value="info">信息</option><option value="success">成功</option><option value="warning">警告</option><option value="error">错误</option></select></label><small>{rows.length}/{view.events.length} 条</small>{(query||level!=='all')&&<button className="mc-pill" onClick={()=>{setQuery('');setLevel('all');setPage(0)}}>清除事件筛选</button>}</div>
   <ol className="mc-replay-events" aria-label="保留事件记录">{shown.map(e=><li key={e.id} className={e.level}><div><code>T+{e.tick}{e.seq!==undefined?' · #'+e.seq:''}</code><b>{e.message}</b><small>{[e.kind,e.agentId,e.taskId].filter(Boolean).join(' · ')}</small></div><button className="mc-pill" disabled={disabled} onClick={()=>send({kind:'event',id:e.id})} aria-label={'定位事件 '+e.message}><ClockCounterClockwise size={12}/> 定位</button></li>)}</ol>
   {!rows.length&&<p className="mc-chain-empty">{view.events.length?'当前筛选下暂无事件。':'保留记录中暂无事件。'}</p>}
   {pages>1&&<div className="mc-replay-pages"><button className="mc-pill" disabled={current===0} onClick={()=>setPage(current-1)}>上一页事件</button><span>{current+1}/{pages}</span><button className="mc-pill" disabled={current===pages-1} onClick={()=>setPage(current+1)}>下一页事件</button></div>}
  </>}
 </section>;
}
