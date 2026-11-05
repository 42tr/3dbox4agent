'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const E=require('../src/engine'),Nav=require('../src/navigation'),Replay=require('../src/replay');
const Wasm=require('../server/physics'),Native=require('../server/rust-physics'),Rules=require('../server/rust-task-rules'),RustNav=require('../server/rust-navigation'),Ledger=require('../server/rust-world-ledger');
const {createServer}=require('../server/world-server');
(async()=>{
 const scene=E.getScene('lunar-outpost-v1');assert(E.validateScene(scene));
 // Rendering composition must not put task/resource destinations inside a facility.
 const points=[...scene.tasks.map(t=>t.target),...Object.values(scene.resource)];
 for(const p of points)assert(Nav.free(...p,scene.obstacles),JSON.stringify(p));
 const old=E.getScene('lunar-sampling-v1');assert.deepEqual(old.tasks.find(t=>t.id==='sample').target,[80,55]);assert.equal(old.obstacles.length,4);
 const detached=E.getScene(scene.id);detached.obstacles[0].x=0;assert.equal(E.getScene(scene.id).obstacles[0].x,46);
 await Wasm.initialize();
 for(const mode of ['kinematic','wasm','native'])for(const seed of [40,42,43]){
  const s=E.create(seed,'nearest',scene,{physicsMode:mode==='kinematic'?'kinematic':'rapier'}),p=mode==='kinematic'?null:(mode==='wasm'?Wasm:Native).createPhysics(s),frames=[E.snapshot(s)];
  if(mode==='native'){E.bindTaskRules(s,Rules);E.bindNavigation(s,RustNav);E.bindWorldLedger(s,Ledger.create(s))}
  let faulted=false;
  try{while(!s.done&&s.tick<1000){if(s.tick===3)faulted=E.fault(s);const before=s.agents.map(a=>[a.x,a.y]);E.step(s,p);for(const [i,a] of s.agents.entries())assert(Nav.clearSegment(before[i],[a.x,a.y],s.obstacles),`${mode}/${seed}/${s.tick}/${a.id}`);if(s.tick%20===0)frames.push(E.snapshot(s))}
   frames.push(E.snapshot(s));assert(faulted&&s.done&&!s.failed,`${mode}/${seed}`);assert(s.tasks.every(t=>t.status==='done'));assert.equal(s.asset.condition,'operational');assert.equal(s.events.filter(e=>e.kind==='sample_collected').length,1);assert.deepEqual(s.events.find(e=>e.kind==='sample_collected').position,[90,46]);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed,policy:'nearest',sceneId:scene.id},frames}));
  }finally{p?.free();E.disposeWorld(s)}
 }
 const linked=E.create(42,'nearest',scene,{dispatchMode:'networked'});while(!linked.done&&linked.tick<1000)E.step(linked);assert(linked.done&&!linked.failed);assert(linked.events.some(e=>e.kind==='dispatch_delivered'));
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const result=await new Promise((resolve,reject)=>{const child=spawn('python3',['sdk/python/multi_agent_demo.py','--url',`http://127.0.0.1:${server.address().port}`,'--scene',scene.id,'--auto-report-samples','--archive','--timeout','45']);let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>resolve({code,out,err}))});assert.equal(result.code,0,result.err);const report=JSON.parse(result.out);assert.equal(report.status,'completed');assert.equal(report.agentProcesses,12);assert(report.sampleReports.some(r=>r.status==='delivered'));assert(Replay.unwrapArchive(report).multiprocess)}finally{server.close()}
 console.log('lunar outpost: navigable facilities, fault recovery, sampling and replay across kinematic/WASM/native, delayed dispatch and 12 Python agents passed');
})().catch(e=>{console.error(e);process.exitCode=1});
