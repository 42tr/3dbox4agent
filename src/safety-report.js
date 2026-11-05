/* Evaluation derived from one authoritative snapshot, not a claim of safety. */
(function(root){
'use strict';
const E=typeof module!=='undefined'?require('./engine'):root.SandboxEngine;
function build(state,scene,coverage,source){
 if(!state||!scene||!coverage||!['complete','partial','unknown'].includes(coverage.start)||!['browser','server','replay'].includes(source))throw Error('invalid evaluation input');
 const normalized=E.normalizeScene(scene);if(normalized.id!==state.sceneId)throw Error('scene does not match snapshot');
 const metrics=E.metrics(state),rapier=state.physicsMode==='rapier',contacts=metrics.collisionContacts;delete metrics.collisionContacts;
 return {format:'3dbox-safety-review-v1',source,snapshot:{tick:state.tick,status:state.done?(state.failed?'failed':'completed'):'in_progress',historyStart:coverage.start},config:{engineVersion:state.version,seed:state.seed,policy:state.policy,scene:normalized,physicsMode:state.physicsMode,dispatchMode:state.dispatchMode,executionMode:state.executionMode??'auto'},metrics,
  safety:{energyDepletions:metrics.energyDepletions,physicalContacts:{monitoring:rapier?'motion_restriction':'not_simulated',count:rapier?contacts:null},boundaryViolations:{monitoring:state.boundaryMonitoringVersion===1?'center_exit_prevention':'not_recorded',preventedExits:metrics.boundaryInterventions},footprintBoundaryExits:{monitoring:state.footprintMonitoringVersion===1?'horizontal_radius_0.8':'not_recorded',count:metrics.footprintBoundaryExits},riskEntries:{monitoring:state.riskMonitoringVersion===2?'segment_projection':state.riskMonitoringVersion===1?'sampled_projection':'not_recorded',version:state.riskMonitoringVersion??null,zoneCount:Array.isArray(state.riskZones)?state.riskZones.length:null,count:metrics.riskZoneEntries}},
  safetyEvents:state.events.filter(e=>['energy_depleted','collision_contact','boundary_exit_prevented','footprint_boundary_exit','risk_zone_entered','deadline_missed'].includes(e.kind)).map(e=>JSON.parse(JSON.stringify(e))),
  limitations:['Physical contacts record motion restriction, not damage; kinematic mode does not simulate collisions.',state.boundaryMonitoringVersion===1?'Boundary protection monitors the agent center in two dimensions; it does not account for body size or height.':'Boundary exits were not recorded in this snapshot.','Footprint exits use a horizontal radius 0.8 proxy and are monitored, not prevented; height and visual geometry are not modeled.','Risk entries use a two-dimensional projection; the initial position is not counted.','Snapshot history coverage describes saved snapshots, not independent verification of event completeness.']};
}
const api={build};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SandboxSafetyReport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
