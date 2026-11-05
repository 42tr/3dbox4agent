'use strict';
const assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const E=require('../src/engine'),R=require('../src/replay'),{createServer}=require('../server/world-server');
(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));let worker,worker2;
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,method='GET',data,token){const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});const body=await res.json();assert(res.ok,JSON.stringify(body));return body}
  const scene=E.getScene('lunar-sampling-v1');scene.communication.lossRate=0;
  const session=await call('/sessions','POST',{scene}),root='/sessions/'+session.sessionId,admin=session.adminToken;
  let state=await call(root+'/step','POST',{count:65},admin),sample=state.world.events.find(e=>e.kind==='sample_collected');assert(sample&&!state.world.done);
  const agent=sample.agentId,credentials=await call(root+`/agents/${agent}/credentials`,'POST',{},admin);
  worker=spawn('python3',['sdk/python/task_agent.py','--poll','0.01','--auto-report-samples'],{env:{...process.env,BOX_URL:base,BOX_SESSION:session.sessionId,BOX_AGENT:agent,BOX_TOKEN:credentials.agentToken},stdio:['ignore','pipe','pipe']});let log='';worker.stdout.setEncoding('utf8');worker.stderr.setEncoding('utf8');worker.stdout.on('data',s=>log+=s);worker.stderr.on('data',s=>log+=s);
  async function waitFor(predicate){const deadline=Date.now()+5000;while(Date.now()<deadline){if(worker.exitCode!==null)throw Error('worker exited: '+log);const snapshot=await call(root,'GET',undefined,admin);if(predicate(snapshot.world))return snapshot;await new Promise(r=>setTimeout(r,20))}throw Error('agent timeout: '+log)}
  await waitFor(w=>w.sampleReports?.length===1&&w.sampleReports[0].status==='pending');
  await call(root+'/communication-outage','POST',{agentId:agent,duration:12},admin);
  state=await call(root+'/step','POST',{count:12},admin);assert.equal(state.world.sampleReports[0].reason,'interrupted');
  await waitFor(w=>w.sampleReports?.length===2&&w.sampleReports[1].status==='pending');
  state=await call(root+'/step','POST',{count:12},admin);assert.equal(state.world.sampleReports[1].status,'delivered');
  await new Promise(r=>setTimeout(r,80));state=await call(root,'GET',undefined,admin);assert.equal(state.world.sampleReports.length,2);
  const h=await call(root+'/history?after=-1','GET',undefined,admin);assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:h.frames.map(f=>f.world)}));
  const lossy=E.getScene('lunar-sampling-v1');lossy.communication.lossRate=1;const second=await call('/sessions','POST',{scene:lossy}),root2='/sessions/'+second.sessionId,admin2=second.adminToken;let secondState=await call(root2+'/step','POST',{count:65},admin2),secondSample=secondState.world.events.find(e=>e.kind==='sample_collected');assert(secondSample);const creds=await call(root2+`/agents/${secondSample.agentId}/credentials`,'POST',{},admin2);
  worker2=spawn('python3',['sdk/python/task_agent.py','--poll','0.01','--auto-report-samples','--sample-report-attempts','2'],{env:{...process.env,BOX_URL:base,BOX_SESSION:second.sessionId,BOX_AGENT:secondSample.agentId,BOX_TOKEN:creds.agentToken},stdio:'ignore'});
  async function waitSecond(count){const deadline=Date.now()+5000;while(Date.now()<deadline){if(worker2.exitCode!==null)throw Error('second worker exited');const current=await call(root2,'GET',undefined,admin2);if(current.world.sampleReports?.length===count&&current.world.sampleReports.at(-1).status==='pending')return;await new Promise(r=>setTimeout(r,20))}throw Error('second worker timeout')}
  for(let attempt=1;attempt<=2;attempt++){await waitSecond(attempt);secondState=await call(root2+'/step','POST',{count:12},admin2);assert.equal(secondState.world.sampleReports.at(-1).reason,'dropped')}
  await new Promise(r=>setTimeout(r,120));secondState=await call(root2,'GET',undefined,admin2);assert.equal(secondState.world.sampleReports.length,2);
  worker2.kill();await new Promise(r=>worker2.once('close',r));worker2=spawn('python3',['sdk/python/task_agent.py','--poll','0.01','--auto-report-samples','--sample-report-attempts','2'],{env:{...process.env,BOX_URL:base,BOX_SESSION:second.sessionId,BOX_AGENT:secondSample.agentId,BOX_TOKEN:creds.agentToken},stdio:'ignore'});await new Promise(r=>setTimeout(r,150));assert.equal(worker2.exitCode,null);secondState=await call(root2,'GET',undefined,admin2);assert.equal(secondState.world.sampleReports.length,2);

 }finally{for(const child of [worker,worker2])if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('close',r))}server.close()}
 console.log('independent sample agent interruption, bounded retry and replay passed');
})().catch(e=>{console.error(e);process.exitCode=1});
