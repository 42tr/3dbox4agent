'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine'),JS=require('../src/navigation'),Rust=require('../server/rust-navigation');
const {planGroundRoute}=require('../rust/physics/target/release/box_physics.node');
{
 const {spawnSync}=require('node:child_process');
 const stale=spawnSync(process.execPath,['-e',"const assert=require('node:assert/strict'),file=require.resolve('./rust/physics/target/release/box_physics.node');require(file);require.cache[file].exports={};assert.throws(()=>require('./server/rust-navigation'),/rebuild the Rust module/);"],{encoding:'utf8'});
 assert.equal(stale.status,0,stale.stderr);
}
function cost(start,path,zones,metric){if(path===null)return null;let total=0,from=start;for(const p of path){total+=JS.segmentCost(from,p,zones,metric);from=p}return total}
function compare(start,target,obstacles=[],zones=[],metric='distance'){
 const before=JSON.stringify([start,target,obstacles,zones]),a=JS.plan(start,target,obstacles,zones,metric),b=Rust.plan(start,target,obstacles,zones,metric);
 assert.equal(JSON.stringify([start,target,obstacles,zones]),before);assert.equal(b===null,a===null,JSON.stringify({start,target,metric}));
 if(b===null)return;
 assert.deepEqual(b.at(-1),target);let from=start;for(const p of b){assert(JS.clearSegment(from,p,obstacles));from=p}
 assert(Math.abs(cost(start,a,zones,metric)-cost(start,b,zones,metric))<1e-7,JSON.stringify({start,target,metric,a,b,costA:cost(start,a,zones,metric),costB:cost(start,b,zones,metric)}));
 assert.deepEqual(Rust.plan(start,target,obstacles,zones,metric),b);
}
for(const metric of ['distance','time','energy']){
 for(const [start,target,obstacles] of [
  [[10,50],[90,50],[]],[[10,50],[10,50],[]],[[10,50],[90,50],[{x:40,y:30,w:20,h:40}]],
  [[10,50],[50,50],[{x:40,y:30,w:20,h:40}]],[[10,50],[90,50],[{x:40,y:0,w:20,h:100}]],
  [[37.9,45],[55,45],[{x:40,y:40,w:10,h:10}]],[[2,2],[98,98],[{x:40,y:40,w:20,h:20,padding:.9}]],
  [[1.99,50],[90,50],[]],[[10,50],[100,50],[]],[[4.3,6.1],[94.7,93.2],[{x:40,y:30,w:.001,h:40}]],
 ])compare(start,target,obstacles,[],metric);
 const zones=[{x:25,y:25,w:50,h:50,speedFactor:.2,energyFactor:5},
              {x:35,y:40,w:25,h:20,speedFactor:.04,energyFactor:25}];
 for(const target of [[90,50],[98,98],[10,50],[50,90]])compare([10,50],target,[],zones,metric);
 for(let i=0;i<18;i++){
  const start=[4.1+(i*7)%28,4.3+(i*11)%90],target=[66.1+(i*13)%28,5.7+(i*17)%88];
  compare(start,target,[{x:40,y:31,w:14,h:24}],zones,metric);
 }
}
for(const change of [v=>v.metric='fast',v=>v.start=[null,4],v=>v.obstacles=[{x:2,y:2,w:-1,h:4}],
 v=>v.zones=[{x:2,y:2,w:10,h:10,speedFactor:2,energyFactor:1}],
 v=>v.obstacles=Array.from({length:1025},()=>({x:10,y:10,w:1,h:1}))]){
 const v={start:[10,50],target:[90,50],obstacles:[],zones:[],metric:'distance'};change(v);assert.throws(()=>planGroundRoute(JSON.stringify(v)),/invalid navigation input/);
}
assert.throws(()=>planGroundRoute(' '.repeat(512*1024+1)),/too large/);

