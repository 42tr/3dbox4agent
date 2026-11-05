'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const Replay=require('../src/replay');
const {createServer}=require('../server/world-server');

async function run(options,args){
 const server=createServer(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 try{
  const child=spawn('python3',[path.resolve('sdk/python/multi_agent_demo.py'),'--url',url,'--archive','--timeout','45',...args],{env:{...process.env,BOX_TOKEN:'sentinel-secret-value',BOX_COORDINATOR_TOKEN:'other-sentinel-secret'},stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
  assert(!output.includes('sentinel-secret-value'));assert(!output.includes('other-sentinel-secret'));if(!output)throw Error(error);return {exit,report:JSON.parse(output),error};
 }finally{server.close()}
}
(async()=>{
 const result=await run({},[]);assert.equal(result.exit,0,result.error);const r=result.report;
 assert.equal(r.status,'completed');assert(r.faultInjected);assert.equal(r.agentProcesses,15);assert.equal(r.coordinatorProcesses,1);assert.equal(r.processLogs.length,16);assert(!r.historyTruncated);assert(r.actions.some(a=>a.type==='move'&&a.status==='completed'));assert(r.actions.some(a=>a.type==='work_task'&&a.status==='completed'));assert(r.actions.some(a=>a.type==='move'&&a.status==='failed'&&a.reason==='agent_unavailable'));assert(r.decisions.every(d=>d.actor==='external'));assert(r.events.some(e=>e.kind==='part_dropped'));assert(r.events.some(e=>e.kind==='asset_verified'));assert(r.processLogs.filter(x=>x.output.includes('提交')).length>=4);
 let loaded;try{loaded=Replay.unwrapArchive(r)}catch(error){const i=r.archive.frames.findIndex(frame=>{try{Replay.validateArchive({...r.archive,frames:[frame]});return false}catch{return true}});console.error('invalid frame',i,JSON.stringify(r.archive.frames[i]?.tasks));throw error}assert(loaded.multiprocess);assert(!loaded.truncated);assert.equal(loaded.archive.frames.at(-1).asset.condition,'operational');
 const linked=await run({},['--dispatch','networked_external','--outage','first-command']);assert.equal(linked.exit,0,linked.error);assert.equal(linked.report.status,'completed');assert(linked.report.outageInjected&&linked.report.faultInjected);assert(linked.report.decisions.some(d=>d.status==='failed'&&d.reason==='interrupted'));assert(linked.report.decisions.some(d=>d.status==='accepted'));assert(linked.report.events.some(e=>e.kind==='dispatch_failed'&&e.reason==='interrupted'));assert(Replay.unwrapArchive(linked.report).multiprocess);
 const reported=await run({},['--dispatch','networked_reported','--outage','first-command','--link-profile','long','--outage-duration','20']);assert.equal(reported.exit,0,reported.error);assert.equal(reported.report.status,'completed');assert.equal(reported.report.config.linkProfile,'long');assert.equal(reported.report.archive.config.scene.communication.delay,12);assert(reported.report.outageInjected&&reported.report.faultInjected);assert(reported.report.metrics.reportDelivered>0&&reported.report.metrics.reportFailed>0);assert(reported.report.decisions.some(d=>d.status==='failed'&&d.reason==='interrupted'));assert(Replay.unwrapArchive(reported.report).multiprocess);
 const short=await run({maxHistoryBytes:1},['--fault','none','--max-ticks','1']);assert.equal(short.exit,1,short.error);assert.equal(short.report.status,'timeout');assert.equal(short.report.reason,'tick_limit');assert(short.report.historyTruncated);assert(Replay.unwrapArchive(short.report).truncated);
 console.log('multi-process coordinator and agent integration tests passed');
})().catch(error=>{console.error(error);process.exitCode=1});
