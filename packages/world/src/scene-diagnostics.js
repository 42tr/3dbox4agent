/* Static, advisory checks; deliberately allow experiments with blocked tasks. */
(function(root){
'use strict';
const E=typeof module!=='undefined'?require('./world-core'):root.SandboxEngine;
const Nav=typeof module!=='undefined'?require('./navigation'):root.SandboxNavigation;
const Elevation=typeof module!=='undefined'?require('./elevation'):root.SandboxElevation;
const Sensors=typeof module!=='undefined'?require('./sensors'):root.SandboxSensors;
const Surface=typeof module!=='undefined'?require('./surface-domain'):root.SandboxSurfaceDomain;
function analyze(input){
 const scene=E.normalizeScene(input),blocks=scene.obstacles.concat(Elevation.blockedCells(scene.heightfield)),warnings=[],byId=new Map(scene.tasks.map(t=>[t.id,t])),ancestors=new Map();
 function dependencies(task){if(ancestors.has(task.id))return ancestors.get(task.id);const found=new Set();for(const id of task.dependsOn){found.add(id);for(const parent of dependencies(byId.get(id)))found.add(parent)}ancestors.set(task.id,found);return found}
 function checkSource(task,behavior){const sources=scene.tasks.filter(t=>t.behavior===behavior);if(!sources.length)warnings.push({code:'missing_state_source',taskId:task.id,requiredBehavior:behavior});else if(sources.every(t=>dependencies(t).has(task.id)))warnings.push({code:'cyclic_state_dependency',taskId:task.id,requiredBehavior:behavior,sourceTaskIds:sources.map(t=>t.id)});}
 for(const task of scene.tasks){
  const candidates=scene.agents.filter(a=>a.capabilities.includes(task.capability));
  if(!candidates.length)warnings.push({code:'missing_capability',taskId:task.id,capability:task.capability});
  if(candidates.length&&candidates.every(a=>!Sensors.isAir(a))&&!Nav.free(...task.target,blocks))warnings.push({code:'ground_target_blocked',taskId:task.id,target:task.target.slice()});
  if(task.behavior==='deliver'&&candidates.length&&candidates.every(a=>!Sensors.isAir(a))&&!Nav.free(...scene.resource.warehouse,blocks))warnings.push({code:'ground_pickup_blocked',taskId:task.id,target:scene.resource.warehouse.slice()});
  if(scene.surfaceDomain&&candidates.length){for(const [kind,goal]of [['surface_target_unavailable',task.target],...(task.behavior==='deliver'?[['surface_pickup_unavailable',scene.resource.warehouse]]:[])]){const possible=candidates.some(a=>Sensors.isAir(a)||[goal,...Surface.approaches(goal,3.7)].some(p=>Nav.free(...p,blocks.concat(Surface.masks(scene.surfaceDomain,a.mobility??'ground')))&&Nav.clearSegment(p,goal,scene.obstacles,0)));if(!possible)warnings.push({code:kind,taskId:task.id,target:goal.slice()})}}
  if(task.behavior==='repair')for(const source of ['confirm','deliver'])checkSource(task,source);
  if(task.behavior==='verify')checkSource(task,'repair');
 }
 const deliveries=scene.tasks.filter(t=>t.behavior==='deliver'),repairs=scene.tasks.filter(t=>t.behavior==='repair');
 if(deliveries.length>1)warnings.push({code:'single_part_multiple_deliveries',taskIds:deliveries.map(t=>t.id)});
 if(repairs.length>1)warnings.push({code:'single_part_multiple_repairs',taskIds:repairs.map(t=>t.id)});
 return {sceneId:scene.id,sceneName:scene.name,taskCount:scene.tasks.length,agentCount:scene.agents.reduce((n,a)=>n+a.count,0),warnings};
}
function describe(w){switch(w.code){case 'surface_target_unavailable':return `任务 ${w.taskId}：没有设备能在自身水陆通行区域内找到可用作业接近点。`;case 'surface_pickup_unavailable':return `任务 ${w.taskId}：仓库附近没有符合设备水陆通行区域的可用取货点。`;case 'missing_capability':return `任务 ${w.taskId}：没有配置具备 ${w.capability} 能力的设备。`;case 'ground_target_blocked':return `任务 ${w.taskId}：所有具备能力的设备均为地面设备，目标位于导航障碍或安全边距内，可能无法到达。`;case 'ground_pickup_blocked':return `任务 ${w.taskId}：所有具备能力的设备均为地面设备，仓库位置位于导航障碍或安全边距内，可能无法取件。`;case 'missing_state_source':return `任务 ${w.taskId}：场景中没有 ${w.requiredBehavior} 行为任务，无法由已有任务产生所需状态。`;case 'cyclic_state_dependency':return `任务 ${w.taskId} 需要 ${w.requiredBehavior} 状态，但所有来源任务（${w.sourceTaskIds.join('、')}）都依赖该任务，可能形成状态死锁。`;case 'single_part_multiple_deliveries':return `运输任务 ${w.taskIds.join('、')} 共享一份备件，多次运输可能无法全部完成。`;case 'single_part_multiple_repairs':return `维修任务 ${w.taskIds.join('、')} 共享一份备件，多次维修可能无法全部完成。`;default:throw Error('unknown diagnostic')}}
const api={analyze,describe};if(typeof module!=='undefined')module.exports=api;else root.SandboxSceneDiagnostics=api;
})(typeof globalThis!=='undefined'?globalThis:this);
