'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Tasks=require('../server/rust-world-tasks'),Rules=require('../server/rust-task-rules'),Ledger=require('../server/rust-world-ledger'),Motion=require('../server/rust-world-motion'),Physics=require('../server/rust-physics'),{WorldTasks}=require('../rust/physics/target/release/box_physics.node');
const initialWorld=E.create(42),initial={tasks:initialWorld.tasks,agents:initialWorld.agents.map(a=>({id:a.id,role:a.role,capabilities:a.capabilities}))};
const native=(value=initial)=>new WorldTasks(JSON.stringify(value));
const cmd=(n,kind,taskId,detail={})=>n.command(JSON.stringify({kind,taskId,...detail}));
const proposed=id=>({id,behavior:'survey',name:'Follow-up',role:'drone',capability:'inspect',target:[65,55],duration:3,dependsOn:['inspect'],status:'pending',assignee:null});
for(const mutate of [v=>v.tasks=[],v=>v.tasks.push({...v.tasks[0]}),v=>v.tasks[0].target[0]=-1,v=>v.tasks[0].duration=.5,v=>v.tasks[0].deadline=10000001,v=>v.tasks[0].priority=101,v=>v.tasks[0].dependsOn=['missing'],v=>v.tasks[0].dependsOn=['confirm'],v=>v.tasks[0].phase='repairing',v=>v.tasks[0].status='other',v=>v.tasks[0].status='active',v=>v.tasks[0].assignee='drone-1',v=>v.tasks[0].assignmentId=0,v=>v.tasks[0].startedAssignmentId=2,v=>v.tasks[0].unknown=true,v=>v.agents=[],v=>v.agents.push({...v.agents[0]})]){const value=structuredClone(initial);mutate(value);assert.throws(()=>native(value),/invalid world tasks/)}
{
 const a=native(),b=native();let before=a.snapshot();
 for(const args of [['assign','confirm',{agentId:'drone-1',assignmentId:1}],['assign','inspect',{agentId:'vehicle-1',assignmentId:1}],['assign','inspect',{agentId:'missing',assignmentId:1}],['assign','inspect',{agentId:'drone-1',assignmentId:0}],['complete','inspect',{assignmentId:1}],['requeue','inspect',{assignmentId:1,clearPhase:false}],['phase','inspect',{assignmentId:1,phase:'loading'}],['assign','missing',{agentId:'drone-1',assignmentId:1}]])assert.throws(()=>cmd(a,...args),/invalid world tasks/);
 assert.equal(a.snapshot(),before);cmd(a,'assign','inspect',{agentId:'drone-1',assignmentId:1});assert.equal(a.read('inspect','status'),'"active"');assert.equal(a.read('inspect','phase'),null);cmd(a,'start','inspect',{assignmentId:1});cmd(a,'requeue','inspect',{assignmentId:1,clearPhase:false});
 before=a.snapshot();assert.throws(()=>cmd(a,'assign','inspect',{agentId:'drone-1',assignmentId:1}),/invalid world tasks/);assert.equal(a.snapshot(),before);cmd(a,'assign','inspect',{agentId:'drone-2',assignmentId:2});before=a.snapshot();assert.throws(()=>cmd(a,'complete','inspect',{assignmentId:1}),/invalid world tasks/);assert.equal(a.snapshot(),before);cmd(a,'start','inspect',{assignmentId:2});cmd(a,'complete','inspect',{assignmentId:2});
 before=a.snapshot();for(const [kind,detail] of [['assign',{agentId:'drone-1',assignmentId:3}],['requeue',{assignmentId:2,clearPhase:false}],['phase',{assignmentId:2,phase:null}],['complete',{assignmentId:2}]])assert.throws(()=>cmd(a,kind,'inspect',detail),/invalid world tasks/);assert.equal(a.snapshot(),before);
 cmd(a,'assign','confirm',{agentId:'drone-1',assignmentId:3});cmd(a,'start','confirm',{assignmentId:3});cmd(a,'complete','confirm',{assignmentId:3});cmd(a,'assign','deliver',{agentId:'vehicle-1',assignmentId:4});before=a.snapshot();assert.throws(()=>cmd(a,'phase','deliver',{assignmentId:4,phase:'to_site'}),/invalid world tasks/);assert.equal(a.snapshot(),before);
 for(const phase of ['loading','to_site','unloading'])cmd(a,'phase','deliver',{assignmentId:4,phase});cmd(a,'complete','deliver',{assignmentId:4});
 a.append(JSON.stringify(proposed('follow-up')));a.append(JSON.stringify(proposed('other-follow-up')));cmd(a,'assign','follow-up',{agentId:'drone-1',assignmentId:5});before=a.snapshot();assert.throws(()=>cmd(a,'assign','other-follow-up',{agentId:'drone-1',assignmentId:6}),/invalid world tasks/);assert.equal(a.snapshot(),before);
 for(const mutate of [t=>t.id='follow-up',t=>t.dependsOn=['missing'],t=>t.dependsOn=['inspect','inspect'],t=>t.role='missing',t=>t.behavior='repair',t=>t.duration=1001,t=>t.status='done',t=>t.assignmentId=1]){const task=proposed('rejected');mutate(task);assert.throws(()=>a.append(JSON.stringify(task)),/invalid world tasks/);assert.equal(a.snapshot(),before)}
 const restored=native({...initial,tasks:JSON.parse(a.snapshot())});cmd(restored,'requeue','follow-up',{assignmentId:5,clearPhase:true});assert.equal(a.snapshot(),before);assert.deepEqual(JSON.parse(b.snapshot()),initial.tasks);assert.equal(b.read('inspect','status'),'"pending"');
 a.free();a.free();for(const operation of [()=>a.snapshot(),()=>a.read('inspect','status'),()=>cmd(a,'complete','follow-up',{assignmentId:5}),()=>a.append(JSON.stringify(proposed('closed')))])assert.throws(operation,/closed/);b.free();restored.free();
 const limit=native();for(let i=0;i<95;i++)limit.append(JSON.stringify(proposed('task-'+i)));before=limit.snapshot();assert.throws(()=>limit.append(JSON.stringify(proposed('overflow'))),/invalid world tasks/);assert.equal(limit.snapshot(),before);limit.free();
}
function bind(world){const store=Tasks.create(world);E.bindWorldTasks(world,store);E.bindWorldLedger(world,Ledger.create(world));E.bindWorldMotion(world,Motion.create(world));E.bindTaskRules(world,Rules,world.tick!==0);return store}
{
 const s=E.create(42),retained=s.tasks[0],copy=E.snapshot(s),store=bind(s);assert.deepEqual(E.snapshot(s),copy);
 for(const [key,value] of [['status','done'],['assignee','drone-1'],['phase','loading'],['assignmentId',1],['startedAssignmentId',1],['name','other'],['id','other'],['target',[0,0]]]){assert.throws(()=>s.tasks[0][key]=value,TypeError);assert.throws(()=>Object.defineProperty(s.tasks[0],key,{value}),TypeError)}
 assert.throws(()=>s.tasks=[],TypeError);assert.throws(()=>s.tasks.push({}),TypeError);assert.throws(()=>s.tasks[0].dependsOn.push('missing'),TypeError);assert.throws(()=>s.tasks[0].target[0]=0,TypeError);retained.status='done';retained.target[0]=0;assert.deepEqual(E.snapshot(s),copy);assert.throws(()=>E.bindWorldTasks(E.create(42),store),/unavailable/);E.disposeWorld(s);E.disposeWorld(s);assert.throws(()=>store.views,e=>e.worldTasksFailure&&e.status===503);
 const wrong=Tasks.create(E.create(43,'nearest',E.getScene('lunar-outpost-v1')));assert.throws(()=>E.bindWorldTasks(E.create(42),wrong),/unavailable/);wrong.free();
}
for(const sceneId of ['industrial-park-v1','industrial-park-parallel-v1','industrial-park-priority-v1','lunar-base-v1','lunar-terrain-v1','lunar-sampling-v1','lunar-outpost-v1','shore-coordination-v1'])for(const seed of [42,43]){
 const a=E.create(seed,'nearest',E.getScene(sceneId)),b=E.snapshot(a);bind(b);let fork=null;
 while(!a.done&&a.tick<1000){if(a.tick===3){E.fault(a);E.fault(b);fork=E.snapshot(b);bind(fork)}E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a),`${sceneId}:${seed}:${a.tick}`);if(fork){E.step(fork);assert.deepEqual(E.snapshot(fork),E.snapshot(b))}}
 assert(a.done);assert.deepEqual(E.metrics(b),E.metrics(a));E.disposeWorld(b);if(fork)E.disposeWorld(fork);
}
{
 const a=E.create(42,'nearest',E.getScene(),{dispatchMode:'external'}),b=E.snapshot(a);bind(b);
 const both=operation=>{const x=operation(a),y=operation(b);assert.deepEqual(y,x);assert.deepEqual(E.snapshot(b),E.snapshot(a));return x};
 assert(both(s=>E.assign(s,'inspect','drone-1')).ok);both(s=>E.step(s).tick);assert.equal(both(s=>{const t=s.tasks[0];return E.revokeTask(s,{requestId:'revoke',taskId:t.id,agentId:t.assignee,assignmentId:t.assignmentId,observedTick:s.tick})}).revocation.status,'accepted');
 assert(both(s=>E.assign(s,'inspect','drone-2')).ok);assert(both(s=>E.injectLowEnergy(s,'drone-2',4)).ok);
 const proposal={requestId:'follow-up',observedTick:a.tick,task:{id:'follow-up',name:'复勘',role:'drone',target:[65,55],duration:3,dependsOn:[]}};assert.equal(both(s=>E.proposeSurvey(s,proposal)).proposal.status,'accepted');assert(both(s=>E.proposeSurvey(s,proposal)).duplicate);assert(both(s=>E.assign(s,'follow-up','drone-3')).ok);both(s=>E.setDispatchMode(s,'rule'));while(!a.done&&a.tick<1000)both(s=>E.step(s).tick);assert(a.done&&!a.failed);assert.equal(a.tasks.length,6);E.disposeWorld(b);
}
{
 const a=E.create(42,'nearest',E.getScene('lunar-outpost-v1'),{physicsMode:'rapier'}),b=E.snapshot(a),pa=Physics.createPhysics(a),pb=Physics.createPhysics(b);E.bindTaskRules(a,Rules);bind(b);let interrupted=false;
 try{while(!a.done&&a.tick<1000){if(!interrupted&&a.part.location==='carried'){E.fault(a);E.fault(b);interrupted=true}E.step(a,pa);E.step(b,pb);assert.deepEqual(E.snapshot(b),E.snapshot(a),`Rapier:${a.tick}`)}assert(interrupted&&a.done&&!a.failed)}finally{pa.free();pb.free();E.disposeWorld(b)}
}
console.log('Rust-owned task graph, dependency/capability/version guards, phase transitions, immutable views, eight-scene per-frame parity, restores, proposals/revocations/low energy and actual Rapier cargo interruption passed');
