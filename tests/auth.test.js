'use strict';
const assert=require('node:assert/strict');const http=require('node:http');const {createServer}=require('../server/world-server');
(async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,base=`http://127.0.0.1:${port}`;
 async function request(path,method='GET',data,token){const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [response.status,await response.json()]}
 try{
 const [,created]=await request('/sessions','POST',{seed:42}),id='/sessions/'+created.sessionId,admin=created.adminToken;
 assert.equal(admin.length,43);let [status]=await request(id);assert.equal(status,401);[status]=await request(id,'GET',undefined,'x'.repeat(43));assert.equal(status,401);
 let [,issued]=await request(id+'/agents/drone-1/credentials','POST',{},admin),agent=issued.agentToken;assert.equal(agent.length,43);assert.notEqual(agent,admin);
 let [ok,obs]=await request(id+'/observations/drone-1','GET',undefined,agent);assert.equal(ok,200);assert.equal(obs.self.id,'drone-1');assert(!('agents' in obs));
 for(const path of [id,id+'/history',id+'/observations/drone-2']){[status]=await request(path,'GET',undefined,agent);assert.equal(status,403,path)}
 for(const path of [id+'/step',id+'/assign',id+'/message',id+'/agents/drone-2/credentials']){[status]=await request(path,'POST',{},agent);assert.equal(status,403,path)}
 [status]=await request(id+'/agents/drone-2/messages','POST',{to:'drone-1',text:'x'},agent);assert.equal(status,403);
 [status]=await request(id+'/agents/drone-1/messages','POST',{from:'drone-2',to:'drone-2',text:'x'},agent);assert.equal(status,403);
 let [,sent]=await request(id+'/agents/drone-1/messages','POST',{to:'drone-2',text:'x'},agent);assert.deepEqual(Object.keys(sent),['messageId']);
 const [,second]=await request('/sessions','POST',{seed:42});[status]=await request('/sessions/'+second.sessionId,'GET',undefined,admin);assert.equal(status,401);[status]=await request('/sessions/'+second.sessionId,'GET',undefined,agent);assert.equal(status,401);
 // A request authenticated before token rotation cannot mutate after the body arrives.
 const pending=http.request({hostname:'127.0.0.1',port,path:id+'/agents/drone-1/messages',method:'POST',headers:{authorization:'Bearer '+agent,'content-type':'application/json','transfer-encoding':'chunked'}});
 const result=new Promise((resolve,reject)=>{pending.on('response',r=>{r.resume();r.on('end',()=>resolve(r.statusCode))});pending.on('error',reject)});pending.write('{"to":"drone-2",');await new Promise(resolve=>setTimeout(resolve,30));
 const [,replacement]=await request(id+'/agents/drone-1/credentials','POST',{},admin);pending.end('"text":"late"}');assert.equal(await result,401);
 [status]=await request(id+'/observations/drone-1','GET',undefined,agent);assert.equal(status,401);[status]=await request(id+'/observations/drone-1','GET',undefined,replacement.agentToken);assert.equal(status,200);
 let [,world]=await request(id,'GET',undefined,admin);assert(!JSON.stringify(world).includes(admin));assert(!JSON.stringify(world).includes(replacement.agentToken));assert.equal(world.world.communication.queue.length,1);
 await request(id,'DELETE',undefined,admin);[status]=await request(id+'/observations/drone-1','GET',undefined,replacement.agentToken);assert.equal(status,404);console.log('authorization tests passed');
 }finally{server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
