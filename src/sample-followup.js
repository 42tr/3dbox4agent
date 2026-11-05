/* Derive sample-report-followup timing from the current world snapshot only. */
(function(root){
'use strict';
function summarize(s){return (s.events||[]).filter(e=>e.kind==='sample_collected').map(sample=>{const reports=(s.sampleReports||[]).filter(r=>r.agentId===sample.agentId&&r.taskId===sample.taskId),delivered=reports.find(r=>r.status==='delivered'),proposal=(s.proposals||[]).find(p=>delivered&&p.status==='accepted'&&p.sampleReportId===delivered.id),completion=(s.events||[]).find(e=>proposal&&e.kind==='task_completed'&&e.taskId===proposal.task.id);return {agentId:sample.agentId,taskId:sample.taskId,collectedTick:sample.tick,reportAttempts:reports.length,reportSubmittedTick:delivered?.submittedTick??null,reportDeliveredTick:delivered?.appliedTick??null,proposalTick:proposal?.appliedTick??null,followupCompletedTick:completion?.tick??null,samplingToFollowupTicks:completion?completion.tick-sample.tick:null}})}
const api={summarize};if(typeof module!=='undefined')module.exports=api;else root.SandboxSampleFollowup=api;
})(typeof globalThis!=='undefined'?globalThis:this);
