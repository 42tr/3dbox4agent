/* Explicit work operations for delivery, repair and sampling. */
(function (root) {
'use strict';

const Device = typeof module !== 'undefined' ? require('./device-capabilities') : root.SandboxDeviceCapabilities;
const flows = Object.freeze({
  deliver: Object.freeze(['dock_pickup','load','dock_delivery','unload','handoff']),
  repair: Object.freeze(['diagnose','remove','install','self_test']),
  sample: Object.freeze(['collect_sample']),
});
const durations = Object.freeze({dock_pickup:1,load:4,dock_delivery:1,unload:4,handoff:1,diagnose:2,remove:3,install:4,self_test:3});
const labels = Object.freeze({dock_pickup:'取货对接',load:'装货',dock_delivery:'卸货对接',unload:'卸货',handoff:'交接',
  diagnose:'现场诊断',remove:'拆卸故障部件',install:'安装备件',self_test:'维修自检',collect_sample:'定点采样'});
const valid = operation => typeof operation==='string'&&Object.hasOwn(labels,operation);
const duration = (task,operation) => operation==='collect_sample'?task.duration:durations[operation];
const canSample = agent => agent.role==='rover'&&Device.mobility(agent)==='ground'&&agent.capabilities.includes('sample');
const supported = (task,agent) => !!task&&!!agent&&Object.hasOwn(flows,task.behavior)&&Device.mobility(agent)==='ground'&&
  (task.behavior!=='sample'||canSample(agent));
const sampleCapacity = 4;
const sampleCount = (world,agentId) => world.events.filter(e=>e.kind==='sample_collected'&&e.agentId===agentId).length;
const sampleFull = (world,agentId) => sampleCount(world,agentId)>=sampleCapacity;
const installed = task => task.behavior==='repair'&&task.operationState?.last==='install';
const unloaded = task => task.behavior==='deliver'&&task.operationState?.last==='unload';

function docked(task,agent,operation) {
  const state=task.operationState;
  return state?.last===operation&&state.assignmentId===task.assignmentId&&Math.abs(agent.distance-state.distance)<=.05&&
    Math.hypot(agent.x-state.position[0],agent.y-state.position[1])<=.05;
}

function next(world,task,agent) {
  if (!supported(task,agent)||task.status!=='active'||task.assignee!==agent.id) return null;
  if (task.behavior==='sample') return 'collect_sample';
  if (task.behavior==='repair') {
    const steps=flows.repair;
    return steps[steps.indexOf(task.operationState?.last)+1]??null;
  }
  if (unloaded(task)) return 'handoff';
  if (world.part.location==='carried'&&world.part.carrierId===agent.id) {
    return docked(task,agent,'dock_delivery')?'unload':'dock_delivery';
  }
  return docked(task,agent,'dock_pickup')?'load':'dock_pickup';
}

function operationBlock(world,task,agent,operation) {
  if (!supported(task,agent)||!flows[task.behavior].includes(operation)) return 'operation_not_supported';
  if (operation!==next(world,task,agent)) return 'operation_out_of_order';
  if (operation==='collect_sample') return sampleFull(world,agent.id)?'sample_slots_full':null;
  const part=world.part;
  if (part.reservedBy!==task.id) return 'part_unavailable';
  if (task.behavior==='repair') {
    if (world.asset.diagnosis!=='confirmed') return 'anomaly_unconfirmed';
    return part.location===(operation==='self_test'?'consumed':'site')?null:'part_unavailable';
  }
  if (operation==='handoff') return part.location==='ground'?null:'part_unavailable';
  if (operation==='dock_delivery'||operation==='unload') {
    return part.location==='carried'&&part.carrierId===agent.id?null:'part_unavailable';
  }
  return ['warehouse','ground'].includes(part.location)?null:'part_unavailable';
}

function describe(world,task,agent) {
  const operation=next(world,task,agent);
  if (!operation) return null;
  return {operation,label:labels[operation],durationTicks:duration(task,operation),
    completed:task.operationState?.last??null,reason:operationBlock(world,task,agent,operation)};
}

const api={flows,labels,valid,duration,canSample,sampleCapacity,sampleCount,sampleFull,supported,installed,unloaded,next,operationBlock,describe};
if(typeof module!=='undefined')module.exports=api;
else root.SandboxTaskOperations=api;
})(typeof globalThis!=='undefined'?globalThis:this);
