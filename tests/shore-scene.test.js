'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const E=require('../src/engine'),R=require('../src/replay'),X=require('../src/experiments');
const P=require('../server/physics'),{createServer}=require('../server/world-server');
(async()=>{
 const scene=E.getScene('shore-coordination-v1');assert.equal(scene.agents.reduce((n,a)=>n+a.count,0),12);assert.equal(scene.terrain[0].id,'shore-crossing');assert.equal(scene.tasks.find(t=>t.id==='confirm').dependsOn.length,2);
 await P.initialize();
 for(const mode of ['kinematic','rapier'])for(const seed of [40,42]){
  const s=E.create(seed,'nearest',scene,{physicsMode:mode}),physics=mode==='rapier'?P.createPhysics(s):null,frames=[E.snapshot(s)];
  try{E.step(s,physics);assert.equal(s.tasks.filter(t=>t.status==='active').length,2);assert(E.fault(s));while(!s.done&&s.tick<1000){E.step(s,physics);if(s.tick%25===0)frames.push(E.snapshot(s))}frames.push(E.snapshot(s));
   assert(s.done&&!s.failed,`${mode}/${seed} tick ${s.tick}`);assert.equal(s.asset.condition,'operational');assert(E.metrics(s).terrainDistance>0);assert(s.events.some(e=>e.kind==='device_fault'));assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed,policy:'nearest',sceneId:scene.id},frames}));
  }finally{physics?.free()}
 }
 const paired=X.runEnergyBatch({startSeed:42,count:1,maxTicks:1000,policy:'nearest',energyTick:3,energyLevel:5,target:'first_active',sceneId:scene.id});assert.equal(paired.pairs[0].energy.status,'completed');assert(paired.pairs[0].energy.energyInjected);
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const base=`http://127.0.0.1:${server.address().port}`,r=await fetch(base+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sceneId:scene.id})});assert.equal(r.status,201);assert.equal((await r.json()).world.sceneId,scene.id);
  const child=spawn('python3',['sdk/python/planner_demo.py','--url',base,'--scene',scene.id,'--fault-tick','3'],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(code,0,err);const report=JSON.parse(out);assert.equal(report.status,'completed');assert(report.metrics.terrainDistance>0);
 }finally{server.close()}
 console.log('shore coordination scene integration passed');
})().catch(e=>{console.error(e);process.exitCode=1});
