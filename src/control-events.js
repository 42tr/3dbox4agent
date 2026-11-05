/* Bounded, untrusted management-process timeline; it is not an authoritative world event stream. */
(function(root){
'use strict';
function describe(report,tick,revision=null){
 if(!report||report.controlEvents===undefined)return null;
 const events=report.controlEvents,id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(x),ids=x=>Array.isArray(x)&&x.length>0&&x.length<=16&&new Set(x).size===x.length&&x.every(id);
 if(!Array.isArray(events)||events.length>100||!Number.isSafeInteger(tick)||tick<0||(revision!==null&&(!Number.isSafeInteger(revision)||revision<0))||events.some(e=>!e||!Number.isSafeInteger(e.tick)||e.tick<0||e.tick>10000000||!['coordinator_failure_injected','coordinator_failure_detected','coordinator_shards_reassigned'].includes(e.kind)||(e.elapsedMs!==undefined&&(!Number.isFinite(e.elapsedMs)||e.elapsedMs<0||e.elapsedMs>10000000))||(e.kind==='coordinator_failure_injected'?!id(e.coordinatorId):!ids(e.coordinatorIds))))throw Error('invalid coordinator control events');
 for(const e of events){const hasRevision=e.observedRevision!==undefined,hasPrior=e.priorDecisionIds!==undefined;if((hasRevision&&(!Number.isSafeInteger(e.observedRevision)||e.observedRevision<0))||(hasPrior&&(e.kind!=='coordinator_shards_reassigned'||!hasRevision||!Array.isArray(e.priorDecisionIds)||e.priorDecisionIds.length>1000||new Set(e.priorDecisionIds).size!==e.priorDecisionIds.length||e.priorDecisionIds.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(x))))||(e.kind==='coordinator_shards_reassigned'&&hasRevision&&!hasPrior))throw Error('invalid coordinator observation boundary')}
 if(!events.length)return null;const visible=events.filter(e=>e.tick<=tick&&(revision===null||e.observedRevision===undefined||e.observedRevision<=revision));if(!visible.length)return revision===null?'管理进程记录：当前步之前没有节点故障记录。':'管理进程记录：当前版本之前没有节点故障记录。';
 const message=visible.map(e=>`T+${e.tick} `+(e.kind==='coordinator_failure_injected'?`模拟 ${e.coordinatorId} 进程退出`:e.kind==='coordinator_failure_detected'?`检测到 ${e.coordinatorIds.join('、')} 退出`:`任务分片交给 ${e.coordinatorIds.join('、')}`)+(e.elapsedMs!==undefined?`（耗时 ${e.elapsedMs.toFixed(1)} 毫秒）`:'' )).join('；');
 return (revision!==null&&events.some(e=>e.observedRevision!==undefined)?'管理进程记录（有版本的按观察版本显示，旧记录按步显示；非世界事件）：':'管理进程记录（按步显示，不区分同一步的不同版本；非世界事件）：')+message+'。';
}
const api={describe};if(typeof module!=='undefined')module.exports=api;else root.SandboxControlEvents=api;
})(typeof globalThis!=='undefined'?globalThis:this);
