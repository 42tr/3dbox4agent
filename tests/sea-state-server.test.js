'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Replay=require('../src/replay'),D=require('../src/surface-domain'),{createServer}=require('../server/world-server');
(async()=>{
 for(const physicsBackend of ['rust','wasm']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-sea-')),server=createServer({physicsBackend,taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust',journalDir:dir,replayJournal:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,owned=[];
  async function req(route,method='GET',body,token){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),v=await r.json();if(!r.ok)throw Object.assign(Error(v.error),{status:r.status});return v}
  try{
   const s=await req('/sessions','POST',{sceneId:'shore-sea-state-v1',seed:42,physicsMode:'rapier',sensorMode:physicsBackend==='rust'?'rapier':'geometry'});owned.push(s);const root='/sessions/'+s.sessionId,post=(route,body)=>req(root+route,'POST',body,s.adminToken),get=()=>req(root,'GET',undefined,s.adminToken);
   await post('/step',{count:10});const credentials=await post('/agents/boat-1/credentials',{}),observer=await post('/observer/credentials',{}),ownBefore=await req(root+'/observations/boat-1','GET',undefined,credentials.agentToken),saved=await get();
   await assert.rejects(req(root+'/terrain-effect','POST',{zoneId:'north-sea',duration:80},observer.observerToken),e=>e.status===403);assert.deepEqual(await get(),saved);
   await post('/terrain-effect',{zoneId:'north-sea',duration:80,speedFactor:.35,energyFactor:2.5});const ownAfter=await req(root+'/observations/boat-1','GET',undefined,credentials.agentToken);assert.equal(ownAfter.self.returnEnergyEstimate,ownBefore.self.returnEnergyEstimate);assert(!Object.hasOwn(ownAfter,'terrainEffects'));
   await post('/step',{count:60});await post('/terrain-effect',{zoneId:'south-sea',duration:180,speedFactor:.4,energyFactor:2});const original=await get();assert.equal(original.world.terrainEffects.length,2);
   const ends=[];for(let i=0;i<2;i++){
    const branch=await req('/event-journals/'+s.sessionId+'/fork','POST',{revision:original.revision},s.adminToken);owned.push(branch);assert.notEqual(branch.adminToken,s.adminToken);assert.deepEqual(branch.world.terrainEffects,original.world.terrainEffects);
    await assert.rejects(req('/sessions/'+branch.sessionId+'/observations/boat-1','GET',undefined,credentials.agentToken),e=>e.status===401);
    const state=await req('/sessions/'+branch.sessionId+'/step','POST',{count:700},branch.adminToken);assert(state.world.done&&!state.world.failed);assert.equal(state.metrics.completed,7);assert(state.metrics.terrainEffectDistance>0);ends.push(state.world);
    const history=await req('/sessions/'+branch.sessionId+'/history?after=-1','GET',undefined,branch.adminToken),frames=history.frames.map(f=>f.world);for(const w of frames)for(const a of w.agents)assert(D.bodyFree(w.surfaceDomain,a.mobility,[a.x,a.y]));assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{scene:s.scene,sceneId:s.scene.id,seed:42,policy:'nearest'},frames}));assert.deepEqual(await get(),original);
   }
   const final=await post('/step',{count:700});assert.deepEqual(ends[0],ends[1]);assert.deepEqual(final.world,ends[0]);const exposed=final.world.events.filter(e=>e.kind==='terrain_effect_exposure');assert(exposed.every(e=>final.world.agents.find(a=>a.id===e.agentId).mobility==='water'));
   console.log(JSON.stringify({physicsBackend,actualHttp:true,scopedStaticEstimate:true,observerReadOnly:true,twoActiveWeatherForks:true,independentCredentials:true,allThreeComplete:7,replayValidated:true,onlyBoatExposure:true,tick:final.world.tick}));
  }finally{for(const s of owned)await req('/sessions/'+s.sessionId,'DELETE',undefined,s.adminToken).catch(()=>{});await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
