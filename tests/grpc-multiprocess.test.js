'use strict';
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path'),{createServer}=require('../server/world-server');
(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const env={...process.env,PYTHONPATH:[process.env.BOX_STREAM_TEST_DEPS||'',process.env.PYTHONPATH||''].filter(Boolean).join(path.delimiter)};
 const gateway=spawn('python3',['sdk/python/grpc_gateway.py','--world-url',url,'--port','0'],{env,stdio:['ignore','pipe','pipe']});let stderr='';gateway.stderr.on('data',b=>stderr+=b);
 try{
  const port=await new Promise((resolve,reject)=>{let out='';const timeout=setTimeout(()=>reject(Error('gateway startup timeout')),10000);gateway.stdout.on('data',b=>{out+=b;const m=/listening on 127\.0\.0\.1:(\d+)/.exec(out);if(m){clearTimeout(timeout);resolve(Number(m[1]))}});gateway.on('error',e=>{clearTimeout(timeout);reject(e)});gateway.on('exit',code=>{clearTimeout(timeout);reject(Error(`gateway exited ${code}: ${stderr}`))})});
  const target=`127.0.0.1:${port}`;
  const args=['sdk/python/multi_agent_demo.py','--url',url,'--scene','lunar-sampling-v1','--fault','none','--sample-followup','--agent-grpc-target',target,'--coordinator-grpc-target',target,'--archive','--timeout','90',...(process.env.BOX_GRPC_STREAM_TEST?['--grpc-observe-stream']:[])];
  const report=await new Promise((resolve,reject)=>{const child=spawn('python3',args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(Error(`demo exited ${code}: ${err} ${out.slice(-2000)}`));try{resolve(JSON.parse(out))}catch(e){reject(e)}})});
  assert.equal(report.status,'completed');assert.equal(report.config.agentRequestTransport,'grpc');assert.equal(report.config.coordinatorRequestTransport,'grpc');
  if(process.env.BOX_GRPC_STREAM_TEST){assert.equal(report.config.observationTransport,'grpc-stream');assert(report.processLogs.every(p=>p.output.includes('gRPC 观察流已连接')))}
  assert(report.sampleFollowup.reportDeliveredTick!==null&&report.sampleFollowup.followupCompletedTick!==null);assert(report.proposals.some(p=>p.status==='accepted'&&p.sampleReportId));
  require('../src/replay').unwrapArchive(report);console.log('gRPC agent and coordinator sampling, evidence proposal and replay passed');
 }finally{gateway.kill();await new Promise(r=>gateway.exitCode!==null||gateway.signalCode!==null?r():gateway.once('exit',r));await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
