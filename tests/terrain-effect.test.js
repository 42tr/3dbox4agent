'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),R=require('../src/replay');
const {createServer}=require('../server/world-server');
const scene=E.getScene('shore-coordination-v1');
function setup(){const s=E.create(42,'nearest',scene,{dispatchMode:'external'}),a=s.agents.find(x=>x.id==='vehicle-1');a.x=38;a.y=50;const input={requestId:'cross',type:'move',target:{x:53,y:50},targetTick:1,expiresTick:90};assert(E.submitAction(s,a.id,input).ok);return {s,a}}
(async()=>{
 const control=setup(),hazard=setup();const initial=E.observe(hazard.s,hazard.a.id).self.returnEnergyEstimate;
 assert.equal(E.injectTerrainEffect(hazard.s,'missing',10).reason,'unknown_zone');assert.equal(E.injectTerrainEffect(hazard.s,'shore-crossing',0).reason,'invalid_effect');assert(E.injectTerrainEffect(hazard.s,'shore-crossing',30,.5,2).ok);
 assert.equal(E.observe(hazard.s,hazard.a.id).self.returnEnergyEstimate,initial,'the static estimate does not expose live terrain effects');assert.equal(E.injectTerrainEffect(hazard.s,'shore-crossing',10).reason,'zone_already_affected');
 const frames=[E.snapshot(hazard.s)];for(let i=0;i<4;i++){E.step(control.s);E.step(hazard.s);frames.push(E.snapshot(hazard.s))}
 assert(control.a.x>hazard.a.x);assert(E.metrics(hazard.s).terrainEffectDistance>0);assert.equal(E.metrics(hazard.s).terrainEffectAgents,1);assert.equal(hazard.s.events.filter(e=>e.kind==='terrain_effect_exposure').length,1);assert.equal(E.metrics(control.s).terrainEffectAgents,0);const normalLoss=control.a.initialBattery-control.a.battery,affectedLoss=hazard.a.initialBattery-hazard.a.battery;assert(Math.abs(normalLoss-affectedLoss)<1e-7,'half speed and double energy factor have equal per-tick cost');
 while(hazard.s.tick<31){E.step(hazard.s);frames.push(E.snapshot(hazard.s))}assert.equal(hazard.s.terrainEffects.length,0);assert(hazard.s.events.some(e=>e.kind==='terrain_effect_ended'&&e.tick===31));
 const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id},frames};assert(R.validateArchive(archive));const bad=structuredClone(archive);bad.frames[1].terrainEffects[0].speedFactor=0;assert.throws(()=>R.validateArchive(bad));const forged=structuredClone(archive);forged.frames[1].agents.find(a=>a.id==='vehicle-1').terrainEffectDistance=999;assert.throws(()=>R.validateArchive(forged));
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const base=`http://127.0.0.1:${server.address().port}`;async function req(path,method='GET',data,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
  const [,session]=await req('/sessions','POST',{sceneId:scene.id}),root='/sessions/'+session.sessionId,admin=session.adminToken;const [,agent]=await req(root+'/agents/drone-1/credentials','POST',{},admin);
  assert.equal((await req(root+'/terrain-effect','POST',{zoneId:'shore-crossing',duration:4},agent.agentToken))[0],403);let [status,state]=await req(root+'/terrain-effect','POST',{zoneId:'shore-crossing',duration:4},admin);assert.equal(status,200);assert.equal(state.world.terrainEffects[0].untilTick,4);
  [status,state]=await req(root+'/step','POST',{count:5},admin);assert.equal(status,200);assert.equal(state.world.terrainEffects.length,0);const [,history]=await req(root+'/history?after=-1','GET',undefined,admin);assert(R.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id},frames:history.frames.map(x=>x.world)}));
 }finally{server.close()}
 console.log('temporary terrain effect motion, energy, expiry, replay and API tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
