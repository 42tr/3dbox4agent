'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),R=require('../src/replay');
const archive=frames=>({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames});
function world(type='execute_task',mode=type==='work_task'?'primitive':'agent',targetTick=1){const w=E.create(42,'nearest',E.getScene(),{dispatchMode:'external',executionMode:mode});assert(E.submitAction(w,'drone-1',{requestId:'unknown-task',type,taskId:'missing',targetTick,expiresTick:100}).ok);return w}
let rejected;
for(const type of ['execute_task','work_task']){
 const w=world(type),frames=[E.snapshot(w)];assert(R.validateArchive(archive(frames)));E.step(w);frames.push(E.snapshot(w));assert.equal(w.actions[0].status,'rejected');assert.equal(w.actions[0].reason,'task_not_assigned');assert(R.validateArchive(archive(frames)));assert(R.validateArchive(archive([E.snapshot(w)])));if(type==='execute_task')rejected=archive([E.snapshot(w)]);
 const cancelled=world(type);assert(E.cancelAction(cancelled,'drone-1','unknown-task').ok);assert(R.validateArchive(archive([E.snapshot(cancelled)])));
 const low=world(type);assert(E.injectLowEnergy(low,'drone-1',4).ok);assert.equal(low.actions[0].reason,'low_battery');assert(R.validateArchive(archive([E.snapshot(low)])));
 const disabled=world(type,'auto');E.step(disabled);assert.equal(disabled.actions[0].reason,'agent_execution_disabled');assert(R.validateArchive(archive([E.snapshot(disabled)])));
 const unavailable=world(type);assert(E.assign(unavailable,'inspect','drone-1').ok);assert(E.fault(unavailable));E.step(unavailable);assert.equal(unavailable.actions[0].reason,'agent_unavailable');assert(R.validateArchive(archive([E.snapshot(unavailable)])));
 const revoked=world(type);assert(E.assign(revoked,'inspect','drone-1').ok);const task=revoked.tasks[0];assert.equal(E.revokeTask(revoked,{requestId:'revoke',taskId:task.id,agentId:'drone-1',assignmentId:task.assignmentId,observedTick:0}).revocation.status,'accepted');assert.equal(revoked.actions[0].reason,'task_revoked');assert(R.validateArchive(archive([E.snapshot(revoked)])));
}
for(const mutate of [a=>a.status='accepted',a=>a.status='completed',a=>a.status='failed',a=>a.taskId='<invalid>',a=>a.requestId='',a=>a.reason='not_a_reason',a=>a.reason='expired',a=>a.updatedTick=2,a=>a.updatedTick=-1,a=>a.targetTick=0,a=>a.expiresTick=101,a=>a.submittedTick=2,a=>a.progress=1,a=>a.result={kind:'not_detected',observedTick:1},a=>a.phase='charging',a=>a.energyAdded=2]){const value=structuredClone(rejected);mutate(value.frames[0].actions[0]);assert.throws(()=>R.validateArchive(value))}
for(const kind of ['action_submitted','action_rejected']){const value=structuredClone(rejected);value.frames[0].events=value.frames[0].events.filter(e=>e.kind!==kind);assert.throws(()=>R.validateArchive(value))}
{const value=structuredClone(rejected);value.frames[0].actions.push({...value.frames[0].actions[0]});assert.throws(()=>R.validateArchive(value))}
{const w=world(),value=archive([E.snapshot(w)]);value.frames[0].actions[0].updatedTick=0;assert.throws(()=>R.validateArchive(value));value.frames[0].actions[0].updatedTick=undefined;value.frames[0].done=true;assert.throws(()=>R.validateArchive(value))}
// Legacy fixed-step test fixtures can advance the clock before action activation.
{const w=E.create(42,'nearest',E.getScene(),{dispatchMode:'external',executionMode:'agent'});assert(E.submitAction(w,'drone-1',{requestId:'expired',type:'execute_task',taskId:'missing',targetTick:1,expiresTick:1}).ok);w.tick=1;E.step(w);assert.equal(w.actions[0].reason,'expired');assert(R.validateArchive(archive([E.snapshot(w)])))}
{const scene=E.getScene();scene.id='deferred-intent-world-end';scene.tasks=[{...scene.tasks[0],target:[22,32],duration:1}];const w=E.create(42,'nearest',scene,{dispatchMode:'external',executionMode:'agent'});assert(E.assign(w,'inspect','drone-1').ok);assert(E.submitAction(w,'drone-1',{requestId:'later',type:'execute_task',taskId:'missing',targetTick:10,expiresTick:100}).ok);assert(E.submitAction(w,'drone-1',{requestId:'finish',type:'execute_task',taskId:'inspect',targetTick:1,expiresTick:100}).ok);const frames=[E.snapshot(w)];while(!w.done&&w.tick<20){E.step(w);frames.push(E.snapshot(w))}assert(w.done);assert.equal(w.actions[0].reason,'run_ended');assert(R.validateArchive({...archive(frames),config:{seed:42,policy:'nearest',sceneId:scene.id,scene}}))}
// A pending intention may become executable if a task is proposed and assigned
// before its due tick. Validation uses each frame's own task graph.
for(const type of ['execute_task','work_task']){
 const w=world(type,undefined,5),frames=[E.snapshot(w)];assert.equal(E.proposeSurvey(w,{requestId:'create-missing',observedTick:0,task:{id:'missing',name:'后续勘察',role:'drone',target:[22,32],duration:2,dependsOn:[]}}).proposal.status,'accepted');assert(E.assign(w,'missing','drone-1').ok);
 if(type==='work_task'){// Primitive work must be within reach; initial drone-1 is at 22,32.
  assert.deepEqual([w.agents[0].x,w.agents[0].y],[22,32]);
 }
 frames.push(E.snapshot(w));for(let i=0;i<100&&w.tasks.at(-1).status!=='done';i++){E.step(w);frames.push(E.snapshot(w))}assert.equal(w.tasks.at(-1).status,'done');assert.equal(w.actions[0].status,'completed');assert(R.validateArchive(archive(frames)));
}
console.log('Deferred unknown-task intention replay: pending/rejected/cancelled, priority errors, partial history, future task activation and contradictory-state rejection passed');
