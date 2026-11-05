//! Owned task graph and task lifecycle. Commands validate against the stored
//! graph, rather than accepting a replacement copy of host task state.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};

fn invalid() -> Error { Error::from_reason("invalid world tasks input") }
fn present<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where D: Deserializer<'de>, T: Deserialize<'de> { T::deserialize(d).map(Some) }
fn id(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status { Pending, Active, Done }
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Behavior { Survey, Detect, Confirm, Deliver, Repair, Verify, Sample, Deploy, Build }
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase { ToPickup, Loading, ToSite, Unloading, Repairing }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Task {
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] pub(crate) build_site:Option<String>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] pub(crate) material_cost:Option<Vec<crate::materials::Item>>,
    pub(crate) id: String, pub(crate) behavior: Behavior, name: String, pub(crate) role: String, pub(crate) capability: String,
    pub(crate) target: [f64; 2], duration: u32, depends_on: Vec<String>, pub(crate) status: Status, pub(crate) assignee: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    priority: Option<u32>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    deadline: Option<u32>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub(crate) assignment_id: Option<u32>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    started_assignment_id: Option<u32>,
    // Outer Option preserves missing versus explicitly null in existing archives.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub(crate) phase: Option<Option<Phase>>,
}
impl Task {
    pub(crate) fn dispatch_order(&self)->(u32,u32){(self.priority.unwrap_or(0),self.deadline.unwrap_or(u32::MAX))}
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Agent { id: String, role: String, capabilities: Vec<String> }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial { tasks: Vec<Task>, agents: Vec<Agent>, #[serde(default)] tick:u32 }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkContext { tick:u32 }

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct AssignmentRequest {task_id:serde_json::Value,agent_id:serde_json::Value}
#[derive(Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
enum InterruptionRequest {Fault{},#[serde(skip_deserializing)]PowerDepleted{agent_id:String},DeviceFault{#[serde(rename="agentId")]agent_id:String,#[serde(default,rename="expectedFaultGeneration",deserialize_with="present")]expected_fault_generation:Option<u32>},LowEnergy{#[serde(rename="agentId")]agent_id:serde_json::Value,level:serde_json::Value}}
struct AssignmentState {
    task:Option<(usize,Task)>,agent:Option<(usize,crate::world_motion::Motion,crate::world_execution::Execution)>,
    mode:&'static str,prefix:usize,binding:[u64;5],fingerprint:String,reason:Option<String>,
}
#[napi]
#[derive(Clone)]
pub struct WorldAssignmentTicket {owner:u64,identity:u64,request:String,tick:u32,binding:[u64;5],fingerprint:String,plan:String,used:bool}
#[napi]
impl WorldAssignmentTicket {
    #[napi]
    pub fn plan(&self)->Result<String>{if self.used{return Err(invalid())}Ok(self.plan.clone())}
    #[napi]
    pub fn free(&mut self){self.used=true;self.request.clear();self.fingerprint.clear();self.plan.clear();}
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Assign { #[serde(rename="taskId")] task_id: String, #[serde(rename="agentId")] agent_id: String, #[serde(rename="assignmentId")] assignment_id: u32 },
    Requeue { #[serde(rename="taskId")] task_id: String, #[serde(rename="assignmentId")] assignment_id: u32, #[serde(rename="clearPhase")] clear_phase: bool },
    Start { #[serde(rename="taskId")] task_id: String, #[serde(rename="assignmentId")] assignment_id: u32 },
    Complete { #[serde(rename="taskId")] task_id: String, #[serde(rename="assignmentId")] assignment_id: u32 },
    Phase { #[serde(rename="taskId")] task_id: String, #[serde(rename="assignmentId")] assignment_id: u32, phase: Option<Phase> },
}

fn valid_task(t: &Task) -> bool {
    t.material_cost.as_ref().is_none_or(|c|crate::materials::cost_valid(c)) && id(&t.id, 64) && !matches!(t.id.as_str(), "__proto__" | "constructor" | "prototype")
        && id(&t.role, 48) && id(&t.capability, 64)
        && !t.name.is_empty() && t.name.encode_utf16().count() <= 100
        && t.target.iter().all(|n| n.is_finite() && (0.0..=100.0).contains(n))
        && (1..=10000).contains(&t.duration) && t.depends_on.len() <= 100
        && t.depends_on.iter().all(|d| id(d, 64))
        && t.priority.is_none_or(|p| p <= 100) && t.deadline.is_none_or(|d| (1..=10_000_000).contains(&d))
        && t.assignment_id.is_none_or(|n| n > 0)
        && t.started_assignment_id.is_none_or(|n| n > 0 && t.assignment_id.is_some_and(|a| n <= a))
        && (t.behavior != Behavior::Sample || t.capability == "sample")
        && (t.behavior != Behavior::Deploy || t.capability == "relay")
        && if t.behavior==Behavior::Build{t.capability=="build"&&t.build_site.as_deref().is_some_and(|s|id(s,64))&&t.material_cost.as_ref().is_some_and(|v|!v.is_empty())}else{t.build_site.is_none()}
        && match t.phase.flatten() {
            None => true,
            Some(Phase::Repairing) => t.behavior == Behavior::Repair,
            Some(_) => t.behavior == Behavior::Deliver,
        }
}

#[napi]
#[derive(Clone)]
pub struct WorldTasks {
    checkpoint_id: u64,
    tasks: Vec<Task>,
    indices: HashMap<String, usize>,
    agents: HashMap<String, Vec<String>>,
    survey_roles: HashSet<String>,
    last_assignment: u32,
    work_binding: Option<[u64;4]>,
    work_ticks: HashMap<(String,u32),u32>,
    assignment_binding:Option<[u64;5]>,
    assignment_ticket:Option<u64>,
    interruption_binding:Option<[u64;6]>,
    event_binding:Option<[u64;6]>,
    closed: bool,
}
impl WorldTasks {
    pub(crate) fn environment_binding(&self,binding:[u64;6])->Result<()>{
        if self.event_binding.is_some_and(|b|b!=binding)||self.interruption_binding.is_some_and(|b|b!=binding)||self.work_binding.is_some_and(|b|b!=binding[..4])||self.assignment_binding.is_some_and(|b|b[..3]!=binding[..3]||b[3..]!=binding[4..]){return Err(invalid())}Ok(())
    }
    pub(crate) fn event_context(&self,now:u32,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<([u64;6],bool)>{
        let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let catalog:Vec<_>=self.tasks.iter().map(|t|t.id.clone()).collect();self.revocation_context("",&actors,&catalog)?;let(c,l,recovery)=control.task_events_context(now,&ids,&catalog,ledger)?;let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(e,_)=environment.time_context(now as u64,&ids)?;let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,_)=resources.proposal_catalog(now as u64,&self.tasks,&roster)?;let(a,_)=actions.ending_context(now,&ids)?;let binding=[m,e,r,a,c,l];if self.event_binding.is_some_and(|b|b!=binding)||self.interruption_binding.is_some_and(|b|b!=binding)||self.work_binding.is_some_and(|b|b!=binding[..4])||self.assignment_binding.is_some_and(|b|b[..3]!=binding[..3]||b[3..]!=binding[4..]){return Err(invalid())}Ok((binding,recovery))
    }
    pub(crate) fn action_event(actions:&crate::world_actions::WorldActions,index:usize,name:&str,status:&str,reason:Option<&str>)->Result<serde_json::Value>{let rows:Vec<serde_json::Value>=serde_json::from_str(&actions.snapshot()?).map_err(|_|invalid())?;let a=rows.get(index).ok_or_else(invalid)?;let label=match a["type"].as_str(){Some("execute_task")=>"执行任务",Some("work_task")=>"执行作业",_=>return Err(invalid())};let mut event=serde_json::json!({"message":format!("{} 的{}动作{}",name,label,if status=="completed"{"已完成"}else{"已失败"}),"type":if status=="completed"{"success"}else{"warning"},"kind":format!("action_{}",status),"agentId":a["agentId"],"requestId":a["requestId"],"actionType":a["type"]});if let Some(reason)=reason{event["reason"]=reason.into()}Ok(event)}
    pub(crate) fn ending_tasks(&self)->Result<(Vec<Task>,Vec<Task>)>{self.active()?;Ok((self.tasks.clone(),self.tasks.iter().filter(|t|t.status==Status::Pending&&self.ready(t)).cloned().collect()))}
    pub(crate) fn time_identity(&self)->Result<u64>{self.active()?;Ok(self.checkpoint_id)}
    pub(crate) fn time_deadlines(&self,tick:u32)->Result<serde_json::Value>{
        self.active()?;Ok(serde_json::json!(self.tasks.iter().filter(|t|t.status!=Status::Done&&t.deadline.is_some_and(|d|tick==d+1)).map(|t|serde_json::json!({"id":t.id,"name":t.name,"deadline":t.deadline})).collect::<Vec<_>>()))
    }
    pub(crate) fn proposal_catalog(&self,catalog:&[String],agents:&[(String,String,bool)])->Result<(u64,Vec<Task>)>{
        self.active()?;if self.tasks.iter().map(|t|&t.id).ne(catalog.iter())||agents.len()!=self.agents.len()||agents.iter().any(|(id,_,survey)|self.agents.get(id).is_none_or(|caps|caps.iter().any(|c|c=="inspect")!=*survey)){return Err(invalid())}
        Ok((self.checkpoint_id,self.tasks.clone()))
    }
    pub(crate) fn revocation_context(&self,task:&str,agents:&[(usize,crate::world_motion::Motion,crate::world_execution::Execution)],catalog:&[String])->Result<(u64,Option<Task>)>{
        self.active()?;if agents.len()!=self.agents.len()||agents.iter().any(|(_,a,e)|self.agents.get(&a.id)!=Some(&e.capabilities))||self.tasks.iter().map(|t|&t.id).ne(catalog.iter()){return Err(invalid())}
        Ok((self.checkpoint_id,self.indices.get(task).map(|i|self.tasks[*i].clone())))
    }
    pub(crate) fn revoke_owned(&mut self,t:&Task,binding:[u64;6])->Result<()>{
        if self.interruption_binding.is_some_and(|b|b!=binding)||self.work_binding.is_some_and(|b|b!=binding[..4])||self.assignment_binding.is_some_and(|b|b[..3]!=binding[..3]||b[3..]!=binding[4..]){return Err(invalid())}
        self.command(serde_json::json!({"kind":"requeue","taskId":t.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?,"clearPhase":true}).to_string())?;self.interruption_binding=Some(binding);self.assignment_ticket=None;Ok(())
    }
    fn assignment_state(&self,input:&str,now:u32,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<AssignmentState>{
        self.active()?;if now>10_000_000||input.len()>2*1024*1024{return Err(invalid())}
        let request:AssignmentRequest=serde_json::from_str(input).map_err(|_|invalid())?;
        let agents=motion.lifecycle_agents()?;
        if agents.is_empty()||agents.len()!=self.agents.len()||agents.iter().any(|(_,a,e)|self.agents.get(&a.id)!=Some(&e.capabilities)){return Err(invalid())}
        let ids:Vec<_>=agents.iter().map(|(_,a,_)|a.id.clone()).collect();let(control_id,ledger_id,prefix,mode,done)=control.assignment_context(now,&ids,ledger)?;
        let mut environment_id=None;for(i,a,_)in &agents{let id=environment.stationary_identity(*i,&a.id,now as u64)?;if environment_id.is_some_and(|before|before!=id){return Err(invalid())}environment_id=Some(id)}
        let(_,_,_,motion_id)=motion.activation_components(&ids[0])?;
        let task=request.task_id.as_str().and_then(|id|self.indices.get(id)).map(|i|(*i,self.tasks[*i].clone()));
        let(resource_id,resource)=resources.assignment_context(task.as_ref().map(|(_,t)|t),now)?;
        let actor=agents.iter().find(|(_,a,_)|request.agent_id.as_str()==Some(a.id.as_str())).cloned();
        let mut data=serde_json::json!({"done":done,"tasks":self.tasks,"agents":agents.iter().map(|(_,a,e)|serde_json::json!({"id":a.id,"status":e.status,"disabled":e.disabled,"battery":a.battery,"capabilities":e.capabilities,"deployableRelay":e.deployable_relay})).collect::<Vec<_>>(),"part":resource["state"]["part"],"asset":resource["state"]["asset"],"taskId":task.as_ref().map(|(_,t)|t.id.as_str()),"agentId":actor.as_ref().map(|(_,a,_)|a.id.as_str())});
        if let Some(materials)=resource["state"].get("materials"){data["materials"]=materials.clone()}
        let reason=crate::assignment_precondition(data.to_string())?;let reason=if reason.is_empty(){None}else{Some(reason)};
        let binding=[motion_id,environment_id.ok_or_else(invalid)?,resource_id,control_id,ledger_id];
        if self.assignment_binding.is_some_and(|before|before!=binding)||self.work_binding.is_some_and(|before|before[..3]!=binding[..3]){return Err(invalid())}
        let fingerprint=serde_json::json!({"admission":data,"actors":agents.iter().map(|(_,a,e)|serde_json::json!([a,e])).collect::<Vec<_>>(),"resources":resource,"environment":environment.snapshot()?,"control":control.snapshot()?,"prefix":prefix,"tick":now,"lastAssignment":self.last_assignment}).to_string();
        Ok(AssignmentState{task,agent:actor,mode,prefix,binding,fingerprint,reason})
    }
    pub(crate) fn activation_context(&self,task:Option<&str>,agent:&str)->Result<(u64,Option<Task>,Option<Task>)>{
        self.active()?;if !self.agents.contains_key(agent){return Err(invalid())}
        Ok((self.checkpoint_id,task.and_then(|id|self.indices.get(id)).map(|i|self.tasks[*i].clone()),self.tasks.iter().find(|t|t.status==Status::Active&&t.assignee.as_deref()==Some(agent)).cloned()))
    }
    pub(crate) fn stationary_resume(&self,task:Option<&str>,agent:&str)->Result<(u64,bool)>{
        self.active()?;
        if !self.agents.contains_key(agent){return Err(invalid())}
        let resume=task.and_then(|id|self.indices.get(id)).is_some_and(|i|self.tasks[*i].status==Status::Active&&self.tasks[*i].assignee.as_deref()==Some(agent));
        Ok((self.checkpoint_id,resume))
    }

    fn active(&self) -> Result<()> {
        if self.closed { Err(Error::from_reason("world tasks is closed")) } else { Ok(()) }
    }
    fn at(&self, task_id: &str) -> Result<usize> { self.indices.get(task_id).copied().ok_or_else(invalid) }
    fn ready(&self, t: &Task) -> bool {
        t.depends_on.iter().all(|d| self.indices.get(d).is_some_and(|i| self.tasks[*i].status == Status::Done))
    }
    fn checked_active(&self, task_id: &str, assignment_id: u32) -> Result<usize> {
        let i = self.at(task_id)?;
        if self.tasks[i].status != Status::Active || self.tasks[i].assignment_id != Some(assignment_id) { return Err(invalid()); }
        Ok(i)
    }
}

#[napi]
impl WorldTasks {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        if input.len() > 1024 * 1024 { return Err(invalid()); }
        let Initial { tasks, agents, tick } = serde_json::from_str(&input).map_err(|_| invalid())?;
        if tick>10_000_000{return Err(invalid())}
        if tasks.is_empty() || tasks.len() > 100 || agents.is_empty() || agents.len() > 50 { return Err(invalid()); }
        let mut agent_map = HashMap::new();
        let mut survey_roles = HashSet::new();
        for a in agents {
            if !id(&a.id, 64) || !id(&a.role, 48) || a.capabilities.is_empty() || a.capabilities.len() > 32
                || a.capabilities.iter().any(|c| !id(c, 64)) || agent_map.contains_key(&a.id) { return Err(invalid()); }
            if a.capabilities.iter().any(|c| c == "inspect") { survey_roles.insert(a.role); }
            agent_map.insert(a.id, a.capabilities);
        }
        let mut indices = HashMap::new();
        for (i, t) in tasks.iter().enumerate() {
            if !valid_task(t) || indices.insert(t.id.clone(), i).is_some() { return Err(invalid()); }
        }
        // A topological pass validates both dependency references and cycles.
        let mut visited = HashSet::new();
        loop {
            let before = visited.len();
            for t in &tasks {
                if t.depends_on.iter().any(|d| !indices.contains_key(d)) { return Err(invalid()); }
                if t.depends_on.iter().all(|d| visited.contains(d)) { visited.insert(t.id.clone()); }
            }
            if visited.len() == tasks.len() { break; }
            if visited.len() == before { return Err(invalid()); }
        }
        let mut active_agents = HashSet::new();
        let mut assignments = HashSet::new();
        for t in &tasks {
            if let Some(assignment) = t.assignment_id { if !assignments.insert(assignment) { return Err(invalid()); } }
            if t.status == Status::Pending {
                if t.assignee.is_some() { return Err(invalid()); }
            } else {
                let a = t.assignee.as_ref().and_then(|a| agent_map.get(a)).ok_or_else(invalid)?;
                if t.assignment_id.is_none() || !a.contains(&t.capability)
                    || t.depends_on.iter().any(|d| tasks[indices[d]].status != Status::Done)
                    || t.status == Status::Active && !active_agents.insert(t.assignee.as_ref()) { return Err(invalid()); }
            }
        }
        let last_assignment = tasks.iter().filter_map(|t| t.assignment_id).max().unwrap_or(0);
        let work_ticks=tasks.iter().filter(|t|t.status==Status::Active).map(|t|((t.id.clone(),t.assignment_id.unwrap()),tick)).collect();
        Ok(Self { checkpoint_id: crate::world_checkpoint::identity(), tasks, indices, agents: agent_map, survey_roles, last_assignment, work_binding:None,work_ticks,assignment_binding:None,assignment_ticket:None,interruption_binding:None,event_binding:None,closed: false })
    }

    #[napi]
    pub fn interrupt(&mut self,input:String,now:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,actions:&mut crate::world_actions::WorldActions,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        self.active()?;if input.len()>2*1024*1024||!now.is_finite()||now.fract()!=0.0||!(0.0..=10_000_000.0).contains(&now){return Err(invalid())}let now=now as u32;
        let request:InterruptionRequest=serde_json::from_str(&input).map_err(|_|invalid())?;
        self.interrupt_owned(request,now,motion,environment,resources,actions,control,ledger)
    }

    #[napi]
    pub fn assign_planned_events(&mut self,input:String,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        if !expected.is_finite()||expected.fract()!=0.0||!(0.0..=10_000_000.0).contains(&expected){return Err(invalid())}
        let state=self.assignment_state(&input,expected as u32,motion,environment,resources,control,ledger)?;
        environment.dispatch_context(expected as u64,&motion.lifecycle_agents()?)?;
        let mut route=None;
        if state.reason.is_none(){
            let(_,task)=state.task.as_ref().ok_or_else(invalid)?;let(_,agent,_)=state.agent.as_ref().ok_or_else(invalid)?;
            if task.behavior==Behavior::Deliver{
                // A delivery is admissible only when both pickup and delivery
                // legs exist. Its initial execution route stops at the part.
                if let Some(from)=resources.activation_part(&agent.id)?.1{
                    route=environment.task_route(&agent.id,[agent.x,agent.y],from,false)?;
                    if route.is_some()&&environment.task_route(&agent.id,if environment.surface_domain()?.is_some(){*route.as_ref().and_then(|p|p.last()).ok_or_else(invalid)?}else{from},task.target,false)?.is_none(){route=None}
                }
            }else{route=environment.task_route(&agent.id,[agent.x,agent.y],task.target,false)?;}
        }
        // Keep private preparation isolated from a caller-held public lease.
        // The existing event transaction stages every participant before commit.
        let mut next=self.clone();let mut ticket=next.prepare_assignment(input,expected,motion,environment,resources,control,ledger)?;
        let encoded=next.commit_assignment_events(&mut ticket,serde_json::to_string(&route).map_err(|_|invalid())?,motion,environment,resources,control,ledger)?;
        *self=next;Ok(encoded)
    }
    #[napi]
    pub fn prepare_assignment(&mut self,input:String,now:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<WorldAssignmentTicket>{
        if !now.is_finite()||now.fract()!=0.0||!(0.0..=10_000_000.0).contains(&now){return Err(invalid())}let now=now as u32;
        let state=self.assignment_state(&input,now,motion,environment,resources,control,ledger)?;
        let plan=serde_json::json!({"reason":state.reason,"taskId":state.task.as_ref().map(|(_,t)|&t.id),"agentId":state.agent.as_ref().map(|(_,a,_)|&a.id)}).to_string();let identity=crate::world_checkpoint::identity();
        self.assignment_ticket=Some(identity);Ok(WorldAssignmentTicket{owner:self.checkpoint_id,identity,request:input,tick:now,binding:state.binding,fingerprint:state.fingerprint,plan,used:false})
    }
    #[napi]
    pub fn commit_assignment(&mut self,ticket:&mut WorldAssignmentTicket,route:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        self.active()?;if ticket.used||ticket.owner!=self.checkpoint_id||self.assignment_ticket!=Some(ticket.identity)||route.len()>256*1024{return Err(invalid())}
        let mut state=self.assignment_state(&ticket.request,ticket.tick,motion,environment,resources,control,ledger)?;
        if state.binding!=ticket.binding||state.fingerprint!=ticket.fingerprint{return Err(invalid())}
        let route:Option<Vec<[f64;2]>>=serde_json::from_str(&route).map_err(|_|invalid())?;
        if let Some(points)=&route{if points.len()>4096||points.iter().flatten().any(|n|!n.is_finite()||!(0.0..=100.0).contains(n)){return Err(invalid())}}
        if state.reason.is_none()&&route.is_none(){state.reason=Some("unreachable_target".into())}
        if let Some(reason)=state.reason{let encoded=serde_json::json!({"ok":false,"reason":reason}).to_string();self.assignment_binding=Some(state.binding);self.assignment_ticket=None;ticket.used=true;return Ok(encoded)}
        let(_,task)=state.task.ok_or_else(invalid)?;let(index,agent,mut execution)=state.agent.ok_or_else(invalid)?;
        let cleared=execution.activation_clear_wait()?;let version:u32=state.prefix.checked_add(if cleared.is_some(){2}else{1}).ok_or_else(invalid)?.try_into().map_err(|_|invalid())?;
        let mut next=self.clone();next.command(serde_json::json!({"kind":"assign","taskId":task.id,"agentId":agent.id,"assignmentId":version}).to_string())?;
        let assigned=&next.tasks[next.at(&task.id)?];let mut next_resources=resources.clone();next_resources.reserve_assignment(assigned,&agent,ticket.tick)?;
        execution.route=if state.mode=="primitive"{Vec::new()}else{route.ok_or_else(invalid)?};execution.status=if state.mode=="auto"{crate::world_execution::Status::Working}else{crate::world_execution::Status::Assigned};execution.work=0;execution.collision_replans=Some(0);
        if !execution.valid(agent.distance){return Err(invalid())}
        let encoded=serde_json::json!({"ok":true,"assignmentId":version,"clearedWait":cleared}).to_string();
        motion.commit_stationary(index,agent,execution)?;*resources=next_resources;next.assignment_binding=Some(state.binding);next.assignment_ticket=None;*self=next;ticket.used=true;Ok(encoded)
    }
    #[napi]
    pub fn commit_assignment_events(&mut self,ticket:&mut WorldAssignmentTicket,route:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let catalog:Vec<_>=self.tasks.iter().map(|t|t.id.clone()).collect();control.proposal_context(ticket.tick,&ids,&catalog,ledger)?;
        let mut next=self.clone();let mut next_ticket=ticket.clone();let mut next_motion=motion.clone();let mut next_resources=resources.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let mut result:serde_json::Value=serde_json::from_str(&next.commit_assignment(&mut next_ticket,route,&mut next_motion,environment,&mut next_resources,&next_control,&next_ledger)?).map_err(|_|invalid())?;
        if result["ok"]==true{let t=next.tasks.iter().find(|t|t.assignment_id.map(u64::from)==result["assignmentId"].as_u64()).ok_or_else(invalid)?;let agent=t.assignee.as_deref().ok_or_else(invalid)?;let(_,_,e,_)=next_motion.activation_components(agent)?;if !result["clearedWait"].is_null(){let wait=&result["clearedWait"];next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 结束道路等待",e.name),"type":"info","kind":"roadblock_wait_ended","agentId":agent,"roadblockId":wait["roadblockId"],"startedTick":wait["startedTick"],"outcome":"cancelled"}))?;}next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 接受「{}」",e.name,t.name),"type":"info","kind":"task_assigned","agentId":agent,"taskId":t.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?}))?;}
        result["published"]=true.into();let encoded=serde_json::to_string(&result).map_err(|_|invalid())?;next_control.validate_commit(&next_ledger)?;*self=next;*ticket=next_ticket;*motion=next_motion;*resources=next_resources;*control=next_control;*ledger=next_ledger;Ok(encoded)
    }
    #[napi]
    pub fn start_events(&mut self,task_id:String,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<bool>{
        if !expected.is_finite()||expected.fract()!=0.0||!(1.0..=10_000_000.0).contains(&expected){return Err(invalid())}let now=expected as u32;let(binding,recovery)=self.event_context(now,motion,environment,resources,actions,control,ledger)?;let t=&self.tasks[self.at(&task_id)?];if t.status!=Status::Active{return Err(invalid())}let agent=t.assignee.as_deref().ok_or_else(invalid)?;let(_,a,e,_)=motion.activation_components(agent)?;resources.work_owner(t,&a,&e,now)?;let task_move=e.status==crate::world_execution::Status::Manual&&control.lifecycle_context(now,agent,ledger)?.3=="primitive"&&actions.moves_task(agent,&t.id);if e.disabled||e.status!=crate::world_execution::Status::Working&&!task_move||e.lifecycle_waiting(){return Err(invalid())}if !recovery||t.started_assignment_id==t.assignment_id{return Ok(false)}let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();next.command(serde_json::json!({"kind":"start","taskId":t.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?}).to_string())?;next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 开始执行「{}」",e.name,t.name),"type":"info","kind":"task_work_started","taskId":t.id,"agentId":agent,"assignmentId":t.assignment_id.ok_or_else(invalid)?}))?;next.event_binding=Some(binding);next_control.validate_commit(&next_ledger)?;*self=next;*control=next_control;*ledger=next_ledger;Ok(true)
    }
    #[napi]
    pub fn advance_work_events(&mut self,task_id:String,input:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,actions:&mut crate::world_actions::WorldActions,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        if input.len()>128{return Err(invalid())}let context:WorkContext=serde_json::from_str(&input).map_err(|_|invalid())?;let now=context.tick;let(binding,_)=self.event_context(now,motion,environment,resources,actions,control,ledger)?;let t=self.tasks[self.at(&task_id)?].clone();let actor=t.assignee.as_deref().ok_or_else(invalid)?;let(_,agent,execution,_)=motion.activation_components(actor)?;let mut next=self.clone();let mut next_motion=motion.clone();let mut next_resources=resources.clone();let mut next_actions=actions.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let mut result:serde_json::Value=serde_json::from_str(&next.advance_work(task_id.clone(),input.clone(),&mut next_motion,environment,&mut next_resources,&mut next_actions)?).map_err(|_|invalid())?;
        match result["effect"].as_str().ok_or_else(invalid)?{
            "route_to_site"=>{let(_,a,_,_)=next_motion.activation_components(actor)?;if let Some(route)=environment.ending_route(actor,[a.x,a.y],t.target,false)?{next.finish_loading(task_id.clone(),input,serde_json::to_string(&route).map_err(|_|invalid())?,&mut next_motion,environment,&mut next_resources,&mut next_actions)?;next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 已装载备件",execution.name),"type":"info","kind":"part_loaded","agentId":actor,"taskId":t.id}))?;let(_,_,_,mode,_)=next_control.lifecycle_context(now,actor,&next_ledger)?;if mode=="primitive"{let(index,a,mut e,_)=next_motion.activation_components(actor)?;e.route.clear();e.status=crate::world_execution::Status::Assigned;next_motion.commit_stationary(index,a,e)?;if let Some(index)=next_actions.finish_work(&t.id,actor,now,false)?{next_control.task_event(&mut next_ledger,Self::action_event(&next_actions,index,&execution.name,"completed",None)?)?;}}result["loaded"]=true.into();}
                else if let Some(roadblock)=environment.activation_roadblock()?{let(index,a,mut e,_)=next_motion.activation_components(actor)?;e.loading_wait(t.target,roadblock.clone(),now,t.id.clone(),t.assignment_id.ok_or_else(invalid)?)?;next_motion.commit_stationary(index,a,e)?;next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 道路不可达，等待封闭解除",execution.name),"type":"warning","kind":"roadblock_wait_started","agentId":actor,"roadblockId":roadblock,"goal":t.target,"mode":"loading"}))?;result["waiting"]=true.into();}
                else{if let Some(index)=next_actions.fail_work(&t.id,actor,now,"unreachable_target")?{next_control.task_event(&mut next_ledger,Self::action_event(&next_actions,index,&execution.name,"failed",Some("unreachable_target"))?)?;}next_resources.work_command("abort",&t,&a,now)?;next.command(serde_json::json!({"kind":"requeue","taskId":t.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?,"clearPhase":true}).to_string())?;let(index,a,mut e,_)=next_motion.activation_components(actor)?;e.status=crate::world_execution::Status::Idle;e.work=0;next_motion.commit_stationary(index,a,e)?;next_ledger.finish(true)?;next_control.task_event(&mut next_ledger,serde_json::json!({"message":"备件到维修点的路径不可达","type":"warning","kind":"run_failed","reason":"unreachable_target","agentId":actor,"taskId":t.id}))?;result["failed"]=true.into();}
            },
            "energy_depleted"=>{if let Some(index)=result["actionIndex"].as_u64(){next_control.task_event(&mut next_ledger,Self::action_event(&next_actions,index as usize,&execution.name,"failed",Some("energy_depleted"))?)?;}if result["dropped"]==true{next_control.task_event(&mut next_ledger,serde_json::json!({"message":"运输中断，备件留在当前位置","type":"warning","kind":"part_dropped","agentId":actor,"taskId":t.id}))?;}next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 电量耗尽，任务重新分配",execution.name),"type":"warning","kind":"energy_depleted","agentId":actor,"taskId":t.id}))?;},
            "none"=>{},
            effect=>{let event=match effect{"build"=>{let site=next_resources.construction_site(t.build_site.as_deref().ok_or_else(invalid)?)?;Some(serde_json::json!({"message":format!("设施「{}」建设完成",site.name),"kind":"construction_completed","type":"success","siteId":site.id,"obstacleId":site.obstacle_id,"agentId":actor,"taskId":t.id,"assignmentId":t.assignment_id}))},"deploy"=>Some(serde_json::json!({"message":format!("{} 已部署通信中继",execution.name),"kind":"relay_deployed","type":"success","agentId":actor,"taskId":t.id,"assignmentId":t.assignment_id,"position":[agent.x,agent.y]})),"delivered"=>Some(serde_json::json!({"message":"备件已送至维修点","kind":"part_delivered","type":"success","agentId":actor,"taskId":t.id})),"sample"=>Some(serde_json::json!({"message":format!("{} 已完成采样",execution.name),"kind":"sample_collected","type":"success","agentId":actor,"taskId":t.id,"position":t.target})),"repair"=>Some(serde_json::json!({"message":"备件已使用，设备完成维修","kind":"asset_repaired","type":"success","agentId":actor,"taskId":t.id})),"verify"=>Some(serde_json::json!({"message":"复核通过，设备恢复运行","kind":"asset_verified","type":"success","agentId":actor,"taskId":t.id})),"detect"|"confirm"|"complete"=>None,_=>return Err(invalid())};if let Some(event)=event{next_control.task_event(&mut next_ledger,event)?;}if let Some(index)=result["actionIndex"].as_u64(){next_control.task_event(&mut next_ledger,Self::action_event(&next_actions,index as usize,&execution.name,"completed",None)?)?;}next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("「{}」完成",t.name),"kind":"task_completed","type":"success","agentId":actor,"taskId":t.id}))?;}
        }
        result["published"]=true.into();let encoded=serde_json::to_string(&result).map_err(|_|invalid())?;next.event_binding=Some(binding);next_control.validate_commit(&next_ledger)?;*self=next;*motion=next_motion;*resources=next_resources;*actions=next_actions;*control=next_control;*ledger=next_ledger;Ok(encoded)
    }
    #[napi]
    pub fn advance_work(&mut self,task_id:String,input:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,actions:&mut crate::world_actions::WorldActions)->Result<String>{
        self.active()?;if input.len()>128{return Err(invalid())}
        let context:WorkContext=serde_json::from_str(&input).map_err(|_|invalid())?;let now=context.tick;
        if now==0||now>10_000_000{return Err(invalid())}
        let i=self.at(&task_id)?;let current=&self.tasks[i];
        if current.status!=Status::Active{return Err(invalid())}
        let assignment=current.assignment_id.ok_or_else(invalid)?;
        let key=(task_id.clone(),assignment);
        if self.work_ticks.get(&key).is_some_and(|before|now<=*before){return Err(invalid())}
        let actor=current.assignee.as_deref().ok_or_else(invalid)?;
        let (agent_index,mut agent,mut execution,motion_id)=motion.work_components(actor)?;
        let environment_id=environment.stationary_identity(agent_index,actor,now as u64)?;
        let resource_id=resources.work_check(current,&agent,&execution,now)?;
        let action_id=actions.work_identity(actor,now)?;
        let binding=[motion_id,environment_id,resource_id,action_id];
        if self.work_binding.is_some_and(|before|before!=binding){return Err(invalid())}
        let energy=agent.battery.min(execution.work_energy_per_tick.unwrap_or(0.08));
        if !execution.thermal_work(energy)?{motion.commit_stationary(agent_index,agent,execution)?;self.work_ticks.insert(key,now);self.work_binding=Some(binding);return Ok(serde_json::json!({"effect":"none","actionIndex":null,"dropped":false}).to_string())}
        let mut next=current.clone();let mut next_resources=resources.clone();let mut next_actions=actions.clone();
        if next.behavior==Behavior::Deliver{next.phase=match next.phase.flatten(){Some(Phase::ToPickup)=>Some(Some(Phase::Loading)),Some(Phase::ToSite)=>Some(Some(Phase::Unloading)),_=>next.phase};}
        execution.work=execution.work.checked_add(1).ok_or_else(invalid)?;
        agent.battery=(agent.battery-execution.work_energy_per_tick.unwrap_or(0.08)).max(0.0);
        execution.thermal_spend(energy)?;
        let mut effect="none";let mut action_index=None;let mut dropped=false;
        if agent.battery<=0.0{
            action_index=next_actions.finish_work(&task_id,actor,now,true)?;
            let result=next_resources.work_command("abort",current,&agent,now)?;
            dropped=result["dropped"].as_bool().ok_or_else(invalid)?;
            if result["released"].as_bool().ok_or_else(invalid)?{next.phase=Some(None)}
            next.status=Status::Pending;next.assignee=None;
            execution.disabled=true;execution.status=crate::world_execution::Status::Fault;execution.route.clear();execution.work=0;
            effect="energy_depleted";
        }else if next.behavior==Behavior::Deliver&&next.phase.flatten()==Some(Phase::Loading){
            if execution.work>=4{effect="route_to_site"}
        }else{
            let complete=if next.behavior==Behavior::Deliver&&next.phase.flatten()==Some(Phase::Unloading){execution.work>=5}else{execution.work>=next.duration};
            if complete{
                effect=match next.behavior{Behavior::Deliver=>"delivered",Behavior::Sample=>"sample",Behavior::Detect=>"detect",Behavior::Confirm=>"confirm",Behavior::Repair=>"repair",Behavior::Verify=>"verify",Behavior::Survey=>"complete",Behavior::Deploy=>"deploy",Behavior::Build=>"build"};
                if next.behavior==Behavior::Deliver{next_resources.work_command("deliver",current,&agent,now)?;}
                else if matches!(next.behavior,Behavior::Detect|Behavior::Confirm|Behavior::Repair|Behavior::Verify){next_resources.work_command("effect",current,&agent,now)?;}
                action_index=next_actions.finish_work(&task_id,actor,now,false)?;
                next_resources.work_command("finish",current,&agent,now)?;
                next.status=Status::Done;next.phase=Some(None);execution.status=crate::world_execution::Status::Idle;execution.work=0;
                if next.behavior==Behavior::Deploy{if execution.deployable_relay!=Some(true)||execution.relay_state.as_ref().is_none_or(|s|s.deployed){return Err(invalid())}execution.relay_state=Some(crate::relay::State::deploy(next.id.clone(),next.assignment_id.ok_or_else(invalid)?,now as u32,[agent.x,agent.y]));execution.status=crate::world_execution::Status::Deployed;}
            }
        }
        if !valid_task(&next)||!execution.valid(agent.distance){return Err(invalid())}
        let encoded=serde_json::to_string(&serde_json::json!({"effect":effect,"actionIndex":action_index,"dropped":dropped})).map_err(|_|invalid())?;
        motion.commit_stationary(agent_index,agent,execution)?;
        *resources=next_resources;*actions=next_actions;self.tasks[i]=next;
        self.work_ticks.insert(key,now);self.work_binding=Some(binding);Ok(encoded)
    }

    // Navigation supplies a route only after the loading work phase succeeds.
    // The actual pickup, phase, work reset and route then commit as one native operation.
    #[napi]
    pub fn finish_loading(&mut self,task_id:String,input:String,route:String,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions)->Result<()> {
        self.active()?;if input.len()>128||route.len()>256*1024{return Err(invalid())}
        let context:WorkContext=serde_json::from_str(&input).map_err(|_|invalid())?;let now=context.tick;
        let route:Vec<[f64;2]>=serde_json::from_str(&route).map_err(|_|invalid())?;
        let i=self.at(&task_id)?;let current=&self.tasks[i];let actor=current.assignee.as_deref().ok_or_else(invalid)?;
        if current.status!=Status::Active||current.behavior!=Behavior::Deliver||current.phase.flatten()!=Some(Phase::Loading)||self.work_ticks.get(&(task_id,current.assignment_id.ok_or_else(invalid)?))!=Some(&now){return Err(invalid())}
        let (agent_index,agent,mut execution,motion_id)=motion.work_components(actor)?;
        let environment_id=environment.stationary_identity(agent_index,actor,now as u64)?;
        let resource_id=resources.work_check(current,&agent,&execution,now)?;let action_id=actions.work_identity(actor,now)?;
        if self.work_binding!=Some([motion_id,environment_id,resource_id,action_id])||execution.work<4||agent.battery<=0.0{return Err(invalid())}
        let mut next=current.clone();let mut next_resources=resources.clone();
        next_resources.work_command("load",current,&agent,now)?;
        next.phase=Some(Some(Phase::ToSite));execution.work=0;execution.route=route;
        if !valid_task(&next)||!execution.valid(agent.distance){return Err(invalid())}
        motion.commit_stationary(agent_index,agent,execution)?;*resources=next_resources;self.tasks[i]=next;Ok(())
    }

    #[napi]
    pub fn read(&self, task_id: String, field: String) -> Result<Option<String>> {
        self.active()?;
        let t = &self.tasks[self.at(&task_id)?];
        let value = match field.as_str() {
            "status" => Some(serde_json::to_value(t.status)),
            "assignee" => Some(serde_json::to_value(&t.assignee)),
            "assignmentId" => t.assignment_id.map(serde_json::to_value),
            "startedAssignmentId" => t.started_assignment_id.map(serde_json::to_value),
            "phase" => t.phase.map(serde_json::to_value),
            _ => return Err(invalid()),
        };
        value.map(|v| serde_json::to_string(&v.map_err(|_| invalid())?).map_err(|_| invalid())).transpose()
    }

    #[napi]
    pub fn command(&mut self, input: String) -> Result<()> {
        self.active()?;
        if input.len() > 4096 { return Err(invalid()); }
        let command: Command = serde_json::from_str(&input).map_err(|_| invalid())?;
        match command {
            Command::Assign { task_id, agent_id, assignment_id } => {
                let i = self.at(&task_id)?;
                let t = &self.tasks[i];
                if t.status != Status::Pending || !self.ready(t) || assignment_id <= self.last_assignment
                    || !self.agents.get(&agent_id).is_some_and(|caps| caps.contains(&t.capability))
                    || self.tasks.iter().any(|t| t.status == Status::Active && t.assignee.as_ref() == Some(&agent_id)) { return Err(invalid()); }
                let t = &mut self.tasks[i];
                self.work_ticks.retain(|(id,_),_|id!=&task_id);
                t.status = Status::Active;
                t.assignee = Some(agent_id);
                t.assignment_id = Some(assignment_id);
                match t.behavior {
                    Behavior::Deliver => t.phase = Some(Some(Phase::ToPickup)),
                    Behavior::Repair => t.phase = Some(Some(Phase::Repairing)),
                    _ => (),
                }
                self.last_assignment = assignment_id;
            }
            Command::Requeue { task_id, assignment_id, clear_phase } => {
                let i = self.checked_active(&task_id, assignment_id)?;
                let t = &mut self.tasks[i];
                t.status = Status::Pending;
                t.assignee = None;
                if clear_phase { t.phase = Some(None); }
            }
            Command::Start { task_id, assignment_id } => {
                let i = self.checked_active(&task_id, assignment_id)?;
                self.tasks[i].started_assignment_id = Some(assignment_id);
            }
            Command::Complete { task_id, assignment_id } => {
                let i = self.checked_active(&task_id, assignment_id)?;
                self.tasks[i].status = Status::Done;
                self.tasks[i].phase = Some(None);
            }
            Command::Phase { task_id, assignment_id, phase } => {
                let i = self.checked_active(&task_id, assignment_id)?;
                let t = &mut self.tasks[i];
                let previous = t.phase.flatten();
                let allowed = phase.is_none() || phase == previous || match (t.behavior, previous, phase) {
                    (Behavior::Deliver, Some(Phase::ToPickup), Some(Phase::Loading))
                    | (Behavior::Deliver, Some(Phase::Loading), Some(Phase::ToSite))
                    | (Behavior::Deliver, Some(Phase::ToSite), Some(Phase::Unloading)) => true,
                    _ => false,
                };
                if !allowed { return Err(invalid()); }
                t.phase = Some(phase);
            }
        }
        Ok(())
    }

    #[napi]
    pub fn append(&mut self, input: String) -> Result<()> {
        self.active()?;
        if input.len() > 65536 || self.tasks.len() >= 100 { return Err(invalid()); }
        let t: Task = serde_json::from_str(&input).map_err(|_| invalid())?;
        if !valid_task(&t) || t.behavior != Behavior::Survey || t.capability != "inspect" || t.duration > 1000
            || t.status != Status::Pending || t.assignee.is_some() || t.assignment_id.is_some()
            || t.started_assignment_id.is_some() || t.phase.is_some() || self.indices.contains_key(&t.id)
            || !self.survey_roles.contains(&t.role)
            || t.depends_on.iter().collect::<HashSet<_>>().len() != t.depends_on.len()
            || t.depends_on.iter().any(|d| !self.indices.contains_key(d)) { return Err(invalid()); }
        self.indices.insert(t.id.clone(), self.tasks.len());
        self.tasks.push(t);
        Ok(())
    }

    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        self.active()?;
        serde_json::to_string(&self.tasks).map_err(|_| invalid())
    }
    #[napi]
    pub fn free(&mut self) {
        self.closed = true;
        self.tasks.clear(); self.tasks.shrink_to_fit();
        self.indices.clear(); self.indices.shrink_to_fit();
        self.agents.clear(); self.agents.shrink_to_fit();
        self.survey_roles.clear(); self.survey_roles.shrink_to_fit();
        self.work_ticks.clear(); self.work_ticks.shrink_to_fit();self.work_binding=None;self.assignment_binding=None;self.assignment_ticket=None;self.interruption_binding=None;self.event_binding=None;
    }
}

crate::world_checkpoint::world_checkpoint!(WorldTasks);

impl WorldTasks{
    fn interrupt_owned(&mut self,request:InterruptionRequest,now:u32,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,actions:&mut crate::world_actions::WorldActions,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        self.active()?;let depleted=matches!(request,InterruptionRequest::PowerDepleted{..});let low_energy=matches!(request,InterruptionRequest::LowEnergy{..});let targeted=matches!(request,InterruptionRequest::DeviceFault{..});
        let agents=motion.lifecycle_agents()?;
        if agents.is_empty()||agents.len()!=self.agents.len()||agents.iter().any(|(_,a,e)|self.agents.get(&a.id)!=Some(&e.capabilities)){return Err(invalid())}
        let ids:Vec<_>=agents.iter().map(|(_,a,_)|a.id.clone()).collect();let(control_id,ledger_id,_,_,done)=control.assignment_context(now,&ids,ledger)?;
        if done{return Ok(if low_energy||targeted||depleted{serde_json::json!({"ok":false,"reason":"world_finished"}).to_string()}else{"{\"ok\":false}".into()})}
        let task=match &request{InterruptionRequest::Fault{}=>self.tasks.iter().find(|t|t.status==Status::Active),InterruptionRequest::DeviceFault{agent_id,..}|InterruptionRequest::PowerDepleted{agent_id}=>self.tasks.iter().find(|t|t.status==Status::Active&&t.assignee.as_deref()==Some(agent_id.as_str())),InterruptionRequest::LowEnergy{agent_id,..}=>self.tasks.iter().find(|t|t.status==Status::Active&&t.assignee.as_deref()==agent_id.as_str())}.cloned();
        let actor=match &request{InterruptionRequest::Fault{}=>task.as_ref().and_then(|t|t.assignee.as_deref()),InterruptionRequest::DeviceFault{agent_id,..}|InterruptionRequest::PowerDepleted{agent_id}=>Some(agent_id.as_str()),InterruptionRequest::LowEnergy{agent_id,..}=>agent_id.as_str()};
        let Some((index,mut agent,mut execution))=agents.iter().find(|(_,a,_)|Some(a.id.as_str())==actor).cloned()else{return Ok(if low_energy||targeted||depleted{serde_json::json!({"ok":false,"reason":"unknown_agent"}).to_string()}else{"{\"ok\":false}".into()})};
        if depleted&&(agent.battery!=0.0||execution.disabled||execution.operating_energy_per_tick.is_none()||execution.operating_state.as_ref().is_none_or(|s|s.tick!=now)){return Err(invalid())}
        if let InterruptionRequest::DeviceFault{expected_fault_generation,..}=&request{
            if execution.recoverable_fault==Some(true){let Some(generation)=expected_fault_generation else{return Ok(serde_json::json!({"ok":false,"reason":"invalid_fault"}).to_string())};if *generation>10_000_000{return Ok(serde_json::json!({"ok":false,"reason":"invalid_fault"}).to_string())}if execution.fault_generation!=Some(*generation){return Ok(serde_json::json!({"ok":false,"reason":"fault_changed"}).to_string())}}else if expected_fault_generation.is_some(){return Ok(serde_json::json!({"ok":false,"reason":"invalid_fault"}).to_string())}
            if execution.disabled{return Ok(serde_json::json!({"ok":false,"reason":"agent_unavailable"}).to_string())}
        }
        let mut level=None;
        if let InterruptionRequest::LowEnergy{level:value,..}=&request{
            if execution.disabled{return Ok(serde_json::json!({"ok":false,"reason":"agent_unavailable"}).to_string())}
            let number=value.as_f64();if number.is_none_or(|n|!n.is_finite()||!(1.0..=5.0).contains(&n)||n>=agent.battery){return Ok(serde_json::json!({"ok":false,"reason":"invalid_energy_level"}).to_string())}level=number;
        }
        let environment_id=environment.stationary_identity(index,&agent.id,now as u64)?;let(_,_,_,motion_id)=motion.activation_components(&agent.id)?;
        let(resource_id,_)=resources.assignment_context(task.as_ref(),now)?;let action_id=actions.interruption_identity(&ids,now)?;
        let binding=[motion_id,environment_id,resource_id,action_id,control_id,ledger_id];
        control.interruption_components(self.checkpoint_id,binding)?;
        if self.interruption_binding.is_some_and(|b|b!=binding)||self.work_binding.is_some_and(|b|b!=binding[..4])||self.assignment_binding.is_some_and(|b|b[..3]!=binding[..3]||b[3..]!=binding[4..]){return Err(invalid())}
        let mut next=self.clone();let mut next_resources=resources.clone();let mut next_actions=actions.clone();let mut effects=Vec::new();
        if let Some(value)=level{effects.push(serde_json::json!({"kind":"low_energy_injected","agentId":agent.id,"before":agent.battery,"level":value,"amount":agent.battery-value}));agent.battery=value;}
        effects.extend(next_actions.interrupt_actor(&agent.id,task.as_ref().map(|t|t.id.as_str()),now,low_energy,targeted||depleted,depleted,[motion_id,environment_id,resource_id,self.checkpoint_id,control_id,ledger_id])?);
        if let Some(t)=&task{
            let result=next_resources.work_command("abort",t,&agent,now)?;let released=result["released"].as_bool().ok_or_else(invalid)?;
            if result["dropped"].as_bool().ok_or_else(invalid)?{effects.push(serde_json::json!({"kind":"part_dropped","agentId":agent.id,"taskId":t.id}))}
            next.command(serde_json::json!({"kind":"requeue","taskId":t.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?,"clearPhase":released}).to_string())?;
            if low_energy{effects.push(serde_json::json!({"kind":"low_energy_replan","agentId":agent.id,"taskId":t.id}))}
        }
        if let Some(wait)=execution.activation_clear_wait()?{effects.push(serde_json::json!({"kind":"wait_cancelled","agentId":agent.id,"wait":wait}))}
        execution.route.clear();execution.work=0;execution.task_needs_route=None;
        execution.status=if low_energy{if execution.relay_state.as_ref().is_some_and(|s|s.deployed){crate::world_execution::Status::Deployed}else{crate::world_execution::Status::Idle}}else{execution.disabled=true;crate::world_execution::Status::Fault};
        if !low_energy&&!depleted{if execution.recoverable_fault==Some(true){execution.fault_generation=Some(execution.fault_generation.ok_or_else(invalid)?.checked_add(1).filter(|n|*n<=10_000_000).ok_or_else(invalid)?)}let mut event=serde_json::json!({"kind":"device_fault","agentId":agent.id});if let Some(task)=&task{event["taskId"]=task.id.clone().into()}if let InterruptionRequest::DeviceFault{expected_fault_generation,..}=&request{event["targeted"]=true.into();if let Some(generation)=expected_fault_generation{event["expectedFaultGeneration"]=(*generation).into()}}effects.push(event)}
        if depleted{let mut event=serde_json::json!({"kind":"energy_depleted","agentId":agent.id,"source":"operating"});if let Some(t)=&task{event["taskId"]=t.id.clone().into()}effects.push(event)}
        if !execution.valid(agent.distance){return Err(invalid())}let encoded=serde_json::json!({"ok":true,"effects":effects}).to_string();
        motion.commit_stationary(index,agent,execution)?;*resources=next_resources;*actions=next_actions;next.interruption_binding=Some(binding);next.assignment_ticket=None;*self=next;Ok(encoded)
    }
    pub(crate) fn operating_depleted(&mut self,agent_id:&str,now:u32,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,resources:&mut crate::world_resources::WorldResources,actions:&mut crate::world_actions::WorldActions,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{self.interrupt_owned(InterruptionRequest::PowerDepleted{agent_id:agent_id.into()},now,motion,environment,resources,actions,control,ledger)}
}
