//! Owned decision identities and lifecycle, central command queue and retries.
//! Coupled event operations derive admission/routes and transport from native
//! participants and commit assignment, decision/queue state and facts together.
//! Legacy low-level interfaces remain available for mixed backend configurations.
use crate::ordered_map::OrderedMap;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
const MAX_TICK: u64 = 10_000_000;
const MAX_COUNT: u64 = 9_007_199_254_740_000;
fn invalid() -> Error {
    Error::from_reason("invalid world dispatch input")
}
fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn task_id(s: &str) -> bool {
    token(s) && !["__proto__", "constructor", "prototype"].contains(&s)
}
// Agent identifiers contain only ASCII letters, digits, underscores and hyphens.
// Preserve the existing English identifier tie order, including lowercase-first
// tertiary weights after comparing the complete case-folded primary sequence.
fn identifier_order(a:&str,b:&str)->std::cmp::Ordering{
    fn weight(c:u8)->u8{match c{b'_'=>0,b'-'=>1,b'0'..=b'9'=>2+c-b'0',_=>12+c.to_ascii_lowercase()-b'a'}}
    a.bytes().map(weight).cmp(b.bytes().map(weight)).then_with(||a.bytes().map(|c|c.is_ascii_uppercase()).cmp(b.bytes().map(|c|c.is_ascii_uppercase())))
}
fn present<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}
fn decode<T: for<'de> Deserialize<'de>>(s: &str) -> Result<T> {
    if s.len() > 4 * 1024 * 1024 {
        return Err(invalid());
    }
    serde_json::from_str(s).map_err(|_| invalid())
}
fn encode<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|_| invalid())
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Actor {
    Rule,
    Network,
    External,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Pending,
    Accepted,
    Rejected,
    Failed,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Reason {
    StaleObservation,
    NotAvailable,
    Expired,
    Unavailable,
    Interrupted,
    Dropped,
    RunEnded,
    ModeChanged,
    DecisionLimit,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Decision {
    actor: Actor,
    request_id: String,
    task_id: String,
    agent_id: String,
    observed_tick: u64,
    status: Status,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    submitted_tick: Option<u64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    applied_tick: Option<u64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    reason: Option<Reason>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    coordinator_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Packet {
    id: u64,
    task_id: String,
    agent_id: String,
    observed_tick: u64,
    due_tick: u64,
    expires_tick: u64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    actor: Option<Actor>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    request_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    decisions: Vec<Decision>,
    dispatch_queue: Vec<Packet>,
    dispatch_avoid: OrderedMap<String>,
    next_dispatch_id: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    delay: u64,
    ttl: u64,
    loss_rate: f64,
    decision_max_age: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial {
    tick: u64,
    seed: u32,
    agents: Vec<String>,
    tasks: Vec<String>,
    config: Config,
    state: State,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    actor: Actor,
    request_id: String,
    task_id: String,
    agent_id: String,
    observed_tick: u64,
    reason: Option<Reason>,
    coordinator_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RulePacket {
    task_id: String,
    agent_id: String,
    observed_tick: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Device {
    id: String,
    disabled: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Outage {
    agent_id: String,
    started_tick: u64,
    until_tick: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Environment {
    agents: Vec<Device>,
    outages: Vec<Outage>,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Transport {
    Waiting,
    Delivered,
    Expired,
    Unavailable,
    Interrupted,
    Dropped,
}
impl Transport {
    fn reason(self) -> Option<Reason> {
        match self {
            Self::Expired => Some(Reason::Expired),
            Self::Unavailable => Some(Reason::Unavailable),
            Self::Interrupted => Some(Reason::Interrupted),
            Self::Dropped => Some(Reason::Dropped),
            _ => None,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Outcome {
    id: u64,
    state: Transport,
}
struct DispatchEventContext{binding:[u64;9],actors:Vec<(usize,crate::world_motion::Motion,crate::world_execution::Execution)>,tasks:Vec<crate::world_tasks::Task>,ready:HashSet<String>,resource:serde_json::Value,done:bool,mode:&'static str,environment:serde_json::Value}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct OwnedIntent{actor:Actor,request_id:String,task_id:String,agent_id:String,observed_tick:u64,coordinator_id:Option<String>}
impl OwnedIntent{fn intent(self)->Intent{Intent{actor:self.actor,request_id:self.request_id,task_id:self.task_id,agent_id:self.agent_id,observed_tick:self.observed_tick,reason:None,coordinator_id:self.coordinator_id}}}
#[napi]
#[derive(Clone)]
pub struct WorldDispatch {
    checkpoint_id: u64,
    state: State,
    agents: Vec<String>,
    tasks: HashSet<String>,
    seed: u32,
    config: Config,
    last_tick: u64,
    last_ready: u64,
    tickets: HashMap<u64, Transport>,
    event_binding:Option<[u64;9]>,
    closed: bool,
}
impl WorldDispatch {
    pub(crate) fn bind_coordinator_reads(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<u64>{let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;self.event_binding=Some(ctx.binding);Ok(self.checkpoint_id)}
    pub(crate) fn coordinator_identity(&self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<u64>{let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;if self.event_binding!=Some(ctx.binding){return Err(invalid())}Ok(self.checkpoint_id)}
    pub(crate) fn coordinator_tasks(&self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger,statuses:&[serde_json::Value])->Result<Vec<serde_json::Value>>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;if self.event_binding!=Some(ctx.binding){return Err(invalid())}let mut ready:Vec<_>=ctx.tasks.iter().filter(|t|ctx.ready.contains(&t.id)).collect();ready.sort_by(|a,b|{let(ap,ad)=a.dispatch_order();let(bp,bd)=b.dispatch_order();bp.cmp(&ap).then(ad.cmp(&bd))});let mut result=Vec::new();
        for t in ready{if matches!(ctx.mode,"networked_external"|"networked_reported")&&self.state.dispatch_queue.iter().any(|p|p.actor==Some(Actor::External)&&p.task_id==t.id){continue}
            let target=if t.behavior==crate::world_tasks::Behavior::Deliver&&!ctx.resource["state"]["part"]["position"].is_null(){ctx.resource["state"]["part"]["position"].clone()}else{serde_json::json!(t.target)};let v=serde_json::to_value(t).map_err(|_|invalid())?;let mut candidates=Vec::new();
            if ctx.mode=="networked_reported"{for r in statuses{let id=r["id"].as_str().ok_or_else(invalid)?;if !self.candidate(&ctx,&t.id,id,environment,reports,true,true,expected as u64)?{continue}let spec=ctx.actors.iter().find(|(_,a,_)|a.id==id).ok_or_else(invalid)?;let captured=r["capturedTick"].as_u64().ok_or_else(invalid)?;candidates.push(serde_json::json!({"id":id,"x":r["x"],"y":r["y"],"battery":r["battery"],"reportedTick":captured,"receivedTick":r["receivedTick"],"age":expected as u64-captured,"speed":spec.2.speed}))}}
            else{for(_,a,e)in &ctx.actors{if self.candidate(&ctx,&t.id,&a.id,environment,reports,false,matches!(ctx.mode,"networked"|"networked_external"),expected as u64)?{candidates.push(serde_json::json!({"id":a.id,"x":a.x,"y":a.y,"battery":a.battery,"speed":e.speed}))}}}
            let mut row=serde_json::json!({"id":t.id,"capability":t.capability,"target":target,"name":v["name"],"behavior":v["behavior"],"duration":v["duration"],"priority":v.get("priority").cloned().unwrap_or(0.into()),"candidates":candidates});if let Some(deadline)=v.get("deadline"){row["deadline"]=deadline.clone()}result.push(row)
        }Ok(result)
    }
    fn automatic_candidate(&self,ctx:&DispatchEventContext,task:&crate::world_tasks::Task,environment:&crate::world_environment::WorldEnvironment,policy:&str,networked:bool)->Result<Option<String>>{
        let target=if task.behavior==crate::world_tasks::Behavior::Deliver&&!ctx.resource["state"]["part"]["position"].is_null(){serde_json::from_value(ctx.resource["state"]["part"]["position"].clone()).map_err(|_|invalid())?}else{task.target};
        let mut candidates=Vec::new();
        for (_,a,_) in &ctx.actors{
            if networked&&self.state.dispatch_queue.iter().any(|p|p.agent_id==a.id){continue}
            if Self::live_route(ctx,&task.id,&a.id,environment)?.is_some(){candidates.push(a)}
        }
        if networked{if let Some(avoid)=(&self.state.dispatch_avoid).into_iter().find(|(id,_)|*id==task.id).map(|(_,id)|id){if candidates.iter().any(|a|&a.id!=avoid){candidates.retain(|a|&a.id!=avoid)}}}
        candidates.sort_by(|a,b|{
            // Squared distance preserves nearest order without cross-runtime
            // hypot rounding breaking mathematically equal-distance ID ties.
            let distance2=|x:f64,y:f64|{let dx=x-target[0];let dy=y-target[1];dx*dx+dy*dy};
            let order=if policy=="battery"{b.battery.total_cmp(&a.battery)}else{distance2(a.x,a.y).total_cmp(&distance2(b.x,b.y))};
            order.then_with(||identifier_order(&a.id,&b.id))
        });
        Ok(candidates.first().map(|a|a.id.clone()))
    }
    fn event_context(&self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<DispatchEventContext>{
        let now=self.now(expected)?;let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(all,ready)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();self.proposal_catalog(now,&catalog,&ids)?;let(t,_)=tasks.revocation_context("",&actors,&catalog)?;let(c,l,done,_)=control.proposal_context(now as u32,&ids,&catalog,ledger)?;control.peer_events_context(now,&ids,self.seed,ledger)?;
        let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let e=environment.dispatch_context(now,&actors)?;let(a,_)=actions.ending_context(now as u32,&ids)?;
        let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,site)=resources.proposal_catalog(now,&all,&roster)?;let(_,resource)=resources.assignment_context(None,now as u32)?;let(p,link)=peer.dispatch_context(now,&ids,self.seed)?;if serde_json::to_value(&self.config).map_err(|_|invalid())?!=link["config"]{return Err(invalid())}let rp=reports.dispatch_context(now,&actors,site,self.seed,&link["reportsConfig"],ledger)?;
        let binding=[m,e,t,r,a,p,rp,c,l];if self.event_binding.is_some_and(|b|b!=binding){return Err(invalid())}let devices:Vec<_>=actors.iter().map(|(_,a,e)|serde_json::json!({"id":a.id,"disabled":e.disabled})).collect();Ok(DispatchEventContext{binding,actors,tasks:all,ready:ready.into_iter().map(|t|t.id).collect(),resource,done,mode:control.dispatch_mode()?,environment:serde_json::json!({"agents":devices,"outages":link["outages"]})})
    }
    fn live_route(ctx:&DispatchEventContext,task_id:&str,agent_id:&str,environment:&crate::world_environment::WorldEnvironment)->Result<Option<Vec<[f64;2]>>>{
        if !ctx.ready.contains(task_id){return Ok(None)}let t=ctx.tasks.iter().find(|t|t.id==task_id).ok_or_else(invalid)?;if crate::world_control::WorldControl::ending_precondition(t,&ctx.resource).is_some(){return Ok(None)}let Some((_,a,e))=ctx.actors.iter().find(|(_,a,_)|a.id==agent_id)else{return Ok(None)};
        if e.disabled||e.status!=crate::world_execution::Status::Idle||a.battery<=5.0||(!e.capabilities.contains(&t.capability)||t.behavior==crate::world_tasks::Behavior::Deploy&&e.deployable_relay!=Some(true)){return Ok(None)}
        if t.behavior==crate::world_tasks::Behavior::Deliver{let value=ctx.resource["state"]["part"]["position"].clone();if value.is_null(){return Ok(None)}let from:[f64;2]=serde_json::from_value(value).map_err(|_|invalid())?;let first=environment.ending_route(agent_id,[a.x,a.y],from,false)?;if first.is_none()||environment.ending_route(agent_id,if environment.surface_domain()?.is_some(){*first.as_ref().and_then(|p|p.last()).ok_or_else(invalid)?}else{from},t.target,false)?.is_none(){return Ok(None)}return Ok(first)}environment.ending_route(agent_id,[a.x,a.y],t.target,false)
    }
    fn candidate(&self,ctx:&DispatchEventContext,task_id:&str,agent_id:&str,environment:&crate::world_environment::WorldEnvironment,reports:&crate::world_reports::WorldReports,reported:bool,reserved:bool,now:u64)->Result<bool>{
        if reserved&&self.state.dispatch_queue.iter().any(|p|p.agent_id==agent_id){return Ok(false)}if !ctx.ready.contains(task_id){return Ok(false)}let t=ctx.tasks.iter().find(|t|t.id==task_id).ok_or_else(invalid)?;if crate::world_control::WorldControl::ending_precondition(t,&ctx.resource).is_some(){return Ok(false)}if reported{return reports.dispatch_candidate(agent_id,&t.capability,now)}Ok(Self::live_route(ctx,task_id,agent_id,environment)?.is_some())
    }
    fn owned_assignment(task_id:&str,agent_id:&str,route:Option<Vec<[f64;2]>>,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&mut crate::world_tasks::WorldTasks,resources:&mut crate::world_resources::WorldResources,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<bool>{
        let Some(route)=route else{return Ok(false)};let mut ticket=tasks.prepare_assignment(serde_json::json!({"taskId":task_id,"agentId":agent_id}).to_string(),expected,motion,environment,resources,control,ledger)?;
        let r:serde_json::Value=decode(&tasks.commit_assignment_events(&mut ticket,encode(&route)?,motion,environment,resources,control,ledger)?)?;Ok(r["ok"]==true)
    }
    fn decision_fact(d:&Decision,message:&str)->serde_json::Value{
        let mut fact=serde_json::json!({"message":message,"type":if d.reason.is_some(){"warning"}else{"info"},"kind":if d.reason.is_some(){"decision_rejected"}else{"decision_accepted"},"requestId":d.request_id,"actor":d.actor,"taskId":d.task_id,"agentId":d.agent_id});if let Some(r)=d.reason{fact["reason"]=serde_json::to_value(r).unwrap()}if let Some(id)=&d.coordinator_id{fact["coordinatorId"]=id.clone().into()}fact
    }
    fn dispatch_fact(p:&Packet,reason:Option<Reason>)->serde_json::Value{
        let label=match reason{Some(Reason::Expired)=>"过期",Some(Reason::Unavailable)=>"设备不可用",Some(Reason::Interrupted)=>"通信中断",Some(Reason::Dropped)=>"丢包",Some(Reason::StaleObservation)=>"观察过时",Some(Reason::NotAvailable)=>"任务或设备不可用",Some(Reason::DecisionLimit)=>"决策数量达到上限",Some(Reason::RunEnded)=>"run_ended",Some(Reason::ModeChanged)=>"mode_changed",None=>""};
        let mut fact=serde_json::json!({"message":if reason.is_some(){format!("任务指令未送达或被拒绝（{label}）")}else{"任务指令已送达并接受".to_owned()},"type":if reason.is_some(){"warning"}else{"success"},"kind":if reason.is_some(){"dispatch_failed"}else{"dispatch_delivered"},"dispatchId":p.id,"taskId":p.task_id,"agentId":p.agent_id});if let Some(r)=reason{fact["reason"]=serde_json::to_value(r).unwrap()}fact
    }
    fn event_commit(&mut self,next:Self,motion:&mut crate::world_motion::WorldMotion,next_motion:crate::world_motion::WorldMotion,tasks:&mut crate::world_tasks::WorldTasks,next_tasks:crate::world_tasks::WorldTasks,resources:&mut crate::world_resources::WorldResources,next_resources:crate::world_resources::WorldResources,control:&mut crate::world_control::WorldControl,next_control:crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,next_ledger:crate::world_ledger::WorldLedger)->Result<()>{next_control.validate_commit(&next_ledger)?;*self=next;*motion=next_motion;*tasks=next_tasks;*resources=next_resources;*control=next_control;*ledger=next_ledger;Ok(())}
    pub(crate) fn proposal_catalog(&self,now:u64,tasks:&[String],agents:&[String])->Result<u64>{
        self.now(now as f64)?;if self.agents!=agents||self.tasks.len()!=tasks.len()||tasks.iter().any(|t|!self.tasks.contains(t)){return Err(invalid())}Ok(self.checkpoint_id)
    }
    pub(crate) fn event_packet_ids(&self)->Result<Vec<u64>>{self.active()?;Ok(self.state.dispatch_queue.iter().map(|p|p.id).collect())}
    fn active(&self) -> Result<()> {
        if self.closed {
            Err(Error::from_reason("world dispatch is closed"))
        } else {
            Ok(())
        }
    }
    fn now(&self, n: f64) -> Result<u64> {
        self.active()?;
        if !n.is_finite() || n.fract() != 0.0 || n < self.last_tick as f64 || n > MAX_TICK as f64 {
            return Err(invalid());
        }
        Ok(n as u64)
    }
    fn stale(&self, observed: u64, now: u64) -> bool {
        observed > now || now - observed > self.config.decision_max_age
    }
    fn valid_intent(&self, i: &Intent) -> bool {
        token(&i.request_id)
            && i.task_id.encode_utf16().count() <= 64
            && i.agent_id.encode_utf16().count() <= 64
            && i.observed_tick <= 9_007_199_254_740_991
            && i.coordinator_id
                .as_ref()
                .is_none_or(|id| i.actor == Actor::External && token(id) && id.len() <= 40)
    }
    fn same(d: &Decision, i: &Intent) -> bool {
        d.actor == i.actor
            && d.request_id == i.request_id
            && d.task_id == i.task_id
            && d.agent_id == i.agent_id
            && d.observed_tick == i.observed_tick
            && d.coordinator_id == i.coordinator_id
    }
    fn admission(&self, i: &Intent, now: u64) -> bool {
        match i.reason {
            Some(Reason::StaleObservation) => self.stale(i.observed_tick, now),
            Some(Reason::NotAvailable) => !self.stale(i.observed_tick, now),
            None => {
                !self.stale(i.observed_tick, now)
                    && self.tasks.contains(&i.task_id)
                    && self.agents.contains(&i.agent_id)
            }
            _ => false,
        }
    }
    fn decision_valid(&self, d: &Decision, now: u64) -> bool {
        let i = Intent {
            actor: d.actor,
            request_id: d.request_id.clone(),
            task_id: d.task_id.clone(),
            agent_id: d.agent_id.clone(),
            observed_tick: d.observed_tick,
            coordinator_id: d.coordinator_id.clone(),
            reason: d.reason,
        };
        if !self.valid_intent(&i)
            || d.status == Status::Accepted
                && (!self.tasks.contains(&d.task_id) || !self.agents.contains(&d.agent_id))
        {
            return false;
        }
        match d.submitted_tick {
            None => {
                d.status != Status::Pending
                    && d.status != Status::Failed
                    && d.applied_tick
                        .is_some_and(|t| t <= now && self.admission(&i, t))
                    && if d.status == Status::Accepted {
                        d.reason.is_none()
                    } else {
                        matches!(
                            d.reason,
                            Some(Reason::StaleObservation | Reason::NotAvailable)
                        )
                    }
            }
            Some(submitted) => {
                if submitted > now || d.actor != Actor::External {
                    return false;
                }
                let due = submitted + self.config.delay;
                let expires = submitted + self.config.ttl;
                match d.status {
                    Status::Pending => {
                        d.applied_tick.is_none()
                            && d.reason.is_none()
                            && !self.stale(d.observed_tick, submitted)
                            && self.tasks.contains(&d.task_id)
                            && self.agents.contains(&d.agent_id)
                            && due > now
                            && expires >= now
                    }
                    Status::Accepted => {
                        d.reason.is_none()
                            && d.applied_tick == Some(due)
                            && due <= now
                            && due <= expires
                            && !self.stale(d.observed_tick, due)
                    }
                    Status::Rejected => {
                        d.applied_tick.is_some_and(|t| {
                            t <= now
                                && (t == submitted || t == due && t <= expires)
                                && self.admission(&i, t)
                        }) && matches!(
                            d.reason,
                            Some(Reason::StaleObservation | Reason::NotAvailable)
                        )
                    }
                    Status::Failed => d.applied_tick.is_some_and(|t| {
                        t >= submitted
                            && t <= now
                            && match d.reason {
                                Some(Reason::Expired) => t > expires,
                                Some(
                                    Reason::Unavailable | Reason::Interrupted | Reason::Dropped,
                                ) => t == due && t <= expires,
                                Some(Reason::RunEnded | Reason::ModeChanged) => {
                                    t < due && t <= expires
                                }
                                _ => false,
                            }
                    }),
                }
            }
        }
    }
    fn packet(
        &self,
        task: String,
        agent: String,
        observed: u64,
        actor: Option<Actor>,
        request_id: Option<String>,
        now: u64,
    ) -> Result<Packet> {
        if self.state.dispatch_queue.len() >= 100
            || self.state.next_dispatch_id >= MAX_COUNT
            || !self.tasks.contains(&task)
            || !self.agents.contains(&agent)
            || self.state.dispatch_queue.iter().any(|p| p.task_id == task)
        {
            return Err(invalid());
        }
        Ok(Packet {
            id: self.state.next_dispatch_id,
            task_id: task,
            agent_id: agent,
            observed_tick: observed,
            due_tick: now + self.config.delay,
            expires_tick: now + self.config.ttl,
            actor,
            request_id,
        })
    }
}
#[napi]
impl WorldDispatch {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        let i: Initial = decode(&input)?;
        if i.tick > MAX_TICK
            || i.agents.is_empty()
            || i.agents.len() > 50
            || i.tasks.is_empty()
            || i.tasks.len() > 100
            || i.agents.iter().any(|a| !token(a))
            || i.agents.iter().collect::<HashSet<_>>().len() != i.agents.len()
            || i.tasks.iter().any(|id| !task_id(id))
            || i.tasks.iter().collect::<HashSet<_>>().len() != i.tasks.len()
            || !(1..=10000).contains(&i.config.delay)
            || !(1..=10000).contains(&i.config.ttl)
            || !(1..=10000).contains(&i.config.decision_max_age)
            || !i.config.loss_rate.is_finite()
            || !(0.0..=1.0).contains(&i.config.loss_rate)
            || i.state.decisions.len() > 1000
            || i.state.dispatch_queue.len() > 100
            || i.state.next_dispatch_id == 0
            || i.state.next_dispatch_id > MAX_COUNT
        {
            return Err(invalid());
        }
        let w = Self { checkpoint_id: crate::world_checkpoint::identity(),
            state: i.state,
            agents: i.agents,
            tasks: i.tasks.into_iter().collect(),
            config: i.config,
            seed: i.seed,
            last_tick: i.tick,
            last_ready: i.tick,
            tickets: HashMap::new(),
            event_binding:None,
            closed: false,
        };
        let mut ids = HashSet::new();
        for d in &w.state.decisions {
            if !w.decision_valid(d, i.tick) || !ids.insert((d.actor, &d.request_id)) {
                return Err(invalid());
            }
        }
        let mut queued = HashSet::new();
        let mut packet_ids = HashSet::new();
        let mut pending = HashSet::new();
        for p in &w.state.dispatch_queue {
            if p.id == 0
                || p.id >= w.state.next_dispatch_id
                || !packet_ids.insert(p.id)
                || !queued.insert(&p.task_id)
                || !w.tasks.contains(&p.task_id)
                || !w.agents.contains(&p.agent_id)
                || p.observed_tick > i.tick
                || p.due_tick <= i.tick
                || p.expires_tick < i.tick
                || p.due_tick < p.observed_tick + w.config.delay
                || p.due_tick > w.config.delay + MAX_TICK
            {
                return Err(invalid());
            }
            if p.actor == Some(Actor::External) {
                let Some(id) = &p.request_id else {
                    return Err(invalid());
                };
                let Some(d) = w.state.decisions.iter().find(|d| {
                    d.actor == Actor::External && d.request_id == *id && d.status == Status::Pending
                }) else {
                    return Err(invalid());
                };
                if d.task_id != p.task_id
                    || d.agent_id != p.agent_id
                    || d.observed_tick != p.observed_tick
                    || d.submitted_tick.is_none_or(|t| {
                        p.due_tick != t + w.config.delay || p.expires_tick != t + w.config.ttl
                    })
                    || !pending.insert(id)
                {
                    return Err(invalid());
                }
            } else if p.actor.is_some()
                || p.request_id.is_some()
                || p.due_tick != p.observed_tick + w.config.delay
                || p.expires_tick != p.observed_tick + w.config.ttl
            {
                return Err(invalid());
            }
        }
        if w.state
            .decisions
            .iter()
            .filter(|d| d.status == Status::Pending)
            .count()
            != pending.len()
        {
            return Err(invalid());
        }
        for (task, agent) in &w.state.dispatch_avoid {
            if !w.tasks.contains(task) || !w.agents.contains(agent) {
                return Err(invalid());
            }
        }
        Ok(w)
    }
    #[napi]
    pub fn register_task(&mut self, id: String, tick: f64) -> Result<()> {
        let now = self.now(tick)?;
        if !task_id(&id) || self.tasks.len() >= 100 || self.tasks.contains(&id) {
            return Err(invalid());
        }
        self.tasks.insert(id);
        self.last_tick = now;
        Ok(())
    }
    #[napi]
    pub fn automatic_events(&mut self,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&mut crate::world_tasks::WorldTasks,resources:&mut crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;
        if ctx.done||!matches!(ctx.mode,"rule"|"networked"){return Err(invalid())}
        let networked=ctx.mode=="networked";let policy=control.dispatch_policy()?;
        // Capture ready branches once, then re-read live candidates after each
        // staged assignment/reservation. Stable sorting retains declaration ties
        // and the original rule request index even for branches with no candidate.
        let mut ready:Vec<_>=ctx.tasks.iter().filter(|t|ctx.ready.contains(&t.id)).cloned().collect();
        ready.sort_by(|a,b|{let(ap,ad)=a.dispatch_order();let(bp,bd)=b.dispatch_order();bp.cmp(&ap).then(ad.cmp(&bd))});
        let mut next=self.clone();let mut next_motion=motion.clone();let mut next_tasks=tasks.clone();let mut next_resources=resources.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
        let mut assignments=0;let mut enqueued=0;let before=next.state.decisions.len();
        for(index,task)in ready.iter().enumerate(){
            if networked&&next.state.dispatch_queue.iter().any(|p|p.task_id==task.id){continue}
            let live=next.event_context(expected,&next_motion,environment,&next_tasks,&next_resources,actions,peer,reports,&next_control,&next_ledger)?;
            let Some(agent_id)=next.automatic_candidate(&live,task,environment,policy,networked)?else{continue};
            if networked{
                next.enqueue_events(encode(&RulePacket{task_id:task.id.clone(),agent_id,observed_tick:expected as u64})?,expected,&next_motion,environment,&next_tasks,&next_resources,actions,peer,reports,&mut next_control,&mut next_ledger)?;enqueued+=1;
            }else{
                let result:serde_json::Value=decode(&next.immediate_events(serde_json::json!({"actor":"rule","requestId":format!("rule-{}-{}",expected as u64,index),"taskId":task.id,"agentId":agent_id,"observedTick":expected as u64}).to_string(),expected,&mut next_motion,environment,&mut next_tasks,&mut next_resources,actions,peer,reports,&mut next_control,&mut next_ledger)?)?;
                if result["assigned"]==true{assignments+=1}
            }
        }
        let decisions=next.state.decisions.len()-before;next.last_tick=expected as u64;next.event_binding=Some(ctx.binding);
        self.event_commit(next,motion,next_motion,tasks,next_tasks,resources,next_resources,control,next_control,ledger,next_ledger)?;
        encode(&serde_json::json!({"assigned":assignments>0,"assignments":assignments,"enqueued":enqueued,"decisions":decisions}))
    }
    #[napi]
    pub fn immediate_events(&mut self,input:String,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&mut crate::world_tasks::WorldTasks,resources:&mut crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;let input:OwnedIntent=decode(&input)?;let mut i=input.intent();let fail=|reason:&str|encode(&serde_json::json!({"ok":false,"reason":reason}));if !self.valid_intent(&i){return fail("invalid_decision")}
        if let Some(d)=self.state.decisions.iter().find(|d|d.actor==i.actor&&d.request_id==i.request_id){return if Self::same(d,&i){encode(&serde_json::json!({"ok":true,"duplicate":true,"decision":d,"assigned":false}))}else{fail("request_id_conflict")}}if ctx.done{return fail("world_finished")}if self.state.decisions.len()>=1000{return fail("decision_limit")}
        let route=if self.stale(i.observed_tick,expected as u64){i.reason=Some(Reason::StaleObservation);None}else{let route=Self::live_route(&ctx,&i.task_id,&i.agent_id,environment)?;if route.is_none(){i.reason=Some(Reason::NotAvailable)}route};
        let mut next=self.clone();let mut next_motion=motion.clone();let mut next_tasks=tasks.clone();let mut next_resources=resources.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let assigned=if i.reason.is_none(){Self::owned_assignment(&i.task_id,&i.agent_id,route,expected,&mut next_motion,environment,&mut next_tasks,&mut next_resources,&mut next_control,&mut next_ledger)?}else{false};if i.reason.is_none()&&!assigned{i.reason=Some(Reason::NotAvailable)}
        let mut result:serde_json::Value=decode(&next.immediate(encode(&i)?,expected)?)?;let d=next.state.decisions.last().ok_or_else(invalid)?;next_control.task_event(&mut next_ledger,Self::decision_fact(d,if d.reason.is_some(){"指挥分配被拒绝"}else{"指挥分配已接受"}))?;result["ok"]=true.into();result["assigned"]=assigned.into();next.event_binding=Some(ctx.binding);self.event_commit(next,motion,next_motion,tasks,next_tasks,resources,next_resources,control,next_control,ledger,next_ledger)?;encode(&result)
    }
    #[napi]
    pub fn external_events(&mut self,input:String,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;if !matches!(ctx.mode,"networked_external"|"networked_reported"){return Err(invalid())}let input:OwnedIntent=decode(&input)?;let mut i=input.intent();let fail=|reason:&str|encode(&serde_json::json!({"ok":false,"reason":reason}));if i.actor!=Actor::External||!self.valid_intent(&i)||i.task_id.is_empty()||i.agent_id.is_empty(){return fail("invalid_decision")}
        if let Some(d)=self.state.decisions.iter().find(|d|d.actor==i.actor&&d.request_id==i.request_id){return if Self::same(d,&i){encode(&serde_json::json!({"ok":true,"duplicate":true,"decision":d}))}else{fail("request_id_conflict")}}if ctx.done{return fail("world_finished")}if self.state.decisions.len()>=1000{return fail("decision_limit")}if self.state.dispatch_queue.len()>=100{return fail("queue_full")}if self.state.dispatch_queue.iter().any(|p|p.actor==Some(Actor::External)&&p.task_id==i.task_id){return fail("task_in_transit")}
        i.reason=if self.stale(i.observed_tick,expected as u64){Some(Reason::StaleObservation)}else if !self.candidate(&ctx,&i.task_id,&i.agent_id,environment,reports,ctx.mode=="networked_reported",true,expected as u64)?{Some(Reason::NotAvailable)}else{None};
        let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let mut result:serde_json::Value=decode(&next.external(encode(&i)?,expected)?)?;let d=next.state.decisions.last().ok_or_else(invalid)?;
        let event=if i.reason.is_some(){Self::decision_fact(d,"指挥分配被拒绝")}else{let p=next.state.dispatch_queue.last().ok_or_else(invalid)?;let mut fact=serde_json::json!({"message":"外部任务指令已排队","type":"info","kind":"dispatch_sent","dispatchId":p.id,"requestId":d.request_id,"taskId":d.task_id,"agentId":d.agent_id});if let Some(id)=&d.coordinator_id{fact["coordinatorId"]=id.clone().into()}fact};next_control.task_event(&mut next_ledger,event)?;result["ok"]=true.into();next.event_binding=Some(ctx.binding);next_control.validate_commit(&next_ledger)?;*self=next;*control=next_control;*ledger=next_ledger;encode(&result)
    }
    #[napi]
    pub fn enqueue_events(&mut self,input:String,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;let i:RulePacket=decode(&input)?;if ctx.done||ctx.mode!="networked"||i.observed_tick!=expected as u64||!self.candidate(&ctx,&i.task_id,&i.agent_id,environment,reports,false,true,expected as u64)?{return Err(invalid())}
        let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let result=next.enqueue(encode(&i)?,expected)?;let p=next.state.dispatch_queue.last().ok_or_else(invalid)?;let t=ctx.tasks.iter().find(|t|t.id==p.task_id).ok_or_else(invalid)?;let name=serde_json::to_value(t).map_err(|_|invalid())?["name"].as_str().ok_or_else(invalid)?.to_owned();next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("任务「{}」指令发往 {}",name,p.agent_id),"type":"info","kind":"dispatch_sent","dispatchId":p.id,"taskId":p.task_id,"agentId":p.agent_id}))?;next.event_binding=Some(ctx.binding);next_control.validate_commit(&next_ledger)?;*self=next;*control=next_control;*ledger=next_ledger;Ok(result)
    }
    #[napi]
    pub fn ready_events(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;if ctx.done||!matches!(ctx.mode,"networked"|"networked_external"|"networked_reported"){return Err(invalid())}let mut next=self.clone();let result=next.ready(encode(&ctx.environment)?,expected)?;next.event_binding=Some(ctx.binding);control.validate_commit(ledger)?;*self=next;Ok(result)
    }
    #[napi]
    pub fn settle_events(&mut self,id:f64,expected:f64,motion:&mut crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&mut crate::world_tasks::WorldTasks,resources:&mut crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;if ctx.done||!id.is_finite()||id.fract()!=0.0||!(1.0..=MAX_COUNT as f64).contains(&id)||expected as u64!=self.last_ready{return Err(invalid())}let id=id as u64;let transport=*self.tickets.get(&id).ok_or_else(invalid)?;if transport==Transport::Waiting{return Err(invalid())}let p=self.state.dispatch_queue.iter().find(|p|p.id==id).cloned().ok_or_else(invalid)?;
        let mut next=self.clone();let mut next_motion=motion.clone();let mut next_tasks=tasks.clone();let mut next_resources=resources.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let mut reason=transport.reason();let mut assigned=false;
        if p.actor==Some(Actor::External){
            if reason.is_none(){if self.stale(p.observed_tick,expected as u64){reason=Some(Reason::StaleObservation)}else{assigned=Self::owned_assignment(&p.task_id,&p.agent_id,Self::live_route(&ctx,&p.task_id,&p.agent_id,environment)?,expected,&mut next_motion,environment,&mut next_tasks,&mut next_resources,&mut next_control,&mut next_ledger)?;if !assigned{reason=Some(Reason::NotAvailable)}}}
            next.settle(id as f64,reason.map(|r|serde_json::to_value(r).unwrap().as_str().unwrap().to_owned()),expected)?;let d=next.state.decisions.iter().find(|d|d.actor==Actor::External&&Some(&d.request_id)==p.request_id.as_ref()).ok_or_else(invalid)?;next_control.task_event(&mut next_ledger,Self::decision_fact(d,if reason.is_some(){"外部任务指令失败或被拒绝"}else{"外部任务指令已接受"}))?;
        }else{
            if reason.is_none(){let mut i=Intent{actor:Actor::Network,request_id:format!("network-{}",p.id),task_id:p.task_id.clone(),agent_id:p.agent_id.clone(),observed_tick:p.observed_tick,reason:None,coordinator_id:None};
                if let Some(d)=next.state.decisions.iter().find(|d|d.actor==i.actor&&d.request_id==i.request_id){if !Self::same(d,&i){return Err(invalid())}reason=d.reason;}else if next.state.decisions.len()>=1000{reason=Some(Reason::DecisionLimit)}else{
                    if self.stale(i.observed_tick,expected as u64){reason=Some(Reason::StaleObservation)}else{assigned=Self::owned_assignment(&p.task_id,&p.agent_id,Self::live_route(&ctx,&p.task_id,&p.agent_id,environment)?,expected,&mut next_motion,environment,&mut next_tasks,&mut next_resources,&mut next_control,&mut next_ledger)?;if !assigned{reason=Some(Reason::NotAvailable)}}i.reason=reason;next.immediate(encode(&i)?,expected)?;let d=next.state.decisions.last().ok_or_else(invalid)?;next_control.task_event(&mut next_ledger,Self::decision_fact(d,if reason.is_some(){"指挥分配被拒绝"}else{"指挥分配已接受"}))?;
                }
            }
            next.settle(id as f64,reason.map(|r|serde_json::to_value(r).unwrap().as_str().unwrap().to_owned()),expected)?;
        }
        next_control.task_event(&mut next_ledger,Self::dispatch_fact(&p,reason))?;next.event_binding=Some(ctx.binding);self.event_commit(next,motion,next_motion,tasks,next_tasks,resources,next_resources,control,next_control,ledger,next_ledger)?;encode(&serde_json::json!({"assigned":assigned,"reason":reason}))
    }
    #[napi]
    pub fn cancel_events(&mut self,reason:String,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,resources:&crate::world_resources::WorldResources,actions:&crate::world_actions::WorldActions,peer:&crate::world_peer::WorldPeer,reports:&crate::world_reports::WorldReports,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,resources,actions,peer,reports,control,ledger)?;if !matches!(reason.as_str(),"mode_changed"|"run_ended")||reason=="run_ended"&&!ctx.done{return Err(invalid())}let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let count=next.state.dispatch_queue.len();let packets=next.state.dispatch_queue.clone();next.cancel(reason.clone(),expected)?;
        for p in &packets{next_control.task_event(&mut next_ledger,serde_json::json!({"message":if reason=="mode_changed"{"任务指令未送达（指挥方式切换）"}else{"任务指令未送达（实验结束）"},"type":"warning","kind":"dispatch_failed","dispatchId":p.id,"taskId":p.task_id,"agentId":p.agent_id,"reason":reason}))?}next.event_binding=Some(ctx.binding);next_control.validate_commit(&next_ledger)?;*self=next;*control=next_control;*ledger=next_ledger;encode(&serde_json::json!({"cancelled":count}))
    }
    #[napi]
    pub fn immediate(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let i: Intent = decode(&input)?;
        if !self.valid_intent(&i) {
            return Err(invalid());
        }
        if let Some(d) = self
            .state
            .decisions
            .iter()
            .find(|d| d.actor == i.actor && d.request_id == i.request_id)
        {
            if !Self::same(d, &i) {
                return Err(invalid());
            }
            return encode(&serde_json::json!({"duplicate":true,"decision":d}));
        }
        if self.state.decisions.len() >= 1000 || !self.admission(&i, now) {
            return Err(invalid());
        }
        let d = Decision {
            actor: i.actor,
            request_id: i.request_id,
            task_id: i.task_id,
            agent_id: i.agent_id,
            observed_tick: i.observed_tick,
            status: if i.reason.is_some() {
                Status::Rejected
            } else {
                Status::Accepted
            },
            submitted_tick: None,
            applied_tick: Some(now),
            reason: i.reason,
            coordinator_id: i.coordinator_id,
        };
        let result = encode(&serde_json::json!({"duplicate":false,"decision":d}))?;
        self.state.decisions.push(d);
        self.last_tick = now;
        Ok(result)
    }
    #[napi]
    pub fn external(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let i: Intent = decode(&input)?;
        if i.actor != Actor::External || !self.valid_intent(&i) {
            return Err(invalid());
        }
        if let Some(d) = self
            .state
            .decisions
            .iter()
            .find(|d| d.actor == i.actor && d.request_id == i.request_id)
        {
            if !Self::same(d, &i) {
                return Err(invalid());
            }
            return encode(&serde_json::json!({"duplicate":true,"decision":d}));
        }
        if self.state.decisions.len() >= 1000
            || self.state.dispatch_queue.len() >= 100
            || self
                .state
                .dispatch_queue
                .iter()
                .any(|p| p.actor == Some(Actor::External) && p.task_id == i.task_id)
            || !self.admission(&i, now)
        {
            return Err(invalid());
        }
        let p = if i.reason.is_none() {
            Some(self.packet(
                i.task_id.clone(),
                i.agent_id.clone(),
                i.observed_tick,
                Some(Actor::External),
                Some(i.request_id.clone()),
                now,
            )?)
        } else {
            None
        };
        let d = Decision {
            actor: i.actor,
            request_id: i.request_id,
            task_id: i.task_id,
            agent_id: i.agent_id,
            observed_tick: i.observed_tick,
            status: if i.reason.is_some() {
                Status::Rejected
            } else {
                Status::Pending
            },
            submitted_tick: Some(now),
            applied_tick: if i.reason.is_some() { Some(now) } else { None },
            reason: i.reason,
            coordinator_id: i.coordinator_id,
        };
        let result = encode(&serde_json::json!({"duplicate":false,"decision":d,"packet":p}))?;
        self.state.decisions.push(d);
        if let Some(p) = p {
            self.state.dispatch_queue.push(p);
            self.state.next_dispatch_id += 1;
            self.tickets.clear();
        }
        self.last_tick = now;
        Ok(result)
    }
    #[napi]
    pub fn enqueue(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let i: RulePacket = decode(&input)?;
        if i.observed_tick != now {
            return Err(invalid());
        }
        let p = self.packet(i.task_id, i.agent_id, i.observed_tick, None, None, now)?;
        let result = encode(&p)?;
        self.state.dispatch_queue.push(p);
        self.state.next_dispatch_id += 1;
        self.last_tick = now;
        self.tickets.clear();
        Ok(result)
    }
    #[napi]
    pub fn ready(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let e: Environment = decode(&input)?;
        if now <= self.last_ready
            || e.agents.len() != self.agents.len()
            || e.agents.iter().zip(&self.agents).any(|(a, b)| a.id != *b)
            || e.outages.len() > self.agents.len()
            || e.outages
                .iter()
                .map(|o| &o.agent_id)
                .collect::<HashSet<_>>()
                .len()
                != e.outages.len()
            || e.outages.iter().any(|o| {
                !self.agents.contains(&o.agent_id)
                    || o.started_tick > now
                    || o.until_tick < now
                    || o.until_tick <= o.started_tick
                    || o.until_tick > o.started_tick + 1000
            })
        {
            return Err(invalid());
        }
        let packets:Vec<_>=self.state.dispatch_queue.iter().map(|p|serde_json::json!({"id":p.id,"dueTick":p.due_tick,"expiresTick":p.expires_tick,"unavailable":e.agents.iter().any(|a|a.id==p.agent_id&&a.disabled),"interrupted":e.outages.iter().any(|o|o.agent_id==p.agent_id&&now<=o.until_tick)})).collect();
        let result = crate::central_link_tick(encode(
            &serde_json::json!({"tick":now,"seed":self.seed,"lossRate":self.config.loss_rate,"offset":1000000,"packets":packets}),
        )?)?;
        let outcomes: Vec<Outcome> = decode(&result)?;
        self.tickets = outcomes.into_iter().map(|o| (o.id, o.state)).collect();
        self.last_ready = now;
        self.last_tick = now;
        Ok(result)
    }
    #[napi]
    pub fn settle(&mut self, id: f64, reason: Option<String>, tick: f64) -> Result<()> {
        let now = self.now(tick)?;
        if !id.is_finite()
            || id.fract() != 0.0
            || id < 1.0
            || id > MAX_COUNT as f64
            || now != self.last_ready
        {
            return Err(invalid());
        }
        let id = id as u64;
        let transport = *self.tickets.get(&id).ok_or_else(invalid)?;
        if transport == Transport::Waiting {
            return Err(invalid());
        }
        let reason: Option<Reason> = reason
            .map(|s| serde_json::from_value(serde_json::Value::String(s)).map_err(|_| invalid()))
            .transpose()?;
        let index = self
            .state
            .dispatch_queue
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(invalid)?;
        let p = &self.state.dispatch_queue[index];
        if let Some(failure) = transport.reason() {
            if reason != Some(failure) {
                return Err(invalid());
            }
        } else if !matches!(
            reason,
            None | Some(Reason::StaleObservation | Reason::NotAvailable | Reason::DecisionLimit)
        ) {
            return Err(invalid());
        }
        if p.actor == Some(Actor::External) {
            let d = self
                .state
                .decisions
                .iter()
                .find(|d| {
                    d.actor == Actor::External && Some(&d.request_id) == p.request_id.as_ref()
                })
                .ok_or_else(invalid)?;
            if d.status != Status::Pending
                || reason == Some(Reason::DecisionLimit)
                || transport == Transport::Delivered
                    && (self.stale(d.observed_tick, now)
                        != (reason == Some(Reason::StaleObservation)))
            {
                return Err(invalid());
            }
            let key = d.request_id.clone();
            let d = self
                .state
                .decisions
                .iter_mut()
                .find(|d| d.actor == Actor::External && d.request_id == key)
                .unwrap();
            d.status = if transport.reason().is_some() {
                Status::Failed
            } else if reason.is_some() {
                Status::Rejected
            } else {
                Status::Accepted
            };
            d.reason = reason;
            d.applied_tick = Some(now);
        } else {
            if transport == Transport::Delivered {
                if reason == Some(Reason::DecisionLimit) {
                    if self.state.decisions.len() < 1000 {
                        return Err(invalid());
                    }
                } else {
                    let request = format!("network-{}", p.id);
                    let d = self
                        .state
                        .decisions
                        .iter()
                        .find(|d| d.actor == Actor::Network && d.request_id == request)
                        .ok_or_else(invalid)?;
                    if d.applied_tick != Some(now)
                        || d.task_id != p.task_id
                        || d.agent_id != p.agent_id
                        || d.reason != reason
                    {
                        return Err(invalid());
                    }
                }
            }
            if reason.is_some() {
                self.state
                    .dispatch_avoid
                    .insert(p.task_id.clone(), p.agent_id.clone());
            } else {
                self.state.dispatch_avoid.remove(&p.task_id);
            }
        }
        self.state.dispatch_queue.remove(index);
        self.tickets.remove(&id);
        self.last_tick = now;
        Ok(())
    }
    #[napi]
    pub fn cancel(&mut self, reason: String, tick: f64) -> Result<()> {
        let now = self.now(tick)?;
        let reason = match reason.as_str() {
            "run_ended" => Reason::RunEnded,
            "mode_changed" => Reason::ModeChanged,
            _ => return Err(invalid()),
        };
        let requests: HashSet<_> = self
            .state
            .dispatch_queue
            .iter()
            .filter(|p| p.actor == Some(Actor::External))
            .filter_map(|p| p.request_id.as_ref())
            .collect();
        for d in &mut self.state.decisions {
            if d.actor == Actor::External
                && d.status == Status::Pending
                && requests.contains(&d.request_id)
            {
                d.status = Status::Failed;
                d.reason = Some(reason);
                d.applied_tick = Some(now)
            }
        }
        self.state.dispatch_queue.clear();
        if reason == Reason::ModeChanged {
            self.state.dispatch_avoid.clear()
        }
        self.tickets.clear();
        self.last_tick = now;
        Ok(())
    }
    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        self.active()?;
        encode(&self.state)
    }
    #[napi]
    pub fn free(&mut self) {
        self.closed = true;
        self.event_binding=None;
        self.state.decisions.clear();
        self.state.dispatch_queue.clear();
        self.state.dispatch_avoid.clear();
        self.tasks.clear();
        self.agents.clear();
        self.tickets.clear();
    }
}

crate::world_checkpoint::world_checkpoint!(WorldDispatch);
