'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const WebSocket=require('ws');
const {requestOriginError}=require('../server/request-origin');
const {createServer}=require('../server/world-server');
const {createSupervisor}=require('../server/world-supervisor');

function request(base,route,{host='3dbox.42tr.cn',origin='https://3dbox.42tr.cn',method='GET',body,token}={}){
 return new Promise((resolve,reject)=>{
  const headers={host,...(origin===null?{}:{origin}),...(token?{authorization:'Bearer '+token}:{})};
  const payload=body===undefined?undefined:JSON.stringify(body);
  if(payload!==undefined){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(payload)}
  const req=http.request(base+route,{method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,text,json:()=>JSON.parse(text)}));res.on('error',reject)});
  req.setTimeout(5000,()=>req.destroy(Error('HTTP request timeout')));req.on('error',reject);req.end(payload);
 });
}

function stream(base,host,origin){
 const socket=new WebSocket(base.replace('http:','ws:')+'/stream',{headers:{host},origin});
 const queue=[],waiting=[];
 const opened=new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
 const closed=new Promise(resolve=>socket.once('close',resolve));
 socket.on('error',()=>{});
 socket.on('message',raw=>{const value=JSON.parse(raw.toString());if(waiting.length){const next=waiting.shift();clearTimeout(next.timer);next.resolve(value)}else queue.push(value)});
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>waiting.push({resolve,timer:setTimeout(()=>reject(Error('stream message timeout')),5000)}));
 return {socket,opened,closed,next};
}

async function rejectStream(base,host,origin){
 const socket=new WebSocket(base.replace('http:','ws:')+'/stream',{headers:{host},origin});
 const rejected=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.terminate();reject(Error('stream rejection timeout'))},3000);socket.once('error',()=>{clearTimeout(timer);resolve(true)});socket.once('open',()=>{clearTimeout(timer);socket.terminate();resolve(false)})});
 assert.equal(rejected,true);
}

(async()=>{
 for(const headers of [
  {host:'3dbox.42tr.cn'},
  {host:'3dbox.42tr.cn',origin:'https://3dbox.42tr.cn'},
  {host:'3dbox.42tr.cn:443',origin:'https://3dbox.42tr.cn'},
  {host:'192.0.2.1:8787',origin:'http://192.0.2.1:8787'},
  {host:'[2001:db8::1]:8787',origin:'http://[2001:db8::1]:8787'},
  {host:'localhost:8787',origin:'http://localhost:8787'},
 ])assert.equal(requestOriginError({headers}),null,JSON.stringify(headers));
 for(const host of [undefined,'','bad@host','3dbox.42tr.cn/path','3dbox.42tr.cn\\path','3dbox.42tr.cn:99999','3dbox.42tr.cn evil.example'])assert.equal(requestOriginError({headers:{host}}),'invalid_host');
 for(const origin of ['null','','https://evil.example','https://3dbox.42tr.cn.evil.example','https://3dbox.42tr.cn:8443','https://3dbox.42tr.cn/path','ftp://3dbox.42tr.cn'])assert.equal(requestOriginError({headers:{host:'3dbox.42tr.cn',origin}}),'invalid_origin');
 assert.equal(requestOriginError({headers:{host:'127.0.0.1:8787',origin:'https://3dbox.42tr.cn','x-forwarded-host':'3dbox.42tr.cn'}}),'invalid_origin');

 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-remote-'));
 try{
  for(const kind of ['single','supervisor']){
   const options={catalogPath:path.join(dir,kind+'.sqlite3')};
   const server=kind==='single'?createServer(options):createSupervisor({maxWorkers:1,worldOptions:options});
   const clients=[];
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   const base=`http://127.0.0.1:${server.address().port}`;
   try{
    assert.equal((await request(base,'/',{origin:null})).status,200);
    assert.equal((await request(base,'/health')).json().ok,true);
    assert.equal((await request(base,'/health',{host:'192.0.2.1:8787',origin:'http://192.0.2.1:8787'})).status,200);
    assert.equal((await request(base,'/health',{host:'[2001:db8::1]:8787',origin:'http://[2001:db8::1]:8787'})).status,200);
    assert.equal((await request(base,'/health',{origin:'https://evil.example'})).status,403);
    assert.equal((await request(base,'/health',{host:'bad@host',origin:null})).status,403);
    const created=await request(base,'/sessions',{method:'POST',body:{seed:42,physicsMode:'kinematic'}});
    assert.equal(created.status,201,created.text);
    const {sessionId,adminToken}=created.json(),root='/sessions/'+sessionId;
    assert.equal((await request(base,root)).status,401);
    assert.equal((await request(base,root,{token:'x'.repeat(43)})).status,401);
    const live=stream(base,'3dbox.42tr.cn','https://3dbox.42tr.cn');clients.push(live.socket);
    await live.opened;live.socket.send(JSON.stringify({type:'subscribe',sessionId,token:adminToken,afterRevision:-1}));
    const ready=await live.next();assert.equal(ready.type,'ready');assert.equal(ready.role,'admin');
    const stepped=await request(base,root+'/step',{method:'POST',body:{count:1},token:adminToken});
    assert.equal(stepped.status,200,stepped.text);
    let frame=await live.next();while(frame.type!=='frame')frame=await live.next();
    assert.equal(frame.revision,stepped.json().revision);
    await rejectStream(base,'3dbox.42tr.cn','https://evil.example');
    const unauthorized=stream(base,'3dbox.42tr.cn','https://3dbox.42tr.cn');clients.push(unauthorized.socket);
    await unauthorized.opened;unauthorized.socket.send(JSON.stringify({type:'subscribe',sessionId,token:'x'.repeat(43),afterRevision:-1}));
    assert.equal(await unauthorized.closed,1008);
    assert.equal((await request(base,root,{method:'DELETE',token:adminToken})).status,200);
    console.log(`${kind}: HTTPS proxy headers, public IPs, HTTP API, WebSocket and credentials passed`);
   }finally{for(const socket of clients)socket.terminate();await new Promise(resolve=>server.close(resolve))}
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
