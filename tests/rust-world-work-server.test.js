'use strict';
require('./native-phase-http-support')(); // Explicit leaf-phase HTTP compatibility fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),E=require('../src/engine'),Replay=require('../src/replay'),Tasks=require('../server/rust-world-tasks'),Control=require('../server/rust-world-control'),Ledger=require('../server/rust-world-ledger'),{createServer}=require('../server/world-server');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-work-')),originalTasks=Tasks.create,originalControl=Control.create,originalLedger=Ledger.create,inspectFree=new WeakSet(),restored=[],staged=[];let failEffect=null;
 Tasks.create=w=>{const store=originalTasks(w);return {...store,get views(){return store.views},work(...args){const result=store.work(...args),loading=args[6]!==undefined||result?.loaded===true;if(failEffect===(loading?'loaded':result?.effect)){inspectFree.add(w);staged.push(E.snapshot(w));throw Error('host failure after native task work commit')}return result}}};
 Control.create=(w,...args)=>{const c=originalControl(w,...args);return {...c,advanceWorkingTasks(...args){const start=w.events.length,result=c.advanceWorkingTasks(...args),events=w.events.slice(start),behavior=failEffect==='delivered'?'deliver':failEffect;const match=failEffect==='loaded'?events.some(e=>e.kind==='part_loaded'):failEffect==='energy_depleted'?events.some(e=>e.kind==='energy_depleted'):events.some(e=>e.kind==='task_completed'&&w.tasks.find(t=>t.id===e.taskId)?.behavior===behavior);if(failEffect&&match){inspectFree.add(w);staged.push(E.snapshot(w));throw Error('host failure after native task work batch commit')}return result}}};
 Ledger.create=w=>{const l=originalLedger(w);return {...l,get tick(){return l.tick},get done(){return l.done},get failed(){return l.failed},get events(){return l.events},control(world){return l.control.call(this,world)},free(){if(inspectFree.has(w))restored.push(E.snapshot(w));l.free()}}};
 const server=createServer({physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust',journalDir:dir,replayJournal:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,sessions=[];
 async function req(route,method='GET',body,token){const r=await fetch(base+route,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return [r.status,await r.json()]}
 const root=s=>'/sessions/'+s.sessionId;
 try{
  for(const effect of ['detect','loaded','delivered','repair','verify','energy_depleted']){
   const scene=E.getScene('lunar-outpost-v1');if(effect==='energy_depleted'){scene.tasks.find(t=>t.behavior==='repair').duration=100;scene.agents.find(a=>a.role==='robot').workEnergyPerTick=5}
   const [created,s]=await req('/sessions','POST',{scene,physicsMode:'rapier',sensorMode:'rapier'});assert.equal(created,201,JSON.stringify(s));assert.equal(s.recordingContext.runtime.worldWorkVersion,1);sessions.push(s);let saved=s,refused=false;failEffect=effect;
   for(let n=0;n<600;n++){
    const [status,next]=await req(root(s)+'/step','POST',{count:1},s.adminToken);
    if(status===503){refused=true;break}assert.equal(status,200,JSON.stringify(next));saved=next;if(next.world.done)break;
   }
   failEffect=null;assert(refused,effect+' must reach actual native commit');assert.deepEqual(restored.at(-1),saved.world,effect+' raw native rollback');
   const [,frozen]=await req(root(s),'GET',undefined,s.adminToken);assert.equal(frozen.revision,saved.revision);assert.deepEqual(frozen.world,saved.world);assert.equal(frozen.simulationError,'world_step_failed');assert.equal((await req(root(s)+'/step','POST',{count:1},s.adminToken))[0],503);
   const [forked,branch]=await req('/event-journals/'+s.sessionId+'/fork','POST',{revision:saved.revision},s.adminToken);assert.equal(forked,201,JSON.stringify(branch));sessions.push(branch);assert.deepEqual(branch.world,saved.world);
   const task=saved.world.tasks.find(t=>t.status==='active'&&t.behavior===(effect==='loaded'||effect==='delivered'?'deliver':effect==='energy_depleted'?'repair':effect));assert(task,effect);
   const [,sourceView]=await req(root(s)+'/observations/'+task.assignee,'GET',undefined,s.adminToken),[,branchView]=await req(root(branch)+'/observations/'+task.assignee,'GET',undefined,branch.adminToken);assert.deepEqual(sourceView,{...branchView,sessionError:'world_step_failed',simulationError:'world_step_failed'});
   const actual=staged.at(-1);if(effect==='loaded'){assert.equal(actual.part.location,'carried');assert.equal(actual.tasks.find(t=>t.id===task.id).phase,'to_site')}
   else if(effect==='energy_depleted'){assert.equal(actual.tasks.find(t=>t.id===task.id).status,'pending');assert.equal(actual.agents.find(a=>a.id===task.assignee).disabled,true)}
   else{assert.equal(actual.tasks.find(t=>t.id===task.id).status,'done');assert.equal(actual.agents.find(a=>a.id===task.assignee).work,0);if(effect==='repair')assert.equal(actual.part.location,'consumed');if(effect==='verify')assert.equal(actual.asset.condition,'operational')}
   let current=branch;for(let n=0;n<40&&!current.world.done;n++){const [status,next]=await req(root(branch)+'/step','POST',{count:20},branch.adminToken);assert.equal(status,200,JSON.stringify(next));current=next}
   assert.equal(current.world.done,true);if(effect!=='energy_depleted'){assert.equal(current.world.failed,false);assert.equal(current.world.asset.condition,'operational');assert.equal(current.world.part.location,'consumed')}
   else assert(current.world.events.some(e=>e.kind==='energy_depleted'));
   assert.deepEqual((await req(root(s),'GET',undefined,s.adminToken))[1].world,saved.world);
   for(const item of [s,branch]){const [,history]=await req(root(item)+'/history?after=-1','GET',undefined,item.adminToken);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',sceneId:scene.id,scene},frames:history.frames.map(f=>f.world)}));assert.equal((await req(root(item),'DELETE',undefined,item.adminToken))[0],200)}
  }
  assert.equal(staged.length,6);assert.equal(restored.length,6);console.log('HTTP failures after native detect/load/deliver/repair/verify/depletion commits restore live raw/scoped state; independent native journal branches continue and replay');
 }finally{failEffect=null;Tasks.create=originalTasks;Control.create=originalControl;Ledger.create=originalLedger;await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
