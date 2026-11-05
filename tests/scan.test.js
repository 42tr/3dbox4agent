'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const E=require('../src/engine'),R=require('../src/replay');
const {createServer}=require('../server/world-server');

function make(id='scan-1',tick=1){return {requestId:id,type:'scan',targetTick:tick,expiresTick:tick+10}}
function scenario(withWall=false){const scene=E.getScene('industrial-park-v1');scene.sensorRange=100;scene.obstacles=withWall?[{id:'wall',x:55,y:0,w:2,h:80,height:100}]:[];const world=E.create(42,'nearest',scene,{dispatchMode:'external'});const agent=world.agents.find(a=>a.id==='drone-1');agent.x=50;agent.y=37;return world}

(async()=>{
 let s=scenario(),a=s.agents.find(x=>x.id==='drone-1'),before=a.battery;
 assert(E.submitAction(s,a.id,make()).ok);assert(E.submitAction(s,a.id,make()).duplicate);
 assert.equal(E.submitAction(s,a.id,{...make(),type:'move',target:{x:10,y:10}}).reason,'request_id_conflict');
 E.step(s);assert.equal(s.actions[0].status,'accepted');E.step(s);assert.equal(s.actions[0].progress,2);assert(!s.actions[0].result);E.step(s);
 assert.equal(s.actions[0].status,'completed');assert.equal(s.actions[0].result.kind,'anomaly');assert.deepEqual(s.actions[0].result.position,s.part.site);assert.equal(s.actions[0].result.observedTick,3);assert(Math.abs(before-a.battery-.24)<1e-7);assert.equal(s.asset.diagnosis,'unknown');assert.equal(E.observe(s,'drone-1').actions[0].result.kind,'anomaly');assert.equal(E.observe(s,'drone-2').actions.length,0);
 assert(E.submitAction(s,a.id,make('scan-normal',4)).ok);s.asset.condition='operational';for(let i=0;i<3;i++)E.step(s);assert.equal(s.actions[1].result.kind,'normal');
 s=scenario(true);assert(E.submitAction(s,'drone-1',make()).ok);for(let i=0;i<3;i++)E.step(s);assert.deepEqual(s.actions[0].result,{kind:'not_detected',observedTick:3});
 s=scenario();s.sensorRange=1;assert(E.submitAction(s,'drone-1',make()).ok);for(let i=0;i<3;i++)E.step(s);assert.equal(s.actions[0].result.kind,'not_detected');
 s=scenario();assert(E.submitAction(s,'vehicle-1',make()).ok);E.step(s);assert.equal(s.actions[0].status,'rejected');assert.equal(s.actions[0].reason,'missing_capability');
 s=scenario();a=s.agents.find(x=>x.id==='drone-1');a.battery=4;assert(E.submitAction(s,a.id,make()).ok);E.step(s);assert.equal(s.actions[0].reason,'low_battery');
 s=scenario();assert.equal(E.submitAction(s,'drone-1',{...make(),target:{x:1,y:1}}).reason,'invalid_action');
 const builtin=E.create(42,'nearest',E.scene,{dispatchMode:'external'});assert(E.submitAction(builtin,'drone-1',make()).ok);for(let i=0;i<3;i++)E.step(builtin);const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames:[E.snapshot(builtin)]};assert(R.validateArchive(archive));const bad=structuredClone(archive);bad.frames[0].actions[0].result={kind:'<img>',observedTick:3};assert.throws(()=>R.validateArchive(bad));
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 async function req(p,method='GET',data,token){const r=await fetch(url+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
 try{
  const [,session]=await req('/sessions','POST',{seed:42,dispatchMode:'external'}),root='/sessions/'+session.sessionId,admin=session.adminToken;
  const [,first]=await req(root+'/agents/drone-1/credentials','POST',{},admin),[,second]=await req(root+'/agents/drone-2/credentials','POST',{},admin);
  const code="from box_agent import AgentClient\nimport os\nc=AgentClient(os.environ['SID'],'drone-1',os.environ['TOKEN'],os.environ['URL'])\nassert c.scan('sdk-scan',1,10)['action']['status']=='pending'\nprint('scan submitted')";
  const child=spawn('python3',['-c',code],{env:{...process.env,PYTHONPATH:path.resolve('sdk/python'),SID:session.sessionId,TOKEN:first.agentToken,URL:url},stdio:['ignore','pipe','pipe']});let out='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>out+=x);const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(exit,0,out);
  await req(root+'/step','POST',{count:3},admin);const [,own]=await req(root+'/observations/drone-1','GET',undefined,first.agentToken),[,other]=await req(root+'/observations/drone-2','GET',undefined,second.agentToken);
  assert.equal(own.actions[0].status,'completed');assert(own.actions[0].result);assert.equal(other.actions.length,0);const [denied]=await req(root+'/observations/drone-1','GET',undefined,second.agentToken);assert.equal(denied,403);
  console.log('scan action and SDK tests passed');
 }finally{server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
