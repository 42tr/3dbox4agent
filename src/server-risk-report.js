/* Verify and recompute paired server risk-routing results; not an authenticity check. */
(function(root){
'use strict';
const E=typeof module!=='undefined'?require('./engine'):root.SandboxEngine,X=typeof module!=='undefined'?require('./experiments'):root.SandboxExperiments,R=typeof module!=='undefined'?require('./replay'):root.SandboxReplay;
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v}
function same(a,b){return JSON.stringify(canonical(a))===JSON.stringify(canonical(b))}
function initial(s){return {tick:s.tick,agents:s.agents.map(a=>({id:a.id,x:a.x,y:a.y,battery:a.battery,status:a.status,disabled:a.disabled})),tasks:s.tasks.map(t=>({id:t.id,status:t.status,assignee:t.assignee}))}}
function summarize(report){
 const c=report?.config,pairs=report?.pairs;if(report?.format!=='3dbox-server-risk-comparison-v1'||!c||!Array.isArray(pairs)||pairs.length!==c.count||!['rapier','kinematic'].includes(c.physicsMode)||c.dispatchMode!=='rule'||!report.serverRuntime||typeof report.serverRuntime.instanceId!=='string'||!/^[a-f0-9-]{36}$/.test(report.serverRuntime.instanceId))throw Error('报告格式或配置无效');
 X.validateRiskComparison(c);const scene=E.normalizeScene(c.scene);if(scene.id!==c.sceneId)throw Error('场景不一致');const agents=new Set(scene.agents.flatMap(a=>Array.from({length:a.count},(_,i)=>a.role+'-'+(i+1)))),zones=new Set(scene.riskZones.map(z=>z.id));
 for(let i=0;i<pairs.length;i++){const pair=pairs[i],seed=c.startSeed+i;if(!pair||pair.seed!==seed)throw Error('种子不连续');const expectedInitial=initial(E.create(seed,c.policy,scene,{physicsMode:c.physicsMode}));
  for(const condition of ['monitor','avoid']){const run=pair[condition],variant=E.normalizeScene({...scene,riskNavigation:condition}),m=run?.metrics;if(!run||run.seed!==seed||run.policy!==c.policy||run.physicsMode!==c.physicsMode||run.dispatchMode!=='rule'||run.riskMonitoringVersion!==2||!['completed','failed','timeout'].includes(run.status)||!same(E.normalizeScene(run.scene),variant)||!same(run.initial,expectedInitial)||!m||!Number.isSafeInteger(m.ticks)||m.ticks<0||m.ticks>c.maxTicks||!Number.isSafeInteger(m.riskZoneEntries)||m.riskZoneEntries<0||!Number.isFinite(m.distance)||m.distance<0||!Number.isFinite(m.energyUsed)||m.energyUsed<0||!Number.isSafeInteger(m.collisionContacts)||m.collisionContacts<0||typeof run.faultAttempted!=='boolean'||typeof run.faultInjected!=='boolean'||run.faultInjected&&!run.faultAttempted||(c.faultTick===null&&run.faultAttempted)||!Array.isArray(run.events)||run.events.length>200000||!Array.isArray(run.decisions)||run.decisions.length>10000)throw Error('运行记录无效');
   for(let j=0;j<run.events.length;j++){const e=run.events[j];if(!e||e.seq!==j+1||!Number.isSafeInteger(e.tick)||e.tick<0||e.tick>m.ticks||(j&&e.tick<run.events[j-1].tick)||(e.kind==='risk_zone_entered'&&(!agents.has(e.agentId)||!zones.has(e.zoneId))))throw Error('事件无效')}
   if(run.events.filter(e=>e.kind==='risk_zone_entered').length!==m.riskZoneEntries||run.events.filter(e=>e.kind==='device_fault').length!==(run.faultInjected?1:0)||(run.faultInjected&&!run.events.some(e=>e.kind==='device_fault'&&e.tick===c.faultTick)))throw Error('指标与事件不一致');
  }
  if(!same(pair.monitor.initial,pair.avoid.initial))throw Error('配对初始状态不一致');
 }
 const r=X.riskComparisonReport(c,pairs),contacts=c.physicsMode==='rapier'?['monitor','avoid'].map(k=>X.stats(pairs.map(p=>p[k].metrics.collisionContacts))):[null,null];return {summary:r.summary,paired:r.paired,contacts};
}
function extractArchive(report,seed,condition){
 summarize(report);if(!['monitor','avoid'].includes(condition)||!Number.isSafeInteger(seed))throw Error('无效的运行选择');const c=report.config,run=report.pairs.find(p=>p.seed===seed)?.[condition],a=run?.archive;if(!a||typeof run.historyTruncated!=='boolean')throw Error('此运行未保存快照');R.validateArchive(a);
 const first=a.frames[0],last=a.frames.at(-1),m=E.metrics(last),status=last.failed?'failed':last.done?'completed':'timeout';if(a.config.seed!==seed||a.config.policy!==c.policy||!same(E.normalizeScene(a.config.scene),E.normalizeScene(run.scene))||last.physicsMode!==c.physicsMode||last.dispatchMode!=='rule'||last.riskMonitoringVersion!==2||a.coverage?.start!==(run.historyTruncated?'partial':'complete')||(a.coverage.start==='complete'&&!same(initial(first),run.initial))||status!==run.status||['ticks','riskZoneEntries','distance','energyUsed','collisionContacts'].some(k=>m[k]!==run.metrics[k])||!same(last.events,run.events)||!same(last.decisions,run.decisions))throw Error('回放与实验结果不一致');return a;
}
const api={summarize,extractArchive};if(typeof module!=='undefined')module.exports=api;else root.SandboxServerRiskReport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
