/* Read-only index of the coordinator's optional auction trace. */
(function(root){
'use strict';
function fail(){throw Error('竞价轨迹结构或消息关联无效')}
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x);
const tick=x=>Number.isSafeInteger(x)&&x>=0&&x<=10000000;
const score=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1000;
function build(report){
 if(!report||report.format!=='3dbox-multiprocess-v1'||!Array.isArray(report.auctionTrace)||report.auctionTrace.length>3000||typeof report.auctionTraceTruncated!=='boolean'||!Array.isArray(report.auctionTraceIncomplete)||!Array.isArray(report.events)||report.events.length>100000||!Array.isArray(report.decisions)||report.decisions.length>10000)fail();
 const rounds=new Map(),sent=new Map(),delivered=new Map();
 for(const e of report.events){if(e&&(e.kind==='message_sent'||e.kind==='message_delivered')){const map=e.kind==='message_sent'?sent:delivered;if(!Number.isSafeInteger(e.messageId)||map.has(e.messageId))fail();map.set(e.messageId,e)}}
 function message(mid,from,to,delivery){const e=sent.get(mid),d=delivered.get(mid);if(!e||e.from!==from||e.to!==to||!tick(e.tick))fail();if(delivery!==undefined&&(!d||d.from!==from||d.to!==to||d.tick!==delivery))fail()}
 for(const e of report.auctionTrace){
  if(!e||typeof e!=='object'||!/^([a-f0-9]{8})-([1-9][0-9]{0,7})$/.test(e.auctionId))fail();
  if(e.kind==='open'){
   if(rounds.has(e.auctionId)||!id(e.taskId)||!id(e.broker)||!Array.isArray(e.candidates)||e.candidates.length>100||!e.candidates.every(id)||new Set(e.candidates).size!==e.candidates.length||!tick(e.observedTick)||!tick(e.worldRevision))fail();
   rounds.set(e.auctionId,{open:e,calls:[],bids:[],window:null,close:null,worldResult:null});
  }else{
   const r=rounds.get(e.auctionId);if(!r||r.close)fail();
   if(e.kind==='call'){
    if(!id(e.agentId)||e.agentId===r.open.broker||!r.open.candidates.includes(e.agentId)||r.calls.some(x=>x.agentId===e.agentId))fail();message(e.messageId,r.open.broker,e.agentId);if(sent.get(e.messageId).requestId!=='call-'+e.auctionId+'-'+e.agentId)fail();r.calls.push(e);
   }else if(e.kind==='bid'){
    if(!id(e.agentId)||!r.open.candidates.includes(e.agentId)||!score(e.score)||r.bids.some(x=>x.agentId===e.agentId))fail();
    if(e.source==='self'){if(e.agentId!==r.open.broker)fail()}else if(e.source==='message'){if(e.agentId===r.open.broker||!tick(e.receivedTick))fail();message(e.messageId,e.agentId,r.open.broker,e.receivedTick);const call=r.calls.find(c=>c.agentId===e.agentId),incoming=call&&delivered.get(call.messageId);if(!call||!incoming||incoming.from!==r.open.broker||incoming.to!==e.agentId||sent.get(e.messageId).requestId!=='bid-'+call.messageId)fail()}else fail();r.bids.push(e);
   }else if(e.kind==='window'){if(r.window||!tick(e.deadlineTick))fail();r.window=e;
   }else if(e.kind==='close'){
    if(!['accepted','pending','rejected','failed','request_failed','no_bids','task_unavailable','run_ended'].includes(e.status)||!tick(e.observedTick)||!tick(e.worldRevision))fail();
    if(['accepted','pending','rejected','failed','request_failed'].includes(e.status)){if(!id(e.winner)||!score(e.score)||!r.bids.some(b=>b.agentId===e.winner&&b.score===e.score))fail();if(e.status!=='request_failed'&&!id(e.requestId))fail()}
    if(e.reason!==undefined&&(typeof e.reason!=='string'||e.reason.length>200))fail();r.close=e;
   }else fail();
  }
 }
 const incomplete=[...rounds.values()].filter(r=>!r.close).map(r=>r.open.auctionId).sort();if(JSON.stringify(incomplete)!==JSON.stringify(report.auctionTraceIncomplete))fail();
 for(const r of rounds.values())if(r.close?.requestId){const matches=report.decisions.filter(d=>d&&d.requestId===r.close.requestId);if(matches.length>1)fail();if(matches.length){const d=matches[0];if(!['accepted','pending','rejected','failed'].includes(d.status)||d.taskId!==r.open.taskId||d.agentId!==r.close.winner)fail();r.worldResult={status:d.status,reason:d.reason??null,appliedTick:d.appliedTick??null}}}
 return {rounds:[...rounds.values()],truncated:report.auctionTraceTruncated};
}
function locate(round,frames,coverage){const range=coverage?.revisionRange,revision=round.open.worldRevision;if(!Array.isArray(range))return -1;const index=revision-range[0];return index>=0&&index<frames.length&&frames[index].tick===round.open.observedTick?index:-1}
const api={build,locate};if(typeof module!=='undefined')module.exports=api;else root.SandboxAuctionTrace=api;
})(typeof globalThis!=='undefined'?globalThis:this);
