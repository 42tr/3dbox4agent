'use strict';
// Legacy pure rules remain available; compatible owned stores commit assignment natively.
const {assignmentPrecondition,assignmentTransition,revocationPrecondition,revocationTransition,taskWorkTick,actionActivationPrecondition,stationaryActionTick,worldTermination,timedTransitions,terrainSegment,motionBudget,motionAccounting,guardMovement}=require('../native/physics/target/release/box_physics.node');
function check(world,taskId,agentId){
 const input={done:world.done,...(world.materials!==undefined?{materials:world.materials}:{}),tasks:world.tasks.map(({id,status,dependsOn,capability,behavior,materialCost})=>({id,status,dependsOn,capability,behavior,...(materialCost!==undefined?{materialCost}:{})})),agents:world.agents.map(({id,disabled,status,battery,capabilities,deployableRelay})=>({id,disabled,status,battery,capabilities,...(deployableRelay!==undefined?{deployableRelay}:{})})),part:{location:world.part.location,reservedBy:world.part.reservedBy??null},asset:{diagnosis:world.asset.diagnosis,condition:world.asset.condition},taskId:taskId??null,agentId:agentId??null};
 return assignmentPrecondition(JSON.stringify(input))||null;
}
function transition(world,task,agent,route,assignmentId){
 return JSON.parse(assignmentTransition(JSON.stringify({taskId:task.id,agentId:agent.id,behavior:task.behavior,executionMode:world.executionMode??'auto',route,assignmentId})));
}
function checkRevocation(world,input){
 const task=world.tasks.find(t=>t.id===input.taskId),agent=world.agents.find(a=>a.id===input.agentId);
 const data={tick:world.tick,decisionMaxAge:world.communication.config.decisionMaxAge??5,taskId:input.taskId,agentId:input.agentId,assignmentId:input.assignmentId,observedTick:input.observedTick,requireBlockedSince:input.requireBlockedSince??null,task:task?{id:task.id,status:task.status,assignee:task.assignee??null,assignmentId:task.assignmentId??null}:null,agent:agent?{id:agent.id,roadblockWait:agent.roadblockWait??null}:null,actions:world.actions.map(({agentId,requestId,status,resumeTaskId})=>({agentId,requestId,status,resumeTaskId:resumeTaskId??null}))};
 return revocationPrecondition(JSON.stringify(data))||null;
}
function revokeTransition(world,task,agent,input){
 return JSON.parse(revocationTransition(JSON.stringify({taskId:task.id,agentId:agent.id,assignmentId:input.assignmentId,replans:world.replans,reservedBy:world.part.reservedBy??null,location:world.part.location,carrierId:world.part.carrierId??null,x:agent.x,y:agent.y})));
}
function workTick(world,task,agent){
 return JSON.parse(taskWorkTick(JSON.stringify({taskId:task.id,agentId:agent.id,behavior:task.behavior,phase:task.phase??null,work:agent.work,battery:agent.battery,workEnergy:agent.workEnergyPerTick??.08,duration:task.duration})));
}
function checkAction(world,action,agent,task,assignedTask,withinReach){
 return actionActivationPrecondition(JSON.stringify({tick:world.tick,expiresTick:action.expiresTick,actionType:action.type,executionMode:world.executionMode??'auto',agentId:agent.id,agentDisabled:agent.disabled,agentStatus:agent.status,battery:agent.battery,capabilities:agent.capabilities,taskStatus:task?.status??null,taskAssignee:task?.assignee??null,hasAssignedTask:!!assignedTask,withinReach}))||null;
}
function stationaryTick(world,action,agent,chargerBusy){
 return JSON.parse(stationaryActionTick(JSON.stringify({agentId:agent.id,requestId:action.requestId,actionType:action.type,battery:agent.battery,progress:action.progress??null,workEnergy:agent.workEnergyPerTick??.08,phase:action.phase??null,energyAdded:action.energyAdded??null,chargerBusy})));
}
function termination(input){return worldTermination(JSON.stringify(input))}
function timed(input){return JSON.parse(timedTransitions(JSON.stringify(input)))}
function terrain(input){return JSON.parse(terrainSegment(JSON.stringify(input)))}
function movementBudget(input){const [distance,dx,dy]=motionBudget(input.distance,input.boundary,input.remaining,input.speedFactor,input.battery,input.energyRate,input.energyFactor,input.ux,input.uy);return {distance,dx,dy}}
function movementAccounting(input){const [battery,remaining]=motionAccounting(input.battery,input.actualDistance,input.energyRate,input.energyFactor,input.remaining,input.desiredDistance,input.speedFactor);return {battery,remaining}}
function movementGuard(input){return JSON.parse(guardMovement(JSON.stringify(input)))}
module.exports={check,transition,checkRevocation,revokeTransition,workTick,checkAction,stationaryTick,termination,timed,terrain,movementBudget,movementAccounting,movementGuard};
