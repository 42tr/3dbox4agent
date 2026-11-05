import React,{useState} from 'react';
import {Pulse,FileText} from '@phosphor-icons/react';
import {flowChannels,flowReason,filterFlow,type FlowView} from './data-flow';
import {CommunicationRecoveryPanel} from './communication-recovery-panel';
const states={pending:'在途',delivered:'已送达',failed:'失败'};
export function DataFlowPanel({view,source,frame,frames,physics,execution,diagnostics,messaging}:{view?:FlowView;source:string;frame:number;frames:number;physics?:string;execution?:string;diagnostics:()=>void;messaging?:()=>void}){
 const [channel,setChannel]=useState('all'),[state,setState]=useState('all');
 if(!view)return <div className="mc-stream"><p>通信快照尚未载入。</p></div>;
 const filtered=filterFlow(view,channel,state),r=view.reporting,focused=view.scope!==null;
 return <section className="mc-stream" aria-label="快照通信数据">
  <div className="mc-stream-heading"><Pulse size={15}/><b>快照通信</b><code>T+{view.tick}</code></div>
  <p className="mc-flow-scope">{focused?'仅限 '+(view.scope||'所选设备')+' 的收件箱与本人报告。':'全局快照 · 设备、指挥者与固定传感器。'}{frame<frames-1||source==='导入回放'?' 当前为历史记录。':''}</p>
  <div className="mc-flow-caption">当前可见记录</div>
  <div className="mc-flow-totals" aria-label="当前可见通信记录"><div><small>在途</small><b>{view.pending}</b></div><div><small>已送达</small><b>{view.delivered}</b></div><div><small>失败</small><b>{view.failed}</b></div></div>
  {r&&<div className="mc-flow-reporting"><div><b>延迟状态报告{!r.active?' · 已停用':''}</b><span>{r.fresh} / {r.stored} 份有效</span></div><p>累计发出 {r.sent} · 送达 {r.delivered} · 失败 {r.failed} · 在途 {r.pending}</p><small>按采集时刻计算，有效期 {r.maxAge} 步；列表保留各设备最近一份回执。</small></div>}
  {!!view.outages.length&&<div className="mc-flow-outages">{view.outages.map(o=><p key={o.agentId}>{o.agentId} 通信中断 · 至 T+{o.until}</p>)}</div>}
  {!focused&&<CommunicationRecoveryPanel view={view.recovery}/>}
  <div className="mc-flow-filters"><label>通道<select aria-label="通信通道" value={channel} onChange={e=>setChannel(e.target.value)}><option value="all">全部通道</option>{flowChannels.filter(c=>!focused||['peer','scan','sample'].includes(c.id)).map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label><label>状态<select aria-label="通信状态" value={state} onChange={e=>setState(e.target.value)}><option value="all">全部状态</option>{Object.entries(states).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
  <div className="mc-flow-count">显示 {filtered.rows.length} / {filtered.total} 条可见记录</div>
  <div className="mc-flow-records">{filtered.rows.map(row=><article className={'mc-flow-record '+row.state} key={row.key}><header><span>{flowChannels.find(c=>c.id===row.channel)?.label}</span><code>{row.id.startsWith('latest:')?'最近回执':'#'+row.id}</code><b>{states[row.state]}{row.stale?' · 已过期':''}</b></header><div className="mc-flow-route"><code>{row.from}</code><span>→</span><code>{row.to}</code></div><p><time>T+{row.tick}</time>{row.captured!==undefined&&<span>采集 T+{row.captured}</span>}{row.due!==undefined&&row.state==='pending'&&<span>最早 T+{row.due}</span>}{row.expires!==undefined&&row.state==='pending'&&<span>截止 T+{row.expires}</span>}</p>{row.task&&<p>任务 <code>{row.task}</code></p>}{!!row.via?.length&&<p>中继路径 {row.via.join(' → ')}</p>}{row.reason&&<p className="mc-flow-reason">{flowReason(row.reason)}</p>}</article>)}{!filtered.total&&<p className="mc-flow-empty">{!view.available?'当前设备的通信观察不可用。':view.rows.length?'当前筛选下暂无记录。':'当前快照暂无可见通信记录。'}</p>}</div>
  <p>记录来自所选快照，并非完整网络抓包。历史收件箱与最近报告会被替换；失败数仅统计当前可见记录，累计状态报告另列。</p>
  <details className="mc-flow-meta"><summary>快照与链路设置</summary><dl><dt>快照</dt><dd>{frame+1} / {frames}</dd><dt>数据源</dt><dd>{source}</dd><dt>物理模式</dt><dd>{physics==='rapier'?'Rapier 碰撞':'运动学'}</dd><dt>执行方式</dt><dd>{({auto:'自动执行',agent:'设备启动',primitive:'单体分步'} as Record<string,string>)[execution||'auto']||execution}</dd>{view.config&&<><dt>链路延迟</dt><dd>{view.config.delay} 步</dd><dt>有效期</dt><dd>{view.config.ttl} 步</dd><dt>配置丢包率</dt><dd>{Math.round(view.config.lossRate*100)}%</dd></>}</dl></details>
  {messaging&&<button className="mc-pill mc-message-entry" onClick={messaging}>设备通信</button>}
  <button className="mc-pill" onClick={diagnostics}><FileText size={12}/> 记录与服务诊断</button>
 </section>;
}
