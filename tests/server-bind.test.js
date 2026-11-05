'use strict';
const assert=require('node:assert/strict');
const net=require('node:net');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');

async function unusedPort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
async function start(bind){
 const port=await unusedPort(),env={...process.env,WORLD_PORT:String(port)};
 for(const key of ['WORLD_BIND','BOX_EVENT_JOURNAL_DIR','BOX_REPLAY_JOURNAL','BOX_PHYSICS_BACKEND','BOX_TASK_BACKEND','BOX_COMM_BACKEND','BOX_NAV_BACKEND'])delete env[key];
 if(bind!==undefined)env.WORLD_BIND=bind;
 const child=spawn(process.execPath,['server/world-server.js'],{env,stdio:['ignore','pipe','pipe']});
 let output='';const exited=once(child,'close');
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',text=>output+=text);child.stderr.on('data',text=>output+=text);
 try{
  const deadline=Date.now()+10000;
  while(!output.includes('World API:')&&child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  if(bind==='invalid.invalid'){assert.equal((await exited)[0],1);assert.match(output,/invalid WORLD_BIND/);return}
  assert.match(output,new RegExp('World API: http://'+(bind||'127.0.0.1').replaceAll('.','\\.')+':'+port));
  const url=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(url+'/health')).status,200);
  const invalidHost=await new Promise((resolve,reject)=>{const req=http.get(url+'/health',{headers:{host:`192.0.2.1:${port}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject)});
  assert.equal(invalidHost,403);
  assert.equal((await fetch(url+'/health',{headers:{origin:'https://invalid.invalid'}})).status,403);
 }finally{if(child.exitCode===null)child.kill('SIGTERM');await exited}
}
(async()=>{await start();await start('0.0.0.0');await start('invalid.invalid');console.log('default loopback, explicit container bind, host and origin guards passed')})().catch(e=>{console.error(e);process.exitCode=1});
