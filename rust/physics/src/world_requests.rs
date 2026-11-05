//! Owned coordinator proposal/revocation identities, admission and terminal histories.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
const MAX_TICK:u64=10_000_000;
const MAX_ID:u64=9_007_199_254_740_991;
fn invalid()->Error{Error::from_reason("invalid world coordinator requests")}
fn token(s:&str,max:usize)->bool{!s.is_empty()&&s.len()<=max&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
fn blank(s:&str)->bool{s.chars().all(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))}
fn point(p:&[f64;2])->bool{p.iter().all(|n|n.is_finite()&&(0.0..=100.0).contains(n))}
fn decode<T:for<'a> Deserialize<'a>>(s:&str)->Result<T>{if s.len()>16*1024*1024{return Err(invalid())}serde_json::from_str(s).map_err(|_|invalid())}
fn encode<T:Serialize>(v:&T)->Result<String>{serde_json::to_string(v).map_err(|_|invalid())}
fn clock(t:f64)->Result<u64>{if !t.is_finite()||t.fract()!=0.0||!(0.0..=MAX_TICK as f64).contains(&t){Err(invalid())}else{Ok(t as u64)}}
fn owner(o:&Option<String>)->bool{o.as_ref().is_none_or(|s|token(s,40))}
fn no(reason:&str)->Result<String>{encode(&json!({"ok":false,"reason":reason}))}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum SurveyBehavior{Survey}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Inspect{Inspect}
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Survey{
 id:String,behavior:SurveyBehavior,name:String,role:String,capability:Inspect,target:[f64;2],duration:u64,depends_on:Vec<String>,
 #[serde(skip_serializing_if="Option::is_none")]priority:Option<u32>,
 #[serde(skip_serializing_if="Option::is_none")]deadline:Option<u64>,
}
impl Survey{fn valid(&self,max_duration:u64)->bool{token(&self.id,64)&&!matches!(self.id.as_str(),"__proto__"|"constructor"|"prototype")&&!blank(&self.name)&&self.name.encode_utf16().count()<=100&&token(&self.role,48)&&point(&self.target)&&(1..=max_duration).contains(&self.duration)&&self.depends_on.len()<=100&&self.depends_on.iter().all(|s|token(s,64))&&self.depends_on.iter().collect::<HashSet<_>>().len()==self.depends_on.len()&&self.priority.is_none_or(|n|n<=100)&&self.deadline.is_none_or(|n|(1..=MAX_TICK).contains(&n))}}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum Terminal{Accepted,Rejected}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum ProposalReason{StaleObservation,TaskLimit,DuplicateTask,UnknownDependency,UnsupportedRole,EvidenceUnavailable,EvidenceStale,EvidenceMismatch}
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct ProposalInput{
 request_id:String,observed_tick:u64,task:Survey,
 #[serde(skip_serializing_if="Option::is_none")]evidence_id:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]sensor_evidence_id:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]sample_report_id:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]coordinator_id:Option<String>,
}
impl ProposalInput{fn valid(&self)->bool{token(&self.request_id,64)&&self.observed_tick<=MAX_ID&&self.task.valid(1000)&&owner(&self.coordinator_id)&&[self.evidence_id,self.sensor_evidence_id,self.sample_report_id].iter().flatten().all(|n|(1..=MAX_ID).contains(n))&&[self.evidence_id,self.sensor_evidence_id,self.sample_report_id].iter().flatten().count()<=1}}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Proposal{
 request_id:String,observed_tick:u64,applied_tick:u64,status:Terminal,task:Survey,
 #[serde(skip_serializing_if="Option::is_none")]evidence_id:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]sensor_evidence_id:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]sample_report_id:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]reason:Option<ProposalReason>,
 #[serde(skip_serializing_if="Option::is_none")]coordinator_id:Option<String>,
}
impl Proposal{fn input(&self)->ProposalInput{ProposalInput{request_id:self.request_id.clone(),observed_tick:self.observed_tick,task:self.task.clone(),evidence_id:self.evidence_id,sensor_evidence_id:self.sensor_evidence_id,sample_report_id:self.sample_report_id,coordinator_id:self.coordinator_id.clone()}}}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
enum RevocationReason{StaleObservation,AssignmentChanged,RouteConditionChanged}
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct RevokeInput{
 request_id:String,task_id:String,agent_id:String,assignment_id:u64,observed_tick:u64,
 #[serde(skip_serializing_if="Option::is_none")]require_blocked_since:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]coordinator_id:Option<String>,
}
impl RevokeInput{fn valid(&self)->bool{token(&self.request_id,64)&&token(&self.task_id,64)&&token(&self.agent_id,64)&&(1..=MAX_ID).contains(&self.assignment_id)&&self.observed_tick<=MAX_ID&&self.require_blocked_since.is_none_or(|n|n<=self.observed_tick)&&owner(&self.coordinator_id)}}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Revocation{
 request_id:String,task_id:String,agent_id:String,assignment_id:u64,observed_tick:u64,
 #[serde(skip_serializing_if="Option::is_none")]require_blocked_since:Option<u64>,
 applied_tick:u64,status:Terminal,
 #[serde(skip_serializing_if="Option::is_none")]reason:Option<RevocationReason>,
 #[serde(skip_serializing_if="Option::is_none")]coordinator_id:Option<String>,
}
impl Revocation{fn input(&self)->RevokeInput{RevokeInput{request_id:self.request_id.clone(),task_id:self.task_id.clone(),agent_id:self.agent_id.clone(),assignment_id:self.assignment_id,observed_tick:self.observed_tick,require_blocked_since:self.require_blocked_since,coordinator_id:self.coordinator_id.clone()}}}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct State{
 #[serde(skip_serializing_if="Option::is_none")]proposals:Option<Vec<Proposal>>,
 #[serde(skip_serializing_if="Option::is_none")]revocations:Option<Vec<Revocation>>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Agent{id:String,role:String,can_survey:bool}
#[derive(Clone,Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogTask{id:String,survey:Option<Survey>}
#[derive(Clone,Copy,PartialEq,Deserialize)]
#[serde(rename_all="snake_case")]
enum ProofKind{Scan,Fixed,Sample}
#[derive(Clone,Copy,PartialEq,Deserialize)]
#[serde(rename_all="snake_case")]
enum ReportStatus{Pending,Delivered,Failed}
#[derive(Clone,Copy,PartialEq,Deserialize)]
#[serde(rename_all="snake_case")]
enum ResultKind{Anomaly,Normal,NotDetected}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Proof{kind:ProofKind,id:u64,status:ReportStatus,received_tick:Option<u64>,observed_tick:u64,position:Option<[f64;2]>,result:Option<ResultKind>,role:Option<String>,can_survey:Option<bool>}
impl Proof{fn valid(&self,tick:u64)->bool{(1..=MAX_ID).contains(&self.id)&&self.observed_tick<=tick&&self.received_tick.is_none_or(|t|t>=self.observed_tick&&t<=tick)&&self.position.as_ref().is_none_or(point)&&match self.kind{
 ProofKind::Scan=>self.role.as_ref().is_some_and(|s|token(s,48))&&self.can_survey.is_some()&&self.result.is_some()&&(self.result==Some(ResultKind::NotDetected))==self.position.is_none()&&(self.status==ReportStatus::Pending)==self.received_tick.is_none(),
 ProofKind::Fixed=>self.status==ReportStatus::Delivered&&self.received_tick.is_some()&&self.position.is_some()&&matches!(self.result,Some(ResultKind::Anomaly|ResultKind::Normal))&&self.role.is_none()&&self.can_survey.is_none(),
 ProofKind::Sample=>self.position.is_some()&&self.result.is_none()&&self.role.is_none()&&self.can_survey.is_none()&&(self.status==ReportStatus::Pending)==self.received_tick.is_none(),
}}}
#[derive(Clone,Copy,Deserialize)]
#[serde(rename_all="snake_case")]
enum Mode{Rule,Networked,External,NetworkedExternal,NetworkedReported}
impl Mode{fn external(self)->bool{matches!(self,Self::External|Self::NetworkedExternal|Self::NetworkedReported)}}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposalContext{done:bool,mode:Mode,proof:Option<Proof>}
#[derive(Clone,Copy,PartialEq,Deserialize)]
#[serde(rename_all="snake_case")]
enum TaskStatus{Pending,Active,Done}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct LiveTask{id:String,status:TaskStatus,assignee:Option<String>,assignment_id:Option<u64>}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct LiveAgent{id:String,blocked_since:Option<u64>}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeContext{done:bool,mode:Mode,task:Option<LiveTask>,agent:Option<LiveAgent>}
#[derive(Clone,Copy,PartialEq,Deserialize)]
#[serde(rename_all="snake_case")]
enum EventKind{TaskRevoked,RevocationRejected}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Event{kind:EventKind,tick:u64,request_id:String,task_id:String,agent_id:String,assignment_id:Option<u64>,reason:Option<RevocationReason>,coordinator_id:Option<String>}
impl Event{fn matches(&self,r:&Revocation)->bool{self.tick==r.applied_tick&&self.request_id==r.request_id&&self.task_id==r.task_id&&self.agent_id==r.agent_id&&self.coordinator_id==r.coordinator_id&&match r.status{Terminal::Accepted=>self.kind==EventKind::TaskRevoked&&self.assignment_id==Some(r.assignment_id)&&self.reason.is_none(),Terminal::Rejected=>self.kind==EventKind::RevocationRejected&&self.reason==r.reason}}}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PostAgent{id:String,idle:bool,route_empty:bool,work:f64,unsettled_actions:bool}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack{task:Option<LiveTask>,agent:Option<PostAgent>,event:Option<Event>}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Initial{tick:u64,decision_max_age:u64,agents:Vec<Agent>,tasks:Vec<CatalogTask>,state:State,proposal_proofs:Vec<Option<Proof>>,revocation_events:Vec<Option<Event>>}
#[napi]
#[derive(Clone)]
pub struct WorldRequests{
    checkpoint_id: u64,state:State,agents:Vec<Agent>,tasks:Vec<CatalogTask>,max_age:u64,tick:u64,pending:Option<(u64,Revocation)>,next_ticket:u64,revocation_binding:Option<[u64;7]>,proposal_binding:Option<[u64;7]>,read_owner:Option<[u64;2]>,closed:bool}
impl WorldRequests{
 pub(crate) fn coordinator_catalog(&self,now:u64,catalog:&[String],roster:&[(String,String,bool)],owner:[u64;2])->Result<u64>{self.time(now as f64)?;if self.read_owner!=Some(owner)||self.tasks.iter().map(|t|&t.id).ne(catalog.iter())||self.agents.len()!=roster.len()||self.agents.iter().zip(roster).any(|(a,(id,role,survey))|&a.id!=id||&a.role!=role||a.can_survey!=*survey){return Err(invalid())}Ok(self.checkpoint_id)}
 pub(crate) fn bind_coordinator_reads(&mut self,now:u64,catalog:&[String],roster:&[(String,String,bool)],owner:[u64;2])->Result<u64>{if self.read_owner.is_some_and(|old|old!=owner){return Err(invalid())}let mut next=self.clone();next.read_owner=Some(owner);let id=next.coordinator_catalog(now,catalog,roster,owner)?;*self=next;Ok(id)}
 fn time(&self,t:f64)->Result<u64>{self.check()?;let t=clock(t)?;if t<self.tick{return Err(invalid())}Ok(t)}
 fn check(&self)->Result<()>{if self.closed{Err(Error::from_reason("world coordinator requests are closed"))}else{Ok(())}}
 fn proposals(&self)->impl Iterator<Item=&Proposal>{self.state.proposals.iter().flatten()}
 fn revocations(&self)->impl Iterator<Item=&Revocation>{self.state.revocations.iter().flatten()}
 fn proof_matches(p:&ProposalInput,proof:&Proof)->bool{match proof.kind{ProofKind::Scan=>p.evidence_id==Some(proof.id),ProofKind::Fixed=>p.sensor_evidence_id==Some(proof.id),ProofKind::Sample=>p.sample_report_id==Some(proof.id)}}
 fn proposal_reason(&self,p:&ProposalInput,proof:Option<&Proof>,tick:u64)->Option<ProposalReason>{
  if p.observed_tick>tick||tick-p.observed_tick>self.max_age{return Some(ProposalReason::StaleObservation)}
  if self.tasks.len()>=100{return Some(ProposalReason::TaskLimit)}
  if self.tasks.iter().any(|t|t.id==p.task.id){return Some(ProposalReason::DuplicateTask)}
  if p.task.depends_on.iter().any(|id|!self.tasks.iter().any(|t|&t.id==id)){return Some(ProposalReason::UnknownDependency)}
  if !self.agents.iter().any(|a|a.role==p.task.role&&a.can_survey){return Some(ProposalReason::UnsupportedRole)}
  if p.evidence_id.is_some()||p.sensor_evidence_id.is_some()||p.sample_report_id.is_some(){
   let Some(proof)=proof else{return Some(ProposalReason::EvidenceUnavailable)};
   if proof.status!=ReportStatus::Delivered||proof.received_tick.is_none_or(|t|t>p.observed_tick){return Some(ProposalReason::EvidenceUnavailable)}
   if tick-proof.observed_tick>60{return Some(ProposalReason::EvidenceStale)}
   if proof.position!=Some(p.task.target)||proof.kind!=ProofKind::Sample&&proof.result!=Some(ResultKind::Anomaly)||proof.kind==ProofKind::Scan&&(proof.can_survey!=Some(true)||proof.role.as_ref()!=Some(&p.task.role)){return Some(ProposalReason::EvidenceMismatch)}
  }None
 }
 fn revoke_reason(&self,p:&RevokeInput,c:&RevokeContext,tick:u64)->Option<RevocationReason>{
  if p.observed_tick>tick||tick-p.observed_tick>self.max_age{return Some(RevocationReason::StaleObservation)}
  if c.task.as_ref().is_none_or(|t|t.status!=TaskStatus::Active||t.assignee.as_ref()!=Some(&p.agent_id)||t.assignment_id!=Some(p.assignment_id))||c.agent.is_none(){return Some(RevocationReason::AssignmentChanged)}
  if p.require_blocked_since.is_some_and(|t|c.agent.as_ref().and_then(|a|a.blocked_since)!=Some(t)){return Some(RevocationReason::RouteConditionChanged)}None
 }
}
#[napi]
impl WorldRequests{
 #[napi(constructor)]
 pub fn new(input:String)->Result<Self>{
  let i:Initial=decode(&input)?;
  if i.tick>MAX_TICK||!(1..=10000).contains(&i.decision_max_age)||i.agents.is_empty()||i.agents.len()>50||i.tasks.is_empty()||i.tasks.len()>100||i.state.proposals.as_ref().is_some_and(|r|r.len()>1000)||i.state.revocations.as_ref().is_some_and(|r|r.len()>1000){return Err(invalid())}
  let mut ids=HashSet::new();for a in &i.agents{if !token(&a.id,64)||!token(&a.role,48)||!ids.insert(&a.id){return Err(invalid())}}
  ids.clear();for t in &i.tasks{if !token(&t.id,64)||!ids.insert(&t.id)||t.survey.as_ref().is_some_and(|s|s.id!=t.id||!s.valid(10000)){return Err(invalid())}}
  let proposals=i.state.proposals.clone().unwrap_or_default();let dynamic:HashSet<_>=proposals.iter().filter(|p|p.status==Terminal::Accepted).map(|p|p.task.id.as_str()).collect();
  if proposals.len()!=i.proposal_proofs.len()||i.state.revocations.as_ref().map_or(0,Vec::len)!=i.revocation_events.len(){return Err(invalid())}
  let base=i.tasks.iter().filter(|t|!dynamic.contains(t.id.as_str())).cloned().collect();
  let mut w=Self{ checkpoint_id: crate::world_checkpoint::identity(),state:State{proposals:None,revocations:None},agents:i.agents,tasks:base,max_age:i.decision_max_age,tick:i.tick,pending:None,next_ticket:1,revocation_binding:None,proposal_binding:None,read_owner:None,closed:false};
  let mut seen=HashSet::new();let mut last=0;
  for (p,proof) in proposals.iter().zip(&i.proposal_proofs){
   let intent=p.input();if !intent.valid()||!seen.insert(&p.request_id)||p.applied_tick<last||p.applied_tick>i.tick||proof.as_ref().is_some_and(|f|!f.valid(i.tick)||!Self::proof_matches(&intent,f)){return Err(invalid())}
   let reason=w.proposal_reason(&intent,proof.as_ref(),p.applied_tick);
   if reason!=p.reason||(reason.is_none())!=(p.status==Terminal::Accepted){return Err(invalid())}
   if p.status==Terminal::Accepted{if !i.tasks.iter().any(|t|t.id==p.task.id&&t.survey.as_ref()==Some(&p.task)){return Err(invalid())}w.tasks.push(CatalogTask{id:p.task.id.clone(),survey:Some(p.task.clone())})}last=p.applied_tick;
  }
  if w.tasks.len()!=i.tasks.len(){return Err(invalid())}
  let revocations=i.state.revocations.as_ref().map(Vec::as_slice).unwrap_or(&[]);seen.clear();last=0;
  for (r,event) in revocations.iter().zip(&i.revocation_events){
   let fresh=r.observed_tick<=r.applied_tick&&r.applied_tick-r.observed_tick<=w.max_age;
   if !r.input().valid()||!seen.insert(&r.request_id)||r.applied_tick<last||r.applied_tick>i.tick||event.as_ref().is_none_or(|e|!e.matches(r))||(r.status==Terminal::Accepted)!=r.reason.is_none()||r.reason==Some(RevocationReason::StaleObservation)&&fresh||r.reason!=Some(RevocationReason::StaleObservation)&&!fresh||r.reason==Some(RevocationReason::RouteConditionChanged)&&r.require_blocked_since.is_none()||r.status==Terminal::Accepted&&(!w.tasks.iter().any(|t|t.id==r.task_id)||!w.agents.iter().any(|a|a.id==r.agent_id)){return Err(invalid())}last=r.applied_tick;
  }
  w.state=i.state;Ok(w)
 }
 #[napi]
 pub fn snapshot(&self)->Result<String>{self.check()?;encode(&self.state)}
 #[napi]
 pub fn propose_world(&mut self,input:String,tick:f64,tasks:&mut crate::world_tasks::WorldTasks,resources:&mut crate::world_resources::WorldResources,perceptions:&mut crate::world_perceptions::WorldPerceptions,dispatch:&mut crate::world_dispatch::WorldDispatch,reports:&crate::world_reports::WorldReports,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
  let tick=self.time(tick)?;let p:ProposalInput=decode(&input)?;if self.pending.is_some()||!p.valid(){return Err(invalid())}
  if let Some(prior)=self.proposals().find(|r|r.request_id==p.request_id){return if prior.input()==p{encode(&json!({"ok":true,"duplicate":true,"proposal":prior}))}else{no("request_id_conflict")}}
  let ids:Vec<_>=self.agents.iter().map(|a|a.id.clone()).collect();let catalog:Vec<_>=self.tasks.iter().map(|t|t.id.clone()).collect();let agents:Vec<_>=self.agents.iter().map(|a|(a.id.clone(),a.role.clone(),a.can_survey)).collect();
  let(c_id,l_id,done,external)=control.proposal_context(tick as u32,&ids,&catalog,ledger)?;if done{return no("world_finished")}if !external{return no("external_mode_required")}if self.proposals().count()>=1000{return no("proposal_limit")}
  let(t_id,owned)=tasks.proposal_catalog(&catalog,&agents)?;let(r_id,site)=resources.proposal_catalog(tick,&owned,&agents)?;let p_id=perceptions.proposal_catalog(tick as u32,&owned,&agents)?;let d_id=dispatch.proposal_catalog(tick,&catalog,&ids)?;
  let(kind,id)=if let Some(id)=p.evidence_id{(Some("scan"),Some(id))}else if let Some(id)=p.sensor_evidence_id{(Some("fixed"),Some(id))}else if let Some(id)=p.sample_report_id{(Some("sample"),Some(id))}else{(None,None)};
  let(report_id,proof)=reports.proposal_proof(tick,&agents,site,kind,id,ledger)?;let proof:Option<Proof>=proof.map(serde_json::from_value).transpose().map_err(|_|invalid())?;
  if proof.as_ref().is_some_and(|f|!f.valid(tick)||!Self::proof_matches(&p,f)){return Err(invalid())}
  let binding=[t_id,r_id,p_id,d_id,report_id,c_id,l_id];
  if self.proposal_binding.is_some_and(|b|b!=binding)||self.revocation_binding.is_some_and(|b|b[3]!=t_id||b[2]!=r_id||b[5]!=c_id||b[6]!=l_id){return Err(invalid())}
  let reason=self.proposal_reason(&p,proof.as_ref(),tick);let row=Proposal{request_id:p.request_id.clone(),observed_tick:p.observed_tick,applied_tick:tick,status:if reason.is_some(){Terminal::Rejected}else{Terminal::Accepted},task:p.task.clone(),evidence_id:p.evidence_id,sensor_evidence_id:p.sensor_evidence_id,sample_report_id:p.sample_report_id,reason,coordinator_id:p.coordinator_id.clone()};
  let mut next=self.clone();let mut next_tasks=tasks.clone();let mut next_resources=resources.clone();let mut next_perceptions=perceptions.clone();let mut next_dispatch=dispatch.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
  let mut event=json!({"requestId":p.request_id,"taskId":p.task.id});
  if let Some(id)=p.evidence_id{event["evidenceId"]=json!(id)}if let Some(id)=p.sensor_evidence_id{event["sensorEvidenceId"]=json!(id)}if let Some(id)=p.sample_report_id{event["sampleReportId"]=json!(id)}if let Some(owner)=&p.coordinator_id{event["coordinatorId"]=json!(owner)}
  if row.status==Terminal::Accepted{
   let mut task=serde_json::to_value(&p.task).map_err(|_|invalid())?;task["status"]=json!("pending");task["assignee"]=serde_json::Value::Null;next_tasks.append(encode(&task)?)?;
   next_dispatch.register_task(p.task.id.clone(),tick as f64)?;
   next_resources.register(encode(&json!({"id":p.task.id,"behavior":"survey","role":p.task.role,"capability":"inspect","target":p.task.target,"status":"pending","assignee":null}))?,tick as f64)?;
   next_perceptions.register(encode(&json!({"id":p.task.id,"target":p.task.target}))?,tick as u32)?;next_control.register_task(p.task.id.clone(),&next_ledger)?;
   next.tasks.push(CatalogTask{id:p.task.id.clone(),survey:Some(p.task.clone())});let suffix=if let Some(id)=p.evidence_id{format!("（报告 #{}）",id)}else if let Some(id)=p.sensor_evidence_id{format!("（固定传感器报告 #{}）",id)}else if let Some(id)=p.sample_report_id{format!("（采样报告 #{}）",id)}else{String::new()};
   event["message"]=json!(format!("新增临时勘察任务「{}」{}",p.task.name,suffix));event["type"]=json!("info");event["kind"]=json!("task_proposed");
  }else{event["message"]=json!("临时勘察任务提案被拒绝");event["type"]=json!("warning");event["kind"]=json!("proposal_rejected");event["reason"]=json!(reason);}
  let saved:serde_json::Value=decode(&next_ledger.append(encode(&event)?)?)?;next_control.observe(saved["seq"].as_f64().ok_or_else(invalid)?,&next_ledger)?;
  next.state.proposals.get_or_insert_with(Vec::new).push(row.clone());next.tick=tick;next.proposal_binding=Some(binding);next.validate_commit()?;next_control.validate_commit(&next_ledger)?;let encoded=encode(&json!({"ok":true,"duplicate":false,"proposal":row}))?;
  *tasks=next_tasks;*resources=next_resources;*perceptions=next_perceptions;*dispatch=next_dispatch;*control=next_control;*ledger=next_ledger;*self=next;Ok(encoded)
 }
 #[napi]
 pub fn revoke(&mut self,input:String,tick:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,tasks:&mut crate::world_tasks::WorldTasks,actions:&mut crate::world_actions::WorldActions,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
  let tick=self.time(tick)?;let p:RevokeInput=decode(&input)?;if self.pending.is_some()||!p.valid(){return Err(invalid())}
  if let Some(prior)=self.revocations().find(|r|r.request_id==p.request_id){return if prior.input()==p{encode(&json!({"ok":true,"duplicate":true,"revocation":prior}))}else{no("request_id_conflict")}}
  let agents=motion.lifecycle_agents()?;let ids:Vec<_>=agents.iter().map(|(_,a,_)|a.id.clone()).collect();
  if agents.len()!=self.agents.len()||agents.iter().zip(&self.agents).any(|((_,a,e),s)|a.id!=s.id||e.role!=s.role||e.capabilities.iter().any(|c|c=="inspect")!=s.can_survey){return Err(invalid())}
  let(c_id,l_id,done,external)=control.revocation_context(tick as u32,&ids,ledger)?;
  if done{return no("world_finished")}if !external{return no("external_mode_required")}if self.revocations().count()>=1000{return no("revocation_limit")}
  let catalog:Vec<_>=self.tasks.iter().map(|t|t.id.clone()).collect();let(t_id,task)=tasks.revocation_context(&p.task_id,&agents,&catalog)?;
  let actor=agents.iter().find(|(_,a,_)|a.id==p.agent_id).cloned();let mut env_id=None;
  for(i,a,_)in &agents{let id=environment.stationary_identity(*i,&a.id,tick)?;if env_id.is_some_and(|old|old!=id){return Err(invalid())}env_id=Some(id)}
  let(_,_,_,m_id)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(r_id,_)=resources.assignment_context(task.as_ref(),tick as u32)?;let a_id=actions.interruption_identity(&ids,tick as u32)?;
  let binding=[m_id,env_id.ok_or_else(invalid)?,r_id,t_id,a_id,c_id,l_id];if self.revocation_binding.is_some_and(|old|old!=binding)||self.proposal_binding.is_some_and(|b|b[0]!=t_id||b[1]!=r_id||b[5]!=c_id||b[6]!=l_id){return Err(invalid())}
  let c=RevokeContext{done,mode:Mode::External,task:task.as_ref().map(|t|LiveTask{id:t.id.clone(),status:match t.status{crate::world_tasks::Status::Pending=>TaskStatus::Pending,crate::world_tasks::Status::Active=>TaskStatus::Active,crate::world_tasks::Status::Done=>TaskStatus::Done},assignee:t.assignee.clone(),assignment_id:t.assignment_id.map(u64::from)}),agent:actor.as_ref().map(|(_,a,e)|LiveAgent{id:a.id.clone(),blocked_since:task.as_ref().and_then(|t|e.task_blocked_since(t,actions)).map(u64::from)})};
  let reason=self.revoke_reason(&p,&c,tick);let row=Revocation{request_id:p.request_id.clone(),task_id:p.task_id.clone(),agent_id:p.agent_id.clone(),assignment_id:p.assignment_id,observed_tick:p.observed_tick,require_blocked_since:p.require_blocked_since,applied_tick:tick,status:if reason.is_some(){Terminal::Rejected}else{Terminal::Accepted},reason,coordinator_id:p.coordinator_id.clone()};
  let mut next=self.clone();let mut next_motion=motion.clone();let mut next_tasks=tasks.clone();let mut next_actions=actions.clone();let mut next_resources=resources.clone();let mut next_ledger=ledger.clone();let mut next_control=control.clone();let mut events=Vec::new();
  if row.status==Terminal::Accepted{
   let t=task.ok_or_else(invalid)?;let(index,agent,mut execution)=actor.ok_or_else(invalid)?;
   events.extend(next_actions.revoke_actor(&agent.id,&execution.name,tick as u32,[m_id,binding[1],r_id,t_id,c_id,l_id])?);
   let aborted=next_resources.work_command("abort",&t,&agent,tick as u32)?;
   if aborted["dropped"].as_bool().ok_or_else(invalid)?{events.push(json!({"message":"运输中断，备件留在当前位置","type":"warning","kind":"part_dropped","agentId":agent.id,"taskId":t.id}))}
   if let Some(wait)=execution.activation_clear_wait()?{events.push(json!({"message":format!("{} 结束道路等待",execution.name),"type":"info","kind":"roadblock_wait_ended","agentId":agent.id,"roadblockId":wait["roadblockId"],"startedTick":wait["startedTick"],"outcome":"cancelled"}))}
   next_tasks.revoke_owned(&t,[m_id,binding[1],r_id,a_id,c_id,l_id])?;execution.status=crate::world_execution::Status::Idle;execution.route.clear();execution.work=0;execution.blocked_ticks=Some(0);execution.task_needs_route=None;next_motion.commit_stationary(index,agent,execution)?;
   let task_name=serde_json::to_value(&t).map_err(|_|invalid())?;events.push(json!({"message":format!("「{}」已撤回，等待重新分配",task_name["name"].as_str().ok_or_else(invalid)?),"type":"warning","kind":"task_revoked","requestId":p.request_id,"taskId":p.task_id,"agentId":p.agent_id,"assignmentId":p.assignment_id}));
  }else{events.push(json!({"message":"任务撤回被拒绝","type":"warning","kind":"revocation_rejected","requestId":p.request_id,"taskId":p.task_id,"agentId":p.agent_id,"reason":reason}));}
  // Event prefix, derived counters and the request record join the same staged
  // commit; the host cannot acknowledge fabricated post-state or event facts.
  for mut event in events{if event.get("requestId").and_then(serde_json::Value::as_str)==Some(&p.request_id){if let Some(owner)=&p.coordinator_id{event["coordinatorId"]=json!(owner)}}let encoded=next_ledger.append(encode(&event)?)?;let event:serde_json::Value=decode(&encoded)?;next_control.observe(event["seq"].as_f64().ok_or_else(invalid)?,&next_ledger)?;}
  next.state.revocations.get_or_insert_with(Vec::new).push(row.clone());next.tick=tick;next.revocation_binding=Some(binding);next.validate_commit()?;next_control.validate_commit(&next_ledger)?;
  let encoded=encode(&json!({"ok":true,"duplicate":false,"revocation":row}))?;*motion=next_motion;*tasks=next_tasks;*actions=next_actions;*resources=next_resources;*control=next_control;*ledger=next_ledger;*self=next;Ok(encoded)
 }
 #[napi]
 pub fn propose(&mut self,input:String,context:String,tick:f64)->Result<String>{
  let tick=self.time(tick)?;let p:ProposalInput=decode(&input)?;let c:ProposalContext=decode(&context)?;
  if self.pending.is_some()||!p.valid()||c.proof.as_ref().is_some_and(|f|!f.valid(tick)||!Self::proof_matches(&p,f)){return Err(invalid())}
  if let Some(prior)=self.proposals().find(|r|r.request_id==p.request_id){return if prior.input()==p{encode(&json!({"ok":true,"duplicate":true,"proposal":prior}))}else{no("request_id_conflict")}}
  if c.done{return no("world_finished")}if !c.mode.external(){return no("external_mode_required")}if self.proposals().count()>=1000{return no("proposal_limit")}
  let reason=self.proposal_reason(&p,c.proof.as_ref(),tick);let row=Proposal{request_id:p.request_id,observed_tick:p.observed_tick,applied_tick:tick,status:if reason.is_some(){Terminal::Rejected}else{Terminal::Accepted},task:p.task,evidence_id:p.evidence_id,sensor_evidence_id:p.sensor_evidence_id,sample_report_id:p.sample_report_id,reason,coordinator_id:p.coordinator_id};
  let result=encode(&json!({"ok":true,"duplicate":false,"proposal":row}))?;if row.status==Terminal::Accepted{self.tasks.push(CatalogTask{id:row.task.id.clone(),survey:Some(row.task.clone())})}self.state.proposals.get_or_insert_with(Vec::new).push(row);self.tick=tick;Ok(result)
 }
 #[napi]
 pub fn prepare_revocation(&mut self,input:String,context:String,tick:f64)->Result<String>{
  let tick=self.time(tick)?;let p:RevokeInput=decode(&input)?;let c:RevokeContext=decode(&context)?;
  if self.pending.is_some()||!p.valid()||c.task.as_ref().is_some_and(|t|t.id!=p.task_id||!self.tasks.iter().any(|d|d.id==t.id))||c.agent.as_ref().is_some_and(|a|a.id!=p.agent_id||!self.agents.iter().any(|s|s.id==a.id)||a.blocked_since.is_some_and(|t|t>tick)){return Err(invalid())}
  if let Some(prior)=self.revocations().find(|r|r.request_id==p.request_id){return if prior.input()==p{encode(&json!({"ok":true,"duplicate":true,"revocation":prior}))}else{no("request_id_conflict")}}
  if c.done{return no("world_finished")}if !c.mode.external(){return no("external_mode_required")}if self.revocations().count()>=1000{return no("revocation_limit")}
  let reason=self.revoke_reason(&p,&c,tick);let row=Revocation{request_id:p.request_id,task_id:p.task_id,agent_id:p.agent_id,assignment_id:p.assignment_id,observed_tick:p.observed_tick,require_blocked_since:p.require_blocked_since,applied_tick:tick,status:if reason.is_some(){Terminal::Rejected}else{Terminal::Accepted},reason,coordinator_id:p.coordinator_id};let ticket=self.next_ticket;
  let result=encode(&json!({"ok":true,"duplicate":false,"revocation":row,"ticket":ticket}))?;self.pending=Some((ticket,row));self.next_ticket+=1;self.tick=tick;Ok(result)
 }
 #[napi]
 pub fn commit_revocation(&mut self,ticket:f64,input:String,tick:f64)->Result<String>{
  let tick=self.time(tick)?;let ack:Ack=decode(&input)?;let (id,row)=self.pending.as_ref().ok_or_else(invalid)?;
  if ticket!=*id as f64||tick!=row.applied_tick{return Err(invalid())}
  if row.status==Terminal::Accepted&&(ack.task.as_ref().is_none_or(|t|t.id!=row.task_id||t.status!=TaskStatus::Pending||t.assignee.is_some()||t.assignment_id!=Some(row.assignment_id))||ack.agent.as_ref().is_none_or(|a|a.id!=row.agent_id||!a.idle||!a.route_empty||a.work!=0.0||a.unsettled_actions)||ack.event.as_ref().is_none_or(|e|!e.matches(row))){return Err(invalid())}
  let result=encode(row)?;let (_,row)=self.pending.take().ok_or_else(invalid)?;self.state.revocations.get_or_insert_with(Vec::new).push(row);self.tick=tick;Ok(result)
 }
 #[napi]
 pub fn validate_commit(&self)->Result<()>{if self.closed||self.pending.is_some(){return Err(invalid())}Ok(())}
 #[napi]
 pub fn free(&mut self){self.closed=true;self.pending=None;self.revocation_binding=None;self.proposal_binding=None;self.state.proposals=None;self.state.revocations=None;self.agents.clear();self.tasks.clear()}
}

crate::world_checkpoint::world_checkpoint!(WorldRequests);
