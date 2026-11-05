import React from 'react';
import {Buildings,CheckCircle} from '@phosphor-icons/react';
import type {ConstructionView} from './construction-view';
const labels={planned:'待建设',travel:'前往施工点',building:'施工中',waiting:'等待执行',built:'已建成'};
export function ConstructionPanel({view,tasks,observe}:{view?:ConstructionView|null;tasks:()=>void;observe:(id:string)=>void}){
 if(!view)return null;
 return <section className="mc-construction" aria-label="基地建设状态"><header><span><Buildings size={13}/> 基地建设</span><small>建成 {view.built} / {view.total} · T+{view.tick}</small><button onClick={tasks}>任务链</button></header>{view.kind==='unavailable'?<p>当前快照的建设信息不完整。</p>:<div className="mc-construction-grid">{view.sites.map(s=><article key={s.id} aria-label={s.name+' · '+labels[s.state]}><div><b>{s.name}</b><span className={s.state==='built'?'built':''}>{s.state==='built'&&<CheckCircle size={10}/>} {labels[s.state]}</span></div><progress value={s.progress} max={1} aria-label={s.name+'建设进度'}/><small>{s.builtTick!==null?'建成于 T+'+s.builtTick:s.worker?s.worker.name+' · '+s.worker.id:'尚未分配施工设备'}</small><small>{s.state==='built'?'已用':'完成时消耗'}：{s.cost}</small>{s.worker&&<button onClick={()=>observe(s.worker!.id)} aria-label={'观察'+s.name+'施工设备 '+s.worker.id}>观察施工设备</button>}</article>)}</div>}<p>施工范围全程保留碰撞边界；材料在建设完成时消耗。</p></section>;
}
