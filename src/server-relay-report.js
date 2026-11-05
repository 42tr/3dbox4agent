/* Recompute service relay comparison outcomes from the recorded message events. */
(function(root){
'use strict';
const E=typeof module!=='undefined'?require('./engine'):root.SandboxEngine,C=typeof module!=='undefined'?require('./relay-comparison'):root.SandboxRelayComparison;
function summarize(report){
 const c=report?.config,pairs=report?.pairs;
 if(report?.format!=='3dbox-server-relay-comparison-v1'||!c||!['rapier','kinematic'].includes(c.physicsMode)||c.dispatchMode!=='rule'||c.executionMode!=='auto'||!Number.isSafeInteger(c.maxTicks)||c.maxTicks<1||c.maxTicks>1000||!Array.isArray(pairs)||pairs.length!==c.count||!report.serverRuntime||typeof report.serverRuntime.instanceId!=='string'||!/^[a-f0-9-]{36}$/.test(report.serverRuntime.instanceId))throw Error('报告格式或配置无效');
 const scene=C.validateBatch(c),ids=[c.from,c.to,c.relay];if(c.sceneFileSha256!=null&&(typeof c.sceneFileSha256!=='string'||!/^[a-f0-9]{64}$/.test(c.sceneFileSha256)))throw Error('场景文件摘要无效');if(c.archiveSeed===null?c.archiveSide!==null:(!Number.isSafeInteger(c.archiveSeed)||c.archiveSeed<c.startSeed||c.archiveSeed>=c.startSeed+c.count||!['direct','relay'].includes(c.archiveSide)))throw Error('回放配置无效');
 const counts={direct:{delivered:0,failed:0,pending:0},relay:{delivered:0,failed:0,pending:0}},summary={count:c.count,bothDelivered:0,directOnly:0,relayOnly:0,neitherDelivered:0,deliveryDifference:0},rows=[];
 for(let i=0;i<pairs.length;i++){
  const pair=pairs[i];if(!pair||pair.seed!==c.startSeed+i||!pair.direct||!pair.relay||!/^[a-f0-9]{64}$/.test(pair.direct.initialStateSha256)||pair.direct.initialStateSha256!==pair.relay.initialStateSha256)throw Error('种子或初始状态无效');
  const row={seed:pair.seed};
  for(const side of ['direct','relay']){
   const run=pair[side],events=run.messageEvents,outcome=run.outcome;if(!Array.isArray(events)||events.length<1||events.length>8||!outcome||!['delivered','failed','pending'].includes(outcome.status)||!Number.isSafeInteger(outcome.elapsedTicks)||outcome.elapsedTicks<0||outcome.elapsedTicks>c.maxTicks)throw Error('消息记录无效');
   const sent=events[0];if(sent.kind!=='message_sent'||sent.messageId!==1||sent.tick!==0||sent.from!==ids[0]||sent.to!==ids[1]||sent.bytes!==10)throw Error('发送事件无效');
   let relayed=0,terminal=null,transmitted=0;
   for(let j=0;j<events.length;j++){
    const e=events[j];if(!e||e.messageId!==1||!Number.isSafeInteger(e.tick)||e.tick<0||e.tick>outcome.elapsedTicks||!Number.isSafeInteger(e.seq)||e.seq<1||(j&&(e.tick<events[j-1].tick||e.seq<=events[j-1].seq))||terminal)throw Error('消息事件时序无效');if(j===0)continue;
    if(e.kind==='message_relayed'){if(side!=='relay'||relayed||e.relay!==ids[2]||e.hop!==1||e.from!==ids[0]||e.to!==ids[1])throw Error('中继事件无效');relayed++}
    else if(e.kind==='message_hop_transmitted'){const hop=relayed+1,from=hop===1?ids[0]:ids[2],to=side==='direct'||hop===2?ids[1]:ids[2];if(hop>(side==='direct'?1:2)||e.hop!==hop||e.from!==from||e.to!==to||e.bytes!==10||transmitted>=hop)throw Error('发送跳事件无效');transmitted=hop}
    else if(e.kind==='message_delivered'||e.kind==='message_failed'){if(e.from!==ids[0]||e.to!==ids[1])throw Error('终结事件无效');terminal=e}
    else throw Error('消息事件类型无效');
   }
   const status=terminal?(terminal.kind==='message_delivered'?'delivered':'failed'):'pending',reason=terminal?.reason??null,hops=relayed+(status==='delivered'?1:0);if(status==='failed'&&!['expired','unavailable','interrupted','out_of_range','obstructed','dropped','run_ended'].includes(reason)||status!=='failed'&&reason!==null||status==='delivered'&&hops!==(side==='direct'?1:2)||status==='pending'&&outcome.elapsedTicks!==c.maxTicks||terminal&&terminal.tick!==outcome.elapsedTicks||outcome.status!==status||outcome.reason!==reason||outcome.successfulHops!==hops)throw Error('消息结果与事件不一致');
   counts[side][status]++;row[side]={status,reason,elapsedTicks:outcome.elapsedTicks,successfulHops:hops};
  }
  const d=row.direct.status==='delivered',r=row.relay.status==='delivered';summary[d&&r?'bothDelivered':d?'directOnly':r?'relayOnly':'neitherDelivered']++;rows.push(row);
 }
 summary.deliveryDifference=(summary.relayOnly-summary.directOnly)/summary.count;if(!report.summary||Object.keys(summary).some(k=>report.summary[k]!==summary[k]))throw Error('汇总与逐次记录不一致');return {scene,summary,counts,rows};
}
const api={summarize};if(typeof module!=='undefined')module.exports=api;else root.SandboxServerRelayReport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
