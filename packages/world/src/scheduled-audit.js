(function(root){
'use strict';
const E=typeof module!=='undefined'&&module.exports?require('./world-core'):root.SandboxEngine;
const Plan=typeof module!=='undefined'&&module.exports?require('./scheduled-plan'):root.SandboxScheduledPlan;
function analyze(report,archive){
 const multi=report?.format==='3dbox-multiprocess-v1',single=report?.format==='3dbox-scheduled-run-v1';
 if(!multi&&!single)return null;
 const source=single?report.plan:report.scheduledPlan,results=single?report.interventions:report.scheduledInterventions;
 if(source===undefined&&results===undefined)return null;
 if(!source||!Array.isArray(results))throw Error('缺少计划或扰动结果');
 let plan;try{plan=Plan.validate(source)}catch{throw Error('扰动计划无效')}
 const digest=single?report.planSha256:report.scheduledPlanSha256;
 if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||results.length!==plan.interventions.length)throw Error('计划摘要或结果数量无效');
 const profile=multi?(report.config?.linkProfile??'default'):'default';let expected;
 try{expected=E.normalizeScene(E.withLinkProfile(plan.scene,profile))}catch{throw Error('链路配置无效')}
 if(!archive?.config?.scene||JSON.stringify(E.normalizeScene(archive.config.scene))!==JSON.stringify(expected)||archive.config.seed!==plan.seed||archive.config.policy!==plan.policy||archive.frames.some(f=>f.physicsMode!==plan.physicsMode))throw Error('计划与回放配置不一致');
 const range=archive.coverage?.revisionRange,first=Array.isArray(range)?range[0]:null,last=Array.isArray(range)?range[1]:null;
 let lastApplied=-1;
 return results.map((r,i)=>{
  const p=plan.interventions[i];if(!r||r.id!==p.id||r.tick!==p.tick||r.type!==p.type||!['applied','rejected','skipped'].includes(r.status))throw Error('扰动结果与计划不一致');
  if(r.status!=='applied'){
   if(typeof r.reason!=='string'||!r.reason||r.reason.length>200||r.revision!==undefined)throw Error('扰动结果无效');
   return {id:p.id,tick:p.tick,type:p.type,status:r.status,verification:'reported',index:null,reason:r.reason};
  }
  if(!Number.isSafeInteger(r.revision)||r.revision<1||r.revision<=lastApplied||(last!==null&&r.revision>last))throw Error('扰动版本无效');lastApplied=r.revision;
  if(first===null||r.revision<first)return {id:p.id,tick:p.tick,type:p.type,status:r.status,verification:'not_retained',index:null};
  const index=r.revision-first,frame=archive.frames[index];if(!frame||frame.tick!==p.tick)throw Error('扰动版本与回放时间不一致');
  if(index===0)return {id:p.id,tick:p.tick,type:p.type,status:r.status,verification:'prior_not_retained',index};
  const previous=archive.frames[index-1],events=frame.events.slice(previous.events.length);
  const matches=e=>e.tick===p.tick&&(
   p.type==='fault'&&e.kind==='device_fault'||
   p.type==='outage'&&e.kind==='communication_interrupted'&&e.agentId===p.agentId&&e.untilTick===p.tick+p.duration||
   p.type==='low_energy'&&e.kind==='low_energy_injected'&&e.agentId===p.agentId&&e.level===p.level||
   p.type==='roadblock'&&e.kind==='roadblock_started'&&['x','y','w','h'].every(k=>e[k]===p.rect[k])&&e.untilTick===p.tick+p.duration||
   p.type==='terrain'&&e.kind==='terrain_effect_started'&&e.zoneId===p.zoneId&&e.untilTick===p.tick+p.duration&&e.speedFactor===p.speedFactor&&e.energyFactor===p.energyFactor);
  if(events.filter(matches).length!==1)throw Error('扰动结果与新增世界事件不一致');
  return {id:p.id,tick:p.tick,type:p.type,status:r.status,verification:'matched',index};
 });
}
const api={analyze};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SandboxScheduledAudit=api;
})(typeof globalThis!=='undefined'?globalThis:this);