for(const sceneId of ['industrial-park-v1','industrial-park-parallel-v1','lunar-terrain-v1','lunar-sampling-v1','shore-coordination-v1']){
 const scene=E.getScene(sceneId);const s=E.create(42,'nearest',scene);E.bindNavigation(s,Rust);
 while(!s.done&&s.tick<1000){const before=s.agents.map(a=>[a.x,a.y]);E.step(s);s.agents.forEach((a,i)=>{if((a.mobility??(a.role==='drone'?'air':'ground'))==='ground')assert(JS.clearSegment(before[i],[a.x,a.y],s.obstacles),sceneId+' '+s.tick)})}
 assert(s.done&&!s.failed,sceneId);
}
function groundScene(metric){const scene=E.getScene();scene.id='rust-navigation-ground';scene.navigation=metric;scene.obstacles=[];scene.resource={warehouse:[20,50],site:[80,50]};scene.agents=[{role:'carrier',label:'巡检车',count:1,mobility:'ground',capabilities:['inspect'],speed:3}];scene.tasks=[{id:'survey',name:'地面巡检',behavior:'survey',role:'carrier',capability:'inspect',target:[80,50],duration:2,dependsOn:[]}];scene.terrain=[{id:'rough',name:'地表',x:35,y:10,w:20,h:80,speedFactor:.5,energyFactor:3}];return scene}
for(const metric of ['distance','time','energy']){
 const s=E.create(42,'nearest',groundScene(metric),{dispatchMode:'external'});let calls=0;
 E.bindNavigation(s,{plan(...args){calls++;assert.equal(args[4],metric);return Rust.plan(...args)}});
 [s.agents[0].x,s.agents[0].y]=[10,50];assert(E.assign(s,'survey','carrier-1').ok);
 assert(E.injectRoadblock(s,{x:50,y:0,w:8,h:100},5).ok);
 assert(E.injectTerrainEffect(s,'rough',9,.5,1.8).ok);
 while(!s.done&&s.tick<200)E.step(s);
 assert(s.done&&!s.failed);assert(calls>=3);assert(s.events.some(e=>e.kind==='roadblock_wait_started'));
 assert(s.events.some(e=>e.kind==='roadblock_wait_ended'&&e.outcome==='resumed'));assert(s.events.some(e=>e.kind==='terrain_effect_ended'));
}
{
 const scene=groundScene('energy');scene.riskNavigation='avoid';scene.riskZones=[{id:'risk',name:'避险区',x:40,y:40,w:20,h:20}];
 const s=E.create(42,'nearest',scene,{dispatchMode:'external'});E.bindNavigation(s,Rust);const a=s.agents[0];[a.x,a.y]=[80,50];a.battery=10;a.initialBattery=10;
 const observation=E.observe(s,a.id);assert(observation.self.returnEnergyEstimate>0);
 assert(E.injectTerrainEffect(s,'rough',5,.2,5).ok);
 assert.equal(E.observe(s,a.id).self.returnEnergyEstimate,observation.self.returnEnergyEstimate,'authorized estimates must not reveal live terrain effects');
 assert(E.submitAction(s,a.id,{requestId:'charge',type:'charge',targetTick:1,expiresTick:100}).ok);
 for(let i=0;i<200&&s.actions[0].status!=='completed';i++)E.step(s);
 assert.equal(s.actions[0].status,'completed');assert.equal(a.battery,80);assert.equal(E.metrics(s).riskZoneEntries,0);
}
for(const plan of [()=>{throw Error('native navigation failed')},()=>[],()=>[[20,50]],()=>[[80,50]],()=>[[NaN,50]],()=>[[50,50],[80,50]]]){
 const scene=E.getScene();scene.obstacles=[{id:'wall',x:40,y:30,w:20,h:40,height:8}];
 const s=E.create(42,'nearest',scene,{dispatchMode:'external'}),a=s.agents.find(a=>a.id==='vehicle-1');[a.x,a.y]=[10,50];
 const t=s.tasks.find(t=>t.behavior==='deliver');t.dependsOn=[];s.part.position=[80,50];
 E.bindNavigation(s,{plan});const before=E.snapshot(s);assert.throws(()=>E.assign(s,t.id,a.id),/native navigation failed|invalid native navigation result/);assert.deepEqual(E.snapshot(s),before);
}
(async()=>{
 const P=require('../server/rust-physics');await P.initialize();
 const scene=groundScene('distance');scene.terrain=[];scene.agents[0].count=2;
 const s=E.create(42,'nearest',scene,{dispatchMode:'external',physicsMode:'rapier'});
 [s.agents[0].x,s.agents[0].y]=[10,50];[s.agents[1].x,s.agents[1].y]=[35,50];let paddedQueries=0;
 E.bindNavigation(s,{plan(start,target,obstacles,...args){if(obstacles.some(o=>o.padding===.9))paddedQueries++;return Rust.plan(start,target,obstacles,...args)}});
 const physics=P.createPhysics(s);try{
  assert(E.assign(s,'survey','carrier-1').ok);
  for(let i=0;i<200&&!s.done;i++)E.step(s,physics);
  assert(s.done&&!s.failed);assert.equal(s.tasks[0].status,'done');assert(paddedQueries>0);
  assert(s.events.some(e=>e.kind==='collision_replan'));assert(Math.hypot(s.agents[0].x-80,s.agents[0].y-50)<1e-4);
 }finally{physics.free()}
 console.log('Rust grid routing, weighted terrain, charging, risk avoidance, collision replanning and invalid-path guards passed');
})().catch(error=>{console.error(error);process.exitCode=1});
