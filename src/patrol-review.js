/* Read-only patrol/evidence summary derived from the selected world snapshot. */
(function(root){
'use strict';
function summarize(world, selected='global'){
 const reports=world.evidenceReports||[],names=new Map(world.agents.map(a=>[a.id,a.name]));
 const scans=world.actions.filter(a=>a.type==='scan'&&a.status==='completed'&&a.result&&(selected==='global'||a.agentId===selected)).map(a=>({
  agentId:a.agentId,agentName:names.get(a.agentId)||a.agentId,requestId:a.requestId,
  tick:a.result.observedTick,kind:a.result.kind,position:a.result.position||null,
  reports:reports.filter(r=>r.agentId===a.agentId&&r.scanRequestId===a.requestId).map(r=>({status:r.status,reason:r.reason||null,submittedTick:r.submittedTick,appliedTick:r.appliedTick??null}))
 })).sort((a,b)=>b.tick-a.tick);
 return {scans,counts:{total:scans.length,notDetected:scans.filter(a=>a.kind==='not_detected').length,anomaly:scans.filter(a=>a.kind==='anomaly').length,normal:scans.filter(a=>a.kind==='normal').length,
  reports:scans.reduce((n,a)=>n+a.reports.length,0),delivered:scans.reduce((n,a)=>n+a.reports.filter(r=>r.status==='delivered').length,0),failed:scans.reduce((n,a)=>n+a.reports.filter(r=>r.status==='failed').length,0)}};
}
const api={summarize};if(typeof module!=='undefined')module.exports=api;else root.SandboxPatrolReview=api;
})(typeof globalThis!=='undefined'?globalThis:this);
