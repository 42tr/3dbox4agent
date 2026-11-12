//! Ordered accepted-action execution from the same bound native world as the
//! working-task batch. No host decisions, routes or sensing proofs enter here.
use super::*;
use crate::{PhysicsWorld,world_motion::WorldMotion,world_environment::WorldEnvironment,world_tasks::{WorldTasks,Status as TaskStatus},world_actions::{WorldActions,FrameKind},world_resources::WorldResources,world_peer::WorldPeer,world_reports::WorldReports,world_perceptions::WorldPerceptions,world_dispatch::WorldDispatch,world_requests::WorldRequests};

impl WorldControl{
 fn bind_action_advance(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:Option<&PhysicsWorld>)->Result<()>{
  let binding=self.task_advance_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,physics)?;
  if self.task_advance_binding!=Some(binding)||self.action_advance_binding.is_some_and(|old|old!=binding)||matches!(self.state.sensor_model,Some(Sensor::Ray))&&physics.is_none(){return Err(invalid())}
  if self.action_advance_binding.is_none(){self.action_advance_tick=Some(self.linked(ledger)?)}self.action_advance_binding=Some(binding);Ok(())
 }
 fn action_advance(&mut self,expected:f64,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger,mut physics:Option<&mut PhysicsWorld>)->Result<()>{
  let binding=self.task_advance_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,physics.as_deref())?;
  let now=self.linked(ledger)?;if now==0||expected!=now as f64||self.action_advance_binding!=Some(binding)||self.task_advance_tick!=Some(now)||self.action_advance_tick.is_some_and(|t|t>=now)||ledger.done()?{return Err(invalid())}
  let mut next_control=self.clone();let mut next_motion=motion.clone();let mut next_tasks=tasks.clone();let mut next_actions=actions.clone();let mut next_resources=resources.clone();let mut next_ledger=ledger.clone();let mut next_physics=physics.as_ref().map(|p|(**p).clone());
  let ray=matches!(self.state.sensor_model,Some(Sensor::Ray));
  for row in next_actions.accepted_frame()?{
   let(index,a,mut e,_)=next_motion.activation_components(&row.agent)?;let action_index=row.index as f64;
   if e.disabled{next_actions.settle_travel_events(action_index,expected,&mut next_motion,environment,&mut next_resources,&mut next_tasks,&mut next_control,&mut next_ledger)?;continue}
   if e.lifecycle_waiting(){continue}
   match row.kind{
    FrameKind::Task=>continue,
    FrameKind::Charge{travel}=>{
     if travel{
      let station=environment.activation_station()?;
      if next_physics.is_some()&&crate::world_perceptions::sensor_distance(a.x-station[0],a.y-station[1])<=3.0&&environment.activation_reachable([a.x,a.y],station,false)?{e.route.clear();next_motion.commit_stationary(index,a,e)?}
      let(_,_,e,_)=next_motion.activation_components(&row.agent)?;
      if !e.route.is_empty(){if let Some(p)=next_physics.as_mut(){next_motion.advance_route_events_rapier(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger,p)?;}else{next_motion.advance_route_events(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger)?;}}
      let(_,a,e,_)=next_motion.activation_components(&row.agent)?;
      if next_physics.is_some()&&a.battery>0.0&&e.blocked_ticks==Some(10)&&e.collision_replans.unwrap_or(0)<3&&!e.route.is_empty(){next_motion.replan_collision_events(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger)?;}
      next_actions.settle_travel_events(action_index,expected,&mut next_motion,environment,&mut next_resources,&mut next_tasks,&mut next_control,&mut next_ledger)?;
     }
     if !matches!(next_actions.frame_action(row.index)?.map(|r|r.kind),Some(FrameKind::Charge{travel:false})){continue}
    },
    FrameKind::Scan|FrameKind::Rescue=>{},
    FrameKind::Move{target,resume}=>{
     let task=next_tasks.ending_tasks()?.0.into_iter().find(|t|t.status==TaskStatus::Active&&t.assignee.as_deref()==Some(row.agent.as_str())&&Some(t.id.as_str())==resume.as_deref());
     if let Some(task)=&task{
      let(_,goal)=next_resources.work_owner(task,&a,&e,now as u32)?;let air=e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air");
      if next_physics.is_some()&&target==goal&&environment.activation_reachable([a.x,a.y],goal,air)?{e.route.clear();next_motion.commit_stationary(index,a,e)?}
      next_tasks.start_events(task.id.clone(),expected,&next_motion,environment,&next_resources,&next_actions,&mut next_control,&mut next_ledger)?;
     }
     if let Some(p)=next_physics.as_mut(){next_motion.advance_route_events_rapier(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger,p)?;}else{next_motion.advance_route_events(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger)?;}
     let(_,_,e,_)=next_motion.activation_components(&row.agent)?;
     if task.is_some()&&e.blocked_ticks==Some(10)&&e.collision_replans.unwrap_or(0)<3&&!e.route.is_empty(){next_motion.replan_collision_events(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger)?;}
     next_actions.settle_travel_events(action_index,expected,&mut next_motion,environment,&mut next_resources,&mut next_tasks,&mut next_control,&mut next_ledger)?;continue
    },
   }
   if ray{next_actions.advance_stationary_events_ray(action_index,expected,&mut next_motion,environment,&next_resources,&next_tasks,&mut next_control,&mut next_ledger,next_physics.as_ref().ok_or_else(invalid)?)?;}else{next_actions.advance_stationary_events(action_index,expected,&mut next_motion,environment,&next_resources,&next_tasks,&mut next_control,&mut next_ledger)?;}
  }
  next_control.action_advance_tick=Some(now);next_control.validate_commit(&next_ledger)?;
  next_control.task_advance_context(&next_motion,environment,&next_tasks,&next_actions,&next_resources,peer,reports,perceptions,dispatch,requests,&next_ledger,next_physics.as_ref())?;
  *self=next_control;*motion=next_motion;*tasks=next_tasks;*actions=next_actions;*resources=next_resources;*ledger=next_ledger;if let(Some(target),Some(next))=(physics.as_deref_mut(),next_physics){*target=next}Ok(())
 }
}

#[napi]
impl WorldControl{
 #[napi]
 pub fn accepted_actions_bound(&self)->Result<bool>{self.active()?;Ok(self.action_advance_binding.is_some())}
 #[napi]
 pub fn bind_accepted_actions(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger)->Result<()>{self.bind_action_advance(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,None)}
 #[napi]
 pub fn bind_accepted_actions_rapier(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:&PhysicsWorld)->Result<()>{self.bind_action_advance(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,Some(physics))}
 #[napi]
 pub fn advance_accepted_actions(&mut self,expected:f64,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger)->Result<()>{self.action_advance(expected,motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,None)}
 #[napi]
 pub fn advance_accepted_actions_rapier(&mut self,expected:f64,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger,physics:&mut PhysicsWorld)->Result<()>{self.action_advance(expected,motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,Some(physics))}
}
