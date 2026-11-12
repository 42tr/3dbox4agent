import React from 'react';
import {Package} from '@phosphor-icons/react';
import type {MaterialView} from './material-view';
export function MaterialPanel({view}:{view?:MaterialView|null}){
 if(!view)return null;
 return <section className="mc-materials" aria-label={view.scope?'本机任务耗材 · '+view.scope:'任务耗材库存'}><header><span><Package size={12}/> {view.scope?'本机任务预留':'任务耗材'}</span><small>T+{view.tick}</small></header>{view.kind==='unavailable'?<p>当前快照的耗材信息不完整。</p>:view.kind==='global'?<table><thead><tr><th scope="col">耗材</th><th scope="col">可用</th><th scope="col">预留</th><th scope="col">已用</th></tr></thead><tbody>{view.rows.map(r=><tr key={r.id} title={'初始 '+r.initial+' · 库存余量 '+r.remaining}><th scope="row">{r.name}</th><td>{r.available}</td><td>{r.reserved}</td><td>{r.consumed}</td></tr>)}</tbody></table>:view.leases.length?<ul>{view.leases.map(r=><li key={r.taskId}><code>{r.taskId} · #{r.assignmentId}</code><span>{r.items.map(i=>i.name+' ×'+i.amount).join(' · ')}</span></li>)}</ul>:<p>当前设备没有任务耗材预留。</p>}</section>;
}
