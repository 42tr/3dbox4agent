'use strict';const assert=require('node:assert/strict');const {createServer}=require('../server/world-server');
(async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
 let token;async function request(path,method='GET',data){const r=await fetch(url+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
 try{let [status,created]=await request('/sessions','POST',{seed:42});assert.equal(status,201);token=created.adminToken;let base='/sessions/'+created.sessionId;
 let [code,obs]=await request(base+'/observations/drone-1');assert.equal(code,200);assert.equal(obs.self.id,'drone-1');assert(!obs.tasks);
 [code]=await request(base+'/assign','POST',{taskId:'repair',agentId:'drone-1'});assert.equal(code,409);
 let [,stepped]=await request(base+'/step','POST',{count:3});assert.equal(stepped.world.tick,3);assert.equal(stepped.revision,3);
 let [,faulted]=await request(base+'/fault','POST',{});assert.equal(faulted.world.faults,1);assert.equal(faulted.revision,4);
 let [,finished]=await request(base+'/step','POST',{count:1000});assert(finished.world.done&&!finished.world.failed);assert.equal(finished.metrics.completed,5);
 let [,state]=await request(base);assert.deepEqual(state.world,finished.world);[code]=await request(base+'/step','POST',{count:1001});assert.equal(code,400);[code]=await request(base,'DELETE');assert.equal(code,200);[code]=await request(base);assert.equal(code,404);
 console.log('server integration tests passed');}finally{server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
