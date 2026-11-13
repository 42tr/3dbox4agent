//! Owned intent registry, immutable request identity, guarded action lifecycle.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};

const MAX_TICK: u32=10_000_000;
fn invalid() -> Error {Error::from_reason("invalid world actions input")}
fn token(s: &str) -> bool {!s.is_empty()&&s.len()<=64&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')}
fn present<'de,D,T>(d:D)->std::result::Result<Option<T>,D::Error> where D:Deserializer<'de>,T:Deserialize<'de>{T::deserialize(d).map(Some)}
fn tick(value:f64)->Result<u32>{if !value.is_finite()||value<0.0||value>MAX_TICK as f64||value.fract()!=0.0{return Err(invalid());}Ok(value as u32)}
fn index(value:f64)->Result<usize>{if !value.is_finite()||value<0.0||value>=1000.0||value.fract()!=0.0{return Err(invalid());}Ok(value as usize)}

#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Kind {Move,Scan,Charge,ExecuteTask,WorkTask,Rescue}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Status {Pending,Accepted,Completed,Rejected,Failed,Cancelled}
impl Status {fn terminal(self)->bool{!matches!(self,Self::Pending|Self::Accepted)}}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Phase {Travel,Waiting,Charging}
#[derive(Clone,Copy)]
enum LifecycleEvent {Cancel(f64),Travel(f64),Run}
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct Point {x:f64,y:f64}
impl Point {fn valid(&self,size:f64)->bool{[self.x,self.y].iter().all(|n|n.is_finite()&&(0.0..=size).contains(n))}}
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
enum ScanResult {
    Anomaly {position:[f64;2],#[serde(rename="observedTick")]observed_tick:u32},
    Normal {position:[f64;2],#[serde(rename="observedTick")]observed_tick:u32},
    NotDetected {#[serde(rename="observedTick")]observed_tick:u32},
}
impl ScanResult {
    fn observed(&self)->u32{match self{Self::Anomaly{observed_tick,..}|Self::Normal{observed_tick,..}|Self::NotDetected{observed_tick}=>*observed_tick}}
    fn valid(&self,now:u32,size:f64)->bool{self.observed()<=now&&match self{Self::Anomaly{position,..}|Self::Normal{position,..}=>position.iter().all(|n|n.is_finite()&&(0.0..=size).contains(n)),Self::NotDetected{..}=>true}}
}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Action {
    agent_id:String,request_id:String,#[serde(rename="type")]kind:Kind,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]target:Option<Point>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]task_id:Option<String>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]target_agent_id:Option<String>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]observed_tick:Option<u32>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]fault_seq:Option<u32>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]fault_generation:Option<u32>,
    target_tick:u32,expires_tick:u32,submitted_tick:u32,status:Status,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]updated_tick:Option<u32>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]reason:Option<String>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]resume_task_id:Option<String>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]progress:Option<u32>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]phase:Option<Phase>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]energy_added:Option<f64>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]result:Option<ScanResult>,
}
impl Action {
    fn valid(&self,now:u32,size:f64)->bool {
        token(&self.agent_id)&&token(&self.request_id)&&self.submitted_tick<=now
            &&self.target_tick>self.submitted_tick&&self.expires_tick>=self.target_tick
            &&self.expires_tick as u64<=self.submitted_tick as u64+100
            &&match self.kind{Kind::Move=>self.target.as_ref().is_some_and(|p|p.valid(size))&&self.task_id.is_none(),Kind::ExecuteTask|Kind::WorkTask=>self.target.is_none()&&self.task_id.as_deref().is_some_and(token),_=>self.target.is_none()&&self.task_id.is_none()}
            &&if self.kind==Kind::Rescue{self.target_agent_id.as_deref().is_some_and(|id|token(id)&&id!=self.agent_id)&&self.observed_tick.is_some_and(|n|n<=self.submitted_tick)&&self.fault_seq.is_some_and(|n|n>0)&&self.fault_generation.is_some_and(|n|n>0)}else{self.target_agent_id.is_none()&&self.observed_tick.is_none()&&self.fault_seq.is_none()&&self.fault_generation.is_none()}
            &&self.resume_task_id.as_deref().is_none_or(|id|token(id)&&matches!(self.kind,Kind::Move|Kind::Charge))
            &&self.progress.is_none_or(|p|self.kind==Kind::Scan&&p<=3||self.kind==Kind::Rescue&&p<=100)
            &&(self.kind!=Kind::Scan||!matches!(self.status,Status::Accepted|Status::Failed|Status::Completed)||self.progress.is_some())
            &&(self.kind!=Kind::Rescue||!matches!(self.status,Status::Accepted|Status::Completed)||self.progress.is_some())
            &&self.phase.is_none_or(|_|self.kind==Kind::Charge)
            &&self.energy_added.is_none_or(|n|self.kind==Kind::Charge&&n.is_finite()&&(0.0..=80.0).contains(&n))
            &&(self.kind!=Kind::Charge||!matches!(self.status,Status::Accepted|Status::Failed|Status::Completed)||self.phase.is_some()&&self.energy_added.is_some())
            &&self.result.as_ref().is_none_or(|r|self.kind==Kind::Scan&&matches!(self.status,Status::Accepted|Status::Completed)&&self.progress==Some(3)&&r.valid(now,size))
            &&self.reason.as_ref().is_none_or(|r|!r.is_empty()&&r.encode_utf16().count()<=100)
            &&match self.status{
                Status::Pending=>self.updated_tick.is_none()&&self.reason.is_none(),
                Status::Accepted=>self.updated_tick.is_some_and(|n|n>=self.target_tick&&n<=self.expires_tick&&n<=now)&&self.reason.is_none(),
                Status::Completed=>self.updated_tick.is_some_and(|n|n>=self.target_tick&&n<=now)&&self.reason.is_none()
                    &&(self.kind!=Kind::Scan||self.progress==Some(3)&&self.result.is_some())
                    &&(self.kind!=Kind::Charge||self.phase==Some(Phase::Charging)&&self.energy_added.is_some()),
                Status::Failed=>self.updated_tick.is_some_and(|n|n>=self.target_tick&&n<=now)&&self.reason.is_some(),
                Status::Rejected|Status::Cancelled=>self.updated_tick.is_some_and(|n|n>=self.submitted_tick&&n<=now)&&self.reason.is_some(),
            }
    }
    fn same_intent(&self,b:&Self)->bool{self.agent_id==b.agent_id&&self.request_id==b.request_id&&self.kind==b.kind&&self.target==b.target&&self.task_id==b.task_id&&self.target_agent_id==b.target_agent_id&&self.observed_tick==b.observed_tick&&self.fault_seq==b.fault_seq&&self.fault_generation==b.fault_generation&&self.target_tick==b.target_tick&&self.expires_tick==b.expires_tick}
    fn submission(&self,now:u32)->bool{self.status==Status::Pending&&self.submitted_tick==now&&self.updated_tick.is_none()&&self.reason.is_none()&&self.resume_task_id.is_none()&&self.progress.is_none()&&self.phase.is_none()&&self.energy_added.is_none()&&self.result.is_none()}
}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Patch {status:Option<Status>,updated_tick:Option<u32>,reason:Option<String>,resume_task_id:Option<String>,progress:Option<u32>,phase:Option<Phase>,energy_added:Option<f64>,result:Option<ScanResult>}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial {#[serde(default="crate::default_world_size",rename="worldSize")]world_size:f64,tick:u32,agents:Vec<String>,actions:Vec<Action>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct StationaryContext {tick:u32,resume_agent:bool}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivationRoute {route:Option<Vec<[f64;2]>>,wait:bool}
struct ActivationState {
    agent_index:usize,agent:crate::world_motion::Motion,execution:crate::world_execution::Execution,
    task:Option<crate::world_tasks::Task>,assigned_task:Option<crate::world_tasks::Task>,
    mode:&'static str,air:bool,binding:[u64;6],fingerprint:String,reason:Option<String>,goal:Option<[f64;2]>,route_kind:Option<&'static str>,
}
struct LifecycleState {
    agent_index:usize,agent:crate::world_motion::Motion,execution:crate::world_execution::Execution,
    task:Option<crate::world_tasks::Task>,mode:&'static str,done:bool,binding:[u64;6],
}
// Kept opaque: a caller can read the route request but cannot manufacture the
// owned state fingerprint, component identities, action index or clock.
#[napi]
#[derive(Clone)]
pub struct WorldActivationTicket {owner:u64,identity:u64,index:usize,tick:u32,binding:[u64;6],fingerprint:String,plan:String,used:bool}
#[napi]
impl WorldActivationTicket {
    #[napi]
    pub fn plan(&self)->Result<String>{if self.used{return Err(invalid())}Ok(self.plan.clone())}
    #[napi]
    pub fn free(&mut self){self.used=true;self.fingerprint.clear();self.plan.clear();}
}

#[napi]
#[derive(Clone)]
pub struct WorldActions {
    world_size:f64,
    checkpoint_id: u64,actions:Vec<Action>,agents:HashSet<String>,indices:HashMap<(String,String),usize>,last_tick:u32,
    stationary_binding:Option<[u64;5]>,stationary_ticks:HashMap<usize,u32>,activation_binding:Option<[u64;6]>,activation_ticket:Option<u64>,lifecycle_binding:Option<[u64;6]>,closed:bool}
pub(crate) enum FrameKind { Move{target:[f64;2],resume:Option<String>},Charge{travel:bool},Scan,Rescue,Task }
pub(crate) struct FrameAction {pub index:usize,pub agent:String,pub kind:FrameKind}
impl WorldActions {
    pub(crate) fn interaction_radius(&self,request:&str)->Result<f64>{let a=self.actions.iter().find(|a|a.request_id==request).ok_or_else(invalid)?;Ok(match a.kind{Kind::Charge=>2.8,Kind::ExecuteTask=>3.7,_=>0.0})}

 pub(crate) fn pending_due(&self,now:u32)->Result<Vec<usize>>{self.active()?;if now<self.last_tick||now>MAX_TICK{return Err(invalid())}Ok(self.actions.iter().enumerate().filter(|(_,a)|a.status==Status::Pending&&a.target_tick<=now).map(|(i,_)|i).collect())}
 pub(crate) fn frame_action(&self,i:usize)->Result<Option<FrameAction>>{self.active()?;let a=self.actions.get(i).ok_or_else(invalid)?;if a.status!=Status::Accepted{return Ok(None)}let kind=match a.kind{Kind::Move=>{let p=a.target.as_ref().ok_or_else(invalid)?;FrameKind::Move{target:[p.x,p.y],resume:a.resume_task_id.clone()}},Kind::Charge=>FrameKind::Charge{travel:a.phase==Some(Phase::Travel)},Kind::Scan=>FrameKind::Scan,Kind::Rescue=>FrameKind::Rescue,Kind::ExecuteTask|Kind::WorkTask=>FrameKind::Task};Ok(Some(FrameAction{index:i,agent:a.agent_id.clone(),kind}))}
 pub(crate) fn accepted_frame(&self)->Result<Vec<FrameAction>>{self.active()?;let mut rows=Vec::new();for i in 0..self.actions.len(){if let Some(row)=self.frame_action(i)?{rows.push(row)}}Ok(rows)}
 pub(crate) fn waiting_charge(&self,agent:&str)->Result<bool>{self.active()?;Ok(self.actions.iter().any(|a|a.agent_id==agent&&a.kind==Kind::Charge&&a.status==Status::Accepted&&a.phase==Some(Phase::Waiting)))}

 pub(crate) fn report_scan(&self,agent:&str,request:&str,now:u32)->Result<Option<serde_json::Value>>{
  self.active()?;if now<self.last_tick{return Err(invalid())}self.actions.iter().find(|a|a.agent_id==agent&&a.request_id==request&&a.kind==Kind::Scan&&a.status==Status::Completed&&a.result.is_some()).map(|a|serde_json::to_value(a.result.as_ref().unwrap()).map_err(|_|invalid())).transpose()
 }
 pub(crate) fn report_wait(&self,agent:&str,request:&str,task:&str)->Result<bool>{self.active()?;Ok(self.actions.iter().any(|a|a.agent_id==agent&&a.request_id==request&&a.status==Status::Accepted&&a.resume_task_id.as_deref()==Some(task)))}
 pub(crate) fn operating_action_event(&self,index:usize,name:&str)->Result<serde_json::Value>{self.active()?;let a=self.actions.get(index).ok_or_else(invalid)?;if !matches!(a.status,Status::Failed|Status::Rejected)||a.reason.as_deref()!=Some("energy_depleted"){return Err(invalid())}Self::lifecycle_action_fact(a,name,a.status)}
 fn lifecycle_action_fact(action:&Action,name:&str,status:Status)->Result<serde_json::Value>{
  if action.status!=status{return Err(invalid())}
  let label=match action.kind{Kind::Scan=>"扫描",Kind::Charge=>"补能",Kind::Move=>"移动",Kind::ExecuteTask=>"执行任务",Kind::WorkTask=>"执行作业",Kind::Rescue=>"现场救援"};
  let(kind,word,level)=match status{Status::Accepted=>("action_accepted","已接受","info"),Status::Rejected=>("action_rejected","被拒绝","warning"),Status::Cancelled=>("action_cancelled","已取消","warning"),Status::Failed=>("action_failed","已失败","warning"),Status::Completed=>("action_completed","已完成","success"),_=>return Err(invalid())};
  let mut event=serde_json::json!({"message":format!("{} 的{}动作{}",name,label,word),"type":level,"kind":kind,"agentId":action.agent_id,"requestId":action.request_id,"actionType":action.kind});
  if matches!(status,Status::Rejected|Status::Failed|Status::Cancelled){event["reason"]=action.reason.as_deref().ok_or_else(invalid)?.into();}Ok(event)
 }
 pub(crate) fn lifecycle_wait_fact(name:&str,agent:&str,wait:&serde_json::Value)->Result<serde_json::Value>{
  let roadblock=wait["roadblockId"].as_str().ok_or_else(invalid)?;let started=wait["startedTick"].as_u64().ok_or_else(invalid)?;
  Ok(serde_json::json!({"message":format!("{} 结束道路等待",name),"type":"info","kind":"roadblock_wait_ended","agentId":agent,"roadblockId":roadblock,"startedTick":started,"outcome":"cancelled"}))
 }
 // Cancellation, travel settlement and run-end cleanup stage their actual
 // state and ordered ledger facts together, including cargo/requeue counters.
 fn lifecycle_events(&mut self,operation:LifecycleEvent,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,tasks:&mut crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
  self.active()?;let now=tick(expected)?;let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();
  let(t,_)=tasks.revocation_context("",&actors,&catalog)?;let(c,l,_,_)=control.proposal_context(now,&ids,&catalog,ledger)?;self.ending_context(now,&ids)?;
  let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(e,_)=environment.time_context(now as u64,&ids)?;let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,_)=resources.proposal_catalog(now as u64,&all,&roster)?;
  let binding=[m,e,r,t,c,l];if self.lifecycle_binding.is_some_and(|b|b!=binding)||self.activation_binding.is_some_and(|b|b!=binding)||self.stationary_binding.is_some_and(|b|b[..4]!=binding[..4]){return Err(invalid())}
  let mut next=self.clone();let mut next_motion=motion.clone();let mut next_resources=resources.clone();let mut next_tasks=tasks.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
  let encoded=match operation{
   LifecycleEvent::Cancel(i)=>next.cancel_intent(i,expected,&mut next_motion,environment,&next_resources,&next_tasks,&next_control,&next_ledger)?,
   LifecycleEvent::Travel(i)=>next.settle_travel(i,expected,&mut next_motion,environment,&mut next_resources,&mut next_tasks,&next_control,&next_ledger)?,
   LifecycleEvent::Run=>next.cancel_run(expected,&mut next_motion,environment,&next_resources,&next_tasks,&next_control,&next_ledger)?,
  };
  let result:serde_json::Value=serde_json::from_str(&encoded).map_err(|_|invalid())?;let mut events=Vec::new();
  match operation{
   LifecycleEvent::Cancel(i)=>{if result["ok"]==true&&result["duplicate"]==false{let action=next.actions.get(index(i)?).ok_or_else(invalid)?;let(_,_,execution,_)=next_motion.activation_components(&action.agent_id)?;if !result["clearedWait"].is_null(){events.push(Self::lifecycle_wait_fact(&execution.name,&action.agent_id,&result["clearedWait"])?)}events.push(Self::lifecycle_action_fact(action,&execution.name,Status::Cancelled)?)}},
   LifecycleEvent::Travel(i)=>{let action=next.actions.get(index(i)?).ok_or_else(invalid)?;let(_,_,execution,_)=next_motion.activation_components(&action.agent_id)?;
    for effect in result.as_array().ok_or_else(invalid)?{let event=match effect["kind"].as_str().ok_or_else(invalid)?{
     "action_completed"=>Self::lifecycle_action_fact(action,&execution.name,Status::Completed)?,
     "action_failed"=>Self::lifecycle_action_fact(action,&execution.name,Status::Failed)?,
     "part_dropped"=>serde_json::json!({"message":"运输中断，备件留在当前位置","type":"warning","kind":"part_dropped","agentId":action.agent_id,"taskId":effect["taskId"].as_str().ok_or_else(invalid)?}),
     "energy_depleted"=>{let task=effect["taskId"].as_str();let message=if action.kind==Kind::Charge{format!("{} 返程时电量耗尽",execution.name)}else{format!("{} 电量耗尽{}",execution.name,if task.is_some(){"，任务重新分配"}else{""})};let mut event=serde_json::json!({"message":message,"type":"warning","kind":"energy_depleted","agentId":action.agent_id,"actionId":action.request_id});if let Some(task)=task{event["taskId"]=task.into()}event},
     _=>return Err(invalid()),
    };events.push(event)}
   },
   LifecycleEvent::Run=>{for effect in result.as_array().ok_or_else(invalid)?{let event=match effect["kind"].as_str().ok_or_else(invalid)?{
    "action_cancelled"=>{let i=effect["index"].as_u64().ok_or_else(invalid)? as usize;let action=next.actions.get(i).ok_or_else(invalid)?;let(_,_,execution,_)=next_motion.activation_components(&action.agent_id)?;Self::lifecycle_action_fact(action,&execution.name,Status::Cancelled)?},
    "wait_cancelled"=>{let id=effect["agentId"].as_str().ok_or_else(invalid)?;let(_,_,execution,_)=next_motion.activation_components(id)?;Self::lifecycle_wait_fact(&execution.name,id,&effect["wait"])?},
    _=>return Err(invalid()),
   };events.push(event)}}
  }
  for event in events{next_control.task_event(&mut next_ledger,event)?}next_control.validate_commit(&next_ledger)?;
  *self=next;*motion=next_motion;*resources=next_resources;*tasks=next_tasks;*control=next_control;*ledger=next_ledger;Ok(encoded)
 }
 // Stationary state and its ordered terminal events share one native commit.
 // Execution mode, sensing mode and the clock come from the owned controller.
 fn stationary_events(&mut self,action_index:f64,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,physics:Option<&crate::PhysicsWorld>)->Result<String>{
  self.active()?;let i=index(action_index)?;let current=self.actions.get(i).ok_or_else(invalid)?;
  let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();
  let(t,_)=tasks.revocation_context("",&actors,&catalog)?;let(c,l,mode,ray)=control.stationary_events_context(expected,&ids,&catalog,ledger)?;let now=expected as u32;
  self.ending_context(now,&ids)?;if ray!=physics.is_some(){return Err(invalid())}
  let(_,agent,execution,m)=motion.activation_components(&current.agent_id)?;
  let(e,_)=environment.time_context(now as u64,&ids)?;
  let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,_)=resources.proposal_catalog(now as u64,&all,&roster)?;
  if let Some(task)=all.iter().find(|t|Some(t.id.as_str())==current.resume_task_id.as_deref()&&t.status==crate::world_tasks::Status::Active&&t.assignee.as_deref()==Some(agent.id.as_str())){resources.work_owner(task,&agent,&execution,now)?;}
  let binding=[m,e,r,t,c,l];if self.lifecycle_binding.is_some_and(|b|b!=binding)||self.activation_binding.is_some_and(|b|b!=binding)||self.stationary_binding.is_some_and(|b|b[..4]!=binding[..4]){return Err(invalid())}
  let mut next=self.clone();let mut next_motion=motion.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
  let stale=if current.kind==Kind::Rescue{next.rescue_reason(current,motion,environment,Some(ledger),i)?}else{None};
  let encoded=if let Some(reason)=stale{let mut e=execution.clone();e.status=crate::world_execution::Status::Idle;next_motion.commit_stationary(actors.iter().position(|(_,a,_)|a.id==agent.id).ok_or_else(invalid)?,agent.clone(),e)?;next.actions[i].status=Status::Failed;next.actions[i].reason=Some(reason);next.actions[i].updated_tick=Some(now);serde_json::json!([{"kind":"action_failed"}]).to_string()}else{next.stationary(action_index,serde_json::json!({"tick":now,"resumeAgent":mode=="agent"}).to_string(),&mut next_motion,environment,resources,tasks,physics,true)?};
  let effects:Vec<serde_json::Value>=serde_json::from_str(&encoded).map_err(|_|invalid())?;let action=&next.actions[i];
  for effect in &effects{
   let kind=effect["kind"].as_str().ok_or_else(invalid)?;
   let event=match kind{
    "action_completed"|"action_failed"=>{
     let completed=kind=="action_completed";if completed&&action.status!=Status::Completed||!completed&&action.status!=Status::Failed{return Err(invalid())}
     let label=match action.kind{Kind::Scan=>"扫描",Kind::Charge=>"补能",Kind::Rescue=>"现场救援",_=>return Err(invalid())};
     let mut event=serde_json::json!({"message":format!("{} 的{}动作{}",execution.name,label,if completed{"已完成"}else{"已失败"}),"type":if completed{"success"}else{"warning"},"kind":kind,"agentId":action.agent_id,"requestId":action.request_id,"actionType":action.kind});
     if !completed{event["reason"]=action.reason.as_deref().ok_or_else(invalid)?.into();}event
    },
    "energy_depleted"=>{if !matches!(action.kind,Kind::Scan|Kind::Rescue)||action.status!=Status::Failed||action.reason.as_deref()!=Some("energy_depleted"){return Err(invalid())}serde_json::json!({"message":format!("{} {}时电量耗尽",execution.name,if action.kind==Kind::Rescue{"救援"}else{"扫描"}),"type":"warning","kind":kind,"agentId":action.agent_id,"actionId":action.request_id})},
    "rescue_ready"=>{
     if action.kind!=Kind::Rescue||action.status!=Status::Completed{return Err(invalid())}
     let(target_index,target,mut target_execution,_)=next_motion.activation_components(action.target_agent_id.as_deref().ok_or_else(invalid)?)?;
     if !target_execution.disabled||target_execution.recoverable_fault!=Some(true)||target_execution.fault_generation!=action.fault_generation||target.battery<=5.0||action.progress!=execution.rescue.as_ref().map(|p|p.work_ticks)||!crate::rescue::verify_fault(next_ledger.entries()?,&target.id,action.fault_seq.ok_or_else(invalid)?,action.observed_tick.ok_or_else(invalid)?)?{return Err(invalid())}
     target_execution.disabled=false;target_execution.status=if target_execution.relay_state.as_ref().is_some_and(|s|s.deployed){crate::world_execution::Status::Deployed}else{crate::world_execution::Status::Idle};target_execution.route.clear();target_execution.work=0;
     let event=serde_json::json!({"message":format!("{} 完成对 {} 的现场救援",execution.name,target_execution.name),"type":"success","kind":"rescue_completed","agentId":action.agent_id,"requestId":action.request_id,"targetAgentId":target.id,"faultSeq":action.fault_seq,"faultGeneration":action.fault_generation,"workTicks":action.progress,"position":[target.x,target.y],"battery":target.battery});
     next_motion.commit_stationary(target_index,target,target_execution)?;event
    },
    _=>return Err(invalid()),
   };next_control.task_event(&mut next_ledger,event)?;
  }
  next_control.validate_commit(&next_ledger)?;next.lifecycle_binding=Some(binding);
  *self=next;*motion=next_motion;*control=next_control;*ledger=next_ledger;Ok(encoded)
 }
 pub(crate) fn route_intent(&self,agent:&str)->Result<Option<(bool,Option<String>)>>{self.active()?;if !self.agents.contains(agent){return Err(invalid())}let mut found=self.actions.iter().filter(|a|a.agent_id==agent&&a.status==Status::Accepted&&(a.kind==Kind::Move||a.kind==Kind::Charge&&a.phase==Some(Phase::Travel)));let result=found.next().map(|a|(a.kind==Kind::Move,a.resume_task_id.clone()));if found.next().is_some(){return Err(invalid())}Ok(result)}
 pub(crate) fn collision_identity(&self,binding:[u64;6])->Result<()>{self.active()?;if self.activation_binding.is_some_and(|b|b!=binding)||self.lifecycle_binding.is_some_and(|b|b!=binding)||self.stationary_binding.is_some_and(|b|b[..4]!=binding[..4]){return Err(invalid())}Ok(())}
 pub(crate) fn collision_intent(&self,agent:&str)->Result<Option<(bool,Option<String>,Option<[f64;2]>)>>{
  self.active()?;if !self.agents.contains(agent){return Err(invalid())}
  let mut found=self.actions.iter().filter(|a|a.agent_id==agent&&a.status==Status::Accepted&&(a.kind==Kind::Move||a.kind==Kind::Charge&&a.phase==Some(Phase::Travel)));
  let result=found.next().map(|a|(a.kind==Kind::Move,a.resume_task_id.clone(),a.target.as_ref().map(|p|[p.x,p.y])));if found.next().is_some(){return Err(invalid())}Ok(result)
 }
 pub(crate) fn moves_task(&self,agent:&str,task:&str)->bool{self.actions.iter().any(|a|a.agent_id==agent&&a.resume_task_id.as_deref()==Some(task)&&a.kind==Kind::Move&&a.status==Status::Accepted)}
 pub(crate) fn environment_owner(&self,agent:&str,request:Option<&str>)->Option<String>{self.actions.iter().find(|a|a.agent_id==agent&&a.status==Status::Accepted&&matches!(a.kind,Kind::Move|Kind::Charge)&&request.is_none_or(|r|r==a.request_id)).map(|a|a.request_id.clone())}
 pub(crate) fn ending_context(&self,now:u32,agents:&[String])->Result<(u64,bool)>{self.active()?;if now<self.last_tick||agents.len()!=self.agents.len()||agents.iter().any(|a|!self.agents.contains(a)){return Err(invalid())}Ok((self.checkpoint_id,self.actions.iter().any(|a|!a.status.terminal())))}
 pub(crate) fn resumes_task(&self,agent:&str,request:&str,task:&str)->bool{self.actions.iter().any(|a|a.agent_id==agent&&a.request_id==request&&a.status==Status::Accepted&&a.resume_task_id.as_deref()==Some(task))}
 pub(crate) fn revoke_actor(&mut self,agent:&str,name:&str,now:u32,binding:[u64;6])->Result<Vec<serde_json::Value>>{
  self.work_identity(agent,now)?;
  if self.lifecycle_binding.is_some_and(|b|b!=binding)||self.activation_binding.is_some_and(|b|b!=binding)||self.stationary_binding.is_some_and(|b|b[..4]!=binding[..4]){return Err(invalid())}
  let mut events=Vec::new();
  for a in &mut self.actions{if a.agent_id!=agent||a.status.terminal(){continue}let mut next=a.clone();next.status=Status::Cancelled;next.reason=Some("task_revoked".into());next.updated_tick=Some(now);if !next.valid(now,self.world_size){return Err(invalid())}
   let label=match next.kind{Kind::Scan=>"扫描",Kind::Charge=>"补能",Kind::Move=>"移动",Kind::ExecuteTask=>"执行任务",Kind::WorkTask=>"执行作业",Kind::Rescue=>"现场救援"};
   events.push(serde_json::json!({"message":format!("{} 的{}动作已取消",name,label),"type":"warning","kind":"action_cancelled","agentId":agent,"requestId":next.request_id,"actionType":next.kind,"reason":"task_revoked"}));*a=next;
  }
  self.last_tick=now;self.lifecycle_binding=Some(binding);self.activation_ticket=None;Ok(events)
 }
 fn lifecycle_state(&self,agent:&str,task:Option<&str>,now:u32,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<LifecycleState>{
  self.active()?;if now>MAX_TICK||now<self.last_tick||!self.agents.contains(agent){return Err(invalid())}
  let(agent_index,agent,execution,motion_id)=motion.activation_components(agent)?;
  let environment_id=environment.stationary_identity(agent_index,&agent.id,now as u64)?;
  let(resource_id,_)=resources.activation_part(&agent.id)?;let(task_id,task,_)=tasks.activation_context(task,&agent.id)?;
  let(control_id,ledger_id,_,mode,done)=control.lifecycle_context(now,&agent.id,ledger)?;
  let binding=[motion_id,environment_id,resource_id,task_id,control_id,ledger_id];
  if self.lifecycle_binding.is_some_and(|b|b!=binding)||self.activation_binding.is_some_and(|b|b!=binding)||self.stationary_binding.is_some_and(|b|b[..4]!=binding[..4]){return Err(invalid())}
  let task=task.filter(|t|t.status==crate::world_tasks::Status::Active&&t.assignee.as_deref()==Some(&agent.id));
  Ok(LifecycleState{agent_index,agent,execution,task,mode,done,binding})
 }
 fn activation_state(&self,i:usize,now:u32,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<ActivationState>{
  self.active()?;if now>MAX_TICK||now<self.last_tick{return Err(invalid())}
  let action=self.actions.get(i).ok_or_else(invalid)?;if action.status!=Status::Pending||now<action.target_tick{return Err(invalid())}
  let(agent_index,agent,execution,motion_id)=motion.activation_components(&action.agent_id)?;
  let env_id=environment.stationary_identity(agent_index,&agent.id,now as u64)?;
  let(resource_id,part_position)=resources.activation_part(&agent.id)?;
  let(task_id,task,active)=tasks.activation_context(action.task_id.as_deref(),&agent.id)?;
  let(control_id,ledger_id,prefix,mode)=control.activation_context(now,&agent.id,ledger)?;
  let assigned_task=if execution.status==crate::world_execution::Status::Assigned{active}else{None};
  let air=execution.mobility.as_deref().unwrap_or(if execution.role=="drone"{"air"}else{"ground"})=="air";
  let waypoint=task.as_ref().and_then(|t|if t.behavior==crate::world_tasks::Behavior::Deliver&&matches!(t.phase.flatten(),Some(crate::world_tasks::Phase::ToPickup|crate::world_tasks::Phase::Loading)){part_position}else{Some(t.target)});
  let reachable=if action.kind==Kind::WorkTask{if let Some(goal)=waypoint{environment.activation_reachable([agent.x,agent.y],goal,air)?}else{false}}else{false};
  let result=crate::action_activation_precondition(serde_json::json!({"tick":now,"expiresTick":action.expires_tick,"actionType":action.kind,"executionMode":mode,"agentId":agent.id,"agentDisabled":execution.disabled,"agentStatus":execution.status,"battery":agent.battery,"capabilities":execution.capabilities,"taskStatus":task.as_ref().map(|t|t.status),"taskAssignee":task.as_ref().and_then(|t|t.assignee.as_deref()),"hasAssignedTask":assigned_task.is_some(),"withinReach":reachable}).to_string())?;
  let mut reason=if result.is_empty(){None}else{Some(result)};
  if reason.is_none()&&action.kind==Kind::Rescue{reason=self.rescue_reason(action,motion,environment,Some(ledger),i)?;}
  let mut goal=None;let mut route_kind=None;
  if reason.is_none(){
   if action.kind==Kind::ExecuteTask&&execution.task_needs_route==Some(true){if waypoint.is_none(){reason=Some("unreachable_target".into())}else{goal=waypoint;route_kind=Some("task")}}
   else if matches!(action.kind,Kind::Move|Kind::Charge){goal=Some(if action.kind==Kind::Charge{environment.activation_station()?}else{let p=action.target.as_ref().ok_or_else(invalid)?;[p.x,p.y]});route_kind=Some("action")}
  }
  let binding=[motion_id,env_id,resource_id,task_id,control_id,ledger_id];if self.activation_binding.is_some_and(|before|before!=binding){return Err(invalid())}
  let fingerprint=serde_json::json!({"rescueTarget":if action.kind==Kind::Rescue{Some(motion.activation_components(action.target_agent_id.as_deref().ok_or_else(invalid)?)?.1)}else{None},"action":action,"agent":agent,"execution":execution,"task":task,"assignedTask":assigned_task,"partPosition":part_position,"environment":environment.snapshot()?,"context":control.snapshot()?,"prefix":prefix,"tick":now}).to_string();
  Ok(ActivationState{agent_index,agent,execution,task,assigned_task,mode,air,binding,fingerprint,reason,goal,route_kind})
 }
 pub(crate) fn work_identity(&self,agent:&str,now:u32)->Result<u64>{
  self.active()?;if now>MAX_TICK||now<self.last_tick||!self.agents.contains(agent){return Err(invalid())}Ok(self.checkpoint_id)
 }
 pub(crate) fn interruption_identity(&self,agents:&[String],now:u32)->Result<u64>{
  if agents.len()!=self.agents.len()||agents.iter().collect::<HashSet<_>>().len()!=agents.len()||agents.iter().any(|a|!self.agents.contains(a)){return Err(invalid())}self.work_identity(agents.first().ok_or_else(invalid)?,now)
 }
 pub(crate) fn interrupt_actor(&mut self,agent:&str,task:Option<&str>,now:u32,low_energy:bool,all_actions:bool,depleted:bool,binding:[u64;6])->Result<Vec<serde_json::Value>>{
  self.work_identity(agent,now)?;
  if self.lifecycle_binding.is_some_and(|b|b!=binding)||self.activation_binding.is_some_and(|b|b!=binding)||self.stationary_binding.is_some_and(|b|b[..4]!=binding[..4]){return Err(invalid())}
  let mut indices=Vec::new();
  if low_energy||all_actions{indices.extend(self.actions.iter().enumerate().filter(|(_,a)|a.agent_id==agent&&!a.status.terminal()).map(|(i,_)|i));}
  else{
   if let Some(i)=self.actions.iter().position(|a|a.agent_id==agent&&a.task_id.as_deref()==task&&matches!(a.kind,Kind::ExecuteTask|Kind::WorkTask)&&a.status==Status::Accepted){indices.push(i)}
   indices.extend(self.actions.iter().enumerate().filter(|(_,a)|a.agent_id==agent&&matches!(a.kind,Kind::Move|Kind::Charge)&&a.status==Status::Accepted).map(|(i,_)|i));
  }
  let mut effects=Vec::new();
  for i in indices{let mut next=self.actions[i].clone();next.status=if (low_energy||all_actions)&&next.status==Status::Pending{Status::Rejected}else{Status::Failed};next.reason=Some(if depleted{"energy_depleted"}else if low_energy{"low_battery"}else{"agent_unavailable"}.into());next.updated_tick=Some(now);if !next.valid(now,self.world_size){return Err(invalid())}
   effects.push(serde_json::json!({"kind":"action_status","index":i,"status":next.status,"reason":next.reason}));self.actions[i]=next;
  }
  self.last_tick=now;self.lifecycle_binding=Some(binding);self.activation_ticket=None;Ok(effects)
 }
 pub(crate) fn fail_work(&mut self,task:&str,agent:&str,now:u32,reason:&str)->Result<Option<usize>>{let found=self.finish_work(task,agent,now,true)?;if let Some(i)=found{self.actions[i].reason=Some(reason.into());if !self.actions[i].valid(now,self.world_size){return Err(invalid())}}Ok(found)}
 pub(crate) fn finish_work(&mut self,task:&str,agent:&str,now:u32,depleted:bool)->Result<Option<usize>>{
  self.work_identity(agent,now)?;
  let found=self.actions.iter().position(|a|matches!(a.kind,Kind::ExecuteTask|Kind::WorkTask)&&a.task_id.as_deref()==Some(task)&&a.agent_id==agent&&a.status==Status::Accepted);
  if let Some(i)=found{let mut next=self.actions[i].clone();next.status=if depleted{Status::Failed}else{Status::Completed};next.updated_tick=Some(now);next.reason=if depleted{Some("energy_depleted".into())}else{None};if !next.valid(now,self.world_size){return Err(invalid())}self.actions[i]=next;}
  self.last_tick=now;Ok(found)
 }
 fn rescue_reason(&self,action:&Action,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,ledger:Option<&crate::world_ledger::WorldLedger>,index:usize)->Result<Option<String>>{
  let(_,helper,execution,_)=motion.activation_components(&action.agent_id)?;
  if execution.rescue.is_none()||!execution.capabilities.iter().any(|c|c=="rescue"){return Ok(Some("missing_capability".into()))}
  let target_id=action.target_agent_id.as_deref().ok_or_else(invalid)?;
  let Ok((_,target,target_execution,_))=motion.activation_components(target_id)else{return Ok(Some("not_recoverable".into()))};
  if target_id==helper.id||target_execution.recoverable_fault!=Some(true){return Ok(Some("not_recoverable".into()))}
  if !target_execution.disabled||target_execution.status!=crate::world_execution::Status::Fault||target_execution.fault_generation!=action.fault_generation{return Ok(Some("fault_changed".into()))}
  if let Some(ledger)=ledger{if !crate::rescue::verify_fault(ledger.entries()?,target_id,action.fault_seq.ok_or_else(invalid)?,action.observed_tick.ok_or_else(invalid)?)?{return Ok(Some("fault_changed".into()))}}
  if target.battery<=5.0{return Ok(Some("target_low_battery".into()))}
  if !environment.activation_reachable([helper.x,helper.y],[target.x,target.y],false)?{return Ok(Some("out_of_reach".into()))}
  if self.actions.iter().enumerate().any(|(i,a)|i!=index&&a.kind==Kind::Rescue&&a.status==Status::Accepted&&a.target_agent_id==action.target_agent_id&&a.fault_seq==action.fault_seq){return Ok(Some("rescue_in_progress".into()))}
  Ok(None)
 }
 fn active(&self)->Result<()>{if self.closed{Err(Error::from_reason("world actions is closed"))}else{Ok(())}}
 fn stationary(&mut self,action_index:f64,input:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,physics:Option<&crate::PhysicsWorld>,certified_rescue:bool)->Result<String>{
  self.active()?;let i=index(action_index)?;
  if input.len()>512{return Err(invalid())}
  let context:StationaryContext=serde_json::from_str(&input).map_err(|_|invalid())?;let now=context.tick;
  if now>MAX_TICK||now<self.last_tick||self.stationary_ticks.get(&i).is_some_and(|n|now<=*n){return Err(invalid())}
  let current=self.actions.get(i).ok_or_else(invalid)?;
  if current.kind==Kind::Rescue&&!certified_rescue{return Err(invalid())}
  if current.status!=Status::Accepted||!matches!(current.kind,Kind::Scan|Kind::Charge|Kind::Rescue){return Err(invalid())}
  let (agent_index,mut agent,mut execution,motion_id)=motion.stationary_components(&current.agent_id)?;
  let environment_id=environment.stationary_identity(agent_index,&agent.id,now as u64)?;
  let (resource_id,site,anomaly)=resources.stationary_site(&agent.id)?;
  let (task_id,resume)=tasks.stationary_resume(current.resume_task_id.as_deref(),&agent.id)?;
  if physics.is_some_and(|p|p.closed){return Err(invalid())}
  let binding=[motion_id,environment_id,resource_id,task_id,physics.map_or(0,|p|p.checkpoint_id)];
  if self.stationary_binding.is_some_and(|before|before!=binding){return Err(invalid())}
  let mut next=current.clone();let mut effects=Vec::<serde_json::Value>::new();
  match current.kind {
   Kind::Rescue=>{
    let reason=self.rescue_reason(current,motion,environment,None,i)?;
    if let Some(reason)=reason{execution.status=crate::world_execution::Status::Idle;next.status=Status::Failed;next.reason=Some(reason);next.updated_tick=Some(now);effects.push(serde_json::json!({"kind":"action_failed"}));}
    else{
     let energy=agent.battery.min(execution.work_energy_per_tick.unwrap_or(0.08));
     if execution.thermal_work(energy)?{
      let progress=current.progress.ok_or_else(invalid)?.checked_add(1).ok_or_else(invalid)?;next.progress=Some(progress);agent.battery=(agent.battery-energy).max(0.0);execution.thermal_spend(energy)?;
      if agent.battery<=0.0{execution.disabled=true;execution.status=crate::world_execution::Status::Fault;next.status=Status::Failed;next.reason=Some("energy_depleted".into());next.updated_tick=Some(now);effects.push(serde_json::json!({"kind":"action_failed"}));effects.push(serde_json::json!({"kind":"energy_depleted","actionId":current.request_id}));}
      else if progress>=execution.rescue.as_ref().ok_or_else(invalid)?.work_ticks{
       execution.status=crate::world_execution::Status::Idle;next.status=Status::Completed;next.updated_tick=Some(now);effects.push(serde_json::json!({"kind":"rescue_ready"}));effects.push(serde_json::json!({"kind":"action_completed"}));
      }
     }
    }
   },
   Kind::Scan=>{
    let energy=agent.battery.min(execution.work_energy_per_tick.unwrap_or(0.08));
    if execution.thermal_work(energy)?{
    let progress=current.progress.ok_or_else(invalid)?.checked_add(1).ok_or_else(invalid)?;
    agent.battery=(agent.battery-execution.work_energy_per_tick.unwrap_or(0.08)).max(0.0);next.progress=Some(progress);execution.thermal_spend(energy)?;
    if agent.battery<=0.0{
     execution.disabled=true;execution.status=crate::world_execution::Status::Fault;
     next.status=Status::Failed;next.reason=Some("energy_depleted".into());next.updated_tick=Some(now);
     effects.push(serde_json::json!({"kind":"action_failed","reason":"energy_depleted"}));
     effects.push(serde_json::json!({"kind":"energy_depleted","actionId":current.request_id}));
    }else if progress>=3{
     let air=execution.mobility.as_deref().unwrap_or(if execution.role=="drone"{"air"}else{"ground"})=="air";
     let visible=environment.stationary_visible([agent.x,agent.y,if air{16.0}else{1.5+environment.elevation(agent.x,agent.y)}],site,execution.sensor_range,physics)?;
     next.result=Some(if !visible{ScanResult::NotDetected{observed_tick:now}}else if anomaly{ScanResult::Anomaly{position:site,observed_tick:now}}else{ScanResult::Normal{position:site,observed_tick:now}});
     execution.status=crate::world_execution::Status::Idle;next.status=Status::Completed;next.updated_tick=Some(now);
     effects.push(serde_json::json!({"kind":"action_completed"}));
    }
    }
   },
   Kind::Charge=>{
    let mut phase=current.phase.ok_or_else(invalid)?;let mut added=current.energy_added.ok_or_else(invalid)?;
    if !matches!(phase,Phase::Waiting|Phase::Charging)||agent.battery>80.0||!environment.stationary_near_charger([agent.x,agent.y])?{return Err(invalid())}
    let busy=self.actions.iter().enumerate().any(|(other,a)|other!=i&&a.kind==Kind::Charge&&a.status==Status::Accepted&&a.phase==Some(Phase::Charging));
    if phase==Phase::Waiting&&!busy{phase=Phase::Charging}
    if phase==Phase::Charging{
     let amount=2.0_f64.min(80.0-agent.battery);agent.battery+=amount;added+=amount;
     if agent.battery>=80.0-1e-9{
      agent.battery=80.0;execution.route.clear();execution.status=if resume{crate::world_execution::Status::Assigned}else{crate::world_execution::Status::Idle};
      execution.task_needs_route=if resume&&context.resume_agent{Some(true)}else{None};
      next.status=Status::Completed;next.updated_tick=Some(now);effects.push(serde_json::json!({"kind":"action_completed"}));
     }
    }
    next.phase=Some(phase);next.energy_added=Some(added);
   },
   _=>return Err(invalid()),
  }
  if !next.valid(now,self.world_size)||!execution.valid(agent.distance){return Err(invalid())}
  // Encode before writing any participating component. Queries and all checks
  // above use private copies, so a rejection cannot retain a successful prefix.
  let result=serde_json::to_string(&effects).map_err(|_|invalid())?;
  motion.commit_stationary(agent_index,agent,execution)?;
  self.actions[i]=next;self.last_tick=now;self.stationary_binding=Some(binding);self.stationary_ticks.insert(i,now);Ok(result)
 }
}
#[napi]
impl WorldActions {
    #[napi(constructor)]
    pub fn new(input:String)->Result<Self>{
        if input.len()>4*1024*1024{return Err(invalid());}
        let initial:Initial=serde_json::from_str(&input).map_err(|_|invalid())?;
        if !crate::valid_world_size(initial.world_size)||initial.tick>MAX_TICK||initial.agents.is_empty()||initial.agents.len()>50||initial.actions.len()>1000{return Err(invalid());}
        let mut agents=HashSet::new();for a in initial.agents{if !token(&a)||!agents.insert(a){return Err(invalid());}}
        let mut indices=HashMap::new();for(i,a)in initial.actions.iter().enumerate(){
            if !agents.contains(&a.agent_id)||a.target_agent_id.as_ref().is_some_and(|id|!agents.contains(id))||!a.valid(initial.tick,initial.world_size)||indices.insert((a.agent_id.clone(),a.request_id.clone()),i).is_some(){return Err(invalid());}
            // A committed scan result belongs to a completed scan. Updates may
            // temporarily attach the result immediately before completing it.
            if a.result.is_some()&&a.status!=Status::Completed{return Err(invalid());}
        }
        if initial.actions.iter().filter(|a|a.status==Status::Accepted&&a.phase==Some(Phase::Charging)).count()>1{return Err(invalid());}
        // A committed accepted scan with progress, or an at-station charge,
        // has already participated in this snapshot's tick. Forks must not
        // reopen that tick when rebuilding runtime-only native ownership.
        let stationary_ticks=initial.actions.iter().enumerate().filter(|(_,a)|a.status==Status::Accepted&&(matches!(a.kind,Kind::Scan|Kind::Rescue)&&a.progress.is_some_and(|n|n>0)||a.kind==Kind::Charge&&matches!(a.phase,Some(Phase::Waiting|Phase::Charging)))).map(|(i,_)|(i,initial.tick)).collect();
        Ok(Self{ world_size:initial.world_size, checkpoint_id: crate::world_checkpoint::identity(),actions:initial.actions,agents,indices,last_tick:initial.tick,stationary_binding:None,stationary_ticks,activation_binding:None,activation_ticket:None,lifecycle_binding:None,closed:false})
    }
    #[napi]
    pub fn submit(&mut self,input:String,now:f64)->Result<String>{
        self.active()?;let now=tick(now)?;
        if now<self.last_tick||input.len()>65536{return Err(invalid());}
        let a:Action=serde_json::from_str(&input).map_err(|_|invalid())?;
        if !self.agents.contains(&a.agent_id)||a.target_agent_id.as_ref().is_some_and(|id|!self.agents.contains(id))||!a.submission(now){return Err(invalid());}
        if let Some(i)=self.indices.get(&(a.agent_id.clone(),a.request_id.clone())){
            if !self.actions[*i].same_intent(&a){return Err(invalid());}
            return Ok(serde_json::json!({"index":i,"duplicate":true}).to_string());
        }
        if self.actions.len()>=1000||!a.valid(now,self.world_size){return Err(invalid());}
        let i=self.actions.len();self.indices.insert((a.agent_id.clone(),a.request_id.clone()),i);self.actions.push(a);self.last_tick=now;
        Ok(serde_json::json!({"index":i,"duplicate":false}).to_string())
    }
    #[napi]
    pub fn update(&mut self,action_index:f64,input:String,now:f64)->Result<String>{
        self.active()?;let now=tick(now)?;let i=index(action_index)?;
        if now<self.last_tick||input.len()>65536{return Err(invalid());}
        let value:serde_json::Value=serde_json::from_str(&input).map_err(|_|invalid())?;
        let fields=value.as_object().ok_or_else(invalid)?;
        if fields.is_empty()||fields.values().any(serde_json::Value::is_null){return Err(invalid());}
        let p:Patch=serde_json::from_value(value).map_err(|_|invalid())?;
        let before=self.actions.get(i).ok_or_else(invalid)?;
        if before.status.terminal()||before.kind==Kind::Rescue{return Err(invalid());}
        if let Some(status)=p.status{
            let allowed=match before.status{Status::Pending=>matches!(status,Status::Accepted|Status::Rejected|Status::Cancelled),Status::Accepted=>matches!(status,Status::Completed|Status::Failed|Status::Cancelled),_=>false};
            if !allowed||p.updated_tick!=Some(now){return Err(invalid());}
        }else if p.updated_tick.is_some()||p.reason.is_some(){return Err(invalid());}
        if p.resume_task_id.is_some()&&(before.status!=Status::Pending||before.resume_task_id.is_some()){return Err(invalid());}
        if let Some(progress)=p.progress{if before.status==Status::Pending {if progress!=0||before.progress.is_some(){return Err(invalid());}}else if before.progress.is_none_or(|n|progress!=n+1){return Err(invalid());}}
        if let Some(phase)=p.phase{
            let allowed=if before.status==Status::Pending{phase==Phase::Travel&&before.phase.is_none()}else{before.phase==Some(phase)||matches!((before.phase,phase),(Some(Phase::Travel),Phase::Waiting)|(Some(Phase::Waiting),Phase::Charging))};
            if !allowed{return Err(invalid());}
        }
        if let Some(energy)=p.energy_added{if before.status==Status::Pending {if energy!=0.0||before.energy_added.is_some(){return Err(invalid());}}else if before.energy_added.is_none_or(|n|energy<n||energy>n+2.0+1e-9){return Err(invalid());}}
        if let Some(result)=&p.result{if before.status!=Status::Accepted||before.result.is_some()||result.observed()!=now{return Err(invalid());}}
        let stationary_update=before.status==Status::Accepted&&(p.progress.is_some()||p.energy_added.is_some());
        let mut next=before.clone();
        if let Some(v)=p.status{next.status=v;}
        macro_rules! apply{($($field:ident),*)=>{$(if let Some(v)=p.$field{next.$field=Some(v);})*};}
        apply!(updated_tick,reason,resume_task_id,progress,phase,energy_added,result);
        if !next.valid(now,self.world_size){return Err(invalid());}
        if next.status==Status::Accepted&&next.phase==Some(Phase::Charging)&&self.actions.iter().enumerate().any(|(j,a)|j!=i&&a.status==Status::Accepted&&a.phase==Some(Phase::Charging)){return Err(invalid());}
        let encoded=serde_json::to_string(&next).map_err(|_|invalid())?;
        self.actions[i]=next;self.last_tick=now;if stationary_update{self.stationary_ticks.insert(i,now);}Ok(encoded)
    }
    #[napi]
    pub fn action(&self,action_index:f64)->Result<String>{self.active()?;serde_json::to_string(self.actions.get(index(action_index)?).ok_or_else(invalid)?).map_err(|_|invalid())}
    #[napi]
    pub fn snapshot(&self)->Result<String>{self.active()?;serde_json::to_string(&self.actions).map_err(|_|invalid())}
    #[napi]
    pub fn cancel_intent(&mut self,action_index:f64,now:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        let i=index(action_index)?;let now=tick(now)?;self.active()?;let current=self.actions.get(i).ok_or_else(invalid)?;
        let task=if matches!(current.kind,Kind::ExecuteTask|Kind::WorkTask){current.task_id.as_deref()}else{current.resume_task_id.as_deref()};
        let mut state=self.lifecycle_state(&current.agent_id,task,now,motion,environment,resources,tasks,control,ledger)?;
        if current.status==Status::Cancelled&&current.reason.as_deref()==Some("cancel_requested"){return Ok(serde_json::json!({"ok":true,"duplicate":true,"clearedWait":null}).to_string())}
        let reason=if current.status.terminal(){Some("action_not_cancellable")}else if state.done{Some("world_finished")}else{None};
        if let Some(reason)=reason{return Ok(serde_json::json!({"ok":false,"reason":reason}).to_string())}
        let mut cleared_wait=None;
        if current.status==Status::Accepted{
            if matches!(current.kind,Kind::ExecuteTask|Kind::WorkTask){
                if state.task.is_none()||state.execution.status!=crate::world_execution::Status::Working||state.execution.disabled{return Ok(serde_json::json!({"ok":false,"reason":"action_state_conflict"}).to_string())}
                state.execution.status=crate::world_execution::Status::Assigned;state.execution.blocked_ticks=Some(0);state.execution.progress_waypoint=Some(String::new());
            }else{
                if state.execution.status!=crate::world_execution::Status::Manual||state.execution.disabled{return Ok(serde_json::json!({"ok":false,"reason":"action_state_conflict"}).to_string())}
                cleared_wait=state.execution.lifecycle_clear_action_wait(&current.request_id)?;
                state.execution.route.clear();state.execution.blocked_ticks=Some(0);state.execution.status=if state.task.is_some(){crate::world_execution::Status::Assigned}else{crate::world_execution::Status::Idle};
                if state.task.is_some()&&current.kind==Kind::Charge&&state.mode=="agent"{state.execution.task_needs_route=Some(true)}
            }
        }
        let mut next=current.clone();next.status=Status::Cancelled;next.reason=Some("cancel_requested".into());next.updated_tick=Some(now);
        if !next.valid(now,self.world_size)||!state.execution.valid(state.agent.distance){return Err(invalid())}
        let encoded=serde_json::json!({"ok":true,"duplicate":false,"clearedWait":cleared_wait}).to_string();
        if current.status==Status::Accepted{motion.commit_stationary(state.agent_index,state.agent,state.execution)?}
        self.actions[i]=next;self.last_tick=now;self.lifecycle_binding=Some(state.binding);self.activation_ticket=None;Ok(encoded)
    }
    #[napi]
    pub fn settle_travel(&mut self,action_index:f64,now:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,tasks:&mut crate::world_tasks::WorldTasks,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        let i=index(action_index)?;let now=tick(now)?;self.active()?;let current=self.actions.get(i).ok_or_else(invalid)?;
        if current.status!=Status::Accepted{return Err(invalid())}
        let mut state=self.lifecycle_state(&current.agent_id,current.resume_task_id.as_deref(),now,motion,environment,resources,tasks,control,ledger)?;
        if state.done{return Err(invalid())}
        let mut next=current.clone();let mut effects=Vec::<serde_json::Value>::new();let mut next_resources=None;let mut next_tasks=None;
        if state.execution.disabled{
            state.execution.route.clear();next.status=Status::Failed;next.reason=Some("agent_unavailable".into());next.updated_tick=Some(now);
            effects.push(serde_json::json!({"kind":"action_failed","reason":"agent_unavailable"}));
        }else{
            if !matches!(current.kind,Kind::Move|Kind::Charge)||current.kind==Kind::Charge&&current.phase!=Some(Phase::Travel)||state.execution.status!=crate::world_execution::Status::Manual{return Err(invalid())}
            if state.execution.lifecycle_waiting()||state.agent.battery>0.0&&state.execution.blocked_ticks.unwrap_or(0)<60&&!state.execution.route.is_empty(){self.lifecycle_binding=Some(state.binding);self.last_tick=now;return Ok("[]".into())}
            if state.agent.battery<=0.0{
                let mut dropped=false;
                if let Some(t)=&state.task{
                    let mut staged_resources=resources.clone();let result=staged_resources.work_command("abort",t,&state.agent,now)?;
                    dropped=result["dropped"].as_bool().ok_or_else(invalid)?;let released=result["released"].as_bool().ok_or_else(invalid)?;
                    let mut staged_tasks=tasks.clone();staged_tasks.command(serde_json::json!({"kind":"requeue","taskId":t.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?,"clearPhase":released}).to_string())?;
                    next_resources=Some(staged_resources);next_tasks=Some(staged_tasks);state.execution.work=0;
                }
                if current.kind==Kind::Move{effects.push(serde_json::json!({"kind":"action_failed","reason":"energy_depleted"}))}
                if dropped{effects.push(serde_json::json!({"kind":"part_dropped","taskId":state.task.as_ref().ok_or_else(invalid)?.id}))}
                if current.kind==Kind::Charge{effects.push(serde_json::json!({"kind":"action_failed","reason":"energy_depleted"}));state.execution.task_needs_route=None;}
                state.execution.disabled=true;state.execution.status=crate::world_execution::Status::Fault;state.execution.route.clear();
                next.status=Status::Failed;next.reason=Some("energy_depleted".into());next.updated_tick=Some(now);
                effects.push(serde_json::json!({"kind":"energy_depleted","actionId":current.request_id,"taskId":state.task.as_ref().map(|t|&t.id),"returning":current.kind==Kind::Charge}));
            }else if state.execution.blocked_ticks.unwrap_or(0)>=60{
                state.execution.route.clear();state.execution.status=if state.task.is_some(){crate::world_execution::Status::Assigned}else{crate::world_execution::Status::Idle};
                if current.kind==Kind::Charge{state.execution.task_needs_route=if state.task.is_some()&&state.mode=="agent"{Some(true)}else{None};}
                next.status=Status::Failed;next.reason=Some("collision_blocked".into());next.updated_tick=Some(now);effects.push(serde_json::json!({"kind":"action_failed","reason":"collision_blocked"}));
            }else if current.kind==Kind::Charge{
                if !environment.stationary_near_charger([state.agent.x,state.agent.y])?{return Err(invalid())}
                next.phase=Some(Phase::Waiting);
            }else{
                state.execution.status=if state.task.is_some(){crate::world_execution::Status::Assigned}else{crate::world_execution::Status::Idle};
                next.status=Status::Completed;next.updated_tick=Some(now);effects.push(serde_json::json!({"kind":"action_completed"}));
            }
        }
        if !next.valid(now,self.world_size)||!state.execution.valid(state.agent.distance){return Err(invalid())}
        let encoded=serde_json::to_string(&effects).map_err(|_|invalid())?;
        motion.commit_stationary(state.agent_index,state.agent,state.execution)?;
        if let Some(next)=next_resources{*resources=next}if let Some(next)=next_tasks{*tasks=next}
        self.actions[i]=next;self.last_tick=now;self.lifecycle_binding=Some(state.binding);self.activation_ticket=None;Ok(encoded)
    }
    #[napi]
    pub fn cancel_run(&mut self,now:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        let now=tick(now)?;self.active()?;let agents=motion.lifecycle_agents()?;if agents.len()!=self.agents.len(){return Err(invalid())}
        let mut binding=None;
        for(_,agent,_)in &agents{let state=self.lifecycle_state(&agent.id,None,now,motion,environment,resources,tasks,control,ledger)?;if !state.done{return Err(invalid())}if binding.is_some_and(|b|b!=state.binding){return Err(invalid())}binding=Some(state.binding);}
        let mut next_motion=motion.clone();let mut next=self.actions.clone();let mut effects=Vec::<serde_json::Value>::new();
        for(i,action)in next.iter_mut().enumerate(){if !matches!(action.status,Status::Pending|Status::Accepted){continue}
            let(index,agent,mut execution,_)=next_motion.activation_components(&action.agent_id)?;
            if action.status==Status::Accepted&&execution.status==crate::world_execution::Status::Manual{execution.status=crate::world_execution::Status::Idle;execution.route.clear();next_motion.commit_stationary(index,agent,execution)?;}
            action.status=Status::Cancelled;action.reason=Some("run_ended".into());action.updated_tick=Some(now);if !action.valid(now,self.world_size){return Err(invalid())}
            effects.push(serde_json::json!({"kind":"action_cancelled","index":i}));
        }
        for(index,agent,mut execution)in next_motion.lifecycle_agents()?{if let Some(wait)=execution.activation_clear_wait()?{effects.push(serde_json::json!({"kind":"wait_cancelled","agentId":agent.id,"wait":wait}));next_motion.commit_stationary(index,agent,execution)?;}}
        let encoded=serde_json::to_string(&effects).map_err(|_|invalid())?;
        *motion=next_motion;self.actions=next;self.last_tick=now;self.lifecycle_binding=binding;self.activation_ticket=None;Ok(encoded)
    }
    #[napi]
    pub fn cancel_intent_events(&mut self,action_index:f64,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,tasks:&mut crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{self.lifecycle_events(LifecycleEvent::Cancel(action_index),expected,motion,environment,resources,tasks,control,ledger)}
    #[napi]
    pub fn settle_travel_events(&mut self,action_index:f64,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,tasks:&mut crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{self.lifecycle_events(LifecycleEvent::Travel(action_index),expected,motion,environment,resources,tasks,control,ledger)}
    #[napi]
    pub fn cancel_run_events(&mut self,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,tasks:&mut crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{self.lifecycle_events(LifecycleEvent::Run,expected,motion,environment,resources,tasks,control,ledger)}
    #[napi]
    pub fn activate_planned_events(&mut self,action_index:f64,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let i=index(action_index)?;let now=tick(expected)?;
        // Preparation and planning stay private until the state/event commit.
        // A refused route or ledger append must not even replace a live lease.
        let state=self.activation_state(i,now,motion,environment,resources,tasks,control,ledger)?;
        environment.dispatch_context(now as u64,&motion.lifecycle_agents()?)?;
        let mut route=None;let mut wait=false;
        if let Some(goal)=state.goal{
            let reach=self.interaction_radius(&self.actions[i].request_id)?;
            route=environment.interaction_route(&state.agent.id,[state.agent.x,state.agent.y],goal,reach,true,false)?;
            if route.is_none()&&!state.air&&environment.activation_roadblock()?.is_some(){
                wait=environment.interaction_route(&state.agent.id,[state.agent.x,state.agent.y],goal,reach,false,false)?.is_some();
            }
        }
        let mut next=self.clone();
        let mut ticket=next.prepare_activation(action_index,expected,motion,environment,resources,tasks,control,ledger)?;
        let input=serde_json::json!({"route":route,"wait":wait}).to_string();
        let encoded=next.commit_activation_events(&mut ticket,input,motion,environment,resources,tasks,control,ledger)?;
        *self=next;Ok(encoded)
    }
    #[napi]
    pub fn prepare_activation(&mut self,action_index:f64,now:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<WorldActivationTicket>{
        let i=index(action_index)?;let now=tick(now)?;let state=self.activation_state(i,now,motion,environment,resources,tasks,control,ledger)?;
        let plan=serde_json::json!({"reason":state.reason,"goal":state.goal,"routeKind":state.route_kind}).to_string();let identity=crate::world_checkpoint::identity();
        self.activation_ticket=Some(identity);Ok(WorldActivationTicket{owner:self.checkpoint_id,identity,index:i,tick:now,binding:state.binding,fingerprint:state.fingerprint,plan,used:false})
    }
    #[napi]
    pub fn commit_activation(&mut self,ticket:&mut WorldActivationTicket,input:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        self.active()?;if ticket.used||ticket.owner!=self.checkpoint_id||self.activation_ticket!=Some(ticket.identity)||input.len()>256*1024{return Err(invalid())}
        let route:ActivationRoute=serde_json::from_str(&input).map_err(|_|invalid())?;
        let mut state=self.activation_state(ticket.index,ticket.tick,motion,environment,resources,tasks,control,ledger)?;
        if state.binding!=ticket.binding||state.fingerprint!=ticket.fingerprint{return Err(invalid())}
        if route.wait&&(route.route.is_some()||state.goal.is_none()||state.air||environment.activation_roadblock()?.is_none())||state.goal.is_none()&&(route.route.is_some()||route.wait){return Err(invalid())}
        let mut next=self.actions[ticket.index].clone();let mut cleared_wait=None;let mut started_wait=None;
        if state.reason.is_none()&&state.goal.is_some()&&route.route.is_none()&&!route.wait{state.reason=Some("unreachable_target".into())}
        if let Some(reason)=&state.reason{next.status=Status::Rejected;next.reason=Some(reason.clone());}
        else{
            let task_action=matches!(next.kind,Kind::ExecuteTask|Kind::WorkTask);
            if task_action{
                if next.kind==Kind::ExecuteTask&&state.execution.task_needs_route==Some(true){state.execution.route=route.route.unwrap_or_default();state.execution.task_needs_route=None;}
                state.execution.status=crate::world_execution::Status::Working;
            }else{
                let assigned_move=next.kind==Kind::Move&&state.mode=="primitive"&&state.assigned_task.is_some();let assigned_charge=next.kind==Kind::Charge&&matches!(state.mode,"agent"|"primitive")&&state.assigned_task.is_some();
                if assigned_charge{cleared_wait=state.execution.activation_clear_wait()?}
                state.execution.route=route.route.unwrap_or_default();if assigned_move||assigned_charge{next.resume_task_id=state.assigned_task.as_ref().map(|t|t.id.clone())}
                state.execution.status=crate::world_execution::Status::Manual;
                if matches!(next.kind,Kind::Scan|Kind::Rescue){next.progress=Some(0)}else if next.kind==Kind::Charge{next.phase=Some(Phase::Travel);next.energy_added=Some(0.0)}
            }
            next.status=Status::Accepted;
            if route.wait{
                let owner=if task_action{let t=state.task.as_ref().ok_or_else(invalid)?;Some((t.id.clone(),t.assignment_id.ok_or_else(invalid)?))}else{None};
                started_wait=Some(state.execution.activation_wait(state.goal.ok_or_else(invalid)?,environment.activation_roadblock()?.ok_or_else(invalid)?,ticket.tick,next.request_id.clone(),owner)?);
            }
        }
        next.updated_tick=Some(ticket.tick);
        if !next.valid(ticket.tick,self.world_size)||!state.execution.valid(state.agent.distance){return Err(invalid())}
        let encoded=serde_json::json!({"status":next.status,"reason":state.reason,"clearedWait":cleared_wait,"startedWait":started_wait}).to_string();
        if next.status==Status::Accepted{motion.commit_stationary(state.agent_index,state.agent,state.execution)?}
        self.actions[ticket.index]=next;self.last_tick=ticket.tick;self.activation_binding=Some(state.binding);self.activation_ticket=None;ticket.used=true;Ok(encoded)
    }
    #[napi]
    pub fn commit_activation_events(&mut self,ticket:&mut WorldActivationTicket,input:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        self.active()?;let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();let(t,_)=tasks.revocation_context("",&actors,&catalog)?;
        let(c,l,_)=control.task_events_context(ticket.tick,&ids,&catalog,ledger)?;self.ending_context(ticket.tick,&ids)?;let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(e,_)=environment.time_context(ticket.tick as u64,&ids)?;
        let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,_)=resources.proposal_catalog(ticket.tick as u64,&all,&roster)?;
        let binding=[m,e,r,t,c,l];if self.lifecycle_binding.is_some_and(|b|b!=binding)||self.activation_binding.is_some_and(|b|b!=binding)||self.stationary_binding.is_some_and(|b|b[..4]!=binding[..4]){return Err(invalid())}
        let mut next=self.clone();let mut next_motion=motion.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let mut staged_ticket=ticket.clone();
        let encoded=next.commit_activation(&mut staged_ticket,input,&mut next_motion,environment,resources,tasks,&next_control,&next_ledger)?;let result:serde_json::Value=serde_json::from_str(&encoded).map_err(|_|invalid())?;
        let action=next.actions.get(ticket.index).ok_or_else(invalid)?;let(_,agent,execution,_)=next_motion.activation_components(&action.agent_id)?;
        if action.status==Status::Accepted{if let Some(id)=action.task_id.as_deref().or(action.resume_task_id.as_deref()){let task=all.iter().find(|t|t.id==id&&t.status==crate::world_tasks::Status::Active&&t.assignee.as_deref()==Some(agent.id.as_str())).ok_or_else(invalid)?;resources.work_owner(task,&agent,&execution,ticket.tick)?;}}
        if !result["clearedWait"].is_null(){next_control.task_event(&mut next_ledger,Self::lifecycle_wait_fact(&execution.name,&action.agent_id,&result["clearedWait"])?)?;}
        if !matches!(action.status,Status::Accepted|Status::Rejected){return Err(invalid())}next_control.task_event(&mut next_ledger,Self::lifecycle_action_fact(action,&execution.name,action.status)?)?;
        if !result["startedWait"].is_null(){let wait=&result["startedWait"];next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 道路不可达，等待封闭解除",execution.name),"type":"warning","kind":"roadblock_wait_started","agentId":action.agent_id,"roadblockId":wait["roadblockId"],"goal":wait["goal"],"mode":wait["mode"]}))?;}
        next_control.validate_commit(&next_ledger)?;*self=next;*motion=next_motion;*control=next_control;*ledger=next_ledger;ticket.used=staged_ticket.used;Ok(encoded)
    }
    #[napi]
    pub fn advance_stationary(&mut self,action_index:f64,input:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks)->Result<String>{self.stationary(action_index,input,motion,environment,resources,tasks,None,false)}
    #[napi]
    pub fn advance_stationary_ray(&mut self,action_index:f64,input:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,physics:&crate::PhysicsWorld)->Result<String>{self.stationary(action_index,input,motion,environment,resources,tasks,Some(physics),false)}
    #[napi]
    pub fn advance_stationary_events(&mut self,action_index:f64,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{self.stationary_events(action_index,expected,motion,environment,resources,tasks,control,ledger,None)}
    #[napi]
    pub fn advance_stationary_events_ray(&mut self,action_index:f64,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,physics:&crate::PhysicsWorld)->Result<String>{self.stationary_events(action_index,expected,motion,environment,resources,tasks,control,ledger,Some(physics))}
    #[napi]
    pub fn free(&mut self){self.closed=true;self.actions.clear();self.actions.shrink_to_fit();self.agents.clear();self.agents.shrink_to_fit();self.indices.clear();self.indices.shrink_to_fit();self.stationary_ticks.clear();self.stationary_binding=None;self.activation_binding=None;self.activation_ticket=None;self.lifecycle_binding=None;}
}

crate::world_checkpoint::world_checkpoint!(WorldActions);
