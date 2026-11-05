'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),Replay=require('../src/replay'),X=require('../src/experiments');
const {createServer}=require('../server/world-server');

(async()=>{
 const scene=E.getScene('industrial-park-parallel-v1');scene.id='custom-test';scene.name='定制园区';scene.tasks[0].name='<img src=x onerror=alert(1)>';scene.agents[0].label='<b>设备</b>';scene.obstacles[0].x=8;
 scene.extra=JSON.parse('{"__proto__":{"polluted":true}}');scene.tasks[0].status='done';
 const normalized=E.normalizeScene(scene);assert(!('extra' in normalized));assert(!('status' in normalized.tasks[0]));
 assert.equal({}.polluted,undefined);assert(Replay.escapeHtml(scene.tasks[0].name).includes('&lt;img'));
 const bad=structuredClone(scene);bad.agents[0].count=100;assert.throws(()=>E.normalizeScene(bad));
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,method='GET',data,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return [r.status,await r.json()]}
 try{
  let [status,response]=await request('/sessions','POST',{seed:42,sceneId:'wrong',scene});assert.equal(status,400);
  [status,response]=await request('/sessions','POST',{seed:42,sceneId:scene.id,scene,physicsMode:'rapier'});assert.equal(status,201);
  const root='/sessions/'+response.sessionId,admin=response.adminToken,frames=[response.world];assert.equal(response.world.obstacles[0].x,8);assert.equal(response.world.tasks[0].status,'pending');assert.equal(response.world.tasks[0].name,scene.tasks[0].name);
  for(let i=0;i<4;i++){[,response]=await request(root+'/step','POST',{count:1},admin);frames.push(response.world)}
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene:normalized},frames};assert(Replay.validateArchive(archive));
  const tampered=structuredClone(archive);tampered.frames[1].obstacles[0].x=0;assert.throws(()=>Replay.validateArchive(tampered));
  const missing=structuredClone(archive);delete missing.config.scene;assert.throws(()=>Replay.validateArchive(missing));
  const config={startSeed:42,count:1,maxTicks:1000,faultTick:null,policies:['nearest','battery'],sceneId:scene.id,scene:normalized};const batch=X.runBatch(config);assert.equal(batch.scene,scene.id);assert.deepEqual(batch.config.scene,normalized);assert(batch.runs.every(r=>r.status==='completed'));
  const comparison=X.runResilienceBatch({startSeed:42,count:1,policy:'nearest',maxTicks:1000,outageTick:1,outageDuration:10,target:'first_dispatch',sceneId:scene.id,scene:normalized});assert.equal(comparison.scene,scene.id);assert(comparison.pairs[0].outage.outageInjected);
  console.log('custom scene API, replay and experiment tests passed');
 }finally{server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
