//! Owned central report queues and retained evidence. Geometry and recorded
//! coupled event APIs derive sources and geometry from owned participants.
//! Legacy low-level source/geometry commands remain available to the host.
use crate::ordered_map::OrderedMap;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
const MAX_TICK: u64 = 10_000_000;
const MAX_COUNT: u64 = 9_007_199_254_740_000;
fn invalid() -> Error {
    Error::from_reason("invalid world reports input")
}
fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn point(p: &[f64; 2]) -> bool {
    p.iter().all(|n| n.is_finite() && (0.0..=crate::MAX_WORLD_SIZE).contains(n))
}
fn present<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}
fn decode<T: for<'de> Deserialize<'de>>(s: &str) -> Result<T> {
    if s.len() > 16 * 1024 * 1024 {
        return Err(invalid());
    }
    serde_json::from_str(s).map_err(|_| invalid())
}
fn encode<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|_| invalid())
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    delay: u64,
    ttl: u64,
    loss_rate: f64,
    status_interval: u64,
    status_max_age: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Agent {
    id: String,
    role: String,
    capabilities: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Sensor {
    id: String,
    name: String,
    x: f64,
    y: f64,
    height: f64,
    range: f64,
    interval: u64,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum AgentStatus {
    Idle,
    Assigned,
    Working,
    Manual,
    Fault,
    Deployed,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Assignment {
    task_id: String,
    assignment_id: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    id: String,
    x: f64,
    y: f64,
    battery: f64,
    status: AgentStatus,
    capabilities: Vec<String>,
    active_assignment: Option<Assignment>,
    route_blocked_since: Option<u64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusPacket {
    id: u64,
    agent_id: String,
    captured_tick: u64,
    due_tick: u64,
    expires_tick: u64,
    payload: Payload,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusReport {
    id: String,
    x: f64,
    y: f64,
    battery: f64,
    status: AgentStatus,
    capabilities: Vec<String>,
    active_assignment: Option<Assignment>,
    route_blocked_since: Option<u64>,
    captured_tick: u64,
    received_tick: u64,
}
impl StatusReport {
    fn payload(&self) -> Payload {
        Payload {
            id: self.id.clone(),
            x: self.x,
            y: self.y,
            battery: self.battery,
            status: self.status,
            capabilities: self.capabilities.clone(),
            active_assignment: self.active_assignment.clone(),
            route_blocked_since: self.route_blocked_since,
        }
    }
    fn from(p: StatusPacket, now: u64) -> Self {
        let v = p.payload;
        Self {
            id: v.id,
            x: v.x,
            y: v.y,
            battery: v.battery,
            status: v.status,
            capabilities: v.capabilities,
            active_assignment: v.active_assignment,
            route_blocked_since: v.route_blocked_since,
            captured_tick: p.captured_tick,
            received_tick: now,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reporting {
    interval: u64,
    max_age: u64,
    next_id: u64,
    queue: Vec<StatusPacket>,
    reports: OrderedMap<StatusReport>,
    sent: u64,
    delivered: u64,
    failed: u64,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Finding {
    Anomaly,
    Normal,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixedPacket {
    id: u64,
    sensor_id: String,
    result: Finding,
    position: [f64; 2],
    observed_tick: u64,
    due_tick: u64,
    expires_tick: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixedReport {
    sensor_id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    report_id: Option<u64>,
    result: Finding,
    position: [f64; 2],
    observed_tick: u64,
    received_tick: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixedState {
    next_id: u64,
    queue: Vec<FixedPacket>,
    reports: OrderedMap<FixedReport>,
    sent: u64,
    delivered: u64,
    failed: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ScanResult {
    Anomaly {
        position: [f64; 2],
        #[serde(rename = "observedTick")]
        observed_tick: u64,
    },
    Normal {
        position: [f64; 2],
        #[serde(rename = "observedTick")]
        observed_tick: u64,
    },
    NotDetected {
        #[serde(rename = "observedTick")]
        observed_tick: u64,
    },
}
impl ScanResult {
    fn valid(&self, now: u64) -> bool {
        match self {
            Self::Anomaly {
                position,
                observed_tick,
            }
            | Self::Normal {
                position,
                observed_tick,
            } => *observed_tick <= now && point(position),
            Self::NotDetected { observed_tick } => *observed_tick <= now,
        }
    }
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReportStatus {
    Pending,
    Delivered,
    Failed,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Reason {
    Expired,
    Unavailable,
    Interrupted,
    Dropped,
    RunEnded,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    id: u64,
    agent_id: String,
    role: String,
    can_survey: bool,
    request_id: String,
    scan_request_id: String,
    result: ScanResult,
    submitted_tick: u64,
    due_tick: u64,
    expires_tick: u64,
    status: ReportStatus,
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
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sample {
    id: u64,
    agent_id: String,
    task_id: String,
    position: [f64; 2],
    collected_tick: u64,
    request_id: String,
    submitted_tick: u64,
    due_tick: u64,
    expires_tick: u64,
    status: ReportStatus,
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
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    reporting: Option<Reporting>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    fixed_sensors: Option<Vec<Sensor>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    fixed_sensor_state: Option<FixedState>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    evidence_reports: Option<Vec<Evidence>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    sample_reports: Option<Vec<Sample>>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial {
    tick: u64,
    seed: u32,
    config: Config,
    site: [f64; 2],
    agents: Vec<Agent>,
    state: State,
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
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusSource {
    id: String,
    x: f64,
    y: f64,
    battery: f64,
    status: AgentStatus,
    disabled: bool,
    active_assignment: Option<Assignment>,
    route_blocked_since: Option<u64>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceSource {
    agent_id: String,
    request_id: String,
    scan_request_id: String,
    result: ScanResult,
    disabled: bool,
    done: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SampleSource {
    agent_id: String,
    request_id: String,
    task_id: String,
    position: [f64; 2],
    collected_tick: u64,
    disabled: bool,
    done: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sight {
    sensor_id: String,
    visible: bool,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixedInput {
    environment: Environment,
    sight: Vec<Sight>,
    anomaly: bool,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Outcome {
    id: u64,
    state: String,
}
struct ReportEventContext{binding:[u64;8],actors:Vec<(usize,crate::world_motion::Motion,crate::world_execution::Execution)>,tasks:Vec<crate::world_tasks::Task>,done:bool,environment:serde_json::Value}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct ReportCommand{agent_id:String,request_id:String,scan_request_id:Option<String>,task_id:Option<String>}
#[napi]
#[derive(Clone)]
pub struct WorldReports {
    checkpoint_id: u64,
    state: State,
    agents: Vec<Agent>,
    config: Config,
    site: [f64; 2],
    seed: u32,
    last_tick: u64,
    processed: [u64; 4],
    event_binding:Option<[u64;8]>,
    event_physics:Option<u64>,
    closed: bool,
}
impl WorldReports {
    pub(crate) fn coordinator_reports(&self,now:u64,roles:&[String])->Result<serde_json::Value>{
        self.now(now as f64)?;
        // Object.values() puts canonical array-index keys first, then retains
        // arrival order. Decode-to-Value would instead sort all keys.
        fn entries<T>(map:&OrderedMap<T>)->Vec<&(String,T)>{let mut rows:Vec<_>=map.into_iter().collect();let index=|s:&str|s.parse::<u32>().ok().filter(|n|*n<u32::MAX&&n.to_string()==s);rows.sort_by(|a,b|match(index(&a.0),index(&b.0)){(Some(a),Some(b))=>a.cmp(&b),(Some(_),None)=>std::cmp::Ordering::Less,(None,Some(_))=>std::cmp::Ordering::Greater,_=>std::cmp::Ordering::Equal});rows}
        let statuses:Vec<_>=self.state.reporting.as_ref().map(|s|entries(&s.reports).into_iter().map(|(_,r)|serde_json::to_value(r).map_err(|_|invalid())).collect::<Result<Vec<_>>>()).transpose()?.unwrap_or_default();
        let evidence:Vec<_>=self.state.evidence_reports.iter().flatten().filter(|r|r.status==ReportStatus::Delivered).map(|r|serde_json::json!({"id":r.id,"agentId":r.agent_id,"role":r.role,"canSurvey":r.can_survey,"scanRequestId":r.scan_request_id,"result":r.result,"receivedTick":r.applied_tick})).collect();
        let samples:Vec<_>=self.state.sample_reports.iter().flatten().filter(|r|r.status==ReportStatus::Delivered).map(|r|serde_json::json!({"id":r.id,"agentId":r.agent_id,"taskId":r.task_id,"position":r.position,"collectedTick":r.collected_tick,"receivedTick":r.applied_tick,"surveyRoles":roles})).collect();
        let fixed:Vec<_>=self.state.fixed_sensor_state.as_ref().map(|s|entries(&s.reports).into_iter().map(|(_,r)|{let mut v=serde_json::to_value(r).map_err(|_|invalid())?;v["surveyRoles"]=serde_json::json!(roles);Ok(v)}).collect::<Result<Vec<_>>>()).transpose()?.unwrap_or_default();
        let summary=self.state.reporting.as_ref().map(|s|serde_json::json!({"interval":s.interval,"maxAge":s.max_age,"known":s.reports.len(),"fresh":(&s.reports).into_iter().filter(|(_,r)|now-r.captured_tick<=s.max_age).count(),"total":self.agents.len(),"sent":s.sent,"delivered":s.delivered,"failed":s.failed}));
        Ok(serde_json::json!({"statusReports":statuses,"evidence":evidence,"sampleReports":samples,"fixedSensorReports":fixed,"reporting":summary}))
    }
    pub(crate) fn dispatch_context(&self,now:u64,actors:&[(usize,crate::world_motion::Motion,crate::world_execution::Execution)],site:[f64;2],seed:u32,config:&serde_json::Value,ledger:&crate::world_ledger::WorldLedger)->Result<u64>{
        let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let id=self.finalization_context(now,&roster,site,seed,ledger)?;
        if serde_json::to_value(&self.config).map_err(|_|invalid())?!=*config||self.agents.iter().zip(actors).any(|(a,(_,m,e))|a.id!=m.id||a.role!=e.role||a.capabilities!=e.capabilities){return Err(invalid())}Ok(id)
    }
    pub(crate) fn dispatch_candidate(&self,agent:&str,capability:&str,now:u64)->Result<bool>{
        self.now(now as f64)?;Ok(self.state.reporting.as_ref().is_some_and(|s|(&s.reports).into_iter().find(|(id,_)|id.as_str()==agent).is_some_and(|(_,r)|r.captured_tick<=now&&now-r.captured_tick<=s.max_age&&r.status==AgentStatus::Idle&&r.battery>5.0&&r.capabilities.iter().any(|c|c==capability))))
    }
    fn event_context(&self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<ReportEventContext>{
        let now=self.now(expected)?;let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();
        if self.agents.len()!=actors.len()||self.agents.iter().zip(&actors).any(|(a,(_,m,e))|a.id!=m.id||a.role!=e.role||a.capabilities!=e.capabilities){return Err(invalid())}
        let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();let(t,_)=tasks.revocation_context("",&actors,&catalog)?;
        let(c,l,done,_)=control.proposal_context(now as u32,&ids,&catalog,ledger)?;control.peer_events_context(now,&ids,self.seed,ledger)?;
        let(a,_)=actions.ending_context(now as u32,&ids)?;let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(e,_)=environment.time_context(now,&ids)?;
        let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,site)=resources.proposal_catalog(now,&all,&roster)?;if site!=self.site{return Err(invalid())}
        let(p,link)=peer.report_context(now,&ids,self.seed)?;if serde_json::to_value(&self.config).map_err(|_|invalid())?!=link["config"]{return Err(invalid())}
        let binding=[m,e,t,a,r,p,c,l];if self.event_binding.is_some_and(|b|b!=binding){return Err(invalid())}
        let devices:Vec<_>=actors.iter().map(|(_,a,e)|serde_json::json!({"id":a.id,"disabled":e.disabled})).collect();
        Ok(ReportEventContext{binding,actors,tasks:all,done,environment:serde_json::json!({"agents":devices,"outages":link["outages"]})})
    }
    fn event_commit(&mut self,next:Self,control:&mut crate::world_control::WorldControl,next_control:crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,next_ledger:crate::world_ledger::WorldLedger)->Result<()>{next_control.validate_commit(&next_ledger)?;*self=next;*control=next_control;*ledger=next_ledger;Ok(())}
    fn terminal_fact(channel:&str,row:&serde_json::Value)->Result<serde_json::Value>{
        let sample=channel=="sample";if !sample&&channel!="evidence"{return Err(invalid())}let reason=row.get("reason").and_then(serde_json::Value::as_str);let label=match reason{Some("expired")=>"过期",Some("unavailable")=>"设备不可用",Some("interrupted")=>"通信中断",Some("dropped")=>"丢包",Some("run_ended")=>"实验结束",None=>"",_=>return Err(invalid())};
        let message=if sample{if reason.is_some(){format!("采样报告未送达（{label}）")}else{"采样报告已送达指挥者".to_owned()}}else{if reason.is_some(){format!("扫描报告未送达{}",if reason==Some("run_ended"){ "（实验结束）" }else{ "" })}else{"扫描报告已送达指挥者".to_owned()}};
        let mut fact=serde_json::json!({"message":message,"type":if reason.is_some(){"warning"}else{"success"},"kind":match(sample,reason.is_some()){(true,true)=>"sample_report_failed",(true,false)=>"sample_report_delivered",(false,true)=>"evidence_failed",(false,false)=>"evidence_delivered"},"reportId":row["id"],"agentId":row["agentId"]});if sample{fact["taskId"]=row["taskId"].clone()}if let Some(r)=reason{fact["reason"]=r.into()}Ok(fact)
    }
    fn fixed_fact(&self,effect:&serde_json::Value)->Result<serde_json::Value>{
        let p=&effect["report"];match effect["kind"].as_str(){
            Some("sent")=>{let sensor=self.state.fixed_sensors.iter().flatten().find(|s|p["sensorId"].as_str()==Some(s.id.as_str())).ok_or_else(invalid)?;Ok(serde_json::json!({"message":format!("{} 提交固定传感器报告",sensor.name),"type":"info","kind":"fixed_sensor_sent","sensorId":p["sensorId"],"reportId":p["id"]}))},
            Some("failed")=>Ok(serde_json::json!({"message":format!("固定传感器报告未送达{}",if effect["reason"]=="run_ended"{"（实验结束）"}else{""}),"type":"warning","kind":"fixed_sensor_failed","sensorId":p["sensorId"],"reportId":p["id"],"reason":effect["reason"]})),
            Some("delivered")=>Ok(serde_json::json!({"message":"固定传感器报告已送达指挥者","type":"info","kind":"fixed_sensor_delivered","sensorId":p["sensorId"],"reportId":p["id"],"result":p["result"],"position":p["position"],"observedTick":p["observedTick"]})),_=>Err(invalid())
        }
    }
    fn fixed_event_phase(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,physics:Option<&crate::PhysicsWorld>)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,actions,resources,peer,control,ledger)?;let ids:Vec<_>=ctx.actors.iter().map(|(_,a,_)|a.id.clone()).collect();let catalog:Vec<_>=ctx.tasks.iter().map(|t|t.id.clone()).collect();let(_,_,_,ray)=control.stationary_events_context(expected,&ids,&catalog,ledger)?;let physics_id=physics.map_or(0,|p|p.checkpoint_id);if ctx.done||ray!=physics.is_some()||self.event_physics.is_some_and(|p|p!=physics_id){return Err(invalid())}
        let mut sight=Vec::new();for s in self.state.fixed_sensors.iter().flatten(){sight.push(serde_json::json!({"sensorId":s.id,"visible":environment.stationary_visible([s.x,s.y,s.height+environment.elevation(s.x,s.y)],self.site,Some(s.range),physics)?}));}
        let(_,resource)=resources.assignment_context(None,expected as u32)?;let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let encoded=next.fixed(encode(&serde_json::json!({"environment":ctx.environment,"sight":sight,"anomaly":resource["state"]["asset"]["condition"]=="fault"}))?,expected)?;let effects:Vec<serde_json::Value>=decode(&encoded)?;
        for e in &effects{next_control.task_event(&mut next_ledger,next.fixed_fact(e)?)?}next.event_binding=Some(ctx.binding);next.event_physics=Some(physics_id);self.event_commit(next,control,next_control,ledger,next_ledger)?;Ok(encoded)
    }
    pub(crate) fn finalization_context(&self,now:u64,agents:&[(String,String,bool)],site:[f64;2],seed:u32,ledger:&crate::world_ledger::WorldLedger)->Result<u64>{if self.seed!=seed{return Err(invalid())}Ok(self.proposal_proof(now,agents,site,None,None,ledger)?.0)}
    pub(crate) fn proposal_proof(&self,now:u64,agents:&[(String,String,bool)],site:[f64;2],kind:Option<&str>,id:Option<u64>,ledger:&crate::world_ledger::WorldLedger)->Result<(u64,Option<serde_json::Value>)>{
        self.now(now as f64)?;
        if self.site!=site||self.agents.len()!=agents.len()||self.agents.iter().zip(agents).any(|(a,(id,role,survey))|a.id!=*id||a.role!=*role||a.capabilities.iter().any(|c|c=="inspect")!=*survey){return Err(invalid())}
        let proof=match(kind,id){
            (None,None)=>None,
            (Some("scan"),Some(id))=>self.state.evidence_reports.iter().flatten().find(|r|r.id==id).map(|r|{let result=serde_json::to_value(&r.result).map_err(|_|invalid())?;Ok::<serde_json::Value,Error>(serde_json::json!({"kind":"scan","id":r.id,"status":r.status,"receivedTick":r.applied_tick,"observedTick":result["observedTick"],"position":result.get("position"),"result":result["kind"],"role":r.role,"canSurvey":r.can_survey}))}).transpose()?,
            (Some("sample"),Some(id))=>self.state.sample_reports.iter().flatten().find(|r|r.id==id).map(|r|serde_json::json!({"kind":"sample","id":r.id,"status":r.status,"receivedTick":r.applied_tick,"observedTick":r.collected_tick,"position":r.position,"result":null,"role":null,"canSurvey":null})),
            (Some("fixed"),Some(id))=>ledger.entries()?.iter().find(|e|e["kind"].as_str()==Some("fixed_sensor_delivered")&&e["reportId"].as_f64()==Some(id as f64)&&e["observedTick"].as_f64().is_some_and(|n|n.is_finite()&&n.fract()==0.0&&(0.0..=9_007_199_254_740_991.0).contains(&n))).map(|e|serde_json::json!({"kind":"fixed","id":id,"status":"delivered","receivedTick":e["tick"],"observedTick":e["observedTick"].as_f64().unwrap() as u64,"position":e["position"],"result":e["result"],"role":null,"canSurvey":null})),
            _=>return Err(invalid()),
        };Ok((self.checkpoint_id,proof))
    }
    pub(crate) fn has_fixed_sensors(&self)->Result<bool>{self.active()?;Ok(self.state.fixed_sensor_state.is_some())}
    pub(crate) fn status_due(&self,now:u64)->Result<bool>{self.now(now as f64)?;let state=self.state.reporting.as_ref().ok_or_else(invalid)?;Ok(now%state.interval==0)}
    fn active(&self) -> Result<()> {
        if self.closed {
            Err(Error::from_reason("world reports is closed"))
        } else {
            Ok(())
        }
    }
    fn now(&self, value: f64) -> Result<u64> {
        self.active()?;
        if !value.is_finite()
            || value.fract() != 0.0
            || value < self.last_tick as f64
            || value > MAX_TICK as f64
        {
            return Err(invalid());
        }
        Ok(value as u64)
    }
    fn agent(&self, id: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.id == id)
    }
    fn payload_valid(&self, p: &Payload, at: u64) -> bool {
        self.agent(&p.id)
            .is_some_and(|a| a.capabilities == p.capabilities)
            && point(&[p.x, p.y])
            && p.battery.is_finite()
            && (0.0..=100.0).contains(&p.battery)
            && p.route_blocked_since.is_none_or(|n| n <= at)
            && p.active_assignment.as_ref().is_none_or(|a| {
                token(&a.task_id) && a.assignment_id > 0 && a.assignment_id <= MAX_COUNT
            })
    }
    fn timing(
        &self,
        submitted: u64,
        due: u64,
        expires: u64,
        status: ReportStatus,
        applied: Option<u64>,
        reason: Option<Reason>,
        now: u64,
    ) -> bool {
        submitted <= now
            && due == submitted + self.config.delay
            && expires == submitted + self.config.ttl
            && match status {
                ReportStatus::Pending => {
                    applied.is_none() && reason.is_none() && due > now && expires >= now
                }
                ReportStatus::Delivered => {
                    reason.is_none() && applied == Some(due) && due <= expires && due <= now
                }
                ReportStatus::Failed => applied.is_some_and(|t| {
                    t >= submitted
                        && t <= now
                        && match reason {
                            Some(Reason::Expired) => t > expires,
                            Some(Reason::RunEnded) => t < due && t <= expires,
                            Some(_) => t == due && t <= expires,
                            None => false,
                        }
                }),
            }
    }
    fn environment(&self, e: &Environment, now: u64) -> bool {
        e.agents.len() == self.agents.len()
            && e.agents.iter().zip(&self.agents).all(|(a, b)| a.id == b.id)
            && e.outages.len() <= self.agents.len()
            && e.outages
                .iter()
                .map(|o| &o.agent_id)
                .collect::<HashSet<_>>()
                .len()
                == e.outages.len()
            && e.outages.iter().all(|o| {
                self.agent(&o.agent_id).is_some()
                    && o.started_tick <= now
                    && o.until_tick >= now
                    && o.until_tick > o.started_tick
                    && o.until_tick <= o.started_tick + 1000
            })
    }
    fn outcomes(
        &self,
        packets: Vec<(u64, String, u64, u64)>,
        e: &Environment,
        offset: u64,
        fixed: bool,
        now: u64,
    ) -> Result<Vec<Outcome>> {
        if !self.environment(e, now) {
            return Err(invalid());
        }
        let packets:Vec<_>=packets.into_iter().map(|(id,agent,due,expires)|serde_json::json!({"id":id,"dueTick":due,"expiresTick":expires,"unavailable":!fixed&&e.agents.iter().any(|a|a.id==agent&&a.disabled),"interrupted":!fixed&&e.outages.iter().any(|o|o.agent_id==agent&&now<=o.until_tick)})).collect();
        decode(&crate::central_link_tick(encode(
            &serde_json::json!({"tick":now,"seed":self.seed,"lossRate":self.config.loss_rate,"offset":offset,"packets":packets}),
        )?)?)
    }
    fn reason(outcome: &str) -> Result<Option<Reason>> {
        Ok(match outcome {
            "delivered" => None,
            "expired" => Some(Reason::Expired),
            "unavailable" => Some(Reason::Unavailable),
            "interrupted" => Some(Reason::Interrupted),
            "dropped" => Some(Reason::Dropped),
            _ => return Err(invalid()),
        })
    }
    fn budget(sent: u64, delivered: u64, failed: u64, next: u64, queue: usize) -> bool {
        sent <= MAX_COUNT
            && delivered <= sent
            && failed <= sent
            && next == sent + 1
            && sent == delivered + failed + queue as u64
    }
}
#[napi]
impl WorldReports {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        let i: Initial = decode(&input)?;
        let c = &i.config;
        if i.tick > MAX_TICK
            || !point(&i.site)
            || !(1..=10000).contains(&c.delay)
            || !(1..=10000).contains(&c.ttl)
            || !c.loss_rate.is_finite()
            || !(0.0..=1.0).contains(&c.loss_rate)
            || !(1..=10000).contains(&c.status_interval)
            || !(1..=10000).contains(&c.status_max_age)
            || i.agents.is_empty()
            || i.agents.len() > 50
            || i.agents.iter().map(|a| &a.id).collect::<HashSet<_>>().len() != i.agents.len()
            || i.agents.iter().any(|a| {
                !token(&a.id)
                    || !token(&a.role)
                    || a.capabilities.is_empty()
                    || a.capabilities.len() > 32
                    || a.capabilities.iter().any(|s| !token(s))
            })
        {
            return Err(invalid());
        }
        let w = Self { checkpoint_id: crate::world_checkpoint::identity(),
            state: i.state,
            agents: i.agents,
            config: i.config,
            site: i.site,
            seed: i.seed,
            last_tick: i.tick,
            processed: [i.tick; 4],
            event_binding:None,
            event_physics:None,
            closed: false,
        };
        if let Some(r) = &w.state.reporting {
            if r.interval != w.config.status_interval
                || r.max_age != w.config.status_max_age
                || r.queue.len() > w.agents.len()
                || r.reports.len() > w.agents.len()
                || r.reports.len() as u64 > r.delivered
                || !Self::budget(r.sent, r.delivered, r.failed, r.next_id, r.queue.len())
            {
                return Err(invalid());
            }
            let mut queued = HashSet::new();
            let mut ids = HashSet::new();
            for p in &r.queue {
                if p.id == 0
                    || p.id >= r.next_id
                    || !ids.insert(p.id)
                    || !queued.insert(&p.agent_id)
                    || p.agent_id != p.payload.id
                    || p.captured_tick > i.tick
                    || p.due_tick != p.captured_tick + w.config.delay
                    || p.expires_tick != p.captured_tick + w.config.ttl
                    || p.due_tick <= i.tick
                    || p.expires_tick < i.tick
                    || !w.payload_valid(&p.payload, p.captured_tick)
                {
                    return Err(invalid());
                }
            }
            for (id, p) in &r.reports {
                if id != &p.id
                    || p.captured_tick > i.tick
                    || p.received_tick != p.captured_tick + w.config.delay
                    || p.received_tick > p.captured_tick + w.config.ttl
                    || p.received_tick > i.tick
                    || !w.payload_valid(&p.payload(), p.captured_tick)
                {
                    return Err(invalid());
                }
            }
        }
        match (&w.state.fixed_sensors, &w.state.fixed_sensor_state) {
            (None, None) => {}
            (Some(sensors), Some(r)) => {
                if sensors.is_empty()
                    || sensors.len() > 32
                    || sensors.iter().map(|s| &s.id).collect::<HashSet<_>>().len() != sensors.len()
                    || sensors.iter().any(|s| {
                        !token(&s.id)
                            || ["__proto__", "constructor", "prototype"].contains(&s.id.as_str())
                            || s.name.is_empty()
                            || s.name.encode_utf16().count() > 100
                            || !point(&[s.x, s.y])
                            || !s.height.is_finite()
                            || !(0.0..=1000.0).contains(&s.height)
                            || !s.range.is_finite()
                            || s.range <= 0.0
                            || s.range > 10000.0
                            || !(1..=10000).contains(&s.interval)
                    })
                    || r.queue.len() > sensors.len()
                    || r.reports.len() > sensors.len()
                    || r.reports.len() as u64 > r.delivered
                    || !Self::budget(r.sent, r.delivered, r.failed, r.next_id, r.queue.len())
                {
                    return Err(invalid());
                }
                let mut queued = HashSet::new();
                let mut ids = HashSet::new();
                for p in &r.queue {
                    if p.id == 0
                        || p.id >= r.next_id
                        || !ids.insert(p.id)
                        || !queued.insert(&p.sensor_id)
                        || !sensors.iter().any(|s| s.id == p.sensor_id)
                        || p.position != w.site
                        || p.observed_tick == 0
                        || p.observed_tick > i.tick
                        || p.due_tick != p.observed_tick + w.config.delay
                        || p.expires_tick != p.observed_tick + w.config.ttl
                        || p.due_tick <= i.tick
                        || p.expires_tick < i.tick
                    {
                        return Err(invalid());
                    }
                }
                for (id, p) in &r.reports {
                    if id != &p.sensor_id
                        || !sensors.iter().any(|s| s.id == *id)
                        || p.report_id.is_some_and(|n| n == 0 || n >= r.next_id)
                        || p.position != w.site
                        || p.observed_tick == 0
                        || p.observed_tick > i.tick
                        || p.received_tick != p.observed_tick + w.config.delay
                        || p.received_tick > p.observed_tick + w.config.ttl
                        || p.received_tick > i.tick
                    {
                        return Err(invalid());
                    }
                }
            }
            _ => return Err(invalid()),
        }
        if let Some(rows) = &w.state.evidence_reports {
            if rows.len() > 1000 {
                return Err(invalid());
            }
            let mut requests = HashSet::new();
            let mut sources = HashSet::new();
            for (index, r) in rows.iter().enumerate() {
                let Some(a) = w.agent(&r.agent_id) else {
                    return Err(invalid());
                };
                if r.id != index as u64 + 1
                    || r.role != a.role
                    || r.can_survey != a.capabilities.iter().any(|c| c == "inspect")
                    || !token(&r.request_id)
                    || !token(&r.scan_request_id)
                    || !requests.insert((&r.agent_id, &r.request_id))
                    || r.status != ReportStatus::Failed
                        && !sources.insert((&r.agent_id, &r.scan_request_id))
                    || !r.result.valid(r.submitted_tick)
                    || !w.timing(
                        r.submitted_tick,
                        r.due_tick,
                        r.expires_tick,
                        r.status,
                        r.applied_tick,
                        r.reason,
                        i.tick,
                    )
                {
                    return Err(invalid());
                }
            }
        }
        if let Some(rows) = &w.state.sample_reports {
            if rows.len() > 1000 {
                return Err(invalid());
            }
            let mut requests = HashSet::new();
            let mut sources = HashSet::new();
            for (index, r) in rows.iter().enumerate() {
                if r.id != index as u64 + 1
                    || w.agent(&r.agent_id).is_none()
                    || !token(&r.request_id)
                    || !token(&r.task_id)
                    || !requests.insert((&r.agent_id, &r.request_id))
                    || r.status != ReportStatus::Failed
                        && !sources.insert((&r.agent_id, &r.task_id))
                    || r.collected_tick > r.submitted_tick
                    || !point(&r.position)
                    || !w.timing(
                        r.submitted_tick,
                        r.due_tick,
                        r.expires_tick,
                        r.status,
                        r.applied_tick,
                        r.reason,
                        i.tick,
                    )
                {
                    return Err(invalid());
                }
            }
        }
        Ok(w)
    }
    #[napi]
    pub fn submit_events(&mut self,channel:String,input:String,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,actions,resources,peer,control,ledger)?;let cmd:ReportCommand=decode(&input)?;let evidence=channel=="evidence";if !evidence&&channel!="sample"{return Err(invalid())}
        let fail=|reason:&str|encode(&serde_json::json!({"ok":false,"reason":reason}));let Some((_,_,actor))=ctx.actors.iter().find(|(_,a,_)|a.id==cmd.agent_id)else{return fail("unknown_agent")};
        let source=if evidence{cmd.scan_request_id.as_deref()}else{cmd.task_id.as_deref()};if !token(&cmd.request_id)||source.is_none_or(|s|!token(s))||if evidence{cmd.task_id.is_some()}else{cmd.scan_request_id.is_some()}{return fail(if evidence{"invalid_evidence_request"}else{"invalid_sample_report"})}let source=source.unwrap();
        let prior=if evidence{self.state.evidence_reports.iter().flatten().find(|r|r.agent_id==cmd.agent_id&&r.request_id==cmd.request_id).map(|r|(r.scan_request_id.as_str(),serde_json::to_value(r)))}else{self.state.sample_reports.iter().flatten().find(|r|r.agent_id==cmd.agent_id&&r.request_id==cmd.request_id).map(|r|(r.task_id.as_str(),serde_json::to_value(r)))};
        if let Some((id,row))=prior{return if id==source{encode(&serde_json::json!({"ok":true,"duplicate":true,"report":row.map_err(|_|invalid())?}))}else{fail("request_id_conflict")}}
        if ctx.done{return fail("world_finished")}if actor.disabled{return fail("agent_unavailable")}let count=if evidence{self.state.evidence_reports.as_ref().map_or(0,Vec::len)}else{self.state.sample_reports.as_ref().map_or(0,Vec::len)};if count>=1000{return fail(if evidence{"evidence_limit"}else{"sample_report_limit"})}
        let source_value=if evidence{let Some(result)=actions.report_scan(&cmd.agent_id,source,expected as u32)?else{return fail("scan_not_available")};if self.state.evidence_reports.iter().flatten().any(|r|r.agent_id==cmd.agent_id&&r.scan_request_id==source&&r.status!=ReportStatus::Failed){return fail("scan_already_reported")}serde_json::json!({"agentId":cmd.agent_id,"requestId":cmd.request_id,"scanRequestId":source,"result":result,"disabled":actor.disabled,"done":ctx.done})}else{
            let proof=ledger.entries()?.iter().find(|e|e["kind"]=="sample_collected"&&e["agentId"]==cmd.agent_id&&e["taskId"]==source);let Some(proof)=proof else{return fail("sample_not_available")};if !ctx.tasks.iter().any(|t|t.id==source&&t.behavior==crate::world_tasks::Behavior::Sample){return Err(invalid())}if self.state.sample_reports.iter().flatten().any(|r|r.agent_id==cmd.agent_id&&r.task_id==source&&r.status!=ReportStatus::Failed){return fail("sample_already_reported")}serde_json::json!({"agentId":cmd.agent_id,"requestId":cmd.request_id,"taskId":source,"position":proof["position"],"collectedTick":proof["tick"],"disabled":actor.disabled,"done":ctx.done})
        };
        let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let result=if evidence{next.evidence(encode(&source_value)?,expected)?}else{next.sample(encode(&source_value)?,expected)?};let mut r:serde_json::Value=decode(&result)?;r["ok"]=true.into();
        let mut fact=serde_json::json!({"message":format!("{} 已提交{}报告",actor.name,if evidence{"扫描"}else{"采样"}),"type":"info","kind":if evidence{"evidence_sent"}else{"sample_report_sent"},"reportId":r["report"]["id"],"agentId":cmd.agent_id});if !evidence{fact["taskId"]=r["report"]["taskId"].clone()}next_control.task_event(&mut next_ledger,fact)?;
        next.event_binding=Some(ctx.binding);self.event_commit(next,control,next_control,ledger,next_ledger)?;encode(&r)
    }
    #[napi]
    pub fn advance_events(&mut self,channel:String,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,actions,resources,peer,control,ledger)?;if ctx.done{return Err(invalid())}let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let encoded=next.advance(channel.clone(),encode(&ctx.environment)?,expected)?;let effects:Vec<serde_json::Value>=decode(&encoded)?;for r in &effects{next_control.task_event(&mut next_ledger,Self::terminal_fact(&channel,r)?)?}next.event_binding=Some(ctx.binding);self.event_commit(next,control,next_control,ledger,next_ledger)?;Ok(encoded)
    }
    #[napi]
    pub fn schedule_events(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        let ctx=self.event_context(expected,motion,environment,tasks,actions,resources,peer,control,ledger)?;if ctx.done{return Err(invalid())}let mut sources=Vec::new();for(_,a,e)in &ctx.actors{let task=ctx.tasks.iter().find(|t|t.status==crate::world_tasks::Status::Active&&t.assignee.as_deref()==Some(a.id.as_str()));let assignment=task.map(|t|serde_json::json!({"taskId":t.id,"assignmentId":t.assignment_id}));let x=serde_json::to_value(e).map_err(|_|invalid())?;let wait=&x["roadblockWait"];let mut blocked=serde_json::Value::Null;if let Some(t)=task{let owner=&wait["owner"];let valid=if owner["kind"]=="task"{owner["taskId"]==t.id&&owner["assignmentId"]==serde_json::to_value(t.assignment_id).map_err(|_|invalid())?}else if owner["kind"]=="action"{actions.report_wait(&a.id,owner["requestId"].as_str().ok_or_else(invalid)?,&t.id)?}else{false};if valid{blocked=wait["startedTick"].clone()}}
            sources.push(serde_json::json!({"id":a.id,"x":a.x,"y":a.y,"battery":a.battery,"status":e.status,"disabled":e.disabled,"activeAssignment":assignment,"routeBlockedSince":blocked}));}
        let mut next=self.clone();next.schedule(encode(&sources)?,expected)?;next.event_binding=Some(ctx.binding);control.validate_commit(ledger)?;*self=next;Ok("[]".to_owned())
    }
    #[napi]
    pub fn fixed_events(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{self.fixed_event_phase(expected,motion,environment,tasks,actions,resources,peer,control,ledger,None)}
    #[napi]
    pub fn fixed_events_ray(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,resources:&crate::world_resources::WorldResources,peer:&crate::world_peer::WorldPeer,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,physics:&crate::PhysicsWorld)->Result<String>{self.fixed_event_phase(expected,motion,environment,tasks,actions,resources,peer,control,ledger,Some(physics))}
    #[napi]
    pub fn evidence(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let s: EvidenceSource = decode(&input)?;
        let Some(a) = self.agent(&s.agent_id) else {
            return Err(invalid());
        };
        if !token(&s.request_id) || !token(&s.scan_request_id) {
            return Err(invalid());
        }
        if let Some(r) = self
            .state
            .evidence_reports
            .iter()
            .flatten()
            .find(|r| r.agent_id == s.agent_id && r.request_id == s.request_id)
        {
            if r.scan_request_id != s.scan_request_id {
                return Err(invalid());
            }
            return encode(&serde_json::json!({"duplicate":true,"report":r}));
        }
        if s.done
            || s.disabled
            || !s.result.valid(now)
            || self
                .state
                .evidence_reports
                .as_ref()
                .is_some_and(|r| r.len() >= 1000)
            || self.state.evidence_reports.iter().flatten().any(|r| {
                r.agent_id == s.agent_id
                    && r.scan_request_id == s.scan_request_id
                    && r.status != ReportStatus::Failed
            })
        {
            return Err(invalid());
        }
        let r = Evidence {
            id: self
                .state
                .evidence_reports
                .as_ref()
                .map_or(1, |r| r.len() as u64 + 1),
            agent_id: s.agent_id,
            role: a.role.clone(),
            can_survey: a.capabilities.iter().any(|c| c == "inspect"),
            request_id: s.request_id,
            scan_request_id: s.scan_request_id,
            result: s.result,
            submitted_tick: now,
            due_tick: now + self.config.delay,
            expires_tick: now + self.config.ttl,
            status: ReportStatus::Pending,
            applied_tick: None,
            reason: None,
        };
        let encoded = encode(&serde_json::json!({"duplicate":false,"report":r}))?;
        self.state
            .evidence_reports
            .get_or_insert_with(Vec::new)
            .push(r);
        self.last_tick = now;
        Ok(encoded)
    }
    #[napi]
    pub fn sample(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let s: SampleSource = decode(&input)?;
        if self.agent(&s.agent_id).is_none() || !token(&s.request_id) || !token(&s.task_id) {
            return Err(invalid());
        }
        if let Some(r) = self
            .state
            .sample_reports
            .iter()
            .flatten()
            .find(|r| r.agent_id == s.agent_id && r.request_id == s.request_id)
        {
            if r.task_id != s.task_id {
                return Err(invalid());
            }
            return encode(&serde_json::json!({"duplicate":true,"report":r}));
        }
        if s.done
            || s.disabled
            || s.collected_tick > now
            || !point(&s.position)
            || self
                .state
                .sample_reports
                .as_ref()
                .is_some_and(|r| r.len() >= 1000)
            || self.state.sample_reports.iter().flatten().any(|r| {
                r.agent_id == s.agent_id
                    && r.task_id == s.task_id
                    && r.status != ReportStatus::Failed
            })
        {
            return Err(invalid());
        }
        let r = Sample {
            id: self
                .state
                .sample_reports
                .as_ref()
                .map_or(1, |r| r.len() as u64 + 1),
            agent_id: s.agent_id,
            task_id: s.task_id,
            position: s.position,
            collected_tick: s.collected_tick,
            request_id: s.request_id,
            submitted_tick: now,
            due_tick: now + self.config.delay,
            expires_tick: now + self.config.ttl,
            status: ReportStatus::Pending,
            applied_tick: None,
            reason: None,
        };
        let encoded = encode(&serde_json::json!({"duplicate":false,"report":r}))?;
        self.state
            .sample_reports
            .get_or_insert_with(Vec::new)
            .push(r);
        self.last_tick = now;
        Ok(encoded)
    }
    #[napi]
    pub fn schedule(&mut self, input: String, tick: f64) -> Result<()> {
        let now = self.now(tick)?;
        let sources: Vec<StatusSource> = decode(&input)?;
        if sources.len() != self.agents.len() {
            return Err(invalid());
        }
        let mut packets = Vec::new();
        for (s, a) in sources.into_iter().zip(&self.agents) {
            let p = Payload {
                id: s.id,
                x: s.x,
                y: s.y,
                battery: s.battery,
                status: s.status,
                capabilities: a.capabilities.clone(),
                active_assignment: s.active_assignment,
                route_blocked_since: s.route_blocked_since,
            };
            if p.id != a.id || !self.payload_valid(&p, now) {
                return Err(invalid());
            }
            if !s.disabled
                && !self
                    .state
                    .reporting
                    .as_ref()
                    .is_some_and(|r| r.queue.iter().any(|q| q.agent_id == a.id))
            {
                packets.push(p)
            }
        }
        let r = self.state.reporting.get_or_insert_with(|| Reporting {
            interval: self.config.status_interval,
            max_age: self.config.status_max_age,
            next_id: 1,
            queue: Vec::new(),
            reports: OrderedMap::default(),
            sent: 0,
            delivered: 0,
            failed: 0,
        });
        if r.sent > MAX_COUNT - packets.len() as u64 {
            return Err(invalid());
        }
        for payload in packets {
            r.queue.push(StatusPacket {
                id: r.next_id,
                agent_id: payload.id.clone(),
                captured_tick: now,
                due_tick: now + self.config.delay,
                expires_tick: now + self.config.ttl,
                payload,
            });
            r.next_id += 1;
            r.sent += 1;
        }
        self.last_tick = now;
        Ok(())
    }
    #[napi]
    pub fn advance(&mut self, channel: String, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let index = match channel.as_str() {
            "status" => 0,
            "evidence" => 1,
            "sample" => 2,
            _ => return Err(invalid()),
        };
        if now <= self.processed[index] {
            return Err(invalid());
        }
        let e: Environment = decode(&input)?;
        let mut effects = Vec::new();
        if channel == "status" {
            let packets = self.state.reporting.as_ref().map_or_else(Vec::new, |r| {
                r.queue
                    .iter()
                    .map(|p| (p.id, p.agent_id.clone(), p.due_tick, p.expires_tick))
                    .collect()
            });
            let outcomes = self.outcomes(packets, &e, 2000000, false, now)?;
            let mut next = self.state.reporting.clone();
            if let Some(r) = &mut next {
                let mut queue = Vec::new();
                for (p, o) in r.queue.iter().cloned().zip(outcomes) {
                    if p.id != o.id {
                        return Err(invalid());
                    }
                    if o.state == "waiting" {
                        queue.push(p)
                    } else if o.state == "delivered" {
                        r.delivered += 1;
                        r.reports
                            .insert(p.agent_id.clone(), StatusReport::from(p, now));
                    } else {
                        Self::reason(&o.state)?;
                        r.failed += 1;
                    }
                }
                r.queue = queue;
            }
            self.state.reporting = next;
        } else if channel == "evidence" {
            let packets = self
                .state
                .evidence_reports
                .iter()
                .flatten()
                .filter(|r| r.status == ReportStatus::Pending)
                .map(|r| (r.id, r.agent_id.clone(), r.due_tick, r.expires_tick))
                .collect();
            let outcomes = self.outcomes(packets, &e, 4000000, false, now)?;
            let mut rows = self.state.evidence_reports.clone();
            for (r, o) in rows
                .iter_mut()
                .flatten()
                .filter(|r| r.status == ReportStatus::Pending)
                .zip(outcomes)
            {
                if r.id != o.id {
                    return Err(invalid());
                }
                if o.state == "waiting" {
                    continue;
                }
                r.reason = Self::reason(&o.state)?;
                r.status = if r.reason.is_none() {
                    ReportStatus::Delivered
                } else {
                    ReportStatus::Failed
                };
                r.applied_tick = Some(now);
                effects.push(serde_json::to_value(r).map_err(|_| invalid())?)
            }
            self.state.evidence_reports = rows;
        } else {
            let packets = self
                .state
                .sample_reports
                .iter()
                .flatten()
                .filter(|r| r.status == ReportStatus::Pending)
                .map(|r| (r.id, r.agent_id.clone(), r.due_tick, r.expires_tick))
                .collect();
            let outcomes = self.outcomes(packets, &e, 6000000, false, now)?;
            let mut rows = self.state.sample_reports.clone();
            for (r, o) in rows
                .iter_mut()
                .flatten()
                .filter(|r| r.status == ReportStatus::Pending)
                .zip(outcomes)
            {
                if r.id != o.id {
                    return Err(invalid());
                }
                if o.state == "waiting" {
                    continue;
                }
                r.reason = Self::reason(&o.state)?;
                r.status = if r.reason.is_none() {
                    ReportStatus::Delivered
                } else {
                    ReportStatus::Failed
                };
                r.applied_tick = Some(now);
                effects.push(serde_json::to_value(r).map_err(|_| invalid())?)
            }
            self.state.sample_reports = rows;
        }
        self.last_tick = now;
        self.processed[index] = now;
        encode(&effects)
    }
    #[napi]
    pub fn fixed(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        if now <= self.processed[3] {
            return Err(invalid());
        }
        let x: FixedInput = decode(&input)?;
        let sensors = self.state.fixed_sensors.as_deref().unwrap_or(&[]);
        if x.sight.len() != sensors.len()
            || x.sight
                .iter()
                .zip(sensors)
                .any(|(a, b)| a.sensor_id != b.id)
        {
            return Err(invalid());
        }
        let packets = self
            .state
            .fixed_sensor_state
            .as_ref()
            .map_or_else(Vec::new, |r| {
                r.queue
                    .iter()
                    .map(|p| (p.id, String::new(), p.due_tick, p.expires_tick))
                    .collect()
            });
        let outcomes = self.outcomes(packets, &x.environment, 5000000, true, now)?;
        let mut next = self.state.fixed_sensor_state.clone();
        let mut effects = Vec::new();
        if let Some(r) = &mut next {
            let mut queue = Vec::new();
            for (p, o) in r.queue.iter().cloned().zip(outcomes) {
                if p.id != o.id {
                    return Err(invalid());
                }
                if o.state == "waiting" {
                    queue.push(p);
                    continue;
                }
                let reason = Self::reason(&o.state)?;
                if let Some(reason) = reason {
                    r.failed += 1;
                    effects.push(serde_json::json!({"kind":"failed","report":p,"reason":reason}));
                } else {
                    r.delivered += 1;
                    r.reports.insert(
                        p.sensor_id.clone(),
                        FixedReport {
                            sensor_id: p.sensor_id.clone(),
                            report_id: Some(p.id),
                            result: p.result,
                            position: p.position,
                            observed_tick: p.observed_tick,
                            received_tick: now,
                        },
                    );
                    effects.push(serde_json::json!({"kind":"delivered","report":p}));
                }
            }
            r.queue = queue;
            for (s, sight) in sensors.iter().zip(&x.sight) {
                if now % s.interval != 0
                    || !sight.visible
                    || r.queue.iter().any(|p| p.sensor_id == s.id)
                {
                    continue;
                }
                if r.sent >= MAX_COUNT {
                    return Err(invalid());
                }
                let p = FixedPacket {
                    id: r.next_id,
                    sensor_id: s.id.clone(),
                    result: if x.anomaly {
                        Finding::Anomaly
                    } else {
                        Finding::Normal
                    },
                    position: self.site,
                    observed_tick: now,
                    due_tick: now + self.config.delay,
                    expires_tick: now + self.config.ttl,
                };
                r.next_id += 1;
                r.sent += 1;
                effects.push(serde_json::json!({"kind":"sent","report":p}));
                r.queue.push(p);
            }
        }
        let encoded = encode(&effects)?;
        self.state.fixed_sensor_state = next;
        self.last_tick = now;
        self.processed[3] = now;
        Ok(encoded)
    }
    #[napi]
    pub fn cancel(&mut self, channel: String, clear_cache: bool, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let mut effects = Vec::new();
        match channel.as_str() {
            "status" => {
                if let Some(r) = &mut self.state.reporting {
                    let count = r.queue.len();
                    r.failed += count as u64;
                    r.queue.clear();
                    if clear_cache {
                        r.reports.clear()
                    }
                    self.last_tick = now;
                    return encode(&count);
                }
                return encode(&0);
            }
            "evidence" => {
                for r in self
                    .state
                    .evidence_reports
                    .iter_mut()
                    .flatten()
                    .filter(|r| r.status == ReportStatus::Pending)
                {
                    r.status = ReportStatus::Failed;
                    r.applied_tick = Some(now);
                    r.reason = Some(Reason::RunEnded);
                    effects.push(serde_json::to_value(r).map_err(|_| invalid())?)
                }
            }
            "sample" => {
                for r in self
                    .state
                    .sample_reports
                    .iter_mut()
                    .flatten()
                    .filter(|r| r.status == ReportStatus::Pending)
                {
                    r.status = ReportStatus::Failed;
                    r.applied_tick = Some(now);
                    r.reason = Some(Reason::RunEnded);
                    effects.push(serde_json::to_value(r).map_err(|_| invalid())?)
                }
            }
            "fixed" => {
                if let Some(r) = &mut self.state.fixed_sensor_state {
                    for p in &r.queue {
                        effects.push(
                            serde_json::json!({"kind":"failed","report":p,"reason":"run_ended"}),
                        );
                    }
                    r.failed += r.queue.len() as u64;
                    r.queue.clear();
                }
            }
            _ => return Err(invalid()),
        }
        self.last_tick = now;
        encode(&effects)
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
        self.event_physics=None;
        self.state.reporting = None;
        self.state.fixed_sensors = None;
        self.state.fixed_sensor_state = None;
        self.state.evidence_reports = None;
        self.state.sample_reports = None;
        self.agents.clear();
    }
}

crate::world_checkpoint::world_checkpoint!(WorldReports);
