'use strict';
const assert=require('node:assert/strict'),{fork}=require('node:child_process'),path=require('node:path');
(async()=>{
 const parent=fork(path.join(__dirname,'supervisor-parent-fixture.js'),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});let worker,workerGone=false;
 try{
  const ready=await new Promise((resolve,reject)=>{parent.once('message',resolve);parent.once('error',reject)});
  const response=await fetch(`http://127.0.0.1:${ready.port}/sessions`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,201);const session=await response.json();
  const info=new Promise(r=>parent.once('message',r));parent.send('workers');worker=(await info).workers[0];assert.equal(worker.sessionId,session.sessionId);assert(worker.pid!==parent.pid);process.kill(worker.pid,0);
  const gone=new Promise(r=>parent.once('close',r));parent.kill('SIGKILL');await gone;
  const end=Date.now()+7000;while(true){try{process.kill(worker.pid,0)}catch(error){assert.equal(error.code,'ESRCH');workerGone=true;break}if(Date.now()>end)throw Error('orphan worker survived supervisor loss');await new Promise(r=>setTimeout(r,25))}
  console.log('world worker shuts down on supervisor IPC loss; no orphan process remains');
 }finally{parent.kill('SIGKILL');if(worker&&!workerGone){try{process.kill(worker.pid,0);process.kill(worker.pid,'SIGKILL')}catch{}}}
})().catch(error=>{console.error(error);process.exitCode=1});
