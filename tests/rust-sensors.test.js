'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),R=require('../src/replay'),P=require('../server/rust-physics'),{createServer}=require('../server/world-server');
(async()=>{
 const p=P.createPhysics({obstacles:[{x:4,y:4,w:2,h:2,height:8}],agents:[{id:'one',role:'vehicle',x:0,y:5},{id:'two',role:'vehicle',x:2,y:5}]});
 try{
  assert.equal(p.visible({x:0,y:5,z:2},{x:10,y:5,z:2}),false);
  assert.equal(p.visible({x:0,y:5,z:16},{x:10,y:5,z:16}),true);
  assert.equal(p.visible({x:0,y:5,z:2},{x:3,y:5,z:2}),true); // Other agent is not an occluder.
  assert.equal(p.visible({x:5,y:5,z:2},{x:5,y:5,z:2}),false);
  assert.equal(p.visible({x:0,y:5,z:2},{x:0,y:5,z:2}),true);
 }finally{p.free()}
 const scene=E.getScene();scene.id='native-sensor-test';scene.obstacles=[];scene.sensorRange=30;scene.resource.site=[15,10];scene.fixedSensors=[{id:'fixed',name:'fixed',x:2,y:10,height:1.5,range:30,interval:1}];
 const world=E.create(42,'nearest',scene,{physicsMode:'rapier',dispatchMode:'external'});
 world.agents.forEach((a,i)=>{a.x=30+i*2;a.y=50});const a=world.agents.find(x=>x.id==='vehicle-1'),b=world.agents.find(x=>x.id==='vehicle-2');a.x=3;a.y=10;b.x=13;b.y=10;
 const physics=P.createPhysics(world);
 try{
  E.bindRaySensors(world,physics);assert.equal(world.sensorModel,'rapier-ray-v1');assert(E.observe(world,a.id).nearby.some(x=>x.id===b.id));
  assert(E.injectRoadblock(world,{x:7,y:7,w:2,h:6},1).ok);
  let obs=E.observe(world,a.id);assert(!obs.nearby.some(x=>x.id===b.id));assert(obs.memory.some(x=>x.id===b.id&&!x.current));
  E.step(world,physics);assert.equal(world.fixedSensorState.sent,0);
  E.step(world,physics);assert(world.fixedSensorState.sent>0);obs=E.observe(world,a.id);assert(obs.nearby.some(x=>x.id===b.id));
  const orphan=E.snapshot(world);assert.throws(()=>E.step(orphan,physics),/ray sensor backend required/);
 }finally{physics.free()}
 const scanScene=structuredClone(scene);scanScene.id='native-scan-test';scanScene.obstacles=[{id:'wall',x:7,y:7,w:2,h:6,height:8}];
 scanScene.agents.find(x=>x.role==='vehicle').capabilities.push('inspect');
 const scanning=E.create(42,'nearest',scanScene,{physicsMode:'rapier',dispatchMode:'external'}),scanner=scanning.agents.find(x=>x.id==='vehicle-1');scanner.x=3;scanner.y=10;
 const scanPhysics=P.createPhysics(scanning);try{E.bindRaySensors(scanning,scanPhysics);assert(E.submitAction(scanning,scanner.id,{requestId:'scan-ray',type:'scan',targetTick:1,expiresTick:20}).ok);for(let i=0;i<4;i++)E.step(scanning,scanPhysics);assert.equal(scanning.actions[0].result.kind,'not_detected')}finally{scanPhysics.free()}
 const server=createServer({physicsBackend:'rust'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 async function req(path,method='GET',data,token){const response=await fetch(url+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [response.status,await response.json()]}
 try{
  let [status]=await req('/sessions','POST',{physicsMode:'kinematic',sensorMode:'rapier'});assert.equal(status,400);
  let [createdCode,s]=await req('/sessions','POST',{seed:42,physicsMode:'rapier',sensorMode:'rapier'});assert.equal(createdCode,201);assert.equal(s.world.sensorModel,'rapier-ray-v1');const root='/sessions/'+s.sessionId;
  let [,result]=await req(root+'/step','POST',{count:1000},s.adminToken);assert(result.world.done&&!result.world.failed);let [,history]=await req(root+'/history?after=-1','GET',undefined,s.adminToken);
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:s.scene.id,scene:s.scene},frames:history.frames.map(x=>x.world)};assert(R.validateArchive(archive));
  const forged=structuredClone(archive);delete forged.frames.at(-1).sensorModel;assert.throws(()=>R.validateArchive(forged));
  await req(root,'DELETE',undefined,s.adminToken);
 }finally{await new Promise(r=>server.close(r))}
 console.log('Rust ray sensing, roadblock lifecycle, fixed sensor, isolation and replay passed');
})().catch(e=>{console.error(e);process.exitCode=1});
