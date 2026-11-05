'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const E=require('../src/engine'),R=require('../src/replay');
const {createServer}=require('../server/world-server');
const charge=(id,tick=0)=>({requestId:id,type:'charge',targetTick:tick+1,expiresTick:tick+90});
(async()=>{
 let s=E.create(42,'nearest',E.scene,{dispatchMode:'external'}),a=s.agents.find(a=>a.id==='drone-1'),b=s.agents.find(a=>a.id==='drone-2');
 assert(E.injectLowEnergy(s,a.id,5).ok);assert(E.injectLowEnergy(s,b.id,4).ok);
 const before=E.metrics(s).energyUsed,frames=[E.snapshot(s)];assert(E.submitAction(s,a.id,charge('one')).ok);assert(E.submitAction(s,b.id,charge('two')).ok);assert(E.submitAction(s,a.id,charge('one')).duplicate);
 let waited=false;for(let i=0;i<300&&!s.actions.every(x=>x.status==='completed');i++){E.step(s);frames.push(E.snapshot(s));const charging=s.actions.filter(x=>x.phase==='charging'&&x.status==='accepted');assert(charging.length<=1);if(s.actions.some(x=>x.phase==='waiting'))waited=true}
 assert(waited);assert(s.actions.every(x=>x.status==='completed'));assert.equal(a.battery,80);assert.equal(b.battery,80);assert(E.metrics(s).energyCharged>140);assert(E.metrics(s).energyUsed>=before);assert(E.metrics(s).energyUsed<10);
 assert(E.submitAction(s,a.id,charge('enough',s.tick)).ok);E.step(s);assert.equal(s.actions.at(-1).reason,'battery_sufficient');frames.push(E.snapshot(s));
 const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames};assert(R.validateArchive(archive));const invalid=structuredClone(archive);invalid.frames.at(-1).chargingStation=[0,0];assert.throws(()=>R.validateArchive(invalid));
 s=E.create(42,'nearest',E.scene,{dispatchMode:'external'});a=s.agents[0];assert(E.injectLowEnergy(s,a.id,1).ok);a.x=1;a.y=99;assert(E.submitAction(s,a.id,charge('too-far')).ok);for(let i=0;i<100&&s.actions[0].status!=='failed';i++)E.step(s);assert.equal(s.actions[0].reason,'energy_depleted');assert(a.disabled);
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const base=`http://127.0.0.1:${server.address().port}`;async function req(path,method='GET',data,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
  const [,session]=await req('/sessions','POST',{dispatchMode:'external'}),root='/sessions/'+session.sessionId,admin=session.adminToken;const [,credentials]=await req(root+'/agents/drone-1/credentials','POST',{},admin);await req(root+'/low-energy','POST',{agentId:'drone-1',level:5},admin);
  const code="import os; from box_agent import AgentClient; c=AgentClient(os.environ['SID'],'drone-1',os.environ['TOKEN'],os.environ['URL']); assert c.charge('sdk-charge',1,90)['action']['status']=='pending'";
  const child=spawn('python3',['-c',code],{env:{...process.env,PYTHONPATH:'sdk/python',SID:session.sessionId,TOKEN:credentials.agentToken,URL:base},stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',x=>error+=x);const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(exit,0,error);
  await req(root+'/step','POST',{count:100},admin);const [,own]=await req(root+'/observations/drone-1','GET',undefined,credentials.agentToken);assert.equal(own.actions[0].status,'completed');assert.equal(own.self.battery,80);
  const [,history]=await req(root+'/history?after=-1','GET',undefined,admin);assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames:history.frames.map(x=>x.world)}));
 }finally{server.close()}
 console.log('charging action, queue, energy accounting, replay and SDK tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
