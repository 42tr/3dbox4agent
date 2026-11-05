'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const E=require('../src/engine'),P=require('../server/physics'),R=require('../src/replay');
const {createServer}=require('../server/world-server');

function intent(id,taskId,tick){return {requestId:id,type:'execute_task',taskId,targetTick:tick,expiresTick:tick+10}}
(async()=>{
 await P.initialize();
 for(const mode of ['kinematic','rapier']){
  const s=E.create(42,'nearest',E.scene,{executionMode:'agent',physicsMode:mode}),physics=mode==='rapier'?P.createPhysics(s):null,frames=[E.snapshot(s)];let seq=0,injected=false;
  try{
   E.step(s,physics);const first=s.tasks.find(t=>t.status==='active'),agent=s.agents.find(a=>a.id===first.assignee),position=[agent.x,agent.y];assert.equal(agent.status,'assigned');
   for(let i=0;i<3;i++)E.step(s,physics);assert.deepEqual([agent.x,agent.y],position);assert.equal(first.status,'active');
   assert(E.submitAction(s,'drone-2',intent('unauthorized',first.id,s.tick+1)).ok);E.step(s,physics);assert.equal(s.actions[0].reason,'task_not_assigned');
   const start=intent('first',first.id,s.tick+1);assert(E.submitAction(s,agent.id,start).ok);assert(E.submitAction(s,agent.id,start).duplicate);assert.equal(E.submitAction(s,agent.id,{...start,taskId:'other'}).reason,'request_id_conflict');
   E.step(s,physics);assert.equal(s.actions.find(a=>a.requestId==='first').status,'accepted');
   while(!s.done&&s.tick<1000){
    for(const t of s.tasks.filter(t=>t.status==='active')){const a=s.agents.find(x=>x.id===t.assignee);if(a.status==='assigned'&&!s.actions.some(x=>x.agentId===a.id&&x.taskId===t.id&&x.status==='pending'))assert(E.submitAction(s,a.id,intent('agent-'+(++seq),t.id,s.tick+1)).ok)}
    E.step(s,physics);frames.push(E.snapshot(s));
    if(!injected&&s.part.location==='carried'){assert(E.fault(s));frames.push(E.snapshot(s));injected=true;assert(s.actions.some(x=>x.type==='execute_task'&&x.status==='failed'&&x.reason==='agent_unavailable'))}
   }
   assert(injected&&s.done&&!s.failed,mode);assert.equal(s.asset.condition,'operational');assert(s.actions.filter(x=>x.type==='execute_task'&&x.status==='completed').length>=5);
   assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames}));
  }finally{physics?.free()}
 }
 let automatic=E.create(42);assert(E.submitAction(automatic,'drone-1',intent('disabled','inspect',1)).ok);E.step(automatic);assert.equal(automatic.actions[0].reason,'agent_execution_disabled');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 async function req(p,method='GET',body,token){const r=await fetch(url+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return [r.status,await r.json()]}
 try{
  const [,created]=await req('/sessions','POST',{seed:42,executionMode:'agent',dispatchMode:'external'}),root='/sessions/'+created.sessionId,admin=created.adminToken;
  const [,obs]=await req(root+'/coordinator/observation','GET',undefined,admin),agentId=obs.tasks[0].candidates[0].id;
  await req(root+'/coordinator/decisions','POST',{requestId:'assign',taskId:obs.tasks[0].id,agentId,observedTick:obs.tick},admin);
  const [,issued]=await req(root+'/agents/'+agentId+'/credentials','POST',{},admin);
  const code="from box_agent import AgentClient\nimport os\nc=AgentClient(os.environ['SID'],os.environ['AGENT'],os.environ['TOKEN'],os.environ['URL'])\no=c.observe()\nassert o['self']['status']=='assigned'\nt=o['assignedTasks'][0]\nassert c.execute_task('sdk-execute',t['id'],o['tick']+1,o['tick']+10)['action']['status']=='pending'\nprint('task submitted')";
  const child=spawn('python3',['-c',code],{env:{...process.env,PYTHONPATH:path.resolve('sdk/python'),SID:created.sessionId,AGENT:agentId,TOKEN:issued.agentToken,URL:url},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(exit,0,output);
  await req(root+'/step','POST',{count:100},admin);const [,agentObs]=await req(root+'/observations/'+agentId,'GET',undefined,issued.agentToken);assert.equal(agentObs.actions[0].status,'completed');
  const [denied]=await req(root+'/agents/drone-2/actions','POST',intent('forged','inspect',101),issued.agentToken);assert.equal(denied,403);
  const [,nextObs]=await req(root+'/coordinator/observation','GET',undefined,admin);const next=nextObs.tasks[0],nextAgent=next.candidates[0].id;await req(root+'/coordinator/decisions','POST',{requestId:'assign-next',taskId:next.id,agentId:nextAgent,observedTick:nextObs.tick},admin);const [,nextCredential]=await req(root+'/agents/'+nextAgent+'/credentials','POST',{},admin);
  const runner=spawn('python3',[path.resolve('sdk/python/task_agent.py'),'--poll','0.01'],{env:{...process.env,BOX_SESSION:created.sessionId,BOX_AGENT:nextAgent,BOX_TOKEN:nextCredential.agentToken,BOX_URL:url},stdio:['ignore','pipe','pipe']});let runnerOutput='';const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('agent process did not submit task: '+runnerOutput)),5000);runner.stdout.on('data',chunk=>{runnerOutput+=chunk;if(runnerOutput.includes('提交')){clearTimeout(timer);resolve()}});runner.stderr.on('data',chunk=>runnerOutput+=chunk);runner.on('error',reject);runner.on('exit',code=>{if(code!==null&&!runnerOutput.includes('提交')){clearTimeout(timer);reject(Error('agent process exited: '+runnerOutput))}})});try{await ready;const [,runnerObs]=await req(root+'/observations/'+nextAgent,'GET',undefined,nextCredential.agentToken);assert(runnerObs.actions.some(a=>a.type==='execute_task'&&a.taskId===next.id&&a.status==='pending'),JSON.stringify({runnerOutput,runnerObs,next}));await req(root+'/step','POST',{count:10},admin);const [,started]=await req(root+'/observations/'+nextAgent,'GET',undefined,nextCredential.agentToken);assert(started.actions.some(a=>a.type==='execute_task'&&a.status==='accepted'))}finally{runner.kill();await new Promise(resolve=>runner.on('close',resolve))}
  console.log('agent task execution and SDK tests passed');
 }finally{server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
