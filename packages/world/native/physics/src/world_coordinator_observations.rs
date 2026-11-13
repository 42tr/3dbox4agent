//! Coordinator protocol view from actual bound stores. Inputs are identities and
//! clock only; no host snapshot, candidate list, report proof or route is accepted.
use super::*;
use crate::{world_motion::WorldMotion,world_environment::WorldEnvironment,world_tasks::WorldTasks,world_actions::WorldActions,world_resources::WorldResources,world_peer::WorldPeer,world_reports::WorldReports,world_perceptions::WorldPerceptions,world_dispatch::WorldDispatch,world_requests::WorldRequests};
use serde_json::json;
fn value(input:String)->Result<Value>{serde_json::from_str(&input).map_err(|_|invalid())}
impl WorldControl {
 pub(super) fn coordinator_context(&self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger)->Result<[u64;11]>{
  let base=self.observation_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,ledger)?;if self.observation_binding!=Some(base){return Err(invalid())}let now=self.linked(ledger)?;
  let d=dispatch.coordinator_identity(now as f64,motion,environment,tasks,resources,actions,peer,reports,self,ledger)?;
  let actors=motion.lifecycle_agents()?;let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let r=requests.coordinator_catalog(now,&catalog,&roster,[self.checkpoint_id,self.ledger_id])?;
  let mut binding=[0;11];binding[..9].copy_from_slice(&base);binding[9]=d;binding[10]=r;Ok(binding)
 }
}
#[napi]
impl WorldControl {
 #[napi]
 pub fn bind_coordinator_observations(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&mut WorldDispatch,requests:&mut WorldRequests,ledger:&WorldLedger)->Result<()>{
  let base=self.observation_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,ledger)?;if self.observation_binding!=Some(base){return Err(invalid())}let now=self.linked(ledger)?;let mut next_dispatch=dispatch.clone();let mut next_requests=requests.clone();
  next_dispatch.bind_coordinator_reads(now as f64,motion,environment,tasks,resources,actions,peer,reports,self,ledger)?;let actors=motion.lifecycle_agents()?;let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();next_requests.bind_coordinator_reads(now,&catalog,&roster,[self.checkpoint_id,self.ledger_id])?;
  let binding=self.coordinator_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,&next_dispatch,&next_requests,ledger)?;if self.coordinator_binding.is_some_and(|old|old!=binding){return Err(invalid())}*dispatch=next_dispatch;*requests=next_requests;self.coordinator_binding=Some(binding);Ok(())
 }
 #[napi]
 pub fn coordinator_observations_bound(&self)->Result<bool>{self.active()?;Ok(self.coordinator_binding.is_some())}
 #[napi]
 pub fn coordinator_observation(&self,expected:f64,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,dispatch:&WorldDispatch,requests:&WorldRequests,ledger:&WorldLedger)->Result<String>{
  let binding=self.coordinator_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,dispatch,requests,ledger)?;let now=self.linked(ledger)?;if self.coordinator_binding!=Some(binding)||expected!=now as f64{return Err(invalid())}
  let actors=motion.lifecycle_agents()?;let mut roles=Vec::new();for(_,_,e)in &actors{if e.capabilities.iter().any(|c|c=="inspect")&&!roles.contains(&e.role){roles.push(e.role.clone())}}
  let report=reports.coordinator_reports(now,&roles)?;let statuses=report["statusReports"].as_array().ok_or_else(invalid)?;let ready=dispatch.coordinator_tasks(expected,motion,environment,tasks,resources,actions,peer,reports,self,ledger,statuses)?;let mode=self.dispatch_mode()?;let reported=mode=="networked_reported";let max_age=if reported{reporting_age(&report["reporting"])?}else{0};let(all,_)=tasks.ending_tasks()?;
  let mut active=Vec::new();for t in all.iter().filter(|t|t.status==crate::world_tasks::Status::Active){let v=serde_json::to_value(t).map_err(|_|invalid())?;let mut row=json!({"id":t.id,"name":v["name"],"assignee":t.assignee});if let Some(id)=t.assignment_id{row["assignmentId"]=id.into()}
   if reported{let matched=statuses.iter().find(|r|r["id"]==v["assignee"]&&r["activeAssignment"]["taskId"]==v["id"]&&r["activeAssignment"]["assignmentId"]==v["assignmentId"]);row["statusReport"]=if let Some(r)=matched{let captured=r["capturedTick"].as_u64().ok_or_else(invalid)?;let age=now-captured;json!({"status":r["status"],"routeBlockedSince":r["routeBlockedSince"],"capturedTick":captured,"receivedTick":r["receivedTick"],"age":age,"fresh":age<=max_age})}else{Value::Null};}active.push(row)
  }
  let dispatch=value(dispatch.snapshot()?)?;let request=value(requests.snapshot()?)?;let mut out=json!({"version":1,"tick":now,"done":ledger.done()?,"failed":ledger.failed()?,"tasks":ready,"active":active,"decisions":dispatch["decisions"].as_array().into_iter().flatten().filter(|d|d["actor"]=="external").collect::<Vec<_>>(),"revocations":request.get("revocations").cloned().unwrap_or(json!([])),"proposals":request.get("proposals").cloned().unwrap_or(json!([])),"evidence":report["evidence"],"sampleReports":report["sampleReports"],"fixedSensorReports":report["fixedSensorReports"],"knownTasks":all.iter().map(|t|{let v=serde_json::to_value(t).map_err(|_|invalid())?;Ok(json!({"id":t.id,"name":v["name"],"status":t.status}))}).collect::<Result<Vec<_>>>()?});
  if environment.world_size()!=100.0{out["worldSize"]=json!(environment.world_size());}if reported{if report["reporting"].is_null(){return Err(invalid())}out["reporting"]=report["reporting"].clone()}encode(&out)
 }
}
fn reporting_age(report:&Value)->Result<u64>{report["maxAge"].as_u64().ok_or_else(invalid)}
