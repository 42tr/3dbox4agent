'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),R=require('../src/replay'),P=require('../server/physics');
const {createServer}=require('../server/world-server'),{spawn}=require('node:child_process');
(async()=>{
 const scene=E.getScene('lunar-sampling-v1');
 assert(scene.tasks.some(t=>t.behavior==='sample'&&t.dependsOn.includes('survey')));
 const invalid=structuredClone(scene);invalid.tasks.find(t=>t.behavior==='sample').capability='inspect';assert.throws(()=>E.validateScene(invalid));
 await P.initialize();
 for(const mode of ['kinematic','rapier']){
  const s=E.create(42,'nearest',scene,{physicsMode:mode}),physics=mode==='rapier'?P.createPhysics(s):null,frames=[E.snapshot(s)];
  try{
   assert(s.agents.every(a=>E.observe(s,a.id).samples.length===0));
   while(!s.done&&s.tick<1000){E.step(s,physics);if(s.tick%20===0)frames.push(E.snapshot(s))}
   frames.push(E.snapshot(s));assert(s.done&&!s.failed,mode);
   const sample=s.events.find(e=>e.kind==='sample_collected');assert(sample);assert.equal(s.events.filter(e=>e.kind==='sample_collected').length,1);assert.deepEqual(sample.position,[80,55]);
   assert(s.events.findIndex(e=>e.kind==='task_completed'&&e.taskId==='survey')<s.events.indexOf(sample));
   assert.equal(E.metrics(s).samplesCollected,1);assert.equal(E.observe(s,sample.agentId).samples.length,1);assert(s.agents.filter(a=>a.id!==sample.agentId).every(a=>E.observe(s,a.id).samples.length===0));
   const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id},frames};assert(R.validateArchive(archive));
   const forged=structuredClone(archive);const event=forged.frames.at(-1).events.find(e=>e.kind==='sample_collected');event.position=[0,0];assert.throws(()=>R.validateArchive(forged));
  }finally{physics?.free()}
 }
 const faultScene=structuredClone(scene);faultScene.tasks=[{...faultScene.tasks.find(t=>t.id==='sample'),dependsOn:[]}];const interrupted=E.create(42,'nearest',faultScene);E.step(interrupted);const first=interrupted.tasks[0].assignee;assert(first);assert(E.fault(interrupted));assert.equal(interrupted.events.filter(e=>e.kind==='sample_collected').length,0);while(!interrupted.done&&interrupted.tick<1000)E.step(interrupted);assert(interrupted.done&&!interrupted.failed);const recovered=interrupted.events.filter(e=>e.kind==='sample_collected');assert.equal(recovered.length,1);assert.notEqual(recovered[0].agentId,first);
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const url=`http://127.0.0.1:${server.address().port}`;const result=await new Promise((resolve,reject)=>{const child=spawn('python3',['sdk/python/multi_agent_demo.py','--url',url,'--scene',scene.id,'--auto-report-samples','--archive','--timeout','45']);let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>resolve({code,out,err}))});assert.equal(result.code,0,result.err);const report=JSON.parse(result.out);assert.equal(report.status,'completed');assert.equal(report.metrics.samplesCollected,1);assert(report.sampleReports.some(r=>r.status==='delivered'));assert(report.config.autoReportSamples);assert(R.unwrapArchive(report).multiprocess)}finally{server.close()}
 console.log('lunar sampling tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
