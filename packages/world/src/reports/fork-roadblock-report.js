/* Validate a same-snapshot roadblock comparison and derive incremental metrics. */
(function(root){'use strict';
const E=typeof module!=='undefined'?require('../world-core'):root.SandboxEngine,R=typeof module!=='undefined'?require('../replay'):root.SandboxReplay;
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(){throw Error('分支对照记录无效或不一致')}
function summarize(report){
 const c=report?.config,source=report?.source,start=report?.initialWorld,runs=report?.runs,rect=c?.rect;
 if(report?.format!=='3dbox-fork-roadblock-v1'||typeof source?.sessionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(source.sessionId)||!integer(source.revision,0,Number.MAX_SAFE_INTEGER)||!c||!integer(c.duration,1,1000)||!integer(c.maxTicks,1,5000)||!rect||!['x','y','w','h'].every(k=>Number.isFinite(rect[k]))||rect.x<0||rect.y<0||rect.w<2||rect.h<2||rect.x+rect.w>100||rect.y+rect.h>100||!runs||typeof report.worldRuntime?.instanceId!=='string'||!start||start.done)fail();
 let scene;try{scene=E.normalizeScene(c.scene)}catch{fail()}if(scene.id!==start.sceneId)fail();const config={seed:start.seed,policy:start.policy,sceneId:start.sceneId,scene};
 try{R.validateArchive({format:'3dbox-prototype-v1',config,frames:[start]})}catch{fail()}
 const initial=E.metrics(start),rows=[];
 // Round only after subtraction; displayed cumulative metrics are already rounded.
 const distanceOf=w=>w.agents.reduce((n,a)=>n+a.distance,0);
 const energyOf=w=>w.agents.reduce((n,a)=>n+a.initialBattery-a.battery,0)-w.events.filter(e=>e.kind==='low_energy_injected').reduce((n,e)=>n+e.amount,0)+w.actions.filter(a=>a.type==='charge').reduce((n,a)=>n+(a.energyAdded||0),0);
 const roundedDifference=(a,b)=>Math.round((a-b)*100)/100;

 for(const kind of ['control','roadblock']){
  const run=runs[kind],end=run?.finalWorld;if(!run||!end||!['completed','failed','timeout'].includes(run.status)||typeof run.sourceState?.closed!=='boolean'||typeof run.sourceState?.partialTail!=='boolean'||end.tick<start.tick||end.tick>start.tick+c.maxTicks||run.status!==(end.done?(end.failed?'failed':'completed'):'timeout'))fail();
  try{R.validateArchive({format:'3dbox-prototype-v1',config,frames:[start,end]})}catch{fail()}
  if(!same(end.events.slice(0,start.events.length),start.events))fail();const fresh=end.events.slice(start.events.length),closures=fresh.filter(e=>e.kind==='roadblock_started');
  if(kind==='control'&&closures.length)fail();if(kind==='roadblock'&&(closures.length!==1||closures[0].tick!==start.tick||closures[0].startedTick!==start.tick||closures[0].untilTick!==start.tick+c.duration||!['x','y','w','h'].every(k=>closures[0][k]===rect[k])))fail();
  const metrics=E.metrics(end);if(run.archive){let loaded;try{loaded=R.unwrapArchive(run.archive)}catch{fail()}const a=loaded.archive,range=loaded.coverage.revisionRange;if(loaded.coverage.start!=='partial'||!range||a.config.seed!==start.seed||a.config.policy!==start.policy||!same(E.normalizeScene(a.config.scene),scene)||!same(a.frames.at(-1),end)||(range[0]===0&&!same(a.frames[0],start)))fail()}
  const difference=key=>Number.isFinite(metrics[key])&&Number.isFinite(initial[key])?Math.round((metrics[key]-initial[key])*100)/100:null;
  rows.push({condition:kind,status:run.status,steps:end.tick-start.tick,completed:end.done&&!end.failed,completedTasks:metrics.completed-initial.completed,energyUsed:roundedDifference(energyOf(end),energyOf(start)),distance:roundedDifference(distanceOf(end),distanceOf(start)),roadblockWaitTicks:difference('roadblockWaitTicks'),collisionContacts:difference('collisionContacts')});
 }
 return {rows,sourceTick:start.tick,sourceRevision:source.revision};
}
function extractArchive(report,kind){summarize(report);if(!['control','roadblock'].includes(kind))fail();const a=report.runs[kind].archive;if(!a)throw Error('该运行未保存回放');return a}
const api={summarize,extractArchive};if(typeof module!=='undefined')module.exports=api;else root.SandboxForkRoadblockReport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
