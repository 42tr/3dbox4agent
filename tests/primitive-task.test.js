'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const E=require('../src/engine'),P=require('../server/physics'),R=require('../src/replay');
const {createServer}=require('../server/world-server');
const schedule=(id,type,tick,extra={})=>({requestId:id,type,targetTick:tick+1,expiresTick:tick+30,...extra});

(async()=>{
 await P.initialize();
 for(const physicsMode of ['kinematic','rapier'])for(const seed of [40,42,44]){
  const world=E.create(seed,'nearest',E.scene,{executionMode:'primitive',physicsMode}),physics=physicsMode==='rapier'?P.createPhysics(world):null,frames=[E.snapshot(world)];let seq=0,faulted=false;
  try{
   while(!world.done&&world.tick<1000){
    for(const agent of world.agents){const o=E.observe(world,agent.id);if(o.self.status!=='assigned'||o.actions.some(a=>['pending','accepted'].includes(a.status)))continue;const task=o.assignedTasks.find(t=>t.status==='active');assert(task&&task.waypoint);const extra=task.withinReach?{taskId:task.id}:{target:{x:task.waypoint[0],y:task.waypoint[1]}};assert(E.submitAction(world,agent.id,schedule('act-'+(++seq),task.withinReach?'work_task':'move',world.tick,extra)).ok)}
    E.step(world,physics);frames.push(E.snapshot(world));
    if(!faulted&&world.part.location==='carried'&&world.agents.find(a=>a.id===world.part.carrierId).status==='manual'){const carrier=world.part.carrierId;assert(E.fault(world));frames.push(E.snapshot(world));assert(world.actions.some(a=>a.agentId===carrier&&a.type==='move'&&a.status==='failed'&&a.reason==='agent_unavailable'));assert.equal(world.part.location,'ground');faulted=true}
   }
   assert(faulted&&world.done&&!world.failed,`${physicsMode}/${seed}`);assert.equal(world.asset.condition,'operational');assert.equal(world.part.location,'consumed');assert(world.events.some(e=>e.kind==='part_dropped'));
   assert(world.actions.filter(a=>a.type==='work_task'&&a.status==='completed').length>=6);assert(world.actions.filter(a=>a.type==='move'&&a.status==='completed').length>=5);
   assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed,policy:'nearest'},frames}));
  }finally{physics?.free()}
 }
 const s=E.create(42,'nearest',E.scene,{executionMode:'primitive',dispatchMode:'external'});assert(E.assign(s,'inspect','drone-1').ok);assert(E.submitAction(s,'drone-1',schedule('far','work_task',s.tick,{taskId:'inspect'})).ok);E.step(s);assert.equal(s.actions[0].reason,'out_of_reach');assert.equal(s.asset.diagnosis,'unknown');assert(E.submitAction(s,'drone-2',schedule('wrong','work_task',s.tick,{taskId:'inspect'})).ok);E.step(s);assert.equal(s.actions[1].reason,'task_not_assigned');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 async function req(p,method='GET',body,token){const r=await fetch(url+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return [r.status,await r.json()]}
 try{
  const [,session]=await req('/sessions','POST',{seed:42,executionMode:'primitive',dispatchMode:'external'}),root='/sessions/'+session.sessionId,admin=session.adminToken;
  const [,obs]=await req(root+'/coordinator/observation','GET',undefined,admin),task=obs.tasks[0],agent=task.candidates[0].id;
  await req(root+'/coordinator/decisions','POST',{requestId:'assign',taskId:task.id,agentId:agent,observedTick:obs.tick},admin);const [,issued]=await req(root+'/agents/'+agent+'/credentials','POST',{},admin);
  const child=spawn('python3',[path.resolve('sdk/python/task_agent.py'),'--poll','0.01'],{env:{...process.env,BOX_URL:url,BOX_SESSION:session.sessionId,BOX_AGENT:agent,BOX_TOKEN:issued.agentToken},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  try{let observed=null;for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,10));[,observed]=await req(root+'/observations/'+agent,'GET',undefined,issued.agentToken);if(observed.actions.some(a=>a.type==='work_task'&&a.status==='completed'))break;await req(root+'/step','POST',{count:1},admin)}assert(observed.actions.some(a=>a.type==='move'&&a.status==='completed'),output);assert(observed.actions.some(a=>a.type==='work_task'&&a.status==='completed'),output);assert(output.includes('提交移动')&&output.includes('提交作业'))}finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.on('close',r))}}
  console.log('primitive task execution and agent tests passed');
 }finally{server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
