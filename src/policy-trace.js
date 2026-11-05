/* Build a read-only per-call index from an optional, bounded policy trace. */
(function(root){
'use strict';
function fail(){throw Error('决策轨迹结构无效')}
function build(report){
 if(!report||!['asynchronous-policy-v1','multi-agent-policy-v1'].includes(report.experiment)||!Array.isArray(report.policyTrace)||report.policyTrace.length>3000||typeof report.policyTraceTruncated!=='boolean')fail();
 const calls=new Map();let lastCall=0;
 for(const event of report.policyTrace){
  if(!event||!Number.isSafeInteger(event.call)||event.call<1||event.call>1000||!['start','result','submission'].includes(event.kind))fail();
  if(event.kind==='start'){
   const o=event.observation;if((event.worldRevision!==undefined&&(!Number.isSafeInteger(event.worldRevision)||event.worldRevision<0))||calls.has(event.call)||event.call!==lastCall+1||!o||![1,2].includes(o.version)||!Number.isSafeInteger(o.tick)||o.tick<0||o.tick>10000000||!Array.isArray(o.tasks)||o.tasks.length>100)fail();
   calls.set(event.call,{call:event.call,observation:o,worldRevision:event.worldRevision??null,result:null,submission:null,worldResult:null});lastCall=event.call;
  }else{const call=calls.get(event.call);if(!call)fail();
   if(event.kind==='result'){
    if(event.modelResponse!==undefined){const m=event.modelResponse;if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.responseExcerpt!=='string'||new TextEncoder().encode(m.responseExcerpt).length>32768||typeof m.truncated!=='boolean'||typeof m.apiKeyRedacted!=='boolean'||(m.returnedModel!==null&&(typeof m.returnedModel!=='string'||m.returnedModel.length>200)))fail()}
    if(call.result||call.submission||!Number.isFinite(event.elapsedMs)||event.elapsedMs<0||event.elapsedMs>10000000||Object.hasOwn(event,'choice')===Object.hasOwn(event,'error')||(Object.hasOwn(event,'error')&&(typeof event.error!=='string'||event.error.length>200))||(Object.hasOwn(event,'choice')&&event.choice!==null&&(typeof event.choice!=='object'||Array.isArray(event.choice))))fail();call.result=event;
   }else{
    if(!call.result||call.submission||!Object.hasOwn(call.result,'choice')||!call.result.choice||!['accepted','pending','rejected','failed','request_failed'].includes(event.status)||(event.reason!==undefined&&(typeof event.reason!=='string'||event.reason.length>200))||(event.status!=='request_failed'&&(typeof event.requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(event.requestId))))fail();call.submission=event;
   }
  }
 }
 const decisions=Array.isArray(report.decisions)?report.decisions:[],proposals=Array.isArray(report.proposals)?report.proposals:[];if(decisions.length>1000||proposals.length>1000)fail();
 for(const call of calls.values())if(call.submission?.requestId){const matches=[...decisions,...proposals].filter(d=>d&&d.requestId===call.submission.requestId);if(matches.length>1)fail();if(matches.length){const d=matches[0];if(!['accepted','pending','rejected','failed'].includes(d.status)||(d.reason!==undefined&&(typeof d.reason!=='string'||d.reason.length>200))||(d.appliedTick!==undefined&&(!Number.isSafeInteger(d.appliedTick)||d.appliedTick<0||d.appliedTick>10000000)))fail();call.worldResult={status:d.status,reason:d.reason??null,appliedTick:d.appliedTick??null}}}
 return {calls:[...calls.values()],truncated:report.policyTraceTruncated};
}
function locate(call,frames,coverage){const revision=call.worldRevision,range=coverage?.revisionRange;if(revision!==null&&Array.isArray(range)){const index=revision-range[0];return {mode:'revision',index:index>=0&&index<frames.length&&frames[index].tick===call.observation.tick?index:-1}}return {mode:'tick',index:frames.findIndex(f=>f.tick===call.observation.tick)}}
const api={build,locate};if(typeof module!=='undefined')module.exports=api;else root.SandboxPolicyTrace=api;
})(typeof globalThis!=='undefined'?globalThis:this);
