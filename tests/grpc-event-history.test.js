'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {createServer}=require('../server/world-server'),Journal=require('../server/event-journal');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-grpc-history-')),id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('base64url'),wrong=crypto.randomBytes(32).toString('base64url');
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 const journal=Journal.create(dir,id,hash,{},Array.from({length:250},(_,i)=>({seq:i+1,label:'event'})));
 const server=createServer({journalDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const child=spawn('python3',['tests/grpc_event_history_test.py'],{env:{...process.env,PYTHONPATH:[process.env.BOX_STREAM_TEST_DEPS||'',path.resolve('sdk/python')].filter(Boolean).join(path.delimiter),URL:`http://127.0.0.1:${server.address().port}`,SID:id,ADMIN:token,WRONG:wrong},stdio:['pipe','pipe','inherit']});
  child.stdout.setEncoding('utf8');let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY\n')&&!child.appended){child.appended=true;journal.append(1,[{seq:251},{seq:252}]);journal.close(1,'deleted');child.stdin.write('APPENDED\n');} });
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(code,0,output);assert.match(output,/pagination, fixed boundary/);console.log(output.trim());
 }finally{journal.close(1,'deleted');await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
