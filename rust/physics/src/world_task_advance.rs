//! One ordered task-frame batch from bound native participants. Activity, task
//! starts, travel, work, collision recovery and terminal failures share a commit.
use super::*;
use crate::{PhysicsWorld,world_motion::WorldMotion,world_environment::WorldEnvironment,world_tasks::{WorldTasks,Task,Status as TaskStatus,Behavior,Phase},world_actions::WorldActions,world_resources::WorldResources,world_peer::WorldPeer,world_reports::WorldReports,world_perceptions::WorldPerceptions,world_dispatch::WorldDispatch,world_requests::WorldRequests,world_execution::Status};
use serde_json::json;

fn value(s:String)->Result<Value>{serde_json::from_str(&s).map_err(|_|invalid())}
fn same_box(c:&rapier3d::prelude::Collider,b:&Value,field:Option<&crate::heightfield::Heightfield>)->bool{
 let Some(shape)=c.shape().as_cuboid()else{return false};
 let data=["x","y","w","h","height"].map(|k|b[k].as_f64());
 let [Some(x),Some(y),Some(w),Some(h),Some(height)]=data else{return false};
 let expected=if let Some(hf)=field{let [base,top]=hf.bounds(crate::heightfield::Rect{x:x as f32 as f64,y:y as f32 as f64,w:w as f32 as f64,h:h as f32 as f64});let top=top+height as f32 as f64;[x as f32+w as f32/2.0,((base+top)/2.0)as f32,y as f32+h as f32/2.0,w as f32/2.0,((top-base)/2.0)as f32,h as f32/2.0]}else{[x as f32+w as f32/2.0,height as f32/2.0,y as f32+h as f32/2.0,w as f32/2.0,height as f32/2.0,h as f32/2.0]};
 let p=c.translation();let e=shape.half_extents;let actual=[p.x,p.y,p.z,e.x,e.y,e.z];
 c.rotation().angle()<1e-6&&actual.iter().zip(expected).all(|(a,b)|(*a-b).abs()<1e-5)
}
pub(super) fn validate_physics(physics:&PhysicsWorld,motion:&WorldMotion,environment:&WorldEnvironment)->Result<u64>{
 if physics.closed{return Err(invalid())}
 let actors=motion.lifecycle_agents()?;let map=value(environment.snapshot()?)?;
 let field=environment.heightfield()?;if physics.heightfield.as_ref()!=field{return Err(invalid())}
 let domain=environment.surface_domain()?;if physics.surface_domain.as_ref()!=domain{return Err(invalid())}
 let mut expected_domains=0;
 if let Some(profile)=domain{for water_forbidden in [false,true]{
  let expected=profile.partition(!water_forbidden).into_iter().chain(crate::surface_domain::world_bounds()).collect::<Vec<_>>();expected_domains+=expected.len();
  let actual=physics.domain_colliders.iter().filter(|(_,kind)|**kind==water_forbidden).map(|(h,_)|physics.colliders.get(*h).ok_or_else(invalid)).collect::<Result<Vec<_>>>()?;
  if actual.len()!=expected.len(){return Err(invalid())}let mut used=vec![false;actual.len()];
  for r in expected{let found=actual.iter().enumerate().position(|(i,c)|!used[i]&&c.shape().as_cuboid().is_some_and(|shape|{let p=c.translation();let e=shape.half_extents;let x=[p.x,p.y,p.z,e.x,e.y,e.z];let y=[(r.x+r.w/2.0)as f32,1.0,(r.y+r.h/2.0)as f32,r.w as f32/2.0,2.0,r.h as f32/2.0];c.rotation().angle()<1e-6&&x.iter().zip(y).all(|(a,b)|(*a-b).abs()<1e-5)})).ok_or_else(invalid)?;used[found]=true;}
 }}
 if physics.domain_colliders.len()!=expected_domains{return Err(invalid())}

 if let Some(h)=field{let handle=physics.terrain_handle.ok_or_else(invalid)?;let shape=physics.colliders.get(handle).and_then(|c|c.shape().as_trimesh()).ok_or_else(invalid)?;let(v,i)=h.mesh();if shape.indices()!=i.as_slice()||shape.vertices().iter().map(|p|[p.x,p.y,p.z]).ne(v){return Err(invalid())}}else if physics.terrain_handle.is_some(){return Err(invalid())}
 let fixed=map["obstacles"].as_array().ok_or_else(invalid)?;let roads=map["roadblocks"].as_array().cloned().unwrap_or_default();
 if physics.agents.len()!=actors.len()||physics.roadblocks.len()!=roads.len()||physics.colliders.len()!=actors.len()+fixed.len()+roads.len()+expected_domains+usize::from(field.is_some()){return Err(invalid())}
 for(_,a,e)in actors{
  let h=physics.agents.get(&a.id).ok_or_else(invalid)?;let c=physics.colliders.get(*h).ok_or_else(invalid)?;
  let air=e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air");if physics.air.contains(&a.id)!=air||physics.water.contains(&a.id)!=(e.mobility.as_deref()==Some("water")){return Err(invalid())}if let Some(p)=domain{if !p.body_free(if air{"air"}else if e.mobility.as_deref()==Some("water"){"water"}else{"ground"},[a.x,a.y],0.8)?{return Err(invalid())}}let p=c.translation();
  if c.shape().as_ball().is_none_or(|b|(b.radius-0.8).abs()>1e-6)||(p.x as f64-a.x).hypot(p.z as f64-a.y)>0.001||(p.y-if air{16.0}else{field.map_or(1.0,|h|h.proxy_height(a.x,a.y)as f32)}).abs()>0.001{return Err(invalid())}
 }
 for r in &roads{let id=r["id"].as_str().ok_or_else(invalid)?;let h=physics.roadblocks.get(id).ok_or_else(invalid)?;if !same_box(physics.colliders.get(*h).ok_or_else(invalid)?,r,field){return Err(invalid())}}
 let static_colliders:Vec<_>=physics.colliders.iter().filter(|(h,_)|Some(*h)!=physics.terrain_handle&&!physics.domain_colliders.contains_key(h)&&!physics.agents.values().any(|a|a==h)&&!physics.roadblocks.values().any(|r|r==h)).map(|(_,c)|c).collect();
 let mut used=vec![false;static_colliders.len()];for b in fixed{let index=static_colliders.iter().enumerate().position(|(i,c)|!used[i]&&same_box(c,b,field)).ok_or_else(invalid)?;used[index]=true}
 Ok(physics.checkpoint_id)
}

