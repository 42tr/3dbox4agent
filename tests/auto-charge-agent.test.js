'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const E=require('../src/engine'),R=require('../src/replay');
const {createServer}=require('../server/world-server');
(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function req(path,method='GET',data,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});const body=await r.json();assert(r.ok,JSON.stringify(body));return body}
 let child;try{
  const scene=E.getScene();scene.agents.find(a=>a.role==='drone').count=1;
  const session=await req('/sessions','POST',{scene,dispatchMode:'external',executionMode:'primitive'}),root='/sessions/'+session.sessionId,admin=session.adminToken;
  const token=(await req(root+'/agents/drone-1/credentials','POST',{},admin)).agentToken;
  await req(root+'/low-energy','POST',{agentId:'drone-1',level:5},admin);
  const paused=await req(root+'/step','POST',{count:1},admin);assert(!paused.world.done);assert.deepEqual(paused.world.chargeRecovery.agentIds,['drone-1']);
  const initial=await req(root+'/observations/drone-1','GET',undefined,token);assert(initial.self.returnEnergyEstimate+4>5);
  child=spawn('python3',['sdk/python/task_agent.py','--poll','0.01','--lead-ticks','1','--auto-charge','--charge-threshold','1','--charge-reserve','4'],{env:{...process.env,BOX_SESSION:session.sessionId,BOX_AGENT:'drone-1',BOX_TOKEN:token,BOX_URL:base},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
  let state;const deadline=Date.now()+15000;
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,10));assert.equal(child.exitCode,null,output);state=await req(root,'GET',undefined,admin);const action=state.world.actions.find(a=>a.type==='charge');if(action?.status==='completed')break;if(action&&['pending','accepted'].includes(action.status))await req(root+'/step','POST',{count:1},admin)}
  assert(state.world.actions.some(a=>a.type==='charge'&&a.status==='completed'),output);assert.equal(state.world.agents.find(a=>a.id==='drone-1').battery,80);
  const decision=await req(root+'/assign','POST',{taskId:'inspect',agentId:'drone-1'},admin);assert.equal(decision.world.tasks.find(t=>t.id==='inspect').status,'active');
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,10));assert.equal(child.exitCode,null,output);state=await req(root,'GET',undefined,admin);if(state.world.tasks.find(t=>t.id==='inspect').status==='done')break;const live=state.world.actions.some(a=>a.agentId==='drone-1'&&['pending','accepted'].includes(a.status));if(live)await req(root+'/step','POST',{count:1},admin)}
  assert.equal(state.world.tasks.find(t=>t.id==='inspect').status,'done',output);assert(state.world.actions.some(a=>a.type==='work_task'&&a.status==='completed'));assert(output.includes('提交自主补能'));
  const history=await req(root+'/history?after=-1','GET',undefined,admin);assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:history.frames.map(f=>f.world)}));
  console.log('autonomous charging agent rejoined task integration passed');
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.on('close',r))}server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
