'use strict';
const assert=require('node:assert/strict'), {spawn}=require('node:child_process'), {createServer}=require('../server/world-server');
(async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 async function post(path,data,token){const r=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});assert(r.ok,`${path}: ${r.status}`);return r.json()}
 try{const scene=require('../src/engine').getScene();scene.communication.lossRate=0;const s=await post('/sessions',{seed:42,scene,dispatchMode:'external',...(process.env.BOX_GRPC_RUST_TEST?{physicsMode:'rapier'}:{})}),root='/sessions/'+s.sessionId;const agent=await post(root+'/agents/vehicle-1/credentials',{},s.adminToken),coord=await post(root+'/coordinator/credentials',{},s.adminToken);
 const code=await new Promise((resolve,reject)=>{const child=spawn('python3',['tests/grpc_integration_test.py'],{env:{...process.env,PYTHONPATH:'sdk/python',URL:url,SID:s.sessionId,ADMIN:s.adminToken,TOKEN:agent.agentToken,COORD:coord.coordinatorToken},stdio:'inherit'});child.on('error',reject);child.on('close',resolve)});assert.equal(code,0);
 }finally{await new Promise(r=>server.close(r))}})().catch(e=>{console.error(e);process.exitCode=1});
