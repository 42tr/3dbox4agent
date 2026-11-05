'use strict';
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path'),{createServer}=require('../server/world-server');
(async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 async function post(p,data,token){const r=await fetch(url+p,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});assert(r.ok);return r.json()}
 try{const s=await post('/sessions',{seed:42,dispatchMode:'external'}),root='/sessions/'+s.sessionId,agent=await post(root+'/agents/vehicle-1/credentials',{},s.adminToken),coord=await post(root+'/coordinator/credentials',{},s.adminToken);
 const code=await new Promise((resolve,reject)=>{const child=spawn('python3',['tests/grpc_stream_integration_test.py'],{env:{...process.env,PYTHONPATH:[process.env.BOX_STREAM_TEST_DEPS||'',path.resolve('sdk/python')].filter(Boolean).join(path.delimiter),URL:url,SID:s.sessionId,ADMIN:s.adminToken,TOKEN:agent.agentToken,COORD:coord.coordinatorToken},stdio:'inherit'});child.on('error',reject);child.on('close',resolve)});assert.equal(code,0);
 }finally{await new Promise(r=>server.close(r))}})().catch(e=>{console.error(e);process.exitCode=1});
