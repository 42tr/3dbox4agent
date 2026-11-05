'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createServer}=require('../server/world-server');
(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,method='GET',data,token){const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [response.status,await response.json()]}
  const [,session]=await call('/sessions','POST',{}),root='/sessions/'+session.sessionId,admin=session.adminToken;
  const issue=async id=>(await call(root+'/agents/'+id+'/credentials','POST',{},admin))[1].agentToken;
  let token=await issue('drone-1'),other=await issue('drone-2');const p=root+'/agents/drone-1/memory';
  assert.deepEqual(await call(p,'GET',undefined,token),[200,{revision:0,value:{}}]);
  assert.equal((await call(p,'GET',undefined,other))[0],403);assert.equal((await call(p,'GET',undefined,admin))[0],404);
  assert.deepEqual(await call(p,'POST',{expectedRevision:0,value:{note:'私有记忆唯一标记',nested:[1,true]}},token),[200,{revision:1,value:{note:'私有记忆唯一标记',nested:[1,true]}}]);
  assert.equal((await call(p,'POST',{expectedRevision:0,value:{changed:true}},token))[1].error,'memory_revision_conflict');
  assert.equal((await call(p,'POST',{expectedRevision:1,value:{text:'界'.repeat(3000)}},token))[1].error,'memory_too_large');
  assert.equal((await call(p,'POST',{expectedRevision:1,value:[]},token))[1].error,'invalid_memory');
  assert.equal((await call(p,'POST',null,token))[1].error,'invalid_memory');
  assert.deepEqual((await call(root+'/agents/drone-2/memory','GET',undefined,other))[1],{revision:0,value:{}});
  const state=(await call(root,'GET',undefined,admin))[1];assert.equal(state.revision,0);assert(!JSON.stringify(state).includes('私有记忆唯一标记'));
  const rotated=await issue('drone-1');assert.equal((await call(p,'GET',undefined,token))[0],401);token=rotated;
  assert.equal((await call(p,'GET',undefined,token))[1].value.note,'私有记忆唯一标记');
  const code="import os; from box_agent import AgentClient, SandboxError; c=AgentClient(os.environ['SID'],'drone-1',os.environ['TOKEN'],os.environ['URL']); m=c.read_memory(); assert m['revision']==1; assert c.write_memory({'saved':True},m['revision'])['revision']==2\ntry: c.write_memory({},1)\nexcept SandboxError as e: assert e.status==409 and e.code=='memory_revision_conflict'\nelse: raise AssertionError('missing conflict')";
  const child=spawn('python3',['-c',code],{env:{...process.env,PYTHONPATH:'sdk/python',SID:session.sessionId,TOKEN:token,URL:base},stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',x=>error+=x);const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(exit,0,error);
  assert.deepEqual((await call(p,'GET',undefined,token))[1],{revision:2,value:{saved:true}});
  const racing=await Promise.all([call(p,'POST',{expectedRevision:2,value:{writer:1}},token),call(p,'POST',{expectedRevision:2,value:{writer:2}},token)]);
  assert.deepEqual(racing.map(x=>x[0]).sort(),[200,409]);
  await call(root,'DELETE',undefined,admin);assert.equal((await call(p,'GET',undefined,token))[0],404);
  console.log('private agent memory API and SDK tests passed');
 }finally{server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
