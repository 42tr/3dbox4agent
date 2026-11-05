'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Sensors=require('../src/sensors'),N=require('../server/rust-world-perceptions'),P=require('../server/rust-physics'),{WorldPerceptions,PhysicsWorld}=require('../rust/physics/target/release/box_physics.node');
const block=b=>({x:b.x,y:b.y,w:b.w,h:b.h,height:b.height});
function initial(w=E.create(42)){return {tick:w.tick,ray:w.sensorModel==='rapier-ray-v1',agents:w.agents.map(a=>({id:a.id,role:a.role,height:Sensors.position(a).z,range:a.sensorRange??w.sensorRange})),targets:w.tasks.map(t=>({id:t.id,target:t.target})),obstacles:w.obstacles.map(block),perceptions:w.perceptions}}
const native=v=>new WorldPerceptions(JSON.stringify(v));
const frame=w=>({tick:w.tick,agents:w.agents.map(a=>({id:a.id,x:a.x,y:a.y,status:a.status,disabled:a.disabled})),roadblocks:(w.roadblocks||[]).map(block)});
for(const mutate of [v=>v.tick=-1,v=>v.agents=[],v=>v.agents.push(v.agents[0]),v=>v.agents[0].range=0,v=>v.agents[0].height=2,v=>v.targets.push(v.targets[0]),v=>v.targets[0].target=[101,1],v=>v.obstacles[0].height=-1,v=>delete v.perceptions['drone-1'],v=>v.perceptions['fake']=v.perceptions['drone-1'],v=>v.perceptions['drone-1'].current.push(v.perceptions['drone-1'].current[0]),v=>v.perceptions['drone-1'].memory[0].observedTick=1,v=>v.perceptions['drone-1'].memory[0].source='payload',v=>v.perceptions['drone-1'].memory[0].role='spoof',v=>v.perceptions['drone-1'].memory.reverse()]){const v=initial();mutate(v);assert.throws(()=>native(v),/invalid world perceptions/)}
{
 const w=E.create(42),n=native(initial(w)),before=n.snapshot();
 for(const mutate of [v=>v.tick=-1,v=>v.tick=10000001,v=>v.agents.pop(),v=>v.agents[1]=v.agents[0],v=>v.agents.reverse(),v=>v.agents[0].x=101,v=>v.agents[0].status='teleport',v=>v.perceptions={},v=>v.roadblocks.push({x:0,y:0,w:2,h:2,height:0})]){const v=frame(w);mutate(v);assert.throws(()=>n.refresh(JSON.stringify(v)));assert.equal(n.snapshot(),before)}
 assert.throws(()=>n.register(JSON.stringify({id:'inspect',target:[1,1]}),0));assert.throws(()=>n.register(JSON.stringify({id:'new',target:[101,1]}),0));assert.throws(()=>n.refreshRay(JSON.stringify(frame(w)),new PhysicsWorld(JSON.stringify(w))),/invalid world perceptions/);assert.equal(n.snapshot(),before);n.free();n.free();assert.throws(()=>n.snapshot(),/closed/);assert.throws(()=>n.refresh(JSON.stringify(frame(w))),/closed/);
}
function pair(scene=E.getScene(),ray=false){const a=E.create(42,'nearest',scene,{dispatchMode:'external',physicsMode:ray?'rapier':'kinematic'}),b=E.snapshot(a),worlds=[a,b],physics=ray?worlds.map(w=>P.createPhysics(w)):[null,null];if(ray)worlds.forEach((w,i)=>E.bindRaySensors(w,physics[i]));E.bindWorldPerceptions(b,N.create(b,physics[1]));return {worlds,physics,free(){E.disposeWorld(b);physics.forEach(p=>p?.free())}}}
function equal(worlds){assert.deepEqual(E.snapshot(worlds[1]),E.snapshot(worlds[0]));for(const a of worlds[0].agents)assert.deepEqual(E.observe(worlds[1],a.id),E.observe(worlds[0],a.id))}
function refresh(worlds){worlds.forEach(w=>E.refreshPerceptions(w));equal(worlds)}
for(const ray of [false,true]){
 const scene=E.getScene();scene.sensorRange=30;scene.obstacles=[{id:'wall',x:40,y:30,w:4,h:20,height:8}];const p=pair(scene,ray),{worlds}=p;
 worlds.forEach(w=>{w.agents.forEach((a,i)=>{a.x=10+i;a.y=70});const a=w.agents.find(a=>a.id==='vehicle-1'),b=w.agents.find(a=>a.id==='vehicle-2'),drone=w.agents[0];a.x=35;a.y=40;b.x=38;b.y=40;drone.x=35;drone.y=40});refresh(worlds);
 const self='vehicle-1',other='vehicle-2';assert(E.observe(worlds[1],self).nearby.some(a=>a.id===other));const view=worlds[1].perceptions;for(const fn of [()=>worlds[1].perceptions={},()=>view[self].memory=[],()=>view[self].current[0].x=999,()=>view[self].memory.push({})])assert.throws(fn,TypeError);
 worlds.forEach(w=>{w.tick=1;w.agents.find(a=>a.id===other).x=47});refresh(worlds);let obs=E.observe(worlds[1],self);assert(!obs.nearby.some(a=>a.id===other));assert(obs.memory.some(a=>a.id===other&&!a.current&&a.age===1&&a.x===38));assert(E.observe(worlds[1],'drone-1').nearby.some(a=>a.id==='drone-2')===E.observe(worlds[0],'drone-1').nearby.some(a=>a.id==='drone-2'));
 // A disabled observer keeps historical memory until the inclusive TTL, never
 // receives fresh objects, and remains visible to other observers.
 worlds.forEach(w=>{w.agents.find(a=>a.id===self).disabled=true;w.agents.find(a=>a.id===self).status='fault';w.tick=30});refresh(worlds);obs=E.observe(worlds[1],self);assert.equal(obs.nearby.length,0);assert(obs.memory.some(a=>a.id===other&&a.age===30));worlds.forEach(w=>w.tick=31);refresh(worlds);assert(!E.observe(worlds[1],self).memory.some(a=>a.id===other));
 const fork=E.snapshot(worlds[1]),forkPhysics=ray?P.createPhysics(fork):null;if(ray)E.bindRaySensors(fork,forkPhysics,true);E.bindWorldPerceptions(fork,N.create(fork,forkPhysics));worlds.forEach(w=>w.tick=32);fork.tick=32;refresh(worlds);E.refreshPerceptions(fork);assert.deepEqual(E.snapshot(fork),E.snapshot(worlds[1]));assert.throws(()=>E.bindWorldPerceptions(worlds[1],N.create(worlds[1],p.physics[1])));if(ray)assert.throws(()=>E.bindRaySensors(worlds[1],p.physics[1],true),/before native perceptions/);E.disposeWorld(fork);forkPhysics?.free();p.free();
}
{
 // Current order follows entity registration, while memory follows English
 // collation, including identifiers whose primary keys differ only in case.
 const scene=E.getScene();scene.obstacles=[];scene.sensorRange=10000;scene.agents=scene.agents.map(a=>({...a,count:2}));const template={...scene.tasks[0],behavior:'survey',dependsOn:[],target:[50,50]};scene.tasks=['_','-','9','10','aZ','Az','az','a-z','a_z','A','a','Z'].map(id=>({...template,id}));const p=pair(scene),{worlds}=p;refresh(worlds);
 const ids=E.observe(worlds[1],'drone-1').memory.filter(x=>x.kind==='target').map(x=>x.id);assert.deepEqual(ids,scene.tasks.map(x=>x.id).sort((a,b)=>a.localeCompare(b,'en')));
 const proposal={requestId:'dynamic',observedTick:0,task:{id:'aA',name:'动态勘察',role:'drone',target:[40,40],duration:2,dependsOn:[]}};assert.deepEqual(E.proposeSurvey(worlds[1],proposal),E.proposeSurvey(worlds[0],proposal));equal(worlds);assert(E.observe(worlds[1],'drone-1').visibleTargets.some(t=>t.id==='aA'));p.free();
}
for(const ray of [false,true]){
 const scene=E.getScene();scene.obstacles=[];scene.sensorRange=30;const p=pair(scene,ray);p.worlds.forEach(w=>{w.agents.forEach((a,i)=>{a.x=30+i*2;a.y=50});const a=w.agents.find(a=>a.id==='vehicle-1'),b=w.agents.find(a=>a.id==='vehicle-2');a.x=3;a.y=10;b.x=13;b.y=10});refresh(p.worlds);for(const w of p.worlds)assert(E.injectRoadblock(w,{x:7,y:7,w:2,h:6},1).ok);equal(p.worlds);assert(!E.observe(p.worlds[1],'vehicle-1').nearby.some(a=>a.id==='vehicle-2'));for(const w of p.worlds)w.tick=2;for(const w of p.worlds)w.roadblocks=[];refresh(p.worlds);assert(E.observe(p.worlds[1],'vehicle-1').nearby.some(a=>a.id==='vehicle-2'));p.free();
}
// A closed native ray world must refuse the whole refresh before memory/tick
// commit; it cannot silently switch the world's sensing model to geometry.
{
 const w=E.create(42,'nearest',E.getScene(),{physicsMode:'rapier'}),p=new PhysicsWorld(JSON.stringify(w));w.sensorModel='rapier-ray-v1';const n=native(initial(w)),before=n.snapshot();p.free();assert.throws(()=>n.refreshRay(JSON.stringify(frame(w)),p),/closed/);assert.equal(n.snapshot(),before);assert.throws(()=>n.refresh(JSON.stringify(frame(w))),/invalid world perceptions/);assert.equal(n.snapshot(),before);n.free();
}
// Pin actual JS/native decisions at the exact radius and at the immediately
// adjacent representable radii; libm hypot differs from V8 at these boundaries.
{
 let seed=17;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32*90};
 const data=new DataView(new ArrayBuffer(8));function adjacent(n,delta){data.setFloat64(0,n);data.setBigUint64(0,data.getBigUint64(0)+BigInt(delta));return data.getFloat64(0)}
 const p=new PhysicsWorld(JSON.stringify({obstacles:[],agents:[]}));
 for(const ray of [false,true])for(let i=0;i<1000;i++){
  const [x,y,tx,ty]=[random(),random(),random(),random()],r=Math.hypot(tx-x,ty-y);
  for(const [range,expected]of [[adjacent(r,-1),false],[r,true],[adjacent(r,1),true]]){
   const n=native({tick:0,ray,agents:[{id:'a',role:'ground',height:1.5,range},{id:'b',role:'ground',height:1.5,range:100}],targets:[{id:'t',target:[100,100]}],obstacles:[],perceptions:{a:{current:[],memory:[]},b:{current:[],memory:[]}}});
   const f=JSON.stringify({tick:0,agents:[{id:'a',x,y,status:'idle',disabled:false},{id:'b',x:tx,y:ty,status:'idle',disabled:false}],roadblocks:[]});if(ray)n.refreshRay(f,p);else n.refresh(f);assert.equal(JSON.parse(n.snapshot()).a.current.some(a=>a.id==='b'),expected,JSON.stringify({ray,x,y,tx,ty,range,r}));n.free();
  }
 }
 p.free();
}
console.log('Native local observations: typed rejection, atomic ray failure, geometry/ray occlusion, 6,000 exact/adjacent radius boundaries, disabled/TTL boundaries, mixed-case memory, dynamic targets, immutable views and independent forks passed');
