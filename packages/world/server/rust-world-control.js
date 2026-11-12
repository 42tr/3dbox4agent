'use strict';
const {WorldControl}=require('../native/physics/target/release/box_physics.node');
const fields=['version','sceneId','seed','policy','physicsMode','executionMode','sensorModel','peerMessageMetricsVersion','boundaryMonitoringVersion','footprintMonitoringVersion','riskMonitoringVersion','recoveryEventsVersion','terrainRouteAssessmentsVersion','dispatchMode','faults','replans','collisionContacts','chargeRecovery'];
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
function guarded(fn){try{return fn()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldControlFailure:true})}}
function create(world,ledger,owner){
 const native=new WorldControl(JSON.stringify({state:Object.fromEntries(fields.map(k=>[k,world[k]])),agents:world.agents.map(a=>a.id),tasks:world.tasks.map(t=>t.id)}),ledger);let cache=freeze(JSON.parse(native.snapshot())),closed=false;
 function active(){if(closed)throw Error('closed')}
 function commit(fn){return guarded(()=>{active();const r=fn();cache=freeze(JSON.parse(native.snapshot()));return r})}
 return require('./native-components').expose({
  validateCommit(){guarded(()=>native.validateCommit(ledger))},
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=freeze(JSON.parse(native.snapshot()))})},
  owner,
  read(key){return guarded(()=>{active();if(!fields.includes(key))throw Error('unknown');return cache[key]})},
  operating(now,execution,environment,tasks,actions,resources,worldLedger){return commit(()=>{const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['ledger',worldLedger]].map(([kind,store])=>reference(store,kind));native.advanceOperatingEnergy(now,...refs.map(r=>r.native));for(const r of refs)r.refresh();return true})},
  observe(sequence){commit(()=>native.observe(sequence,ledger))},
  mode(mode){commit(()=>native.setMode(JSON.stringify(mode),ledger))},
  recover(agentIds,s){return commit(()=>native.recover(JSON.stringify({agentIds,agents:s.agents.map(a=>({id:a.id,battery:a.battery,disabled:a.disabled,idle:a.status==='idle'}))}),ledger))},
  registerTask(id){commit(()=>native.registerTask(id,ledger))},
  agentObservationVersion:1,
  agentObservationsBound(){return guarded(()=>{active();return native.agentObservationsBound()})},
  bindAgentObservations(execution,environment,tasks,actions,resources,peer,reports,perceptions){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions]].map(([kind,store])=>reference(store,kind));native.bindAgentObservations(...refs.map(r=>r.native),ledger)})},
  agentObservation(agentId,tick,execution,environment,tasks,actions,resources,peer,reports,perceptions){return guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions]].map(([kind,store])=>reference(store,kind));return JSON.parse(native.agentObservation(agentId,tick,...refs.map(r=>r.native),ledger))})},
  coordinatorObservationVersion:1,
  coordinatorObservationsBound(){return guarded(()=>{active();return native.coordinatorObservationsBound()})},
  worldAdvanceVersion:1,
  worldStepBound(){return guarded(()=>{active();return native.worldStepBound()})},
  bindWorldStep(physics,execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));const args=[...refs.map(r=>r.native),ledger];if(physics)physics.bindWorldStep(native,...args);else native.bindWorldStep(...args)})},
  advanceWorldStep(tick,physics,execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));const args=[...refs.map(r=>r.native),ledger];if(physics)physics.advanceWorldStep(native,tick,...args);else native.advanceWorldStep(tick,...args);for(const r of refs.filter(r=>r.kind!=='requests'))r.refresh();reference(owner,'ledger').refresh();cache=freeze(JSON.parse(native.snapshot()))})},
  actionAdvanceVersion:1,
  acceptedActionsBound(){return guarded(()=>{active();return native.acceptedActionsBound()})},
  bindAcceptedActions(physics,execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));const args=[...refs.map(r=>r.native),ledger];if(physics)physics.bindAcceptedActions(native,...args);else native.bindAcceptedActions(...args)})},
  advanceAcceptedActions(tick,physics,execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));const args=[...refs.map(r=>r.native),ledger];if(physics)physics.advanceAcceptedActions(native,tick,...args);else native.advanceAcceptedActions(tick,...args);for(const r of refs.filter(r=>['execution','tasks','actions','resources'].includes(r.kind)))r.refresh();reference(owner,'ledger').refresh();cache=freeze(JSON.parse(native.snapshot()))})},
  taskAdvanceVersion:1,
  workingTasksBound(){return guarded(()=>{active();return native.workingTasksBound()})},
  bindWorkingTasks(physics,execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));const args=[...refs.map(r=>r.native),ledger];if(physics)physics.bindWorkingTasks(native,...args);else native.bindWorkingTasks(...args)})},
  advanceWorkingTasks(tick,physics,execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));const args=[...refs.map(r=>r.native),ledger];if(physics)physics.advanceWorkingTasks(native,tick,...args);else native.advanceWorkingTasks(tick,...args);for(const r of refs.filter(r=>['execution','tasks','actions','resources'].includes(r.kind)))r.refresh();reference(owner,'ledger').refresh();cache=freeze(JSON.parse(native.snapshot()))})},
  bindCoordinatorObservations(execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));native.bindCoordinatorObservations(...refs.map(r=>r.native),ledger)})},
  coordinatorObservation(tick,execution,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests){return guarded(()=>{active();const {reference}=require('./native-components'),refs=[['execution',execution],['environment',environment],['tasks',tasks],['actions',actions],['resources',resources],['peer',peer],['reports',reports],['perceptions',perceptions],['dispatch',dispatch],['requests',requests]].map(([kind,store])=>reference(store,kind));return JSON.parse(native.coordinatorObservation(tick,...refs.map(r=>r.native),ledger))})},
  finalizationVersion:1,
  settleTick(execution,environment,tasks,actions,resources,tick,peer,reports,dispatch){return guarded(()=>{
   active();const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),t=reference(tasks,'tasks'),a=reference(actions,'actions'),r=reference(resources,'resources'),l=reference(owner,'ledger');
   let outcome;if(peer&&reports&&dispatch){const p=reference(peer,'peer'),rp=reference(reports,'reports'),d=reference(dispatch,'dispatch');outcome=native.settleWorld(tick,e.native,env.native,t.native,a.native,r.native,p.native,rp.native,d.native,ledger);for(const ref of [e,a,p,rp,d])ref.refresh()}else outcome=native.settleTick(tick,e.native,env.native,t.native,a.native,r.native,ledger);l.refresh();cache=freeze(JSON.parse(native.snapshot()));return outcome;
  })},
  time(execution,environment,tasks,peer,tick,physics,roads,terrain,planning){return guarded(()=>{
   active();const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),t=reference(tasks,'tasks'),p=reference(peer,'peer'),l=reference(owner,'ledger'),args=[e.native,env.native,t.native,p.native,ledger];let ticket,point;
   const refresh=()=>{for(const ref of [e,env,t,p,l])ref.refresh();cache=freeze(JSON.parse(native.snapshot()))};
   const synchronous=operation=>{const result=operation();if(result&&typeof result.then==='function')throw Error('asynchronous time transition')};
   try{
    if(physics)point=physics.checkpoint();ticket=native.beginTime(tick,...args);const plan=JSON.parse(ticket.plan());let planned;if(planning){const a=reference(planning.actions,'actions'),r=reference(planning.resources,'resources');planned=[e.native,env.native,t.native,a.native,r.native,p.native,ledger];native.planTimeRoadRoutes(ticket,...planned)}refresh();synchronous(()=>roads(plan.roadblocks));
    native.timeTerrain(ticket,...args);if(planned)native.planTimeTerrainRoutes(ticket,...planned);refresh();synchronous(()=>terrain(plan.terrain));native.finishTime(ticket,...args);refresh();native.commitTime(ticket,...args);
   }catch(error){let rollbackError;try{if(ticket){native.abortTime(ticket,...args);refresh()}}catch(failure){rollbackError=failure}try{if(point)physics.rollback(point)}catch(failure){rollbackError??=failure}throw rollbackError||error}
   finally{try{ticket?.free()}catch{}try{point?.free()}catch{}}
  })},
  snapshot(){return guarded(()=>{active();return JSON.parse(native.snapshot())})},
  free(){native.free();closed=true;cache=null}
 },'control',native,()=>{cache=freeze(JSON.parse(native.snapshot()))});
}
module.exports={create,fields};