impl WorldControl{
 pub(super) fn task_advance_context(&self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:Option<&PhysicsWorld>)->Result<[u64;12]>{
  let base=self.coordinator_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger)?;
  if self.coordinator_binding!=Some(base)||matches!(self.state.physics_mode,Physics::Rapier)!=physics.is_some(){return Err(invalid())}
  let mut binding=[0;12];binding[..11].copy_from_slice(&base);binding[11]=physics.map(|p|validate_physics(p,motion,environment)).transpose()?.unwrap_or(0);Ok(binding)
 }
 fn bind_task_advance(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:Option<&PhysicsWorld>)->Result<()>{
  let binding=self.task_advance_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,physics)?;
  if self.task_advance_binding.is_some_and(|old|old!=binding){return Err(invalid())}self.task_advance_binding=Some(binding);Ok(())
 }
 fn task_route_failure(&mut self,task:&Task,blocked:bool,now:u32,motion:&mut WorldMotion,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,ledger:&mut WorldLedger)->Result<()>{
  let actor=task.assignee.as_deref().ok_or_else(invalid)?;let(index,a,mut e,_)=motion.activation_components(actor)?;let reason=if blocked{"collision_blocked"}else{"energy_depleted"};
  if let Some(i)=actions.fail_work(&task.id,actor,now,reason)?{self.task_event(ledger,WorldTasks::action_event(actions,i,&e.name,"failed",Some(reason))?)?}
  let released=value(resources.command(json!({"kind":"abort","taskId":task.id,"agentId":actor,"assignmentId":task.assignment_id,"position":[a.x,a.y]}).to_string(),now as f64)?)?;
  if released["dropped"]==true{self.task_event(ledger,json!({"message":"运输中断，备件留在当前位置","type":"warning","kind":"part_dropped","agentId":actor,"taskId":task.id}))?}
  if released["released"]==true{tasks.command(json!({"kind":"phase","taskId":task.id,"assignmentId":task.assignment_id,"phase":null}).to_string())?}
  e.route.clear();e.status=if blocked{Status::Idle}else{Status::Fault};if !blocked{e.disabled=true;e.work=0}let name=e.name.clone();motion.commit_stationary(index,a,e)?;
  tasks.command(json!({"kind":"requeue","taskId":task.id,"assignmentId":task.assignment_id,"clearPhase":false}).to_string())?;
  if blocked{ledger.finish(true)?;self.task_event(ledger,json!({"message":"设备持续受阻，实验终止","type":"warning","kind":"run_failed","reason":"collision_blocked","agentId":actor,"taskId":task.id}))?}
  else{self.task_event(ledger,json!({"message":format!("{name} 电量耗尽，任务重新分配"),"type":"warning","kind":"energy_depleted","agentId":actor,"taskId":task.id}))?}Ok(())
 }
 fn task_advance(&mut self,expected:f64,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger,mut physics:Option<&mut PhysicsWorld>)->Result<()>{
  let binding=self.task_advance_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,physics.as_deref())?;
  let now=self.linked(ledger)?;if now==0||expected!=now as f64||self.task_advance_binding!=Some(binding)||self.task_advance_tick.is_some_and(|t|t>=now)||ledger.done()?{return Err(invalid())}
  let mut next_control=self.clone();let mut next_motion=motion.clone();let mut next_tasks=tasks.clone();let mut next_actions=actions.clone();let mut next_resources=resources.clone();let mut next_ledger=ledger.clone();let mut next_physics=physics.as_ref().map(|p|(**p).clone());
  for(index,a,mut e)in next_motion.lifecycle_agents()?{let waiting=next_actions.waiting_charge(&a.id)?;e.sample_task_frame(waiting)?;next_motion.commit_stationary(index,a,e)?}
  let active:Vec<_>=next_tasks.ending_tasks()?.0.into_iter().filter(|t|t.status==TaskStatus::Active).map(|t|t.id).collect();
  for id in active{
   let t=next_tasks.ending_tasks()?.0.into_iter().find(|t|t.id==id).ok_or_else(invalid)?;let actor=t.assignee.as_deref().ok_or_else(invalid)?;
   let(index,a,mut e,_)=next_motion.activation_components(actor)?;if e.status!=Status::Working||e.lifecycle_waiting(){continue}
   next_tasks.start_events(id.clone(),expected,&next_motion,environment,&next_resources,&next_actions,&mut next_control,&mut next_ledger)?;
   if next_physics.is_some(){
    let resource=value(next_resources.snapshot()?)?;let reach=if t.behavior==Behavior::Repair{Some(t.target)}else if t.behavior==Behavior::Deliver&&t.phase.flatten()==Some(Phase::ToPickup)&&resource["part"]["location"]=="ground"{Some(serde_json::from_value(resource["part"]["position"].clone()).map_err(|_|invalid())?)}else if t.behavior==Behavior::Deliver&&t.phase.flatten()==Some(Phase::ToSite){Some(t.target)}else{None};
    if reach.map(|goal|environment.activation_reachable([a.x,a.y],goal,false)).transpose()?.unwrap_or(false){e.route.clear();next_motion.commit_stationary(index,a,e)?}
   }
   let(_,_,e,_)=next_motion.activation_components(actor)?;
   if !e.route.is_empty(){if let Some(p)=next_physics.as_mut(){next_motion.advance_route_events_rapier(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger,p)?;}else{next_motion.advance_route_events(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger)?;}}
   else{next_tasks.advance_work_events(id.clone(),json!({"tick":now}).to_string(),&mut next_motion,environment,&mut next_resources,&mut next_actions,&mut next_control,&mut next_ledger)?;}
   let(_,a,e,_)=next_motion.activation_components(actor)?;
   if e.blocked_ticks==Some(10)&&e.collision_replans.unwrap_or(0)<3&&!e.route.is_empty(){next_motion.replan_collision_events(index as f64,expected,environment,&next_resources,&next_tasks,&next_actions,&mut next_control,&mut next_ledger)?;}
   let current=next_tasks.ending_tasks()?.0.into_iter().find(|t|t.id==id).ok_or_else(invalid)?;let(_,_,e,_)=next_motion.activation_components(actor)?;
   if e.blocked_ticks.unwrap_or(0)>=60&&current.status==TaskStatus::Active{next_control.task_route_failure(&current,true,now as u32,&mut next_motion,&mut next_tasks,&mut next_actions,&mut next_resources,&mut next_ledger)?;break}
   if next_ledger.done()?{break}
   if a.battery<=0.0&&current.status==TaskStatus::Active{next_control.task_route_failure(&current,false,now as u32,&mut next_motion,&mut next_tasks,&mut next_actions,&mut next_resources,&mut next_ledger)?;}
  }
  next_control.task_advance_tick=Some(now);next_control.validate_commit(&next_ledger)?;
  next_control.task_advance_context(&next_motion,environment,&next_tasks,&next_actions,&next_resources,peer,reports,perceptions,dispatch,requests,&next_ledger,next_physics.as_ref())?;
  *self=next_control;*motion=next_motion;*tasks=next_tasks;*actions=next_actions;*resources=next_resources;*ledger=next_ledger;if let(Some(target),Some(next))=(physics.as_deref_mut(),next_physics){*target=next}Ok(())
 }
}

#[napi]
impl WorldControl{
 #[napi]
 pub fn working_tasks_bound(&self)->Result<bool>{self.active()?;Ok(self.task_advance_binding.is_some())}
 #[napi]
 pub fn bind_working_tasks(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger)->Result<()>{self.bind_task_advance(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,None)}
 #[napi]
 pub fn bind_working_tasks_rapier(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger,physics:&PhysicsWorld)->Result<()>{self.bind_task_advance(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,Some(physics))}
 #[napi]
 pub fn advance_working_tasks(&mut self,expected:f64,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger)->Result<()>{self.task_advance(expected,motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,None)}
 #[napi]
 pub fn advance_working_tasks_rapier(&mut self,expected:f64,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&mut WorldLedger,physics:&mut PhysicsWorld)->Result<()>{self.task_advance(expected,motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger,Some(physics))}
}
