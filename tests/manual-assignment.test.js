'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{transformSync}=require('esbuild'),E=require('../src/engine');
const context={module:{exports:{}},exports:{}};vm.runInNewContext(transformSync(fs.readFileSync('src/manual-assignment.ts','utf8'),{loader:'ts',format:'cjs',target:'es2020'}).code,context);const M=context.module.exports;
const plain=x=>JSON.parse(JSON.stringify(x)),world=()=>E.create(42,'nearest',E.getScene('lunar-outpost-v1'),{dispatchMode:'external'});
function frame(w){return {key:'one',observer:false,imported:false,focused:false,latest:true,running:false,busy:false,done:w.done,failed:false,tasks:w.tasks,agents:w.agents}}
(async()=>{
 for(const reason of ['__proto__','constructor','toString'])assert.equal(typeof M.assignmentMessage(reason),'string');
 const w=world(),c=frame(w),ready=M.assignmentTasks(c.tasks);assert.deepEqual(plain(ready.map(t=>t.id)),['inspect','survey']);const inspect=ready[0],agents=M.assignmentAgents(c.agents,inspect);assert.equal(agents.length,4);
 const mixed=[{...agents[0],id:'other-role',role:'different'},{...agents[0],id:'empty',battery:5},{...agents[0],id:'disabled',disabled:true},{...agents[0],id:'working',status:'working'},{...agents[0],id:'wrong',capabilities:[]}];assert.deepEqual(plain(M.assignmentAgents(mixed,inspect).map(a=>a.id)),['other-role']);assert.equal(M.assignmentTasks([{...inspect,dependsOn:['missing']}]).length,0);
 for(const [field,reason]of [['observer','read_only'],['imported','imported_replay'],['focused','agent_view'],['running','pause_required'],['busy','busy'],['done','world_finished'],['failed','session_stopped'],['latest','history_view']]){
  const state={...c,[field]:field==='latest'?false:true};let calls=0;const submit=M.createAssignmentController({read:()=>state,setBusy(){throw Error('blocked request acquired lock')},assign(){calls++;return {ok:true}},refresh(){calls++}});assert.equal((await submit('one','inspect',agents[0].id)).reason,reason);assert.equal(calls,0);
 }
 {
  const local=world(),ctx=frame(local),frames=[E.snapshot(local)];let writes=0;const submit=M.createAssignmentController({read:()=>ctx,setBusy(b){ctx.busy=b},assign(t,a){writes++;const r=E.assign(local,t,a);if(r.ok)frames.push(E.snapshot(local));return r},refresh(){}});
  assert.equal((await submit('one','inspect','rover-4')).ok,true);assert.equal(writes,1);assert.equal(frames.length,2);assert.equal(frames[1].tick,0);assert.equal(frames[1].tasks[0].assignee,'rover-4');assert.equal(frames[1].events.at(-1).kind,'task_assigned');assert.equal((await submit('one','inspect','rover-3')).reason,'selection_changed');assert.equal(writes,1);assert.equal(ctx.busy,false);
 }
 {
  const ctx=frame(world());let release,writes=0,reads=0;const gate=new Promise(r=>release=r),submit=M.createAssignmentController({read:()=>ctx,setBusy(b){ctx.busy=b},async assign(){writes++;await gate;return {ok:true}},refresh(){reads++}}),first=submit('one','inspect','rover-1');assert.equal((await submit('one','inspect','rover-1')).reason,'busy');release();assert.equal((await first).ok,true);assert.equal(writes,1);assert.equal(reads,1);
 }
 {
  const ctx=frame(world());let release,writes=0,reads=0,unlocks=0;const gate=new Promise(r=>release=r),submit=M.createAssignmentController({read:()=>ctx,setBusy(b){ctx.busy=b;if(!b)unlocks++},async assign(){writes++;await gate;return {ok:true}},refresh(){reads++}}),first=submit('one','inspect','rover-1');ctx.key='two';ctx.busy=true;release();assert.equal((await first).reason,'context_changed');assert.equal(reads,0);assert.equal(unlocks,0);assert.equal(writes,1);
 }
 {
  const ctx=frame(world());let writes=0,reads=0,errors=0;const submit=M.createAssignmentController({read:()=>ctx,setBusy(b){ctx.busy=b},assign(){writes++;return {ok:true}},refresh(){reads++;throw Error('read disconnected')},onError(){errors++}});const result=await submit('one','inspect','rover-1');assert.equal(result.ok,true);assert.equal(result.refreshPending,true);assert.equal(writes,1);assert.equal(reads,1);assert.equal(errors,1);
 }
 {
  const ctx=frame(world());let writes=0,reads=0,errors=0;const submit=M.createAssignmentController({read:()=>ctx,setBusy(b){ctx.busy=b},assign(){writes++;throw Object.assign(Error('task_not_ready'),{status:409})},refresh(){reads++},onError(){errors++}});assert.equal((await submit('one','inspect','rover-1')).reason,'task_not_ready');assert.equal(writes,1);assert.equal(reads,1);assert.equal(errors,0);assert.equal(ctx.busy,false);
 }
 {
  const ctx=frame(world());let reads=0;const submit=M.createAssignmentController({read:()=>ctx,setBusy(b){ctx.busy=b},assign(){throw Error('network detail with credential')},refresh(){reads++},onError(){ctx.key='new';ctx.busy=true}});assert.equal((await submit('one','inspect','rover-1')).reason,'context_changed');assert.equal(reads,0);assert.equal(ctx.busy,true);assert(!M.assignmentMessage('network detail with credential').includes('credential'));
 }
 {
  const ctx=frame(world());let writes=0,reads=0,errors=0;const submit=M.createAssignmentController({read:()=>ctx,setBusy(b){ctx.busy=b},assign(){writes++;throw Object.assign(Error('world_step_failed'),{status:503})},refresh(){reads++},onError(){errors++;ctx.failed=true}});assert.equal((await submit('one','inspect','rover-1')).reason,'world_step_failed');assert.equal(writes,1);assert.equal(reads,1);assert.equal(errors,1);assert.equal(M.assignmentBlock(ctx),'session_stopped');
 }
 console.log('Manual assignment choices and actual local commit: dependency/capability/status/battery, eight blocked modes, same-tick history, stale choices, single-flight, world-switch fences, accepted-but-unsynced result and rejected refresh without mutation retry passed');
})().catch(e=>{console.error(e);process.exitCode=1});
