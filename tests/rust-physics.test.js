'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),P=require('../server/rust-physics'),{createServer}=require('../server/world-server');
(async()=>{
 await P.initialize();
 const state={obstacles:[{x:4,y:0,w:2,h:8,height:8}],agents:[{id:'ground',role:'vehicle',x:1,y:4},{id:'air',role:'drone',x:1,y:4}]};
 const p=P.createPhysics(state),q=P.createPhysics(state);
 try {
  let scan=p.lidar(state.agents[0],1.5,4,10);assert.equal(scan.length,4);assert(Math.abs(scan[0]-3)<.001);assert.equal(scan[2],null);
  assert.equal(p.lidar(state.agents[1],16,4,10)[0],null);
  let hit=p.move(state.agents[0],8,0);assert(hit.contacts>0&&hit.x<2.3);
  const air=p.move(state.agents[1],8,0);assert(Math.abs(air.x-8)<0.01);
  assert(q.move(state.agents[0],8,0).contacts>0); // Independent sessions do not affect each other.
  p.correctPosition(state.agents[0],1,12);state.agents[0].y=12;
  p.syncRoadblocks([{id:'barrier',x:4,y:10,w:2,h:4,height:4}]);
  scan=p.lidar(state.agents[0],1.5,4,10);assert(Math.abs(scan[0]-3)<.001);
  assert.throws(()=>p.syncRoadblocks([{id:'bad',x:1,y:1,w:-1,h:1,height:1}]),/invalid roadblock/);
  hit=p.move(state.agents[0],8,0);assert(hit.contacts>0&&hit.x<2.3);
  p.correctPosition(state.agents[0],1,12);p.syncRoadblocks([]);
  assert(Math.abs(p.move(state.agents[0],8,0).x-8)<0.01);
  assert.throws(()=>p.move(state.agents[0],1,0),/diverged/);
 }finally{p.free();q.free()}
 assert.throws(()=>p.move(state.agents[0],1,0),/closed/);
 const elevated={obstacles:[],agents:[
  {id:'scanner',role:'drone',x:1,y:4,flightZ:8},
  {id:'target',role:'drone',x:4,y:4,flightZ:8},
 ]};
 const sensing=P.createPhysics(elevated);
 try {
  const east=sensing.lidar(elevated.agents[0],8,4,10)[0];
  assert(Math.abs(east-2.2)<.001,'a scan at the current altitude should hit the other drone');
 }finally{sensing.free()}
 function run(seed,fault){const s=E.create(seed,'nearest',E.scene,{physicsMode:'rapier'}),sim=P.createPhysics(s);let faulted=false;
  try{while(!s.done&&s.tick<1000){if(fault&&!faulted&&s.part.location==='carried'){assert(E.fault(s));faulted=true}E.step(s,sim);
   for(let i=0;i<s.agents.length;i++)for(let j=i+1;j<s.agents.length;j++){let a=s.agents[i],b=s.agents[j];if((a.role==='drone')===(b.role==='drone'))assert(Math.hypot(a.x-b.x,a.y-b.y)>1.55,`overlap ${seed}`)}}
   assert(s.done&&!s.failed,`unfinished seed ${seed}`);assert.equal(s.asset.condition,'operational');if(fault)assert(faulted);return s;
  }finally{sim.free()}}
 for(let seed=0;seed<10;seed++){run(seed,false);run(seed,true)}
 assert.deepEqual(run(42,false),run(42,false));
 const server=createServer({physicsBackend:'rust'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,method='GET',data,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});assert(r.ok,`${path}: ${r.status}`);return r.json()}
 try{const health=await request('/health');assert.equal(health.runtime.physicsBackend,'rust');const created=await request('/sessions','POST',{seed:42,physicsMode:'rapier'});const root='/sessions/'+created.sessionId,token=created.adminToken;
 const issue=await request(root+'/agents/vehicle-1/credentials','POST',{},token);const at=issue.agentToken;
 const scan=await request(root+'/agents/vehicle-1/lidar','POST',{count:8,range:20},at);assert.equal(scan.tick,0);assert.equal(scan.worldRevision,0);assert.equal(scan.distances.length,8);assert(scan.distances.every(d=>d===null||d>=0&&d<=20));
 let denied=await fetch(base+root+'/agents/vehicle-2/lidar',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+at},body:'{}'});assert.equal(denied.status,403);
 denied=await fetch(base+root+'/agents/vehicle-1/lidar',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+at},body:JSON.stringify({count:73})});assert.equal(denied.status,400);
 denied=await fetch(base+root+'/agents/vehicle-1/lidar',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+at},body:JSON.stringify({range:1000})});assert.equal(denied.status,400);
 const coord=await request(root+'/coordinator/credentials','POST',{},token);denied=await fetch(base+root+'/agents/vehicle-1/lidar',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+coord.coordinatorToken},body:'{}'});assert.equal(denied.status,403);
 const unchanged=await request(root,'GET',undefined,token);assert.equal(unchanged.revision,0);assert.equal(unchanged.world.tick,0);const done=await request(root+'/step','POST',{count:1000},token);assert(done.world.done&&!done.world.failed);assert.equal(done.world.asset.condition,'operational');const history=await request(root+'/history?after=-1','GET',undefined,token);assert.equal(history.frames.at(-1).world.tick,done.world.tick);await request(root,'DELETE',undefined,token);

 const preview=await request('/sessions','POST',{seed:42,dispatchMode:'external'});
 const previewPath='/sessions/'+preview.sessionId;
 const dronePath=previewPath+'/agents/drone-1';
 try {
  const {agentToken}=await request(dronePath+'/credentials','POST',{},preview.adminToken);
  await request(dronePath+'/actions','POST',{
   requestId:'climb-before-scan',type:'move',vertical:{deltaM:4},targetTick:1,expiresTick:20,
  },agentToken);
  const before=await request(previewPath+'/step','POST',{count:6},preview.adminToken);
  assert.equal(before.world.physicsMode,'kinematic');
  assert.equal(before.world.sensorModel,undefined);
  const drone=before.world.agents.find(a=>a.id==='drone-1');
  assert.equal(drone.flightZ,20);
  const measurement=await request(dronePath+'/lidar','POST',{count:8},agentToken);
  assert.equal(measurement.distances.length,8);
  assert.deepEqual(measurement.origin,{x:drone.x,y:drone.y,z:20});
  assert.equal(measurement.tick,before.world.tick);
  assert.equal(measurement.worldRevision,before.revision);
  const after=await request(previewPath,'GET',undefined,preview.adminToken);
  assert.equal(after.revision,before.revision);
  assert.deepEqual(after.world,before.world);
 }finally{await request(previewPath,'DELETE',undefined,preview.adminToken)}
 }finally{await new Promise(r=>server.close(r))}
 console.log('Native Rapier collisions, roadblocks, isolation, recovery, and read-only LiDAR at the current altitude in both movement modes passed');
})().catch(e=>{console.error(e);process.exitCode=1});
