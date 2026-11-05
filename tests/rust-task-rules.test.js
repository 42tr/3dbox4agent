'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Rules=require('../server/rust-task-rules'),{createServer}=require('../server/world-server');
function pair(){const a=E.create(42,'nearest'),b=E.create(42,'nearest');E.bindTaskRules(b,Rules);return [a,b]}
function compare(change,task,agent,expected){const [a,b]=pair();change(a);change(b);const x=E.assign(a,task,agent),y=E.assign(b,task,agent);assert.deepEqual(y,x);if(expected)assert.equal(x.reason,expected);assert.deepEqual(E.snapshot(b),E.snapshot(a))}
const noop=()=>{};
compare(s=>s.done=true,'none','none','world_finished');compare(noop,'none','none','unknown_task');compare(noop,'inspect','none','unknown_agent');compare(noop,'confirm','drone-1','task_not_ready');compare(s=>s.agents[0].disabled=true,'inspect','drone-1','agent_unavailable');compare(s=>s.agents[0].battery=5,'inspect','drone-1','low_battery');compare(noop,'inspect','vehicle-1','missing_capability');compare(noop,'inspect','drone-1');
for(const mode of ['auto','agent','primitive'])compare(s=>s.executionMode=mode,'inspect','drone-1');
compare(s=>{s.agents[0].roadblockWait={roadblockId:'roadblock-1',startedTick:0,owner:{kind:'task',taskId:'inspect',assignmentId:1}}},'inspect','drone-1');
{const s=E.create(42,'nearest'),before=E.snapshot(s);E.bindTaskRules(s,{...Rules,check:()=>null,transition:()=>{throw Error('native failure')}});assert.throws(()=>E.assign(s,'inspect','drone-1'),/native failure/);assert.deepEqual(E.snapshot(s),before)}
{const s=E.create(42,'nearest'),before=E.snapshot(s);E.bindTaskRules(s,{...Rules,check:()=>null,transition:()=>({})});assert.throws(()=>E.assign(s,'inspect','drone-1'),/invalid native task transition/);assert.deepEqual(E.snapshot(s),before)}
for(const workTick of [()=>{throw Error('native work failure')},()=>({})]){
 const s=E.create(42,'nearest');s.dispatchMode='external';E.bindTaskRules(s,{...Rules,workTick});assert(E.assign(s,'inspect','drone-1').ok);const agent=s.agents[0],task=s.tasks.find(t=>t.id==='inspect');agent.route=[];const before={work:agent.work,battery:agent.battery,phase:task.phase};assert.throws(()=>E.step(s),/native work failure|invalid native work result/);assert.deepEqual({work:agent.work,battery:agent.battery,phase:task.phase},before);
}
function readyFor(s,id){for(const t of s.tasks)t.status=t.id===id?'pending':'done'}
compare(s=>{readyFor(s,'deliver');s.part.location='carried'},'deliver','vehicle-1','part_unavailable');
compare(s=>{readyFor(s,'deliver');s.executionMode='primitive'},'deliver','vehicle-1');
compare(s=>{readyFor(s,'repair');s.asset.diagnosis='confirmed';s.part.location='site'},'repair','robot-1');
compare(s=>{readyFor(s,'repair');s.asset.diagnosis='unknown'},'repair','robot-1','anomaly_unconfirmed');
compare(s=>{readyFor(s,'repair');s.asset.diagnosis='confirmed';s.part.location='warehouse'},'repair','robot-1','part_unavailable');
compare(s=>{readyFor(s,'verify');s.asset.condition='fault'},'verify','drone-1','repair_required');
for(const scene of ['industrial-park-v1','industrial-park-parallel-v1','lunar-base-v1','lunar-terrain-v1','lunar-sampling-v1','shore-coordination-v1'])for(let seed=0;seed<4;seed++){
 const a=E.create(seed,'nearest',E.getScene(scene)),b=E.create(seed,'nearest',E.getScene(scene));E.bindTaskRules(b,Rules);let faulted=false;
 for(let i=0;i<1000&&!a.done;i++){if(!faulted&&a.tick>5&&a.tasks.some(t=>t.status==='active')){assert.equal(E.fault(a),E.fault(b));faulted=true}E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a),`${scene} seed ${seed} tick ${a.tick}`)}assert(a.done);assert.deepEqual(E.metrics(b),E.metrics(a));
}
{
 const [a,b]=pair();for(const s of [a,b]){assert(E.assign(s,'inspect','drone-1').ok);const agent=s.agents[0];agent.route=[];agent.battery=.04}E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a));assert(a.events.some(e=>e.kind==='energy_depleted'));
}
{
 const scene=E.getScene();scene.obstacles=[];const a=E.create(42,'nearest',scene),b=E.create(42,'nearest',scene);E.bindTaskRules(b,Rules);while(a.tick<300&&!a.tasks.some(t=>t.behavior==='deliver'&&t.phase==='loading')){E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a))}assert(a.tasks.some(t=>t.behavior==='deliver'&&t.phase==='loading'));for(const s of [a,b])assert(E.injectRoadblock(s,{x:55,y:0,w:8,h:100},10).ok);while(!a.done&&a.tick<1000){E.step(a);E.step(b);assert.deepEqual(E.snapshot(b),E.snapshot(a))}assert(a.done&&!a.failed);assert(a.events.some(e=>e.kind==='roadblock_wait_started'));assert(a.events.some(e=>e.kind==='part_loaded'));
}
(async()=>{const servers=[createServer({taskBackend:'js'}),createServer({taskBackend:'rust'})];await Promise.all(servers.map(s=>new Promise(r=>s.listen(0,'127.0.0.1',r))));
 async function request(server,p,method='GET',data,token){const r=await fetch(`http://127.0.0.1:${server.address().port}`+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
 try{assert.equal((await request(servers[1],'/health'))[1].runtime.taskBackend,'rust');const sessions=await Promise.all(servers.map(s=>request(s,'/sessions','POST',{sceneId:'industrial-park-parallel-v1',dispatchMode:'external'})));const task=sessions[0][1].world.tasks.find(t=>t.status==='pending'&&!t.dependsOn.length),agent=sessions[0][1].world.agents.find(a=>a.capabilities.includes(task.capability));const bodies=await Promise.all(servers.map((s,i)=>request(s,'/sessions/'+sessions[i][1].sessionId+'/assign','POST',{taskId:task.id,agentId:agent.id},sessions[i][1].adminToken)));assert.equal(bodies[0][0],200);assert.equal(bodies[0][0],bodies[1][0]);assert.deepEqual(bodies[0][1].world,bodies[1][1].world);
 for(let i=0;i<servers.length;i++){const c=sessions[i][1],root='/sessions/'+c.sessionId;await request(servers[i],root,'DELETE',undefined,c.adminToken)}
 }finally{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))))}console.log('Rust assignment eligibility parity, full scenario behavior and server integration passed')})().catch(e=>{console.error(e);process.exitCode=1});
