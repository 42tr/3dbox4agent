//! One authoritative tick over bound native participants. The gateway supplies
//! only the expected committed clock and actual component/physics references.
use super::*;
use crate::{PhysicsWorld,world_motion::WorldMotion,world_environment::WorldEnvironment,world_tasks::WorldTasks,world_actions::WorldActions,world_resources::WorldResources,world_peer::WorldPeer,world_reports::WorldReports,world_perceptions::WorldPerceptions,world_dispatch::WorldDispatch,world_requests::WorldRequests};

fn value(s:String)->Result<Value>{serde_json::from_str(&s).map_err(|_|invalid())}

impl WorldControl{
 fn world_advance_context(&self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:Option<&PhysicsWorld>)->Result<[u64;12]>{
  let binding=self.task_advance_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,physics)?;
  if self.task_advance_binding!=Some(binding)||self.action_advance_binding!=Some(binding){return Err(invalid())}
  perceptions.validate_owned(self.linked(ledger)? as u32,motion,environment,matches!(self.state.sensor_model,Some(Sensor::Ray)))?;Ok(binding)
 }
 fn bind_world_advance(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:Option<&PhysicsWorld>)->Result<()>{
  let binding=self.world_advance_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,physics)?;
  if self.world_advance_binding.is_some_and(|old|old!=binding){return Err(invalid())}
  if self.world_advance_binding.is_none(){self.world_advance_tick=Some(self.linked(ledger)?)}self.world_advance_binding=Some(binding);Ok(())
 }
 fn world_advance(&mut self,expected:f64,motion:&mut WorldMotion,environment:&mut WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&mut WorldPeer,reports:&mut WorldReports,perceptions:&mut WorldPerceptions,dispatch:&mut WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger,mut physics:Option<&mut PhysicsWorld>)->Result<()>{
  let binding=self.world_advance_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,physics.as_deref())?;
  let old=self.linked(ledger)?;if expected!=old as f64||self.world_advance_binding!=Some(binding)||self.world_advance_tick!=Some(old)||ledger.done()?{return Err(invalid())}
  let mut control=self.clone();let mut motion_next=motion.clone();let mut environment_next=environment.clone();let mut tasks_next=tasks.clone();let mut actions_next=actions.clone();let mut resources_next=resources.clone();let mut peer_next=peer.clone();let mut reports_next=reports.clone();let mut perceptions_next=perceptions.clone();let mut dispatch_next=dispatch.clone();let mut ledger_next=ledger.clone();let mut physics_next=physics.as_ref().map(|p|(**p).clone());
  let ray=matches!(self.state.sensor_model,Some(Sensor::Ray));
  let risk_start=if self.state.risk_monitoring_version==Some(1){Some(motion.lifecycle_agents()?.into_iter().map(|(_,a,_)|(a.id,[a.x,a.y])).collect::<Vec<_>>())}else{None};
  // Road restoration precedes terrain restoration, including route planning.
  let mut ticket=control.begin_time(expected,&motion_next,&mut environment_next,&tasks_next,&peer_next,&mut ledger_next)?;
  control.plan_time_road_routes(&mut ticket,&mut motion_next,&mut environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut ledger_next)?;
  if let Some(p)=physics_next.as_mut(){p.sync_roadblocks(environment_next.physical_roadblocks()?)?;}
  control.time_terrain(&mut ticket,&motion_next,&mut environment_next,&tasks_next,&peer_next,&mut ledger_next)?;
  control.plan_time_terrain_routes(&mut ticket,&mut motion_next,&mut environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut ledger_next)?;
  control.finish_time(&mut ticket,&motion_next,&environment_next,&tasks_next,&mut peer_next,&mut ledger_next)?;
  control.commit_time(&mut ticket,&motion_next,&environment_next,&tasks_next,&peer_next,&ledger_next)?;ticket.free();
  let now=control.linked(&ledger_next)?;let tick=now as f64;
  if motion_next.has_operating_energy()?{control.operating_energy_phase(now as u32,&mut motion_next,&environment_next,&mut tasks_next,&mut actions_next,&mut resources_next,&mut ledger_next)?;}
  if reports_next.has_fixed_sensors()?{if ray{reports_next.fixed_events_ray(tick,&motion_next,&environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut control,&mut ledger_next,physics_next.as_ref().ok_or_else(invalid)?)?;}else{reports_next.fixed_events(tick,&motion_next,&environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut control,&mut ledger_next)?;}}
  reports_next.advance_events("evidence".into(),tick,&motion_next,&environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut control,&mut ledger_next)?;
  reports_next.advance_events("sample".into(),tick,&motion_next,&environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut control,&mut ledger_next)?;
  peer_next.advance_events(tick,&motion_next,&environment_next,&mut control,&mut ledger_next)?;
  if matches!(control.state.dispatch_mode,Mode::NetworkedReported){reports_next.advance_events("status".into(),tick,&motion_next,&environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut control,&mut ledger_next)?;}
  if matches!(control.state.dispatch_mode,Mode::Networked|Mode::NetworkedExternal|Mode::NetworkedReported){
   let ids=dispatch_next.event_packet_ids()?;let outcomes=value(dispatch_next.ready_events(tick,&motion_next,&environment_next,&tasks_next,&resources_next,&actions_next,&peer_next,&reports_next,&control,&ledger_next)?)?;let outcomes=outcomes.as_array().ok_or_else(invalid)?;if ids.len()!=outcomes.len(){return Err(invalid())}
   for(id,outcome)in ids.into_iter().zip(outcomes){if outcome["id"].as_u64()!=Some(id){return Err(invalid())}if outcome["state"]=="waiting"{continue}let result=value(dispatch_next.settle_events(id as f64,tick,&mut motion_next,&environment_next,&mut tasks_next,&mut resources_next,&actions_next,&peer_next,&reports_next,&mut control,&mut ledger_next)?)?;
    if result["assigned"]==true{perceptions_next.refresh_owned(now as u32,&motion_next,&environment_next,ray,physics_next.as_ref())?;}
   }
  }
  for index in actions_next.pending_due(now as u32)?{actions_next.activate_planned_events(index as f64,tick,&mut motion_next,&environment_next,&resources_next,&tasks_next,&mut control,&mut ledger_next)?;}
  if matches!(control.state.dispatch_mode,Mode::Rule|Mode::Networked){let result=value(dispatch_next.automatic_events(tick,&mut motion_next,&environment_next,&mut tasks_next,&mut resources_next,&actions_next,&peer_next,&reports_next,&mut control,&mut ledger_next)?)?;
   if result["assigned"]==true{perceptions_next.refresh_owned(now as u32,&motion_next,&environment_next,ray,physics_next.as_ref())?;}
  }
  if let Some(p)=physics_next.as_mut(){control.advance_working_tasks_rapier(tick,&mut motion_next,&environment_next,&mut tasks_next,&mut actions_next,&mut resources_next,&peer_next,&reports_next,&perceptions_next,&dispatch_next,requests,&mut ledger_next,p)?;}else{control.advance_working_tasks(tick,&mut motion_next,&environment_next,&mut tasks_next,&mut actions_next,&mut resources_next,&peer_next,&reports_next,&perceptions_next,&dispatch_next,requests,&mut ledger_next)?;}
  if !ledger_next.done()?{if let Some(p)=physics_next.as_mut(){control.advance_accepted_actions_rapier(tick,&mut motion_next,&environment_next,&mut tasks_next,&mut actions_next,&mut resources_next,&peer_next,&reports_next,&perceptions_next,&dispatch_next,requests,&mut ledger_next,p)?;}else{control.advance_accepted_actions(tick,&mut motion_next,&environment_next,&mut tasks_next,&mut actions_next,&mut resources_next,&peer_next,&reports_next,&perceptions_next,&dispatch_next,requests,&mut ledger_next)?;}}
  if let Some(start)=risk_start{for event in environment_next.legacy_risk_events(&start,&motion_next)?{control.task_event(&mut ledger_next,event)?}}
  control.settle_world(tick,&mut motion_next,&environment_next,&tasks_next,&mut actions_next,&resources_next,&mut peer_next,&mut reports_next,&mut dispatch_next,&mut ledger_next)?;
  if !ledger_next.done()?&&matches!(control.state.dispatch_mode,Mode::NetworkedReported)&&reports_next.status_due(now)?{reports_next.schedule_events(tick,&motion_next,&environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&mut control,&mut ledger_next)?;}
  perceptions_next.refresh_owned(now as u32,&motion_next,&environment_next,ray,physics_next.as_ref())?;
  control.world_advance_tick=Some(now);control.validate_commit(&ledger_next)?;
  control.world_advance_context(&motion_next,&environment_next,&tasks_next,&actions_next,&resources_next,&peer_next,&reports_next,&perceptions_next,&dispatch_next,requests,&ledger_next,physics_next.as_ref())?;
  *self=control;*motion=motion_next;*environment=environment_next;*tasks=tasks_next;*actions=actions_next;*resources=resources_next;*peer=peer_next;*reports=reports_next;*perceptions=perceptions_next;*dispatch=dispatch_next;*ledger=ledger_next;if let(Some(target),Some(next))=(physics.as_deref_mut(),physics_next){*target=next}Ok(())
 }
}

#[napi]
impl WorldControl{
 #[napi]
 pub fn world_step_bound(&self)->Result<bool>{self.active()?;Ok(self.world_advance_binding.is_some())}
 #[napi]
 pub fn bind_world_step(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger)->Result<()>{self.bind_world_advance(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,None)}
 #[napi]
 pub fn bind_world_step_rapier(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:&PhysicsWorld)->Result<()>{self.bind_world_advance(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,Some(physics))}
 #[napi]
 pub fn advance_world_step(&mut self,expected:f64,motion:&mut WorldMotion,environment:&mut WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&mut WorldPeer,reports:&mut WorldReports,perceptions:&mut WorldPerceptions,dispatch:&mut WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger)->Result<()>{self.world_advance(expected,motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,None)}
 #[napi]
 pub fn advance_world_step_rapier(&mut self,expected:f64,motion:&mut WorldMotion,environment:&mut WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&mut WorldPeer,reports:&mut WorldReports,perceptions:&mut WorldPerceptions,dispatch:&mut WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger,physics:&mut PhysicsWorld)->Result<()>{self.world_advance(expected,motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,Some(physics))}
}
