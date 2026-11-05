'use strict';
const assert=require('node:assert/strict');const {createServer}=require('../server/world-server');
(async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 let token;async function req(path,method='GET',payload,headers={}){const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...headers},body:payload===undefined?undefined:JSON.stringify(payload)});return [res.status,await res.json()]}
 try{
 const html=await fetch(base+'/');assert.equal(html.status,200);assert((await html.text()).includes('连接本地世界服务'));
 let [status,created]=await req('/sessions','POST',{seed:123});assert.equal(status,201);token=created.adminToken;const session='/sessions/'+created.sessionId;
 [status]=await req(session+'/run','POST',{speed:3});assert.equal(status,400);
 [status]=await req(session+'/run','POST',{speed:1});assert.equal(status,200);
 [status]=await req(session+'/step','POST',{count:1});assert.equal(status,409);
 await new Promise(resolve=>setTimeout(resolve,180));
 let [,paused]=await req(session+'/pause','POST',{});assert(paused.world.tick>=1);assert.equal(paused.running,false);
 let [,history]=await req(session+'/history?after=-1');assert.equal(history.frames[0].revision,0);assert.equal(history.frames.at(-1).revision,paused.revision);assert.equal(history.frames.at(-1).world.tick,paused.world.tick);
 let [,secondClient]=await req(session);assert.deepEqual(secondClient.world,paused.world);
 await new Promise(resolve=>setTimeout(resolve,120));let [,still]=await req(session);assert.equal(still.revision,paused.revision);
 [status]=await req(session+'/fault','POST',{}, {origin:'https://evil.example'});assert.equal(status,403);
 [status]=await req(session+'/history?after=abc');assert.equal(status,400);
 [status]=await req(session,'DELETE');assert.equal(status,200);console.log('live server tests passed');
 }finally{server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
