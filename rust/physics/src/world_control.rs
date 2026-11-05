//! Owned immutable world identity/options, event-derived counters and control state.
use crate::world_ledger::WorldLedger;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
#[path="world_observations.rs"]
mod observations;
#[path="world_coordinator_observations.rs"]
mod coordinator_observations;
#[path="world_task_advance.rs"]
mod task_advance;
#[path="world_action_advance.rs"]
mod action_advance;
#[path="world_advance.rs"]
mod world_advance;
#[path="world_power.rs"]
mod world_power;
const MAX_TICK:u64=10_000_000;
fn invalid()->Error{Error::from_reason("invalid world control input")}
fn token(s:&str)->bool{!s.is_empty()&&s.len()<=64&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
fn decode<T:for<'a> Deserialize<'a>>(s:&str)->Result<T>{if s.len()>2*1024*1024{return Err(invalid())}serde_json::from_str(s).map_err(|_|invalid())}
fn encode<T:Serialize>(s:&T)->Result<String>{serde_json::to_string(s).map_err(|_|invalid())}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Mode{Rule,Networked,External,NetworkedExternal,NetworkedReported}
#[derive(Clone,Copy,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Policy{Nearest,Battery}
#[derive(Clone,Copy,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Physics{Kinematic,Rapier}
#[derive(Clone,Copy,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Execution{Auto,Agent,Primitive}
#[derive(Clone,Copy,Deserialize,Serialize)]
enum Sensor{#[serde(rename="geometry-v1")]Geometry,#[serde(rename="rapier-ray-v1")]Ray}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Recovery{started_tick:u64,agent_ids:Vec<String>}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct State{
 version:u32,scene_id:String,seed:u32,policy:Policy,physics_mode:Physics,dispatch_mode:Mode,
 faults:u64,replans:u64,collision_contacts:u64,
 #[serde(skip_serializing_if="Option::is_none")]execution_mode:Option<Execution>,
 #[serde(skip_serializing_if="Option::is_none")]sensor_model:Option<Sensor>,
 #[serde(skip_serializing_if="Option::is_none")]peer_message_metrics_version:Option<u8>,
 #[serde(skip_serializing_if="Option::is_none")]boundary_monitoring_version:Option<u8>,
 #[serde(skip_serializing_if="Option::is_none")]footprint_monitoring_version:Option<u8>,
 #[serde(skip_serializing_if="Option::is_none")]risk_monitoring_version:Option<u8>,
 #[serde(skip_serializing_if="Option::is_none")]recovery_events_version:Option<u8>,
 #[serde(skip_serializing_if="Option::is_none")]terrain_route_assessments_version:Option<u8>,
 #[serde(skip_serializing_if="Option::is_none")]charge_recovery:Option<Recovery>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial{state:State,agents:Vec<String>,tasks:Vec<String>}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Agent{id:String,battery:f64,disabled:bool,idle:bool}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct RecoveryInput{agent_ids:Vec<String>,agents:Vec<Agent>}
#[napi]
pub struct WorldTimeTicket{
 owner:u64,identity:u64,tick:u32,binding:[u64;5],phase:u8,used:bool,road_routes:bool,terrain_routes:bool,plan:String,environment:String,peer:String,execution:Option<String>,
 control_before:Option<WorldControl>,ledger_before:Option<WorldLedger>,motion_before:Option<crate::world_motion::WorldMotion>,environment_before:Option<crate::world_environment::WorldEnvironment>,tasks_before:Option<crate::world_tasks::WorldTasks>,peer_before:Option<crate::world_peer::WorldPeer>,
}
#[napi]
impl WorldTimeTicket{
 #[napi]
 pub fn plan(&self)->Result<String>{if self.used{return Err(invalid())}Ok(self.plan.clone())}
 #[napi]
 pub fn free(&mut self){self.used=true;self.plan.clear();self.environment.clear();self.peer.clear();self.execution=None;self.control_before=None;self.ledger_before=None;self.motion_before=None;self.environment_before=None;self.tasks_before=None;self.peer_before=None;}
}
#[napi]
#[derive(Clone)]
pub struct WorldControl{
    checkpoint_id: u64,
 state:State,agents:Vec<String>,tasks:Vec<String>,ledger_id:u64,last_event:usize,tick:u64,
 faulted:HashSet<String>,pending_mode:Option<(Mode,Mode)>,pending_recovery:bool,time_binding:Option<[u64;5]>,pending_time:Option<u64>,ending_binding:Option<[u64;6]>,ending_tick:Option<u64>,finalization_binding:Option<[u64;9]>,observation_binding:Option<[u64;9]>,coordinator_binding:Option<[u64;11]>,task_advance_binding:Option<[u64;12]>,task_advance_tick:Option<u64>,action_advance_binding:Option<[u64;12]>,action_advance_tick:Option<u64>,world_advance_binding:Option<[u64;12]>,world_advance_tick:Option<u64>,closed:bool,
}
impl WorldControl{
 pub(crate) fn validate_initial_physics(physics:&crate::PhysicsWorld,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment)->Result<()>{task_advance::validate_physics(physics,motion,environment).map(|_|())}
 pub(crate) fn environment_context(&self,now:u64,agents:&[String],tasks:&[String],ledger:&WorldLedger,pending:bool)->Result<(u64,u64,bool,bool)>{
  self.active()?;if now>MAX_TICK||agents!=self.agents||tasks!=self.tasks||self.linked(ledger)?!=now||self.last_event!=ledger.entries()?.len()||self.pending_mode.is_some()||self.pending_recovery{return Err(invalid())}
  if pending{if self.pending_time.is_none(){return Err(invalid())}}else{self.validate_commit(ledger)?}
  Ok((self.checkpoint_id,self.ledger_id,ledger.done()?,self.state.terrain_route_assessments_version==Some(1)))
 }
 pub(crate) fn dispatch_policy(&self)->Result<&'static str>{self.active()?;Ok(match self.state.policy{Policy::Nearest=>"nearest",Policy::Battery=>"battery"})}
 pub(crate) fn dispatch_mode(&self)->Result<&'static str>{self.active()?;Ok(match self.state.dispatch_mode{Mode::Rule=>"rule",Mode::Networked=>"networked",Mode::External=>"external",Mode::NetworkedExternal=>"networked_external",Mode::NetworkedReported=>"networked_reported"})}
 pub(crate) fn peer_events_context(&self,now:u64,agents:&[String],seed:u32,ledger:&WorldLedger)->Result<(u64,u64,bool)>{
  if now>MAX_TICK||seed!=self.state.seed{return Err(invalid())}let(c,l,_,_,done)=self.assignment_context(now as u32,agents,ledger)?;Ok((c,l,done))
 }
 pub(crate) fn stationary_events_context(&self,expected:f64,agents:&[String],tasks:&[String],ledger:&WorldLedger)->Result<(u64,u64,&'static str,bool)>{if !expected.is_finite()||expected.fract()!=0.0||!(1.0..=10_000_000.0).contains(&expected){return Err(invalid())}let(c,l,_)=self.task_events_context(expected as u32,agents,tasks,ledger)?;let(_,_,_,mode,_)=self.lifecycle_context(expected as u32,agents.first().ok_or_else(invalid)?,ledger)?;Ok((c,l,mode,matches!(self.state.sensor_model,Some(Sensor::Ray))))}
 pub(crate) fn route_events_context(&self,expected:f64,agents:&[String],tasks:&[String],ledger:&WorldLedger)->Result<(u64,u64,&'static str,bool,bool,bool,bool)>{if !expected.is_finite()||expected.fract()!=0.0||!(1.0..=10_000_000.0).contains(&expected){return Err(invalid())}let(c,l,_)=self.task_events_context(expected as u32,agents,tasks,ledger)?;let(_,_,_,mode,_)=self.lifecycle_context(expected as u32,agents.first().ok_or_else(invalid)?,ledger)?;Ok((c,l,mode,self.state.boundary_monitoring_version==Some(1),self.state.footprint_monitoring_version==Some(1),self.state.risk_monitoring_version==Some(2),matches!(self.state.physics_mode,Physics::Rapier)))}
 pub(crate) fn task_events_context(&self,now:u32,agents:&[String],tasks:&[String],ledger:&WorldLedger)->Result<(u64,u64,bool)>{let(c,l,done,_)=self.proposal_context(now,agents,tasks,ledger)?;if done{return Err(invalid())}Ok((c,l,self.state.recovery_events_version==Some(1)))}
 pub(crate) fn task_event(&mut self,ledger:&mut WorldLedger,event:Value)->Result<()>{self.time_event(ledger,event)}
 fn settle_tick_inner(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,ledger:&mut WorldLedger)->Result<String>{
  self.validate_commit(ledger)?;let now=self.linked(ledger)?;if now==0||expected!=now as f64||self.ending_tick.is_some_and(|tick|tick>=now){return Err(invalid())}
  let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();if ids!=self.agents{return Err(invalid())}
  let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(e,_)=environment.time_context(now,&ids)?;let(t,_)=tasks.revocation_context("",&actors,&self.tasks)?;let(a,busy_actions)=actions.ending_context(now as u32,&ids)?;let(all,ready)=tasks.ending_tasks()?;
  let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,_)=resources.proposal_catalog(now,&all,&roster)?;let(_,resource)=resources.assignment_context(None,now as u32)?;let binding=[m,e,t,a,r,ledger.identity()?];if self.ending_binding.is_some_and(|b|b!=binding){return Err(invalid())}
  let mut recovery=Vec::new();let mut outcome=if ledger.done()?{"already_done"}else if all.iter().all(|t|t.status==crate::world_tasks::Status::Done){"completed"}else if busy_actions||all.iter().any(|t|t.status==crate::world_tasks::Status::Active){"continue"}else{"failed"};
  if outcome=="failed"{
   'candidate:for task in &ready{if Self::ending_precondition(task,&resource).is_some(){continue}for(_,agent,execution)in &actors{if execution.disabled||execution.status!=crate::world_execution::Status::Idle||agent.battery<=5.0||(!execution.capabilities.contains(&task.capability)||task.behavior==crate::world_tasks::Behavior::Deploy&&execution.deployable_relay!=Some(true)){continue}if Self::ending_task_route(task,agent,environment,&resource)?{outcome="continue";break 'candidate}}}
   if outcome=="failed"{for(_,agent,execution)in &actors{if execution.disabled||execution.status!=crate::world_execution::Status::Idle||agent.battery<=0.0||agent.battery>5.0{continue}let mut capable=false;for task in &ready{if Self::ending_precondition(task,&resource).is_none()&&execution.capabilities.contains(&task.capability)&&(task.behavior!=crate::world_tasks::Behavior::Deploy||execution.deployable_relay==Some(true))&&Self::ending_task_route(task,agent,environment,&resource)?{capable=true;break}}if capable&&environment.ending_recoverable(&agent.id,[agent.x,agent.y],agent.battery,execution.move_energy_per_unit.unwrap_or(0.045),execution.speed,execution.operating_energy_per_tick)?{recovery.push(agent.id.clone())}}
    if !recovery.is_empty(){outcome="wait_charge"}else if environment.activation_roadblock()?.is_some(){outcome="wait_roadblock"}
   }
  }
  if outcome=="failed"{
   'rescue:for(_,target,execution)in &actors{
    if execution.recoverable_fault!=Some(true)||!execution.disabled||target.battery<=5.0||crate::rescue::fault_seq(ledger.entries()?,&target.id).is_none(){continue}
    let mut useful=false;for task in &ready{if Self::ending_precondition(task,&resource).is_none()&&execution.capabilities.contains(&task.capability)&&(task.behavior!=crate::world_tasks::Behavior::Deploy||execution.deployable_relay==Some(true))&&Self::ending_task_route(task,target,environment,&resource)?{useful=true;break}}if !useful{continue}
    for(_,helper,tools)in &actors{let Some(p)=&tools.rescue else{continue};if tools.disabled||tools.status!=crate::world_execution::Status::Idle||helper.battery<=5.0||helper.id==target.id{continue}if environment.ending_rescue_approach(&helper.id,[helper.x,helper.y],[target.x,target.y],helper.battery,tools.move_energy_per_unit.unwrap_or(0.045),p.work_ticks as f64*(tools.work_energy_per_tick.unwrap_or(0.08)+tools.operating_energy_per_tick.unwrap_or(0.0)),tools.speed,tools.operating_energy_per_tick)?{outcome="continue";break 'rescue}}
   }
  }
  let next=self;let mut next_ledger=ledger;
  match outcome{
   "completed"=>{next_ledger.finish(false)?;next.time_event(&mut next_ledger,serde_json::json!({"message":"任务链完成，实验结束","type":"success","kind":"run_completed"}))?;},
   "failed"=>{next_ledger.finish(true)?;let mut event=serde_json::json!({"message":"没有可执行的任务或可用设备，任务链无法继续","type":"warning","kind":"run_failed"});if let Some(task)=ready.first(){event["taskId"]=task.id.clone().into();if let Some(reason)=Self::ending_precondition(task,&resource){event["reason"]=reason.into()}}next.time_event(&mut next_ledger,event)?;},
   "wait_charge"=>{let started=next.state.charge_recovery.is_none();let start=next.state.charge_recovery.as_ref().map_or(now,|r|r.started_tick);next.state.charge_recovery=Some(Recovery{started_tick:start,agent_ids:recovery.clone()});next.tick=now;if started{next.pending_recovery=true;next.time_event(&mut next_ledger,serde_json::json!({"message":"等待低电量设备提交补能动作","type":"warning","kind":"charge_recovery_wait_started","agentIds":recovery}))?;}},
   _=>{}
  }
  if outcome!="wait_charge"{if let Some(r)=&next.state.charge_recovery{let started=r.started_tick;next.time_event(&mut next_ledger,serde_json::json!({"message":"退出补能等待","type":"info","kind":"charge_recovery_wait_ended","startedTick":started}))?;}}
  next.ending_binding=Some(binding);next.ending_tick=Some(now);next.validate_commit(&next_ledger)?;Ok(outcome.to_owned())
 }
 pub(crate) fn ending_precondition(task:&crate::world_tasks::Task,resources:&Value)->Option<&'static str>{
  use crate::world_tasks::Behavior as B;let part=&resources["state"]["part"];let asset=&resources["state"]["asset"];
  let reason=match task.behavior{B::Deliver if !matches!(part["location"].as_str(),Some("warehouse"|"ground"))||!part["reservedBy"].is_null()=>Some("part_unavailable"),B::Repair if asset["diagnosis"]!="confirmed"=>Some("anomaly_unconfirmed"),B::Repair if part["location"]!="site"||!part["reservedBy"].is_null()=>Some("part_unavailable"),B::Verify if asset["condition"]!="repaired"=>Some("repair_required"),_=>None};if reason.is_some(){return reason}
  if task.material_cost.as_ref().is_some_and(|cost|resources["state"].get("materials").and_then(|v|serde_json::from_value::<crate::materials::State>(v.clone()).ok()).is_none_or(|m|!m.available(cost))){return Some("materials_unavailable")}None
 }
 fn ending_task_route(task:&crate::world_tasks::Task,agent:&crate::world_motion::Motion,environment:&crate::world_environment::WorldEnvironment,resources:&Value)->Result<bool>{
  let start=[agent.x,agent.y];if task.behavior==crate::world_tasks::Behavior::Deliver{let position=resources["state"]["part"]["position"].clone();if position.is_null(){return Ok(false)}let from:[f64;2]=serde_json::from_value(position).map_err(|_|invalid())?;let Some(first)=environment.ending_route(&agent.id,start,from,false)?else{return Ok(false)};return Ok(environment.ending_route(&agent.id,if environment.surface_domain()?.is_some(){*first.last().ok_or_else(invalid)?}else{from},task.target,false)?.is_some())}Ok(environment.ending_route(&agent.id,start,task.target,false)?.is_some())
 }
 fn time_event(&mut self,ledger:&mut WorldLedger,event:Value)->Result<()>{let row:Value=decode(&ledger.append(encode(&event)?)?)?;self.observe(row["seq"].as_f64().ok_or_else(invalid)?,ledger)}
 fn time_binding_for(&self,tick:u64,step:u64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,peer:&crate::world_peer::WorldPeer,ledger:&WorldLedger)->Result<[u64;5]>{
  let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();if ids!=self.agents{return Err(invalid())}
  let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(e,_)=environment.time_context(tick,&ids)?;let(t,_)=tasks.revocation_context("",&actors,&self.tasks)?;let(p,_)=peer.time_context(tick,step,&ids)?;let l=ledger.identity()?;if l!=self.ledger_id{return Err(invalid())}Ok([m,e,t,p,l])
 }
 fn time_phase(&self,ticket:&WorldTimeTicket,phase:u8,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,peer:&crate::world_peer::WorldPeer,ledger:&WorldLedger)->Result<()>{
  self.active()?;if ticket.used||ticket.owner!=self.checkpoint_id||ticket.phase!=phase||self.pending_time!=Some(ticket.identity)||self.time_binding!=Some(ticket.binding)||self.linked(ledger)?!=ticket.tick as u64||self.last_event!=ledger.entries()?.len()||self.pending_mode.is_some()||self.pending_recovery{return Err(invalid())}
  let binding=self.time_binding_for(ticket.tick as u64,ticket.tick as u64-1,motion,environment,tasks,peer,ledger)?;if binding!=ticket.binding{return Err(invalid())}
  if self.snapshot()?!=ticket.control_before.as_ref().ok_or_else(invalid)?.snapshot()?||tasks.snapshot()?!=ticket.tasks_before.as_ref().ok_or_else(invalid)?.snapshot()?||motion.snapshot()?!=ticket.motion_before.as_ref().ok_or_else(invalid)?.snapshot()?||environment.snapshot()?!=ticket.environment||peer.snapshot()?!=ticket.peer||phase==2&&ticket.execution.as_ref()!=Some(&motion.snapshot_execution()?){return Err(invalid())}Ok(())
 }
 pub(crate) fn proposal_context(&self,now:u32,agents:&[String],tasks:&[String],ledger:&WorldLedger)->Result<(u64,u64,bool,bool)>{
  if self.tasks!=tasks{return Err(invalid())}self.revocation_context(now,agents,ledger)
 }
 pub(crate) fn revocation_context(&self,now:u32,agents:&[String],ledger:&WorldLedger)->Result<(u64,u64,bool,bool)>{
  let(c,l,_,_,done)=self.assignment_context(now,agents,ledger)?;Ok((c,l,done,matches!(self.state.dispatch_mode,Mode::External|Mode::NetworkedExternal|Mode::NetworkedReported)))
 }
 pub(crate) fn interruption_components(&self,tasks:u64,binding:[u64;6])->Result<()>{
  self.active()?;if binding[4]!=self.checkpoint_id||binding[5]!=self.ledger_id{return Err(invalid())}
  if self.observation_binding.is_some_and(|b|b[2]!=tasks||[b[0],b[1],b[4],b[3],self.checkpoint_id,b[8]]!=binding){return Err(invalid())}
  if self.time_binding.is_some_and(|b|b[0]!=binding[0]||b[1]!=binding[1]||b[2]!=tasks||b[4]!=binding[5]){return Err(invalid())}
  if self.ending_binding.is_some_and(|b|b!=[binding[0],binding[1],tasks,binding[3],binding[2],binding[5]]){return Err(invalid())}Ok(())
 }
 pub(crate) fn assignment_context(&self,now:u32,agents:&[String],ledger:&WorldLedger)->Result<(u64,u64,usize,&'static str,bool)>{
  if agents!=self.agents.as_slice(){return Err(invalid())}self.lifecycle_context(now,agents.first().ok_or_else(invalid)?,ledger)
 }
 pub(crate) fn activation_context(&self,now:u32,agent:&str,ledger:&WorldLedger)->Result<(u64,u64,usize,&'static str)>{
  let(control,owner,prefix,mode,done)=self.lifecycle_context(now,agent,ledger)?;if done{return Err(invalid())}Ok((control,owner,prefix,mode))
 }
 pub(crate) fn lifecycle_context(&self,now:u32,agent:&str,ledger:&WorldLedger)->Result<(u64,u64,usize,&'static str,bool)>{
  self.validate_commit(ledger)?;if self.linked(ledger)?!=now as u64||!self.agents.iter().any(|id|id==agent){return Err(invalid())}
  let mode=match self.state.execution_mode.unwrap_or(Execution::Auto){Execution::Auto=>"auto",Execution::Agent=>"agent",Execution::Primitive=>"primitive"};
  Ok((self.checkpoint_id,self.ledger_id,self.last_event,mode,ledger.done()?))
 }
 fn active(&self)->Result<()>{if self.closed{Err(Error::from_reason("world control is closed"))}else{Ok(())}}
 fn linked(&self,ledger:&WorldLedger)->Result<u64>{self.active()?;let tick=ledger.tick()? as u64;if ledger.identity()?!=self.ledger_id||tick<self.tick||tick>MAX_TICK{return Err(invalid())}Ok(tick)}
 fn ordered_agents(&self,ids:&[String])->bool{
  let mut previous=None;for id in ids{let Some(index)=self.agents.iter().position(|a|a==id)else{return false};if previous.is_some_and(|p|p>=index){return false}previous=Some(index)}!ids.is_empty()
 }
 fn reference(&self,event:&Value,key:&str,ids:&[String])->Result<String>{let id=event.get(key).and_then(Value::as_str).ok_or_else(invalid)?;if !ids.iter().any(|s|s==id){return Err(invalid())}Ok(id.to_owned())}
 fn mode(value:Option<&Value>)->Result<Mode>{serde_json::from_value(value.cloned().ok_or_else(invalid)?).map_err(|_|invalid())}
 fn apply(&mut self,event:&Value,replay:bool)->Result<()>{
  let tick=event.get("tick").and_then(Value::as_u64).ok_or_else(invalid)?;let kind=event.get("kind").and_then(Value::as_str).unwrap_or("");
  if !replay&&(self.pending_mode.is_some()&&kind!="dispatch_mode_changed"||self.pending_recovery&&kind!="charge_recovery_wait_started"){return Err(invalid())}
  match kind{
   "device_fault"=>{let a=self.reference(event,"agentId",&self.agents)?;let task=event.get("taskId").is_some();if task{self.reference(event,"taskId",&self.tasks)?;}else if event.get("targeted").and_then(Value::as_bool)!=Some(true){return Err(invalid())}if event.get("targeted").is_some_and(|v|v.as_bool()!=Some(true)){return Err(invalid())}if !self.faulted.insert(a){return Err(invalid())}self.state.faults+=1;if task{self.state.replans+=1;}},
   "rescue_completed"=>{let a=self.reference(event,"targetAgentId",&self.agents)?;if !self.faulted.remove(&a){return Err(invalid())}},
   "collision_contact"=>{self.reference(event,"agentId",&self.agents)?;self.state.collision_contacts+=1;},
   "low_energy_replan"|"task_revoked"=>{self.reference(event,"agentId",&self.agents)?;self.reference(event,"taskId",&self.tasks)?;self.state.replans+=1;},
   "energy_depleted"=>{self.reference(event,"agentId",&self.agents)?;if event.get("taskId").is_some(){self.reference(event,"taskId",&self.tasks)?;self.state.replans+=1;}},
   "dispatch_mode_changed"=>{let previous=Self::mode(event.get("previous"))?;let mode=Self::mode(event.get("mode"))?;if previous==mode{return Err(invalid())}if replay{if self.state.dispatch_mode!=previous{return Err(invalid())}self.state.dispatch_mode=mode;}else{if self.pending_mode!=Some((previous,mode))||self.state.dispatch_mode!=mode{return Err(invalid())}self.pending_mode=None;}},
   "charge_recovery_wait_started"=>{let ids:Vec<String>=serde_json::from_value(event.get("agentIds").cloned().ok_or_else(invalid)?).map_err(|_|invalid())?;if !self.ordered_agents(&ids){return Err(invalid())}if replay{if self.state.charge_recovery.is_some(){return Err(invalid())}self.state.charge_recovery=Some(Recovery{started_tick:tick,agent_ids:ids});}else{let r=self.state.charge_recovery.as_ref().ok_or_else(invalid)?;if !self.pending_recovery||r.started_tick!=tick||r.agent_ids!=ids{return Err(invalid())}self.pending_recovery=false;}},
   "charge_recovery_wait_ended"=>{let r=self.state.charge_recovery.as_ref().ok_or_else(invalid)?;if event.get("startedTick").and_then(Value::as_u64)!=Some(r.started_tick){return Err(invalid())}self.state.charge_recovery=None;},
   _=>{}
  }Ok(())
 }
}
#[napi]
impl WorldControl{
 #[napi(constructor)]
 pub fn new(input:String,ledger:&WorldLedger)->Result<Self>{
  let i:Initial=decode(&input)?;let s=&i.state;let tick=ledger.tick()? as u64;
  if s.version!=9||!token(&s.scene_id)||i.agents.is_empty()||i.agents.len()>50||i.tasks.is_empty()||i.tasks.len()>100||i.agents.iter().any(|id|!token(id))||i.tasks.iter().any(|id|!token(id))||i.agents.iter().collect::<HashSet<_>>().len()!=i.agents.len()||i.tasks.iter().collect::<HashSet<_>>().len()!=i.tasks.len()||[s.peer_message_metrics_version,s.boundary_monitoring_version,s.footprint_monitoring_version,s.recovery_events_version,s.terrain_route_assessments_version].into_iter().flatten().any(|v|v!=1)||s.risk_monitoring_version.is_some_and(|v|v!=1&&v!=2){return Err(invalid())}
  let expected=(s.faults,s.replans,s.collision_contacts,s.dispatch_mode,s.charge_recovery.clone());let mut state=i.state;state.faults=0;state.replans=0;state.collision_contacts=0;state.charge_recovery=None;
  let entries=ledger.entries()?;if let Some(first)=entries.iter().find(|e|e.get("kind").and_then(Value::as_str)==Some("dispatch_mode_changed")){state.dispatch_mode=Self::mode(first.get("previous"))?;}
  let mut w=Self{ checkpoint_id: crate::world_checkpoint::identity(),state,agents:i.agents,tasks:i.tasks,ledger_id:ledger.identity()?,last_event:entries.len(),tick,faulted:HashSet::new(),pending_mode:None,pending_recovery:false,time_binding:None,pending_time:None,ending_binding:None,ending_tick:None,finalization_binding:None,observation_binding:None,coordinator_binding:None,task_advance_binding:None,task_advance_tick:None,action_advance_binding:None,action_advance_tick:None,world_advance_binding:None,world_advance_tick:None,closed:false};
  for e in entries{w.apply(e,true)?;}
  if (w.state.faults,w.state.replans,w.state.collision_contacts,w.state.dispatch_mode)!=(expected.0,expected.1,expected.2,expected.3){return Err(invalid())}
  match (&w.state.charge_recovery,&expected.4){
   (None,None)=>{},(Some(proof),Some(current))=>{if ledger.done()?||proof.started_tick!=current.started_tick||current.started_tick>tick||!w.ordered_agents(&current.agent_ids){return Err(invalid())}},_=>return Err(invalid())
  }
  w.state.charge_recovery=expected.4;Ok(w)
 }
 #[napi]
 pub fn snapshot(&self)->Result<String>{self.active()?;encode(&self.state)}
 #[napi]
 pub fn settle_tick(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,ledger:&mut WorldLedger)->Result<String>{
  let mut next=self.clone();let mut next_ledger=ledger.clone();let outcome=next.settle_tick_inner(expected,motion,environment,tasks,actions,resources,&mut next_ledger)?;*self=next;*ledger=next_ledger;Ok(outcome)
 }
 #[napi]
 pub fn settle_world(&mut self,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&mut crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&mut crate::world_peer::WorldPeer,reports:&mut crate::world_reports::WorldReports,dispatch:&mut crate::world_dispatch::WorldDispatch,ledger:&mut WorldLedger)->Result<String>{
  // All writes, including the result flags/event, remain on native copies until
  // the last channel and last associated event have validated successfully.
  let mut next=self.clone();let mut next_ledger=ledger.clone();let mut next_motion=motion.clone();
  if !expected.is_finite()||expected.fract()!=0.0||expected<0.0||expected>MAX_TICK as f64||expected!=next.linked(&next_ledger)? as f64{return Err(invalid())}
  for event in next_motion.finish_thermal_events(expected as u32)?{next.time_event(&mut next_ledger,event)?}
  let outcome=next.settle_tick_inner(expected,&next_motion,environment,tasks,actions,resources,&mut next_ledger)?;let now=next.linked(&next_ledger)?;
  let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(all,_)=tasks.ending_tasks()?;let(_,site)=resources.proposal_catalog(now,&all,&roster)?;
  let p=peer.finalization_context(now,&ids,next.state.seed)?;let r=reports.finalization_context(now,&roster,site,next.state.seed,&next_ledger)?;let d=dispatch.proposal_catalog(now,&next.tasks,&ids)?;let b=next.ending_binding.ok_or_else(invalid)?;let binding=[b[0],b[1],b[2],b[3],b[4],p,r,d,b[5]];
  if self.finalization_binding.is_some_and(|before|before!=binding)||self.time_binding.is_some_and(|time|time!=[b[0],b[1],b[2],p,b[5]]){return Err(invalid())}next.finalization_binding=Some(binding);
  if !next_ledger.done()?{*motion=next_motion;*self=next;*ledger=next_ledger;return Ok(outcome)}
  let mut next_actions=actions.clone();let mut next_peer=peer.clone();let mut next_reports=reports.clone();let mut next_dispatch=dispatch.clone();
  let fixed:Value=decode(&next_reports.cancel("fixed".into(),false,now as f64)?)?;for effect in fixed.as_array().ok_or_else(invalid)?{let p=&effect["report"];next.time_event(&mut next_ledger,serde_json::json!({"message":"固定传感器报告未送达（实验结束）","type":"warning","kind":"fixed_sensor_failed","sensorId":p["sensorId"],"reportId":p["id"],"reason":"run_ended"}))?;}
  for channel in ["evidence","sample"]{let cancelled:Value=decode(&next_reports.cancel(channel.into(),false,now as f64)?)?;for r in cancelled.as_array().ok_or_else(invalid)?{let sample=channel=="sample";let mut event=serde_json::json!({"message":if sample{"采样报告未送达（实验结束）"}else{"扫描报告未送达（实验结束）"},"type":"warning","kind":if sample{"sample_report_failed"}else{"evidence_failed"},"reportId":r["id"],"agentId":r["agentId"],"reason":"run_ended"});if sample{event["taskId"]=r["taskId"].clone()}next.time_event(&mut next_ledger,event)?;}}
  let peer_state:Value=decode(&next_peer.snapshot()?)?;for p in peer_state["queue"].as_array().ok_or_else(invalid)?{next.time_event(&mut next_ledger,serde_json::json!({"message":format!("消息 {} 未送达（实验结束）",p["id"].as_u64().ok_or_else(invalid)?),"type":"warning","kind":"message_failed","messageId":p["id"],"from":p["from"],"to":p["to"],"reason":"run_ended"}))?;}next_peer.cancel(now as f64)?;
  let dispatch_state:Value=decode(&next_dispatch.snapshot()?)?;for p in dispatch_state["dispatchQueue"].as_array().ok_or_else(invalid)?{next.time_event(&mut next_ledger,serde_json::json!({"message":"任务指令未送达（实验结束）","type":"warning","kind":"dispatch_failed","dispatchId":p["id"],"taskId":p["taskId"],"agentId":p["agentId"],"reason":"run_ended"}))?;}next_dispatch.cancel("run_ended".into(),now as f64)?;
  let effects:Value=decode(&next_actions.cancel_run(now as f64,&mut next_motion,environment,resources,tasks,&next,&next_ledger)?)?;let action_state:Value=decode(&next_actions.snapshot()?)?;
  for effect in effects.as_array().ok_or_else(invalid)?{let event=match effect["kind"].as_str(){Some("action_cancelled")=>{let action=&action_state[effect["index"].as_u64().ok_or_else(invalid)? as usize];let agent=action["agentId"].as_str().ok_or_else(invalid)?;let name=&actors.iter().find(|(_,a,_)|a.id==agent).ok_or_else(invalid)?.2.name;let label=match action["type"].as_str(){Some("scan")=>"扫描",Some("charge")=>"补能",Some("move")=>"移动",Some("execute_task")=>"执行任务",Some("work_task")=>"执行作业",_=>return Err(invalid())};serde_json::json!({"message":format!("{} 的{}动作已取消",name,label),"type":"warning","kind":"action_cancelled","agentId":agent,"requestId":action["requestId"],"actionType":action["type"],"reason":"run_ended"})},Some("wait_cancelled")=>{let agent=effect["agentId"].as_str().ok_or_else(invalid)?;let name=&actors.iter().find(|(_,a,_)|a.id==agent).ok_or_else(invalid)?.2.name;serde_json::json!({"message":format!("{} 结束道路等待",name),"type":"info","kind":"roadblock_wait_ended","agentId":agent,"roadblockId":effect["wait"]["roadblockId"],"startedTick":effect["wait"]["startedTick"],"outcome":"cancelled"})},_=>return Err(invalid())};next.time_event(&mut next_ledger,event)?;}
  next_reports.cancel("status".into(),false,now as f64)?;next.validate_commit(&next_ledger)?;
  *motion=next_motion;*actions=next_actions;*peer=next_peer;*reports=next_reports;*dispatch=next_dispatch;*ledger=next_ledger;*self=next;Ok(outcome)
 }
 #[napi]
 pub fn begin_time(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&mut crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,peer:&crate::world_peer::WorldPeer,ledger:&mut WorldLedger)->Result<WorldTimeTicket>{
  self.validate_commit(ledger)?;let old=self.linked(ledger)?;if expected!=old as f64||old>=MAX_TICK||ledger.done()?{return Err(invalid())}
  let binding=self.time_binding_for(old,old,motion,environment,tasks,peer,ledger)?;if self.time_binding.is_some_and(|b|b!=binding){return Err(invalid())}let tick=(old+1)as u32;let(_,due)=environment.time_context(old,&self.agents)?;let(_,outages)=peer.time_context(old,old,&self.agents)?;
  let plan=encode(&serde_json::json!({"tick":tick,"roadblocks":due["roadblocks"],"terrain":due["terrain"],"deadlines":tasks.time_deadlines(tick)?,"outages":outages}))?;
  let mut next=self.clone();let mut next_ledger=ledger.clone();let mut next_environment=environment.clone();next_ledger.advance(old as f64)?;next_environment.expire_roadblocks(tick as f64)?;
  for b in due["roadblocks"].as_array().ok_or_else(invalid)?{next.time_event(&mut next_ledger,serde_json::json!({"message":"临时道路封闭已解除","type":"success","kind":"roadblock_ended","roadblockId":b["id"],"startedTick":b["startedTick"],"untilTick":b["untilTick"]}))?}
  let identity=crate::world_checkpoint::identity();next.pending_time=Some(identity);next.time_binding=Some(binding);
  let environment_state=next_environment.snapshot()?;let peer_state=peer.snapshot()?;let motion_before=motion.clone();let tasks_before=tasks.clone();let peer_before=peer.clone();
  let control_before=std::mem::replace(self,next);let ledger_before=std::mem::replace(ledger,next_ledger);let environment_before=std::mem::replace(environment,next_environment);
  Ok(WorldTimeTicket{owner:self.checkpoint_id,identity,tick,binding,phase:0,used:false,road_routes:false,terrain_routes:false,plan,environment:environment_state,peer:peer_state,execution:None,control_before:Some(control_before),ledger_before:Some(ledger_before),motion_before:Some(motion_before),environment_before:Some(environment_before),tasks_before:Some(tasks_before),peer_before:Some(peer_before)})
 }
 #[napi]
 pub fn plan_time_road_routes(&mut self,ticket:&mut WorldTimeTicket,motion:&mut crate::world_motion::WorldMotion,environment:&mut crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,ledger:&mut WorldLedger)->Result<()>{
  self.time_phase(ticket,0,motion,environment,tasks,peer,ledger)?;if ticket.road_routes{return Err(invalid())}let plan:Value=decode(&ticket.plan)?;let expired=!plan["roadblocks"].as_array().ok_or_else(invalid)?.is_empty();
  environment.restored_road_routes(ticket.tick as u64,expired,motion,tasks,actions,resources,self,ledger)?;ticket.road_routes=true;Ok(())
 }
 #[napi]
 pub fn plan_time_terrain_routes(&mut self,ticket:&mut WorldTimeTicket,motion:&mut crate::world_motion::WorldMotion,environment:&mut crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,ledger:&mut WorldLedger)->Result<()>{
  self.time_phase(ticket,1,motion,environment,tasks,peer,ledger)?;if !ticket.road_routes||ticket.terrain_routes{return Err(invalid())}let plan:Value=decode(&ticket.plan)?;let zones:Vec<_>=plan["terrain"].as_array().ok_or_else(invalid)?.iter().map(|e|e["zoneId"].as_str().map(str::to_owned).ok_or_else(invalid)).collect::<Result<_>>()?;
  environment.restored_terrain_routes(ticket.tick as u64,&zones,motion,tasks,actions,resources,self,ledger)?;ticket.terrain_routes=true;Ok(())
 }
 #[napi]
 pub fn time_terrain(&mut self,ticket:&mut WorldTimeTicket,motion:&crate::world_motion::WorldMotion,environment:&mut crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,peer:&crate::world_peer::WorldPeer,ledger:&mut WorldLedger)->Result<()>{
  self.time_phase(ticket,0,motion,environment,tasks,peer,ledger)?;let mut next=self.clone();let mut next_environment=environment.clone();let mut next_ledger=ledger.clone();let ended:Value=decode(&next_environment.expire_terrain(ticket.tick as f64)?)?;
  for e in ended.as_array().ok_or_else(invalid)?{let name=environment.time_zone_name(e["zoneId"].as_str().ok_or_else(invalid)?)?;next.time_event(&mut next_ledger,serde_json::json!({"message":format!("{} 通行条件恢复",name),"type":"success","kind":"terrain_effect_ended","zoneId":e["zoneId"],"startedTick":e["startedTick"],"untilTick":e["untilTick"]}))?}
  let expected=next_environment.snapshot()?;*environment=next_environment;*ledger=next_ledger;*self=next;ticket.environment=expected;ticket.phase=1;Ok(())
 }
 #[napi]
 pub fn finish_time(&mut self,ticket:&mut WorldTimeTicket,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,peer:&mut crate::world_peer::WorldPeer,ledger:&mut WorldLedger)->Result<()>{
  self.time_phase(ticket,1,motion,environment,tasks,peer,ledger)?;let plan:Value=decode(&ticket.plan)?;let mut next=self.clone();let mut next_peer=peer.clone();let mut next_ledger=ledger.clone();
  for t in plan["deadlines"].as_array().ok_or_else(invalid)?{next.time_event(&mut next_ledger,serde_json::json!({"message":format!("「{}」超过截止时间",t["name"].as_str().ok_or_else(invalid)?),"type":"warning","kind":"deadline_missed","taskId":t["id"],"deadline":t["deadline"]}))?}
  let actors=motion.lifecycle_agents()?;for o in plan["outages"].as_array().ok_or_else(invalid)?{let agent=o["agentId"].as_str().ok_or_else(invalid)?;let(_,_,e)=actors.iter().find(|(_,a,_)|a.id==agent).ok_or_else(invalid)?;next.time_event(&mut next_ledger,serde_json::json!({"message":format!("{} 通信恢复",e.name),"type":"success","kind":"communication_restored","agentId":agent}))?}
  next_peer.restore(ticket.tick as f64)?;let expected=next_peer.snapshot()?;let execution=motion.snapshot_execution()?;*peer=next_peer;*ledger=next_ledger;*self=next;ticket.peer=expected;ticket.execution=Some(execution);ticket.phase=2;Ok(())
 }
 #[napi]
 pub fn commit_time(&mut self,ticket:&mut WorldTimeTicket,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,peer:&crate::world_peer::WorldPeer,ledger:&WorldLedger)->Result<()>{
  self.time_phase(ticket,2,motion,environment,tasks,peer,ledger)?;self.pending_time=None;ticket.phase=3;ticket.used=true;Ok(())
 }
 #[napi]
 pub fn abort_time(&mut self,ticket:&mut WorldTimeTicket,motion:&mut crate::world_motion::WorldMotion,environment:&mut crate::world_environment::WorldEnvironment,tasks:&mut crate::world_tasks::WorldTasks,peer:&mut crate::world_peer::WorldPeer,ledger:&mut WorldLedger)->Result<()>{
  self.active()?;if ticket.used||ticket.owner!=self.checkpoint_id||self.pending_time!=Some(ticket.identity)||self.time_binding!=Some(ticket.binding){return Err(invalid())}
  let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let e=environment.time_identity(&ids)?;let t=tasks.time_identity()?;let p=peer.time_identity(&ids)?;
  if [m,e,t,p,ledger.identity()?]!=ticket.binding{return Err(invalid())}
  let saved_control=ticket.control_before.take().ok_or_else(invalid)?;let saved_ledger=ticket.ledger_before.take().ok_or_else(invalid)?;let saved_motion=ticket.motion_before.take().ok_or_else(invalid)?;let saved_environment=ticket.environment_before.take().ok_or_else(invalid)?;let saved_tasks=ticket.tasks_before.take().ok_or_else(invalid)?;let saved_peer=ticket.peer_before.take().ok_or_else(invalid)?;
  *motion=saved_motion;*environment=saved_environment;*tasks=saved_tasks;*peer=saved_peer;*ledger=saved_ledger;*self=saved_control;ticket.used=true;ticket.phase=3;Ok(())
 }
 #[napi]
 pub fn validate_commit(&self,ledger:&WorldLedger)->Result<()>{self.linked(ledger)?;if self.last_event!=ledger.entries()?.len()||self.pending_mode.is_some()||self.pending_recovery||self.pending_time.is_some(){return Err(invalid())}Ok(())}
 #[napi]
 pub fn observe(&mut self,sequence:f64,ledger:&WorldLedger)->Result<()>{
  let tick=self.linked(ledger)?;let entries=ledger.entries()?;
  if sequence!=(self.last_event+1) as f64||sequence>entries.len() as f64{return Err(invalid())}
  let event=&entries[self.last_event];
  // Stage changes so even an invalid event cannot partly update counters.
  let old=self.state.clone();let faulted=self.faulted.clone();let mode=self.pending_mode;let recovery=self.pending_recovery;
  if let Err(error)=self.apply(event,false){self.state=old;self.faulted=faulted;self.pending_mode=mode;self.pending_recovery=recovery;return Err(error)}
  self.last_event+=1;self.tick=tick;Ok(())
 }
 #[napi]
 pub fn set_mode(&mut self,input:String,ledger:&WorldLedger)->Result<()>{
  let tick=self.linked(ledger)?;let mode:Mode=decode(&input)?;
  if ledger.done()?||self.last_event!=ledger.entries()?.len()||self.pending_mode.is_some()||self.pending_recovery||self.pending_time.is_some()||self.state.dispatch_mode==mode{return Err(invalid())}
  self.pending_mode=Some((self.state.dispatch_mode,mode));self.state.dispatch_mode=mode;self.tick=tick;Ok(())
 }
 #[napi]
 pub fn recover(&mut self,input:String,ledger:&WorldLedger)->Result<bool>{
  let tick=self.linked(ledger)?;let c:RecoveryInput=decode(&input)?;
  if ledger.done()?||self.last_event!=ledger.entries()?.len()||self.pending_mode.is_some()||self.pending_recovery||self.pending_time.is_some()||!self.ordered_agents(&c.agent_ids)||c.agents.len()!=self.agents.len()||c.agents.iter().zip(&self.agents).any(|(a,id)|&a.id!=id||!a.battery.is_finite()||!(0.0..=100.0).contains(&a.battery))||c.agent_ids.iter().any(|id|c.agents.iter().find(|a|&a.id==id).is_none_or(|a|a.disabled||!a.idle||a.battery<=0.0||a.battery>5.0)){return Err(invalid())}
  let started=self.state.charge_recovery.is_none();let start=self.state.charge_recovery.as_ref().map_or(tick,|r|r.started_tick);self.state.charge_recovery=Some(Recovery{started_tick:start,agent_ids:c.agent_ids});self.pending_recovery=started;self.tick=tick;Ok(started)
 }
 #[napi]
 pub fn register_task(&mut self,id:String,ledger:&WorldLedger)->Result<()>{
  let tick=self.linked(ledger)?;if ledger.done()?||self.last_event!=ledger.entries()?.len()||self.pending_mode.is_some()||self.pending_recovery||self.pending_time.is_some()||!token(&id)||self.tasks.len()>=100||self.tasks.contains(&id){return Err(invalid())}self.tasks.push(id);self.tick=tick;Ok(())
 }
 #[napi]
 pub fn free(&mut self){self.closed=true;self.agents.clear();self.tasks.clear();self.faulted.clear();self.state.charge_recovery=None;self.pending_mode=None;self.pending_recovery=false;self.pending_time=None;self.time_binding=None;self.ending_binding=None;self.ending_tick=None;self.finalization_binding=None;}
}

crate::world_checkpoint::world_checkpoint!(WorldControl);
