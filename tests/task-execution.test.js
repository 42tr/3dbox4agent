'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{transformSync}=require('esbuild');
const source=transformSync(fs.readFileSync('src/task-execution.ts','utf8'),{loader:'ts',format:'cjs',target:'es2020'}).code,context={module:{exports:{}},exports:{}};
vm.runInNewContext(source,context);const {taskAttempts}=context.module.exports;
const task={id:'repair',name:'修复',status:'done',assignee:'robot-2',assignmentId:2};
const e=(tick,kind,agentId,assignmentId)=>({tick,kind,taskId:'repair',agentId,assignmentId,message:kind});
const events=[e(2,'task_assigned','robot-1',1),e(4,'task_work_started','robot-1',1),e(7,'device_fault','robot-1'),e(9,'task_assigned','robot-2',2),e(10,'task_work_started','robot-2',2),e(18,'task_completed','robot-2')].map((x,i)=>({...x,seq:i+1}));
let rows=taskAttempts([task],events,18);assert.equal(rows.length,2);assert.equal(rows[0].status,'interrupted');assert.equal(rows[0].elapsed,3);assert.equal(rows[1].status,'completed');assert.equal(rows[1].elapsed,8);assert.equal(rows[1].agentId,'robot-2');assert.equal(rows[0].events.length,3);
// Playback only sees events at or before its displayed tick.
rows=taskAttempts([{...task,status:'active',assignee:'robot-1',assignmentId:1}],events,5);assert.equal(rows.length,1);assert.equal(rows[0].status,'running');assert.equal(rows[0].elapsed,1);
// Without a start event, assignment-to-completion is not execution duration.
rows=taskAttempts([task],[e(9,'task_assigned','robot-2',2),e(18,'task_completed','robot-2')],18);assert.equal(rows[0].elapsed,null);assert.equal(rows[0].startedTick,null);
// Scope-limited current observations contain no global event history.
rows=taskAttempts([{id:'repair',name:'修复',status:'active'}],[],50,'robot-2');assert.equal(rows[0].source,'snapshot');assert.equal(rows[0].agentId,'robot-2');assert.equal(rows[0].startedTick,null);assert.equal(rows[0].elapsed,null);assert.equal(rows[0].status,'unknown');assert.equal(rows[0].events.length,0);
// A stale interruption from a previous assignment cannot end the new attempt.
rows=taskAttempts([{...task,status:'active'}],[...events.slice(0,5),e(12,'task_revoked','robot-1',1)],15);assert.equal(rows[1].status,'running');assert.equal(rows[1].elapsed,5);
// An unobserved assignment boundary never becomes a fabricated end timestamp.
rows=taskAttempts([task],[e(1,'task_assigned','robot-1',1),e(2,'task_work_started','robot-1',1),e(8,'task_assigned','robot-2',2)],10);assert.equal(rows[0].status,'interrupted');assert.equal(rows[0].endedTick,null);assert.equal(rows[0].elapsed,null);
// Legacy completion for a different device cannot complete the open attempt.
rows=taskAttempts([task],[e(1,'task_assigned','robot-1',1),e(2,'task_work_started','robot-1',1),e(8,'task_completed','robot-2')],10);assert.equal(rows.length,2);assert.equal(rows[0].status,'interrupted');assert.equal(rows[0].elapsed,null);assert.equal(rows[1].status,'completed');assert.equal(rows[1].elapsed,null);
// A current assignee is not proof of a historical event's actor.
rows=taskAttempts([task],[e(1,'task_assigned',undefined,1),e(2,'task_work_started',undefined,1)],5);assert.equal(rows[0].agentId,null);
console.log('task attempts: interruption, reassignment, playback, partial history and scope passed');
