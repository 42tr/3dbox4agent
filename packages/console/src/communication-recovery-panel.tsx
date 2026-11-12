import React from 'react';
import type {CommunicationRecoveryView,RecoveryActions} from './communication-recovery';
const names:Record<keyof RecoveryActions,string>={move:'移动',work_task:'作业',execute_task:'任务执行',charge:'补能',scan:'扫描',rescue:'救援'};
export function CommunicationRecoveryPanel({view}:{view?:CommunicationRecoveryView|null}){
 if(!view)return null;
 const rows=view.rows.slice(0,10);
 return <section className="mc-recovery" aria-label="失联执行与状态恢复"><header><b>失联执行与状态恢复</b><code>T+{view.tick}</code></header>{!view.available?<p>当前快照的恢复依据不完整。</p>:<><p>显示最近 {rows.length} / {view.total} 次中断；依据本帧事件、已完成动作和最近状态回执。</p>{!view.reportingActive&&<p>本帧未启用延迟状态上报，可能不保留恢复后的回执。</p>}{rows.map(row=><article key={row.key}><header><code>{row.agentId}</code><span>{row.report?'已保留恢复报告':row.restoredTick!==null?'已解除 · 回执未证实':view.finished?'结束前未记录解除':'中断期尚未结束'}</span></header><p>中断 T+{row.startedTick} → T+{row.untilTick}{row.restoredTick!==null&&<> · 解除 T+{row.restoredTick}</>}</p><p>{row.completed?<>中断期完成 {Object.entries(row.completedActions).filter(([,n])=>n>0).map(([type,n])=>names[type as keyof RecoveryActions]+' '+n).join(' · ')}</>:'未记录中断期动作完成，不等于设备未执行。'}</p>{row.report?<p>报告采集 T+{row.report.capturedTick} · 收到 T+{row.report.receivedTick}{row.report.stale===true?' · 已过期':row.report.stale===false?' · 本帧有效':' · 有效期未记录'}</p>:<p>本帧没有该时段恢复后采集的报告；旧回执可能已被替换。</p>}{row.unavailableNow===true&&<p className="mc-recovery-note">设备在当前快照已退出，历史恢复证据不代表当前可用。</p>}</article>)}</>}<p>动作完成、解除事件和新状态回执分别判断；这不是连续在线证明。</p></section>;
}
