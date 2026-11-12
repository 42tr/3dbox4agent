'use strict';
const {WorldRequests}=require('../native/physics/target/release/box_physics.node');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
function guarded(fn){try{return fn()}catch{throw Object.assign(Error('world_step_failed'),{status:503,worldRequestsFailure:true})}}
const survey=t=>({id:t.id,behavior:t.behavior,name:t.name,role:t.role,capability:t.capability,target:t.target,duration:t.duration,dependsOn:t.dependsOn,...(t.priority!==undefined?{priority:t.priority}:{}),...(t.deadline!==undefined?{deadline:t.deadline}:{})});
const live=t=>t?{id:t.id,status:t.status,assignee:t.assignee??null,assignmentId:t.assignmentId??null}:null;
function proof(w,p){
 if(p.evidenceId!==undefined){const r=(w.evidenceReports||[]).find(r=>r.id===p.evidenceId);return r?{kind:'scan',id:r.id,status:r.status,receivedTick:r.appliedTick??null,observedTick:r.result.observedTick,position:r.result.position??null,result:r.result.kind,role:r.role,canSurvey:r.canSurvey}:null}
 if(p.sensorEvidenceId!==undefined){const r=w.events.find(e=>e.kind==='fixed_sensor_delivered'&&e.reportId===p.sensorEvidenceId&&Number.isSafeInteger(e.observedTick));return r?{kind:'fixed',id:r.reportId,status:'delivered',receivedTick:r.tick,observedTick:r.observedTick,position:r.position,result:r.result,role:null,canSurvey:null}:null}
 if(p.sampleReportId!==undefined){const r=(w.sampleReports||[]).find(r=>r.id===p.sampleReportId);return r?{kind:'sample',id:r.id,status:r.status,receivedTick:r.appliedTick??null,observedTick:r.collectedTick,position:r.position,result:null,role:null,canSurvey:null}:null}return null;
}
function event(e){return e?{kind:e.kind,tick:e.tick,requestId:e.requestId,taskId:e.taskId,agentId:e.agentId,assignmentId:e.assignmentId??null,reason:e.reason??null,coordinatorId:e.coordinatorId??null}:null}
function create(w){
 const introduced=new Set((w.proposals||[]).filter(p=>p.status==='accepted').map(p=>p.task.id)),events=new Map(w.events.filter(e=>['task_revoked','revocation_rejected'].includes(e.kind)).map(e=>[e.requestId,e]));
 const native=new WorldRequests(JSON.stringify({tick:w.tick,decisionMaxAge:w.communication.config.decisionMaxAge??5,agents:w.agents.map(a=>({id:a.id,role:a.role,canSurvey:a.capabilities.includes('inspect')})),tasks:w.tasks.map(t=>({id:t.id,survey:introduced.has(t.id)?survey(t):null})),state:{proposals:w.proposals,revocations:w.revocations},proposalProofs:(w.proposals||[]).map(p=>proof(w,p)),revocationEvents:(w.revocations||[]).map(r=>event(events.get(r.requestId)))}));
 let cache=freeze(JSON.parse(native.snapshot())),closed=false;
 function active(){if(closed)throw Error('closed')}
 function commit(fn){return guarded(()=>{active();const r=JSON.parse(fn());cache=freeze(JSON.parse(native.snapshot()));return r})}
 return require('./native-components').expose({
  validateCommit(){guarded(()=>native.validateCommit())},
  checkpoint(){return guarded(()=>native.checkpoint())},
  rollback(point){guarded(()=>{native.rollback(point);cache=freeze(JSON.parse(native.snapshot()))})},
  read(key){return guarded(()=>{active();if(!['proposals','revocations'].includes(key))throw Error('unknown');return cache[key]})},
  propose(input,s){return commit(()=>native.propose(JSON.stringify(input),JSON.stringify({done:s.done,mode:s.dispatchMode,proof:proof(s,input)}),s.tick))},
  proposeWorld(input,tasks,resources,perceptions,dispatch,reports,control,ledger,tick){return commit(()=>{
   const {reference}=require('./native-components'),t=reference(tasks,'tasks'),r=reference(resources,'resources'),p=reference(perceptions,'perceptions'),d=reference(dispatch,'dispatch'),f=reference(reports,'reports'),c=reference(control,'control'),l=reference(ledger,'ledger');
   const result=native.proposeWorld(JSON.stringify(input),tick,t.native,r.native,p.native,d.native,f.native,c.native,l.native),parsed=JSON.parse(result);if(parsed.ok&&!parsed.duplicate){t.refresh();r.refresh();p.refresh();d.refresh();l.refresh();c.refresh()}return result;
  })},
  revoke(input,execution,environment,resources,tasks,actions,control,ledger,tick){return commit(()=>{
   const {reference}=require('./native-components'),e=reference(execution,'execution'),env=reference(environment,'environment'),r=reference(resources,'resources'),t=reference(tasks,'tasks'),a=reference(actions,'actions'),c=reference(control,'control'),l=reference(ledger,'ledger');
   const result=native.revoke(JSON.stringify(input),tick,e.native,env.native,r.native,t.native,a.native,c.native,l.native),parsed=JSON.parse(result);if(parsed.ok&&!parsed.duplicate){e.refresh();r.refresh();a.refresh();l.refresh();c.refresh()}return result;
  })},
  prepareRevocation(input,s,blockedSince){return commit(()=>native.prepareRevocation(JSON.stringify(input),JSON.stringify({done:s.done,mode:s.dispatchMode,task:live(s.tasks.find(t=>t.id===input.taskId)),agent:s.agents.some(a=>a.id===input.agentId)?{id:input.agentId,blockedSince}:null}),s.tick))},
  commitRevocation(ticket,s,row){return commit(()=>{const a=s.agents.find(a=>a.id===row.agentId),e=s.events.find(e=>e.kind==='task_revoked'&&e.requestId===row.requestId);return native.commitRevocation(ticket,JSON.stringify({task:live(s.tasks.find(t=>t.id===row.taskId)),agent:a?{id:a.id,idle:a.status==='idle',route_empty:a.route.length===0,work:a.work,unsettled_actions:s.actions.some(x=>x.agentId===a.id&&['pending','accepted'].includes(x.status))}:null,event:event(e)}),s.tick)})},
  snapshot(){return guarded(()=>{active();return JSON.parse(native.snapshot())})},
  free(){native.free();closed=true;cache=null}
 },'requests',native,()=>{cache=freeze(JSON.parse(native.snapshot()))});
}
module.exports={create};
