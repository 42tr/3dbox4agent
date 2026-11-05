'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),R=require('../src/replay'),X=require('../src/experiments');
const {createServer}=require('../server/world-server');
(async()=>{
 const scene=E.getScene('industrial-park-priority-v1');assert.equal(scene.agents.find(a=>a.role==='drone').count,1);
 for(const [field,value] of [['priority',-1],['priority',101],['deadline',0],['deadline',1.5]]){const bad=structuredClone(scene);bad.tasks[0][field]=value;assert.throws(()=>E.normalizeScene(bad))}
 const world=E.create(42,'nearest',scene),frames=[E.snapshot(world)];E.step(world);assert.equal(world.tasks.find(t=>t.id==='survey').status,'active');assert.equal(world.tasks.find(t=>t.id==='inspect').status,'pending');assert.equal(E.coordinatorObservation(world).tasks[0].priority,1);
 while(!world.done&&world.tick<1000){E.step(world);if(world.tick===31)frames.push(E.snapshot(world))}assert(world.done&&!world.failed);frames.push(E.snapshot(world));const m=E.metrics(world);assert.equal(m.deadlineTasks,2);assert.equal(m.deadlineMissed,1);assert(!world.events.some(e=>e.kind==='deadline_missed'&&e.taskId==='survey'));assert(world.events.some(e=>e.kind==='deadline_missed'&&e.taskId==='inspect')); assert.equal(m.deadlineMissed,world.events.filter(e=>e.kind==='deadline_missed').length);assert(world.events.filter(e=>e.kind==='deadline_missed').every(e=>e.tick===e.deadline+1));assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id},frames}));
 const bat=X.runBatch({startSeed:42,count:1,maxTicks:1000,faultTick:null,sceneId:scene.id,policies:['nearest']});assert.equal(bat.runs[0].metrics.deadlineMissed,m.deadlineMissed);
 const external=E.create(42,'nearest',scene,{dispatchMode:'external'});const observation=E.coordinatorObservation(external);assert.equal(observation.tasks[0].id,'survey');assert.equal(observation.tasks[0].deadline,30);assert.equal(observation.tasks[0].priority,10);
 const network=E.create(42,'nearest',scene,{dispatchMode:'networked'});E.step(network);assert.equal(network.communication.dispatchQueue[0].taskId,'survey');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const url=`http://127.0.0.1:${server.address().port}`;const resp=await fetch(url+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sceneId:scene.id,dispatchMode:'external'})});assert.equal(resp.status,201);const session=await resp.json();assert.equal(session.scene.tasks.find(t=>t.id==='survey').priority,10);assert.equal(session.metrics.deadlineTasks,2)}finally{server.close()}
 console.log('task priority and deadline tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
