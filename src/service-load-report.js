/* Validate and summarize local service load comparisons without trusting their claims. */
(function(root){'use strict';
function summarize(report){
 const bad=()=>{throw Error('服务负载报告格式无效')},finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0,integer=n=>Number.isSafeInteger(n)&&n>=0,hash=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s),c=report?.config;
 if(report?.format!=='3dbox-service-load-v1'||!c||!integer(c.sessions)||c.sessions<1||c.sessions>16||!integer(c.ticks)||c.ticks<1||c.ticks>150||c.sessions*c.ticks>1200||c.sceneId!=='industrial-park-parallel-v1'||c.seedStart!==42||c.messageEveryTicks!==5||!Array.isArray(report.runs)||report.runs.length!==2||!Array.isArray(report.pairs)||report.pairs.length!==c.sessions)bad();
 const encoding=c.stateHashEncoding??'json-stringify-v1';if(!['json-stringify-v1','canonical-json-v1'].includes(encoding))bad();
 const runs=report.runs;for(let i=0;i<2;i++){const r=runs[i],backend=i?'rust':'js',time=r?.stepLatencyMs;if(!r||r.backend!==backend||!r.runtime||r.runtime.taskBackend!==backend||r.runtime.communicationBackend!==backend||r.runtime.physicsBackend!=='wasm'||!finite(r.wallMs)||r.wallMs===0||!integer(r.executedSteps)||!integer(r.stepRequests)||r.stepRequests!==r.executedSteps||!integer(r.responseBytes)||!integer(r.peakRssBytes)||!integer(r.messageAttempts)||!time||![time.p50,time.p95,time.max].every(finite)||time.p50>time.p95||time.p95>time.max||!Array.isArray(r.worlds)||r.worlds.length!==c.sessions)bad();
  let ticks=0,messages=0;for(let j=0;j<c.sessions;j++){const w=r.worlds[j];if(!w||w.seed!==c.seedStart+j||!integer(w.ticks)||w.ticks>c.ticks||typeof w.done!=='boolean'||typeof w.failed!=='boolean'||!hash(w.sha256))bad();ticks+=w.ticks;messages+=Math.ceil(w.ticks/c.messageEveryTicks)}if(ticks!==r.executedSteps||messages!==r.messageAttempts)bad();
 }
 const rows=report.pairs.map((p,i)=>{const a=runs[0].worlds[i],b=runs[1].worlds[i];if(!p||p.seed!==a.seed||p.jsHash!==a.sha256||p.rustHash!==b.sha256||typeof p.equal!=='boolean'||p.equal!==(a.sha256===b.sha256))bad();return {seed:p.seed,equal:p.equal}}),equal=rows.every(r=>r.equal);if(report.allWorldsEqual!==equal)bad();
 return {config:c,stateHashEncoding:encoding,runs:runs.map(r=>({backend:r.backend,executedSteps:r.executedSteps,messageAttempts:r.messageAttempts,wallMs:r.wallMs,stepsPerSecond:r.executedSteps*1000/r.wallMs,stepLatencyMs:r.stepLatencyMs,responseBytes:r.responseBytes,peakRssBytes:r.peakRssBytes})),rows,equal};
}
const api={summarize};if(typeof module!=='undefined')module.exports=api;else root.SandboxServiceLoadReport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
