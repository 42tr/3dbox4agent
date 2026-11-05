/* Validate and recompute statistics from an imported server link comparison. */
(function(root){
'use strict';
const E=typeof module!=='undefined'?require('./engine'):root.SandboxEngine,X=typeof module!=='undefined'?require('./experiments'):root.SandboxExperiments,R=typeof module!=='undefined'?require('./replay'):root.SandboxReplay;
function summarize(report){
 const c=report?.config,pairs=report?.pairs;
 if(report?.format!=='3dbox-server-link-comparison-v1'||!c||!Array.isArray(pairs)||pairs.length!==c.count||c.count<1||c.count>50||!['rapier','kinematic'].includes(c.physicsMode)||c.dispatchMode!=='networked'||!report.serverRuntime||typeof report.serverRuntime.instanceId!=='string'||!/^[a-f0-9-]{36}$/.test(report.serverRuntime.instanceId)||!['nearest','battery'].includes(c.policy))throw Error('报告格式或配置无效');
 X.validateLinkComparison(c);const scene=E.normalizeScene(c.scene);if(scene.id!==c.sceneId||(c.ttlOverride!=null&&c.ttlOverride!==scene.communication.ttl)||(c.decisionMaxAgeOverride!=null&&c.decisionMaxAgeOverride!==scene.communication.decisionMaxAge))throw Error('场景不一致');
 for(let i=0;i<pairs.length;i++){const p=pairs[i],seed=c.startSeed+i;if(!p||p.seed!==seed)throw Error('种子不连续');for(const condition of ['base','delay','loss']){
  const run=p[condition],expected=E.normalizeScene(scene);if(condition==='delay')expected.communication.delay=c.delay;if(condition==='loss')expected.communication.lossRate=c.lossRate;
  if(!run||run.seed!==seed||run.policy!==c.policy||run.physicsMode!==c.physicsMode||run.dispatchMode!==c.dispatchMode||!['completed','failed','timeout'].includes(run.status)||JSON.stringify(E.normalizeScene(run.scene))!==JSON.stringify(expected)||!run.metrics||!Number.isSafeInteger(run.metrics.ticks)||run.metrics.ticks<0||run.metrics.ticks>c.maxTicks||!Number.isSafeInteger(run.metrics.dispatchSent)||!Number.isSafeInteger(run.metrics.dispatchFailed)||run.metrics.dispatchSent<0||run.metrics.dispatchFailed<0||!Array.isArray(run.events)||run.events.length>200000)throw Error('运行记录无效');
  for(let j=0;j<run.events.length;j++){const e=run.events[j];if(!e||e.seq!==j+1||!Number.isSafeInteger(e.tick)||e.tick<0||e.tick>run.metrics.ticks||(j&&e.tick<run.events[j-1].tick))throw Error('事件时序无效')}
  if(run.metrics.dispatchSent!==run.events.filter(e=>e.kind==='dispatch_sent').length||run.metrics.dispatchFailed!==run.events.filter(e=>e.kind==='dispatch_failed').length)throw Error('指令指标与事件不一致');
 }}
 const result=X.linkComparisonReport(c,pairs);return {summary:result.summary,paired:result.paired};
}
function extractArchive(report,seed,condition){
 summarize(report);const c=report.config,run=report.pairs.find(p=>p.seed===seed)?.[condition],archive=run?.archive;if(!['base','delay','loss'].includes(condition)||!archive||typeof run.historyTruncated!=='boolean')throw Error('此运行未保存回放');R.validateArchive(archive);
 const last=archive.frames.at(-1),status=last.failed?'failed':last.done?'completed':'timeout',m=E.metrics(last),coverage=archive.coverage;
 if(archive.config.seed!==seed||archive.config.policy!==c.policy||JSON.stringify(E.normalizeScene(archive.config.scene))!==JSON.stringify(E.normalizeScene(run.scene))||last.physicsMode!==c.physicsMode||last.dispatchMode!=='networked'||coverage?.start!==(run.historyTruncated?'partial':'complete')||status!==run.status||['ticks','dispatchSent','dispatchFailed','energyUsed','collisionContacts'].some(k=>m[k]!==run.metrics[k])||JSON.stringify(last.events)!==JSON.stringify(run.events))throw Error('回放与实验结果不一致');return archive;
}
const api={summarize,extractArchive};if(typeof module!=='undefined')module.exports=api;else root.SandboxServerLinkReport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
