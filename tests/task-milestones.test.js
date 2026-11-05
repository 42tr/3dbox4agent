'use strict';
const assert=require('node:assert/strict'), E=require('../src/engine'), X=require('../src/experiments'), R=require('../src/replay');
const world=E.create(42,'nearest',E.scene,{dispatchMode:'external',executionMode:'agent'});
let record=E.metrics(world).taskMilestones.find(x=>x.taskId==='inspect');
assert.deepEqual(record,{taskId:'inspect',firstAssignedTick:null,firstStartedTick:null,completedTick:null,assignments:0,assignmentToCompletionTicks:null});
assert(E.assign(world,'inspect','drone-1').ok);for(let i=0;i<3;i++)E.step(world);
record=E.metrics(world).taskMilestones.find(x=>x.taskId==='inspect');assert.equal(record.firstAssignedTick,0);assert.equal(record.firstStartedTick,null);assert.equal(record.completedTick,null);
assert(E.submitAction(world,'drone-1',{requestId:'start',type:'execute_task',taskId:'inspect',targetTick:4,expiresTick:10}).ok);E.step(world);assert.equal(E.metrics(world).taskMilestones.find(x=>x.taskId==='inspect').firstStartedTick,4);
assert(E.fault(world));assert(E.assign(world,'inspect','drone-2').ok);assert(E.submitAction(world,'drone-2',{requestId:'restart',type:'execute_task',taskId:'inspect',targetTick:5,expiresTick:10}).ok);while(world.tick<300&&world.tasks.find(x=>x.id==='inspect').status!=='done')E.step(world);
record=E.metrics(world).taskMilestones.find(x=>x.taskId==='inspect');assert.equal(record.assignments,2);assert.equal(record.firstAssignedTick,0);assert.equal(record.firstStartedTick,4);assert.equal(record.completedTick,world.events.find(x=>x.kind==='task_completed'&&x.taskId==='inspect').tick);assert.equal(record.assignmentToCompletionTicks,record.completedTick);assert(record.completedTick>4);
const snapshot=E.snapshot(world);assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames:[snapshot]}));assert.deepEqual(E.metrics(snapshot).taskMilestones,E.metrics(world).taskMilestones);
const legacy=structuredClone(snapshot);delete legacy.recoveryEventsVersion;assert.equal(E.metrics(legacy).taskMilestones,null);
const config={count:2,startSeed:42,maxTicks:1000,faultTick:null,policies:['nearest','battery']};const report=X.runBatch(config);
for(const summary of report.summary){const runs=report.runs.filter(r=>r.policy===summary.policy),m=summary.taskMilestones.find(x=>x.taskId==='inspect'),expected=runs.map(r=>r.metrics.taskMilestones.find(x=>x.taskId==='inspect').completedTick);assert.equal(m.observedRuns,2);assert.equal(m.completedRuns,2);assert.equal(m.completionTicks.n,2);assert.equal(m.completionTicks.mean,(expected[0]+expected[1])/2);assert.equal(m.assignmentToCompletionTicks.n,2)}
const failed=X.runBatch({...config,count:1,maxTicks:1});for(const summary of failed.summary){const m=summary.taskMilestones.find(x=>x.taskId==='inspect');assert.equal(m.completedRuns,0);assert.equal(m.completionTicks.n,0);assert.equal(m.completionTicks.mean,null)}
console.log('task milestone timing, reassignment, replay and batch aggregation passed');
