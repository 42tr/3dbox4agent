(function(root){
'use strict';
const E=typeof module!=='undefined'&&module.exports?require('./engine'):root.SandboxEngine;
const Plan=typeof module!=='undefined'&&module.exports?require('./scheduled-plan'):root.SandboxScheduledPlan;
const Replay=typeof module!=='undefined'&&module.exports?require('./replay'):root.SandboxReplay;
const Audit=typeof module!=='undefined'&&module.exports?require('./scheduled-audit'):root.SandboxScheduledAudit;
const integer=(v,a,b)=>Number.isSafeInteger(v)&&v>=a&&v<=b;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v}
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function stats(v){if(!v.length)return {n:0,mean:null,sd:null};const mean=v.reduce((a,b)=>a+b,0)/v.length;return {n:v.length,mean,sd:v.length===1?0:Math.sqrt(v.reduce((n,x)=>n+(x-mean)**2,0)/(v.length-1))}}
function summarize(report){
 const c=report?.config;if(report?.format!=='3dbox-scheduled-policy-comparison-v1'||!c||!integer(c.count,1,10)||!integer(c.startSeed,0,0xffffffff)||c.startSeed+c.count-1>0xffffffff||!['kinematic','rapier'].includes(c.physicsMode)||![1,2].includes(c.policyProtocol)||!integer(c.maxTicks,1,10000)||!Number.isFinite(c.wallTimeoutSeconds)||c.wallTimeoutSeconds<2||c.wallTimeoutSeconds>300||!Number.isFinite(c.policyTimeoutSeconds)||c.policyTimeoutSeconds<.05||c.policyTimeoutSeconds>120||!integer(c.maxPolicyCalls,1,1000)||!integer(c.maxPolicyErrors,1,100)||!(c.archiveSeed===null||integer(c.archiveSeed,c.startSeed,c.startSeed+c.count-1))||typeof c.traceArchiveDecisions!=='boolean'||c.traceArchiveDecisions&&c.archiveSeed===null||!Array.isArray(report.pairs)||report.pairs.length!==c.count||!hash(report.planSourceSha256)||!hash(report.comparisonSourceSha256)||!hash(report.policySha256?.baseline)||!hash(report.policySha256?.candidate)||typeof report.worldRuntime?.instanceId!=='string')throw Error('对照配置无效');
 let plan,scene;try{plan=Plan.validate(report.plan);scene=E.normalizeScene(c.scene)}catch{throw Error('扰动计划或场景无效')}
 if(!same(scene,plan.scene)||scene.id!==c.sceneId||c.physicsMode!==plan.physicsMode||c.maxTicks!==plan.maxTicks)throw Error('场景或计划配置不一致');
 for(let i=0;i<c.count;i++){
  const pair=report.pairs[i],seed=c.startSeed+i;if(!pair||pair.seed!==seed)throw Error('种子顺序无效');
  for(const side of ['baseline','candidate']){
   const r=pair[side],x=r?.config,m=r?.metrics,expectedPlan={...report.plan,seed};
   if(r?.format!=='3dbox-multiprocess-v1'||r.experiment!=='multi-agent-policy-v1'||!x||x.seed!==seed||x.sceneId!==scene.id||x.physicsMode!==c.physicsMode||x.policyProtocol!==c.policyProtocol||x.clock!=='step'||x.maxTicks!==c.maxTicks||x.maxPolicyCalls!==c.maxPolicyCalls||x.maxPolicyErrors!==c.maxPolicyErrors||x.policyTimeoutSeconds!==c.policyTimeoutSeconds||x.traceDecisions!==(c.traceArchiveDecisions&&seed===c.archiveSeed)||r.policySha256!==report.policySha256[side]||!hash(r.scheduledPlanSha256)||!same(r.scheduledPlan,expectedPlan)||!same(E.normalizeScene(r.scene),scene)||r.worldRuntime?.instanceId!==report.worldRuntime.instanceId||!same(r.sourceSha256,report.sourceSha256)||!['completed','failed','timeout'].includes(r.status)||!m||!integer(m.ticks,0,c.maxTicks)||!Number.isFinite(m.energyUsed)||m.energyUsed<0||!integer(m.completed,0,1000)||!integer(m.total,1,1000)||m.completed>m.total||!Array.isArray(r.events)||r.events.length>200000||!Array.isArray(r.scheduledInterventions)||r.scheduledInterventions.length!==plan.interventions.length||!integer(r.finalRevision,0,10000000))throw Error('运行记录无效');
   if((seed===c.archiveSeed)!==!!r.archive||(r.status==='completed'&&m.completed!==m.total))throw Error('回放或完成状态无效');
   for(let j=0;j<plan.interventions.length;j++){const p=plan.interventions[j],a=r.scheduledInterventions[j];if(!a||a.id!==p.id||a.tick!==p.tick||a.type!==p.type||!['applied','rejected','skipped'].includes(a.status)||a.status==='applied'&&!integer(a.revision,1,r.finalRevision)||a.status!=='applied'&&(typeof a.reason!=='string'||!a.reason||a.reason.length>200))throw Error('扰动记录无效')}
   if(r.status==='completed'&&r.scheduledInterventions.some(a=>a.status!=='applied'))throw Error('完成运行存在未生效扰动');
  }
  if(pair.baseline.scheduledPlanSha256!==pair.candidate.scheduledPlanSha256)throw Error('配对计划摘要不一致');
 }
 const groups=['baseline','candidate'].map(policy=>{const all=report.pairs.map(p=>p[policy]),done=all.filter(r=>r.status==='completed');return {policy,runs:all.length,completed:done.length,failed:all.filter(r=>r.status==='failed').length,timedOut:all.filter(r=>r.status==='timeout').length,allInterventionsApplied:all.filter(r=>r.scheduledInterventions.every(a=>a.status==='applied')).length,completionTicks:stats(done.map(r=>r.metrics.ticks)),energy:stats(done.map(r=>r.metrics.energyUsed))}}),both=report.pairs.filter(p=>['baseline','candidate'].every(n=>p[n].status==='completed'&&p[n].scheduledInterventions.every(a=>a.status==='applied')));
 return {groups,bothCompleted:both.length,tickDifference:stats(both.map(p=>p.candidate.metrics.ticks-p.baseline.metrics.ticks)),energyDifference:stats(both.map(p=>p.candidate.metrics.energyUsed-p.baseline.metrics.energyUsed)),scene};
}
function extractRun(report,seed,side){
 summarize(report);if(!['baseline','candidate'].includes(side))throw Error('策略无效');const run=report.pairs.find(p=>p.seed===seed)?.[side];if(!run?.archive)throw Error('该运行没有保存回放');const {archive}=Replay.unwrapArchive(run),last=archive.frames.at(-1),metrics=E.metrics(last);
 if(archive.config.seed!==seed||last.tick!==run.metrics.ticks||archive.config.sceneId!==report.config.sceneId||last.physicsMode!==report.config.physicsMode||metrics.energyUsed!==run.metrics.energyUsed||!same(last.events,run.events))throw Error('回放与运行记录不一致');Audit.analyze(run,archive);return run;
}
const api={summarize,extractRun};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SandboxScheduledPolicyReport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
