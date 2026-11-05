'use strict';
// Bounded local HTTP load test. Each backend runs in its own fresh Node process.
const {spawnSync}=require('node:child_process'),crypto=require('node:crypto');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value}
function options(sessions,ticks){if(!Number.isInteger(sessions)||sessions<1||sessions>16||!Number.isInteger(ticks)||ticks<1||ticks>150||sessions*ticks>1200)throw Error('sessions must be 1–16, ticks 1–150, product at most 1200');return {sessions,ticks,sceneId:'industrial-park-parallel-v1',seedStart:42,messageEveryTicks:5,stateHashEncoding:'canonical-json-v1'}}
async function worker(backend,config){
 const {createServer}=require('../server/world-server');const server=createServer({taskBackend:backend,communicationBackend:backend,physicsBackend:'wasm'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,sessions=[];let responseBytes=0;
 async function request(path,method='GET',body,token){const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();responseBytes+=Buffer.byteLength(text);const data=JSON.parse(text);if(!response.ok)throw Error(`HTTP ${response.status}: ${data.error}`);return data}
 try{
  const health=await request('/health');if(health.runtime.taskBackend!==backend||health.runtime.communicationBackend!==backend)throw Error('backend mismatch');
  for(let i=0;i<config.sessions;i++){const s=await request('/sessions','POST',{sceneId:config.sceneId,seed:config.seedStart+i,policy:'nearest',dispatchMode:'rule',physicsMode:'kinematic'});sessions.push({id:s.sessionId,token:s.adminToken,seed:config.seedStart+i,world:s.world,executed:0})}
  responseBytes=0;const latency=[],start=performance.now();let peakRssBytes=process.memoryUsage.rss(),messageAttempts=0;
  for(let tick=0;tick<config.ticks;tick++){
   const active=sessions.filter(s=>!s.world.done);if(!active.length)break;
   if(tick%config.messageEveryTicks===0){await Promise.all(active.map(async s=>{await request(`/sessions/${s.id}/message`,'POST',{from:'drone-1',to:'drone-2',text:'benchmark-message'},s.token);messageAttempts++}))}
   await Promise.all(active.map(async s=>{const before=performance.now(),result=await request(`/sessions/${s.id}/step`,'POST',{count:1},s.token);latency.push(performance.now()-before);s.world=result.world;s.executed+=result.executed}));peakRssBytes=Math.max(peakRssBytes,process.memoryUsage.rss());
  }
  const wallMs=performance.now()-start;latency.sort((a,b)=>a-b);const q=p=>latency.length?latency[Math.ceil(latency.length*p)-1]:null;
  return {backend,wallMs,executedSteps:sessions.reduce((n,s)=>n+s.executed,0),stepRequests:latency.length,stepLatencyMs:{p50:q(.5),p95:q(.95),max:latency.at(-1)??null},responseBytes,peakRssBytes,messageAttempts,worlds:sessions.map(s=>({seed:s.seed,ticks:s.world.tick,done:s.world.done,failed:!!s.world.failed,sha256:crypto.createHash('sha256').update(JSON.stringify(canonical(s.world))).digest('hex')})),runtime:health.runtime};
 }finally{await Promise.allSettled(sessions.map(s=>request(`/sessions/${s.id}`,'DELETE',undefined,s.token)));await new Promise(r=>server.close(r))}
}
async function main(){
 if(process.argv[2]==='--worker'){const backend=process.argv[3];if(!['js','rust'].includes(backend))throw Error('invalid backend');const config=options(Number(process.argv[4]),Number(process.argv[5]));console.log(JSON.stringify(await worker(backend,config)));return}
 const config=options(Number(process.argv[2]??4),Number(process.argv[3]??30)),runs=[];for(const backend of ['js','rust']){const child=spawnSync(process.execPath,[__filename,'--worker',backend,String(config.sessions),String(config.ticks)],{encoding:'utf8',maxBuffer:1024*1024,timeout:120000});if(child.error)throw child.error;if(child.status!==0)throw Error(`${backend} worker failed: ${child.stderr.trim()}`);runs.push(JSON.parse(child.stdout))}
 const pairs=runs[0].worlds.map((a,i)=>({seed:a.seed,jsHash:a.sha256,rustHash:runs[1].worlds[i].sha256,equal:a.sha256===runs[1].worlds[i].sha256}));console.log(JSON.stringify({format:'3dbox-service-load-v1',config,runs,pairs,allWorldsEqual:pairs.every(p=>p.equal)},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
