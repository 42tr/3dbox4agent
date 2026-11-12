'use strict';
// Native Rust/Rapier backend. A session owns a separate collider set.
const {PhysicsWorld,initializeWorldRay}=require('../native/physics/target/release/box_physics.node');
async function initialize(){}
function createPhysics(state){
 let physics=new PhysicsWorld(JSON.stringify(state));
 const active=()=>{if(!physics)throw Error('physics world is closed');return physics};
 return {
  initializeWorldRays(input){return initializeWorldRay(input,active())},
  checkpoint(){return active().checkpoint()},
  rollback(point){active().rollback(point)},
  syncRoadblocks(blocks){active().syncRoadblocks(JSON.stringify(blocks))},
  stationaryActions(actions,index,input,motion,environment,resources,tasks){return actions.advanceStationaryRay(index,input,motion,environment,resources,tasks,active())},
  stationaryActionEvents(actions,index,tick,motion,environment,resources,tasks,control,ledger){return actions.advanceStationaryEventsRay(index,tick,motion,environment,resources,tasks,control,ledger,active())},
  fixedReportEvents(reports,tick,motion,environment,tasks,actions,resources,peer,control,ledger){return reports.fixedEventsRay(tick,motion,environment,tasks,actions,resources,peer,control,ledger,active())},
  advanceRoute(motion,index,input,environment){return motion.advanceRouteRapier(index,input,environment,active())},
  advanceRouteEvents(motion,index,tick,environment,resources,tasks,actions,control,ledger){return motion.advanceRouteEventsRapier(index,tick,environment,resources,tasks,actions,control,ledger,active())},
  bindWorldStep(control,...args){return control.bindWorldStepRapier(...args,active())},
  advanceWorldStep(control,tick,...args){return control.advanceWorldStepRapier(tick,...args,active())},
  bindAcceptedActions(control,...args){return control.bindAcceptedActionsRapier(...args,active())},
  advanceAcceptedActions(control,tick,...args){return control.advanceAcceptedActionsRapier(tick,...args,active())},
  bindWorkingTasks(control,...args){return control.bindWorkingTasksRapier(...args,active())},
  advanceWorkingTasks(control,tick,...args){return control.advanceWorkingTasksRapier(tick,...args,active())},
  move(agent,dx,dy){const [x,y,contacts]=active().move(agent.id,agent.x,agent.y,dx,dy);return {x,y,contacts}},
  visible(from,to){return active().visible(from.x,from.y,from.z,to.x,to.y,to.z)},
  refreshPerceptions(store,input){store.refreshRay(input,active())},
  lidar(agent,height,count,maxRange){return active().lidar(agent.id,height,count,maxRange).map(v=>v<0?null:v)},
  correctPosition(agent,x,y){active().correctPosition(agent.id,x,y)},
  free(){if(physics){physics.free();physics=null}}
 };
}
module.exports={initialize,createPhysics};
