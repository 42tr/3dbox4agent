'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),Peer=require('../server/rust-world-peer'),Replay=require('../src/replay');
const keys=['peer','execution','environment','control','ledger'],sequences=new Set();let calls=0,frames=0,refusals=0;
function hashes(r){return keys.map(k=>crypto.createHash('sha256').update(k==='execution'?r[k].snapshot()+r[k].snapshotExecution():r[k].snapshot()).digest('hex'))}
function atomic(w,store,method,args,context){
 if(!context)return store[method](...args);const stores={...context,peer:store},raw=Object.fromEntries(keys.map(k=>[k,C.reference(stores[k],k).native])),points=Object.fromEntries(keys.map(k=>[k,stores[k].checkpoint()])),before=E.snapshot(w);
 const restore=()=>{for(const k of [...keys].reverse())stores[k].rollback(points[k])};
 const invoke=()=>store[method](...args),native=(tick)=>method==='send'?raw.peer.sendEvents(JSON.stringify(args[0]),tick,raw.execution,raw.environment,raw.control,raw.ledger):method==='interrupt'?raw.peer.interruptEvents(args[0],args[1],tick,raw.execution,raw.environment,raw.control,raw.ledger):raw.peer.advanceEvents(tick,raw.execution,raw.environment,raw.control,raw.ledger);
 try{
  const result=invoke(),after=E.snapshot(w),events=after.events.slice(before.events.length);calls++;assert.equal(result.published,true);assert(!Object.keys(result).includes('published'));
  const key=[method,...events.map(e=>e.kind+':'+(e.reason||'')),Array.isArray(result)?result.map(e=>e.state).join(','):result.reason||''].join('|');if(sequences.has(key))return result;sequences.add(key);restore();const initial=hashes(raw);
  for(const tick of [-1,w.tick+.5,w.tick+1,4294967296+w.tick,NaN,Infinity]){assert.throws(()=>native(tick));assert.deepEqual(hashes(raw),initial)}
  const unobserved=JSON.parse(raw.ledger.append(JSON.stringify({message:'unobserved',type:'info'})));assert.throws(()=>native(w.tick));restore();assert.deepEqual(hashes(raw),initial);
  for(let at=1;at<=events.length;at++){
   for(let n=before.events.length;n<200000-at+1;n++){const row=JSON.parse(raw.ledger.append(JSON.stringify({message:'capacity',type:'info',kind:'fixture'})));raw.control.observe(row.seq,raw.ledger)}
   const padded=hashes(raw);for(let retry=0;retry<2;retry++){assert.throws(()=>native(w.tick),/invalid world ledger input/);assert.deepEqual(hashes(raw),padded);raw.control.validateCommit(raw.ledger);refusals++}restore();assert.deepEqual(E.snapshot(w),before);
  }
  const retry=invoke();assert.deepEqual(retry,result);assert.deepEqual(E.snapshot(w),after);return retry;
 }finally{for(const p of Object.values(points))p.free()}
}
function bind(w,checked=true){const s={};for(const [name,method]of [['environment','bindWorldEnvironment'],['ledger','bindWorldLedger'],['motion','bindWorldMotion'],['tasks','bindWorldTasks'],['actions','bindWorldActions'],['resources','bindWorldResources'],['peer','bindWorldPeer'],['reports','bindWorldReports'],['dispatch','bindWorldDispatch'],['perceptions','bindWorldPerceptions'],['requests','bindWorldRequests']]){let store=require('../server/rust-world-'+name).create(w);s[name]=store;if(name==='peer'&&checked){const original=store;store={...original,send(...args){return atomic(w,original,'send',args,args[2])},interrupt(...args){return atomic(w,original,'interrupt',args,args[3])},advance(...args){return atomic(w,original,'advance',args,args[2])}}}E[method](w,store);if(name==='ledger'){s.control=store.control(w);E.bindWorldControl(w,s.control)}if(name==='motion'){s.execution=store.execution(w);E.bindWorldExecution(w,s.execution)}}return s}
function pair(seed,config,change=()=>{}){const scene=E.getScene();scene.obstacles=[];scene.terrain=[];Object.assign(scene.communication,{range:1000,delay:3,ttl:30,lossRate:0,...config});change(scene);const a=E.create(seed,'nearest',scene,{dispatchMode:'external'});for(const [i,x]of [10,40,70,90].entries()){a.agents[i].x=x;a.agents[i].y=50}for(const [i,x]of [20,80].entries()){const device=a.agents.find(a=>a.id==='vehicle-'+(i+1));device.x=x;device.y=50}const b=E.snapshot(a);return {worlds:[a,b],stores:bind(b),scene}}
function both(worlds,fn){const result=fn(worlds[1]);assert.deepEqual(result,fn(worlds[0]));assert.deepEqual(E.snapshot(worlds[1]),E.snapshot(worlds[0]));for(const a of worlds[0].agents)assert.deepEqual(E.observe(worlds[1],a.id),E.observe(worlds[0],a.id));return result}
function step(worlds,n=1){for(let i=0;i<n;i++){both(worlds,w=>E.step(w).tick);frames++}}
for(const config of [{},{bytesPerTick:2},{bytesPerTick:2,ttl:5},{range:35},{lossRate:.5},{lineOfSight:true,bytesPerTick:4}])for(let seed=0;seed<4;seed++){
 const {worlds,scene}=pair(seed,config,s=>{if(s.communication.lineOfSight)s.obstacles=[{id:'wall',x:49,y:0,w:3,h:100,height:20}]});
 try{
  for(const [from,to,text,via]of [['drone-1','drone-4','中文long',['drone-2','drone-3']],['drone-1','drone-3','abc',['drone-2']],['drone-2','drone-1','other',[]]]){assert(both(worlds,w=>E.sendMessage(w,from,to,text,via,'req-'+from+to)).ok);assert(both(worlds,w=>E.sendMessage(w,from,to,text,via,'req-'+from+to)).duplicate);assert.equal(both(worlds,w=>E.sendMessage(w,from,to,text+'!',via,'req-'+from+to)).reason,'request_id_conflict')}
  step(worlds,4);if(seed%2===0)assert(both(worlds,w=>E.interruptCommunication(w,'drone-3',5)).ok);
  const fork=E.snapshot(worlds[1]);bind(fork,false);try{for(let t=0;t<24;t++){step(worlds);E.step(fork);assert.deepEqual(E.snapshot(fork),E.snapshot(worlds[1]))}}finally{E.disposeWorld(fork)}
  assert.deepEqual(E.metrics(worlds[1]).peerMessages,E.metrics(worlds[0]).peerMessages);assert(Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed,policy:'nearest',sceneId:scene.id,scene},frames:[E.snapshot(worlds[1])]}));
 }finally{E.disposeWorld(worlds[1])}
}
// Native positions, mobility, disabled state and temporary blocks determine the link.
for(const mode of ['ground-static','air-over','mobility-override','temporary','disabled']){
 const {worlds,stores}=pair(42,{delay:1,lineOfSight:true},s=>{if(mode!=='temporary')s.obstacles=[{id:'wall',x:49,y:0,w:3,h:100,height:4}];if(mode==='mobility-override')s.agents[0].mobility='ground'});
 try{
  const ground=mode==='ground-static'||mode==='temporary',from=ground?'vehicle-1':'drone-1',to=ground?'vehicle-2':'drone-4';assert(both(worlds,w=>E.sendMessage(w,from,to,'link',[],'link')).ok);
  if(mode==='temporary')assert(both(worlds,w=>E.injectRoadblock(w,{x:49,y:0,w:3,h:100},2)).ok);
  if(mode==='disabled'){worlds[0].agents[3].disabled=true;worlds[0].agents[3].status='fault';stores.execution.update(3,{disabled:true,status:'fault'})}
  step(worlds);const e=worlds[1].events.find(e=>['message_failed','message_delivered'].includes(e.kind));assert(e);assert.equal(e.kind,mode==='air-over'?'message_delivered':'message_failed',mode);if(mode!=='air-over')assert.equal(e.reason,mode==='disabled'?'unavailable':'obstructed');
 }finally{E.disposeWorld(worlds[1])}
}
{
 const {worlds}=pair(42,{delay:1,ttl:100,bytesPerTick:4096});try{for(let i=0;i<25;i++){assert(both(worlds,w=>E.sendMessage(w,'drone-1','drone-2','包-'+i,[],'id-'+i)).ok);step(worlds)}assert.equal(worlds[1].communication.inboxes['drone-2'].length,20);assert.equal(worlds[1].communication.inboxes['drone-2'][0].text,'包-5')}finally{E.disposeWorld(worlds[1])}
}
// Bindings fence valid-looking replacement participants, seed/config mismatches,
// closed participants and a future clock; no trusted host geometry is accepted.
{
 const {worlds,stores:s}=pair(42,{});const w=worlds[1],r=Object.fromEntries(keys.map(k=>[k,C.reference(s[k],k).native]));try{
  assert(E.sendMessage(w,'drone-1','drone-2','guard',[],'guard').ok);const before=hashes(r),command=JSON.stringify({from:'drone-1',to:'drone-2',text:'guard',via:[],requestId:'guard'}),invoke=(m=r.execution,e=r.environment,c=r.control,l=r.ledger)=>r.peer.sendEvents(command,w.tick,m,e,c,l);
  const m=require('../server/rust-world-motion').create(w),ex=m.execution(w),env=require('../server/rust-world-environment').create(w);assert.throws(()=>invoke(C.reference(ex,'execution').native));assert.deepEqual(hashes(r),before);assert.throws(()=>invoke(r.execution,C.reference(env,'environment').native));assert.deepEqual(hashes(r),before);ex.free();env.free();
  const original=JSON.parse(JSON.stringify({tick:w.tick,seed:w.seed,agents:w.agents.map(a=>({id:a.id,...(a.communicationRange===undefined?{}:{communicationRange:a.communicationRange}),...(a.communicationBytesPerTick===undefined?{}:{communicationBytesPerTick:a.communicationBytesPerTick})})),peer:s.peer.snapshot()}));
  for(const change of [v=>v.seed++,v=>v.agents[0].communicationRange=12]){const v=structuredClone(original);change(v);const other=new (require('../rust/physics/target/release/box_physics.node').WorldPeer)(JSON.stringify(v));assert.throws(()=>other.sendEvents(command,w.tick,r.execution,r.environment,r.control,r.ledger));assert.deepEqual(hashes(r),before);other.free()}
  for(const input of [{from:'unknown',to:'drone-2',text:'x',via:[]},{from:'drone-1',to:'drone-1',text:'x',via:[]},{from:'drone-1',to:'drone-2',text:'x',via:['drone-2']},{from:'drone-1',to:'drone-2',text:'\ufeff \t',via:[]}]){const result=JSON.parse(r.peer.sendEvents(JSON.stringify(input),0,r.execution,r.environment,r.control,r.ledger));assert.equal(result.ok,false);assert.deepEqual(hashes(r),before)}
  for(const duration of [-1,0,.5,1001,NaN,Infinity]){assert.equal(JSON.parse(r.peer.interruptEvents('drone-1',duration,0,r.execution,r.environment,r.control,r.ledger)).reason,'invalid_duration');assert.deepEqual(hashes(r),before)}
  const point=r.ledger.checkpoint();r.ledger.finish(false);assert(JSON.parse(invoke()).duplicate);assert.equal(JSON.parse(r.peer.interruptEvents('unknown',-1,0,r.execution,r.environment,r.control,r.ledger)).reason,'world_finished');assert.throws(()=>r.peer.advanceEvents(0,r.execution,r.environment,r.control,r.ledger));r.ledger.rollback(point);point.free();assert.deepEqual(hashes(r),before);
 }finally{E.disposeWorld(w)}
}
assert(calls>500);assert(sequences.size>=15);assert(refusals>=30);console.log(`Native peer events: ${frames} paired frames, ${calls} native operations, ${sequences.size} event sequences and ${refusals} late append refusals; actual geometry/mobility/availability, all six transport reasons, bandwidth/relay/Unicode order, inbox eviction, duplicate/terminal precedence, prefix/clock/identity guards, native checkpoint retry and independent mid-transfer branches/replay passed`);
