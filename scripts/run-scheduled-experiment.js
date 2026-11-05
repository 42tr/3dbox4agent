'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),Plan=require('../src/scheduled-plan'),Replay=require('../src/replay');
(async()=>{
 const args=process.argv.slice(2),file=args[0];if(!file||args.length>3||(args.length>1&&args[1]!=='--url'))throw Error('usage: node scripts/run-scheduled-experiment.js plan.json [--url http://127.0.0.1:8787]');
 const url=new URL(args[2]||'http://127.0.0.1:8787');if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('world URL must be a loopback HTTP origin');
 const raw=fs.readFileSync(file);if(raw.length>60000)throw Error('plan exceeds 60 KB');const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),plan=Plan.validate(input),base=url.origin;
 async function req(path,method='GET',body,token){const response=await fetch(base+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const data=await response.json();return {status:response.status,data}}
 async function required(...args){const res=await req(...args);if(res.status<200||res.status>=300)throw Error('world request failed: '+(res.data.error||res.status));return res.data}
 const runtime=(await required('/health')).runtime;
 const session=await required('/sessions','POST',{scene:plan.scene,seed:plan.seed,policy:plan.policy,physicsMode:plan.physicsMode,dispatchMode:'rule',executionMode:'auto'}),root='/sessions/'+session.sessionId,token=session.adminToken;let state=session,index=0;const outcomes=[];
 try{
  while(true){
   while(index<plan.interventions.length&&plan.interventions[index].tick===state.world.tick&&!state.world.done){
    const item=plan.interventions[index++];let endpoint,payload;
    if(item.type==='fault'){endpoint='fault';payload={}}
    else if(item.type==='outage'){endpoint='communication-outage';payload={agentId:item.agentId,duration:item.duration}}
    else if(item.type==='low_energy'){endpoint='low-energy';payload={agentId:item.agentId,level:item.level}}
    else if(item.type==='roadblock'){endpoint='roadblock';payload={rect:item.rect,duration:item.duration}}
    else {endpoint='terrain-effect';payload={zoneId:item.zoneId,duration:item.duration,speedFactor:item.speedFactor,energyFactor:item.energyFactor}}
    const response=await req(root+'/'+endpoint,'POST',payload,token);
    if(response.status!==200&&response.status!==409)throw Error('world intervention failed: '+(response.data.error||response.status));
    if(response.status===200){state=response.data;outcomes.push({id:item.id,tick:item.tick,type:item.type,status:'applied',revision:state.revision})}
    else outcomes.push({id:item.id,tick:item.tick,type:item.type,status:'rejected',reason:response.data.error||'invalid_request',httpStatus:response.status});
   }
   if(state.world.done||state.world.tick>=plan.maxTicks)break;
   state=await required(root+'/step','POST',{count:1},token);if(state.executed!==1)throw Error('world did not advance');
  }
  for(;index<plan.interventions.length;index++){const item=plan.interventions[index];outcomes.push({id:item.id,tick:item.tick,type:item.type,status:'skipped',reason:state.world.done?'world_finished':'tick_limit'})}
  const history=await required(root+'/history?after=-1','GET',undefined,token),frames=history.frames,first=frames[0].revision,last=frames.at(-1).revision;
  if(last!==state.revision||frames.some((x,i)=>x.revision!==first+i))throw Error('history changed or is noncontiguous');
  if((await required('/health')).runtime.instanceId!==runtime.instanceId)throw Error('world server instance changed');
  const archive={format:'3dbox-prototype-v1',source:'server',config:{sceneId:plan.scene.id,scene:session.scene,seed:plan.seed,policy:plan.policy},coverage:{start:first===0?'complete':'partial',end:state.world.done?'finished':'unfinished',revisionRange:[first,last]},frames:frames.map(x=>x.world)};Replay.validateArchive(archive);
  const status=state.world.failed||outcomes.some(x=>x.status!=='applied')?'failed':state.world.done?'completed':'timeout';
  process.stdout.write(JSON.stringify({format:'3dbox-scheduled-run-v1',planSha256:crypto.createHash('sha256').update(raw).digest('hex'),plan:input,worldRuntime:runtime,status,interventions:outcomes,metrics:state.metrics,events:state.world.events,finalRevision:state.revision,historyTruncated:history.truncated,archive},null,2)+'\n');
  if(status!=='completed')process.exitCode=1;
 }finally{try{await req(root,'DELETE',undefined,token)}catch{}}
})().catch(error=>{console.error(error.message);process.exitCode=1});
