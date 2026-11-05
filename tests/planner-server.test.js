'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {createServer} = require('../server/world-server');
const Display = require('../src/planner-report');

function python(args, env) {
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  });
}
(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 async function req(p,method='GET',body,token){const r=await fetch(url+p,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return [r.status,await r.json()]}
 try{
  const [,session]=await req('/sessions','POST',{seed:42,dispatchMode:'external'}),root='/sessions/'+session.sessionId,admin=session.adminToken;
  const [,credential]=await req(root+'/coordinator/credentials','POST',{},admin);
  const result=await python([path.resolve('sdk/python/planner_coordinator.py'),'--once'],{BOX_URL:url,BOX_SESSION:session.sessionId,BOX_COORDINATOR_TOKEN:credential.coordinatorToken});
  assert.equal(result.code,0,result.err);assert(result.out.includes('accepted'));
  const [,state]=await req(root,'GET',undefined,admin);
  assert.equal(state.world.tasks[0].status,'active');assert.equal(state.world.decisions[0].actor,'external');
  const [forbidden]=await req(root,'GET',undefined,credential.coordinatorToken);assert.equal(forbidden,403);
  await req(root,'DELETE',undefined,admin);
  for(const seed of [42,43,44]){
   const run=await python([path.resolve('sdk/python/planner_demo.py'),'--url',url,'--seed',String(seed)],{});
   assert.equal(run.code,0,run.err);const report=JSON.parse(run.out);
   assert.equal(report.status,'completed');assert.equal(report.faultInjected,true);assert.equal(report.metrics.replans,1);
   assert(report.decisions.length>=6);assert(report.decisions.every(d=>d.actor==='external'&&d.status==='accepted'));
   assert(report.events.some(e=>e.kind==='device_fault'));assert(report.events.some(e=>e.kind==='asset_verified'));
  }
  const parallel=await python([path.resolve('sdk/python/planner_demo.py'),'--url',url,'--scene','industrial-park-parallel-v1'],{});assert.equal(parallel.code,0,parallel.err);const parallelReport=JSON.parse(parallel.out);assert.equal(parallelReport.status,'completed');assert.equal(parallelReport.config.sceneId,'industrial-park-parallel-v1');const first=parallelReport.decisions.filter(d=>d.appliedTick===0);assert.equal(first.length,2);assert.notEqual(first[0].agentId,first[1].agentId);assert(parallelReport.events.some(e=>e.kind==='device_fault'));
  const comparison=await python([path.resolve('sdk/python/planner_compare.py'),'--url',url,'--count','2'],{});assert.equal(comparison.code,0,comparison.err);const report=JSON.parse(comparison.out);assert.equal(report.format,'3dbox-planner-comparison-v1');assert.equal(report.pairs.length,2);assert.equal(report.config.sceneId,'industrial-park-parallel-v1');assert.equal(report.paired.bothCompleted,2);for(const pair of report.pairs){for(const algo of ['nearest','planner']){const run=pair[algo];assert.equal(run.seed,pair.seed);assert.equal(run.config.algorithm,algo);assert.equal(run.status,'completed');assert(run.faultInjected);assert(run.decisions.every(d=>d.actor==='external'));assert(run.events.some(e=>e.kind==='device_fault'&&e.tick===3))}}assert.equal(report.paired.completionTickDifference.mean,report.pairs.reduce((sum,p)=>sum+p.planner.metrics.ticks-p.nearest.metrics.ticks,0)/2);assert(!comparison.out.includes(credential.coordinatorToken));const viewed=Display.summarize(report);assert.equal(viewed.bothCompleted,report.paired.bothCompleted);assert.equal(viewed.completionTickDifference.mean,report.paired.completionTickDifference.mean);
  console.log('planning coordinator integration tests passed');
 }finally{server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
