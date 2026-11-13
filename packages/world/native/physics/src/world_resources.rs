//! Owned abstract asset and single-part lifecycle, fenced by task assignment.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
const MAX_TICK: u64 = 10_000_000;
const MAX_ID: u64 = 9_007_199_254_740_991;
fn present<'de,D,T>(d:D)->std::result::Result<Option<T>,D::Error>where D:Deserializer<'de>,T:Deserialize<'de>{T::deserialize(d).map(Some)}
fn invalid() -> Error {
    Error::from_reason("invalid world resources input")
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
fn decode<T: for<'de> Deserialize<'de>>(s: &str) -> Result<T> {
    if s.len() > 2 * 1024 * 1024 {
        return Err(invalid());
    }
    serde_json::from_str(s).map_err(|_| invalid())
}
fn encode<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|_| invalid())
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Condition {
    Fault,
    Repaired,
    Operational,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Diagnosis {
    Unknown,
    Suspected,
    Confirmed,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Location {
    Warehouse,
    Ground,
    Carried,
    Site,
    Consumed,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    condition: Condition,
    diagnosis: Diagnosis,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Part {
    location: Location,
    position: Option<[f64; 2]>,
    carrier_id: Option<String>,
    reserved_by: Option<String>,
    site: [f64; 2],
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct State {
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] construction:Option<crate::construction::State>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] materials:Option<crate::materials::State>,
    asset: Asset,
    part: Part,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Survey,
    Build,
    Deploy,
    Sample,
    Detect,
    Confirm,
    Deliver,
    Repair,
    Verify,
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum TaskStatus {
    Pending,
    Active,
    Done,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task {
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] build_site:Option<String>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] material_cost:Option<Vec<crate::materials::Item>>,
    id: String,
    behavior: Kind,
    role: String,
    capability: String,
    target: [f64; 2],
    status: TaskStatus,
    assignee: Option<String>,
    assignment_id: Option<u64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Agent {
    id: String,
    role: String,
    capabilities: Vec<String>,
}
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all="snake_case")]
enum Stage {
    Assigned,
    Loaded,
    Applied,
    Completed,
    Aborted,
}
#[derive(Clone, Serialize)]
struct Run {
    agent: String,
    version: u64,
    stage: Stage,
}
#[derive(Clone, Serialize)]
struct TaskState {
    definition: Task,
    version: u64,
    run: Option<Run>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial {
    tick: u64,
    state: State,
    warehouse: [f64; 2],
    agents: Vec<Agent>,
    tasks: Vec<Task>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    kind: String,
    task_id: String,
    agent_id: String,
    assignment_id: u64,
    position: Option<[f64; 2]>,
}
#[napi]
#[derive(Clone)]
pub struct WorldResources {
    checkpoint_id: u64,
    state: State,
    tasks: HashMap<String, TaskState>,
    agents: HashMap<String, Agent>,
    warehouse: [f64; 2],
    last_tick: u64,
    closed: bool,
}
impl WorldResources {
    pub(crate) fn construction_site(&self,id:&str)->Result<crate::construction::Site>{self.active()?;self.state.construction.as_ref().and_then(|v|v.sites.iter().find(|s|s.id==id)).cloned().ok_or_else(invalid)}
    fn construction_valid(state:&State,tasks:&[Task],tick:u64)->bool{
        let Some(c)=&state.construction else{return tasks.iter().all(|t|t.behavior!=Kind::Build&&t.build_site.is_none())};if !c.valid(){return false}
        if tasks.iter().any(|t|t.behavior==Kind::Build&&t.build_site.as_ref().is_none_or(|id|!c.sites.iter().any(|s|s.id==*id))){return false}
        c.sites.iter().all(|s|{let ts=tasks.iter().filter(|t|t.behavior==Kind::Build&&t.build_site.as_deref()==Some(&s.id)).collect::<Vec<_>>();if ts.len()!=1{return false}let t=ts[0];if s.status==crate::construction::Status::Planned{t.status!=TaskStatus::Done}else{t.status==TaskStatus::Done&&s.task_id.as_deref()==Some(&t.id)&&s.agent_id==t.assignee&&s.assignment_id==t.assignment_id&&s.built_tick.is_some_and(|n|u64::from(n)<=tick)}})
    }
    fn materials_valid(state:&State,tasks:&[Task])->bool{
        let Some(m)=&state.materials else{return tasks.iter().all(|t|t.material_cost.is_none())};
        if !m.valid()||tasks.iter().any(|t|t.material_cost.as_ref().is_some_and(|c|!m.cost_known(c))){return false}
        for t in tasks{if let Some(cost)=&t.material_cost{let r=m.reservations.iter().find(|r|r.task_id==t.id);if t.status==TaskStatus::Active{if r.is_none_or(|r|Some(r.agent_id.as_str())!=t.assignee.as_deref()||Some(r.assignment_id)!=t.assignment_id||&r.items!=cost){return false}}else if r.is_some(){return false}}}
        if m.reservations.iter().any(|r|!tasks.iter().any(|t|t.id==r.task_id&&t.material_cost.is_some())){return false}
        m.stock.iter().all(|s|tasks.iter().filter(|t|t.status==TaskStatus::Done).filter_map(|t|t.material_cost.as_ref()).flat_map(|c|c.iter()).filter(|i|i.id==s.id).map(|i|i.amount).sum::<u32>()==s.initial-s.remaining)
    }
    pub(crate) fn observed_materials(&self,agent:&str)->Result<Option<serde_json::Value>>{self.active()?;if !self.agents.contains_key(agent){return Err(invalid())}Ok(self.state.materials.as_ref().map(|m|m.own(agent)))}
    pub(crate) fn route_loaded(&self,actor:&str)->Result<bool>{self.active()?;if !self.agents.contains_key(actor){return Err(invalid())}Ok(self.state.part.location==Location::Carried&&self.state.part.carrier_id.as_deref()==Some(actor))}
    pub(crate) fn proposal_catalog(&self,now:u64,tasks:&[crate::world_tasks::Task],agents:&[(String,String,bool)])->Result<(u64,[f64;2])>{
        self.now(now as f64)?;
        if tasks.len()!=self.tasks.len()||agents.len()!=self.agents.len()||agents.iter().any(|(id,role,survey)|self.agents.get(id).is_none_or(|a|a.role!=*role||a.capabilities.iter().any(|c|c=="inspect")!=*survey)){return Err(invalid())}
        for t in tasks{let definition=&self.tasks.get(&t.id).ok_or_else(invalid)?.definition;if serde_json::to_value(definition.behavior).map_err(|_|invalid())?!=serde_json::to_value(t.behavior).map_err(|_|invalid())?||definition.role!=t.role||definition.capability!=t.capability||definition.target!=t.target||definition.material_cost!=t.material_cost||definition.build_site!=t.build_site{return Err(invalid())}}
        Ok((self.checkpoint_id,self.state.part.site))
    }
    pub(crate) fn assignment_context(&self,task:Option<&crate::world_tasks::Task>,now:u32)->Result<(u64,serde_json::Value)>{
        self.now(now as f64)?;
        if let Some(t)=task{let definition=&self.tasks.get(&t.id).ok_or_else(invalid)?.definition;
            if serde_json::to_value(definition.behavior).map_err(|_|invalid())?!=serde_json::to_value(t.behavior).map_err(|_|invalid())?||definition.role!=t.role||definition.capability!=t.capability||definition.target!=t.target||definition.material_cost!=t.material_cost||definition.build_site!=t.build_site{return Err(invalid())}
        }
        Ok((self.checkpoint_id,serde_json::json!({"state":self.state,"registered":self.tasks,"agents":self.agents,"warehouse":self.warehouse,"lastTick":self.last_tick})))
    }
    pub(crate) fn reserve_assignment(&mut self,t:&crate::world_tasks::Task,a:&crate::world_motion::Motion,now:u32)->Result<()>{
        self.command(serde_json::json!({"kind":"assign","taskId":t.id,"agentId":a.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?}).to_string(),now as f64)?;Ok(())
    }
    pub(crate) fn activation_part(&self,agent:&str)->Result<(u64,Option<[f64;2]>)>{self.active()?;if !self.agents.contains_key(agent){return Err(invalid())}Ok((self.checkpoint_id,self.state.part.position))}
    pub(crate) fn work_owner(&self,t:&crate::world_tasks::Task,a:&crate::world_motion::Motion,e:&crate::world_execution::Execution,now:u32)->Result<(u64,[f64;2])>{
        use crate::world_tasks::{Behavior as B,Phase as P};
        self.now(now as f64)?;
        let registered=self.tasks.get(&t.id).ok_or_else(invalid)?;let definition=&registered.definition;let run=registered.run.as_ref().ok_or_else(invalid)?;
        let same_kind=matches!((definition.behavior,t.behavior),(Kind::Build,B::Build)|(Kind::Deploy,B::Deploy)|(Kind::Survey,B::Survey)|(Kind::Sample,B::Sample)|(Kind::Detect,B::Detect)|(Kind::Confirm,B::Confirm)|(Kind::Deliver,B::Deliver)|(Kind::Repair,B::Repair)|(Kind::Verify,B::Verify));
        if !same_kind||definition.role!=t.role||definition.capability!=t.capability||definition.target!=t.target||definition.material_cost!=t.material_cost||definition.build_site!=t.build_site||run.agent!=a.id||Some(run.version)!=t.assignment_id.map(u64::from)||!self.eligible(definition,&a.id)||self.agents.get(&a.id).is_none_or(|known|known.role!=e.role||known.capabilities!=e.capabilities)||!e.capabilities.contains(&t.capability){return Err(invalid())}
        let goal=if t.behavior==B::Deliver{match t.phase.flatten(){
            Some(P::ToPickup|P::Loading)=>{if run.stage!=Stage::Assigned||self.state.part.reserved_by.as_deref()!=Some(&t.id){return Err(invalid())}self.state.part.position.ok_or_else(invalid)?},
            Some(P::ToSite|P::Unloading)=>{if run.stage!=Stage::Loaded||self.state.part.carrier_id.as_deref()!=Some(&a.id){return Err(invalid())}t.target},
            _=>return Err(invalid()),
        }}else{if run.stage!=Stage::Assigned{return Err(invalid())}t.target};
        Ok((self.checkpoint_id,goal))
    }
    pub(crate) fn work_check(&self,t:&crate::world_tasks::Task,a:&crate::world_motion::Motion,e:&crate::world_execution::Execution,now:u32)->Result<u64>{let(id,goal)=self.work_owner(t,a,e,now)?;if !Self::reached([a.x,a.y],goal){return Err(invalid())}Ok(id)}
    pub(crate) fn work_command(&mut self,kind:&str,t:&crate::world_tasks::Task,a:&crate::world_motion::Motion,now:u32)->Result<serde_json::Value>{
        let mut command=serde_json::json!({"kind":kind,"taskId":t.id,"agentId":a.id,"assignmentId":t.assignment_id.ok_or_else(invalid)?});
        if kind!="finish"{command["position"]=serde_json::json!([a.x,a.y]);}
        serde_json::from_str(&self.command(command.to_string(),now as f64)?).map_err(|_|invalid())
    }
    pub(crate) fn stationary_site(&self,agent:&str)->Result<(u64,[f64;2],bool)>{
        if self.closed||!self.agents.contains_key(agent){return Err(invalid())}Ok((self.checkpoint_id,self.state.part.site,self.state.asset.condition==Condition::Fault))
    }

    fn active(&self) -> Result<()> {
        if self.closed {
            Err(Error::from_reason("world resources is closed"))
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
    fn task_valid(t: &Task) -> bool {
        t.material_cost.as_ref().is_none_or(|c|crate::materials::cost_valid(c)) && (if t.behavior==Kind::Build{t.capability=="build"&&t.build_site.as_deref().is_some_and(token)&&t.material_cost.as_ref().is_some_and(|v|!v.is_empty())}else{t.build_site.is_none()}) && token(&t.id)
            && !["__proto__", "constructor", "prototype"].contains(&t.id.as_str())
            && token(&t.role)
            && t.role.len() <= 48
            && token(&t.capability)
            && point(&t.target)
            && t.assignment_id.is_none_or(|n| n > 0 && n <= MAX_ID)
            && match t.status {
                TaskStatus::Pending => t.assignee.is_none(),
                _ => t.assignee.as_deref().is_some_and(token) && t.assignment_id.is_some(),
            }
    }
    fn eligible(&self, t: &Task, agent: &str) -> bool {
        self.agents
            .get(agent)
            .is_some_and(|a| a.capabilities.contains(&t.capability))
    }
    fn run(&self, c: &Command) -> Result<(&Task, &Run)> {
        let t = self.tasks.get(&c.task_id).ok_or_else(invalid)?;
        let r = t.run.as_ref().ok_or_else(invalid)?;
        if r.agent != c.agent_id
            || r.version != c.assignment_id
            || !self.eligible(&t.definition, &c.agent_id)
        {
            return Err(invalid());
        }
        Ok((&t.definition, r))
    }
    fn position(c: &Command) -> Result<[f64; 2]> {
        let p = c.position.ok_or_else(invalid)?;
        if !point(&p) {
            return Err(invalid());
        }
        Ok(p)
    }
    fn reached(p: [f64; 2], goal: [f64; 2]) -> bool {
        (p[0] - goal[0]).hypot(p[1] - goal[1]) <= 4.0 + 1e-9
    }
}
#[napi]
impl WorldResources {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        let i: Initial = decode(&input)?;
        if !Self::construction_valid(&i.state,&i.tasks,i.tick)||!Self::materials_valid(&i.state,&i.tasks) || i.tick > MAX_TICK
            || !point(&i.warehouse)
            || !point(&i.state.part.site)
            || i.agents.is_empty()
            || i.agents.len() > 50
            || i.tasks.is_empty()
            || i.tasks.len() > 100
        {
            return Err(invalid());
        }
        let mut agents = HashMap::new();
        for a in i.agents {
            if !token(&a.id)
                || !token(&a.role)
                || a.role.len() > 48
                || a.capabilities.is_empty()
                || a.capabilities.len() > 32
                || a.capabilities.iter().any(|s| !token(s))
                || agents.contains_key(&a.id)
            {
                return Err(invalid());
            }
            agents.insert(a.id.clone(), a);
        }
        let mut tasks = HashMap::new();
        for t in i.tasks {
            if !Self::task_valid(&t)
                || tasks.contains_key(&t.id)
                || t.assignee
                    .as_ref()
                    .is_some_and(|id| !agents.contains_key(id))
            {
                return Err(invalid());
            }
            let run = match t.status {
                TaskStatus::Pending => None,
                _ => Some(Run {
                    agent: t.assignee.clone().unwrap(),
                    version: t.assignment_id.unwrap(),
                    stage: if t.status == TaskStatus::Done {
                        Stage::Completed
                    } else if t.behavior == Kind::Deliver
                        && i.state.part.reserved_by.as_deref() == Some(&t.id)
                        && i.state.part.location == Location::Carried
                    {
                        Stage::Loaded
                    } else {
                        Stage::Assigned
                    },
                }),
            };
            tasks.insert(
                t.id.clone(),
                TaskState {
                    version: t.assignment_id.unwrap_or(0),
                    definition: t,
                    run,
                },
            );
        }
        let w = Self { checkpoint_id: crate::world_checkpoint::identity(),
            state: i.state,
            tasks,
            agents,
            warehouse: i.warehouse,
            last_tick: i.tick,
            closed: false,
        };
        let p = &w.state.part;
        if p.position.as_ref().is_some_and(|p| !point(p))
            || p.carrier_id
                .as_ref()
                .is_some_and(|id| !w.agents.contains_key(id))
            || p.location == Location::Warehouse && p.position != Some(w.warehouse)
            || match p.location {
                Location::Warehouse | Location::Ground | Location::Site => {
                    p.position.is_none() || p.carrier_id.is_some()
                }
                Location::Carried => {
                    p.position.is_some() || p.carrier_id.is_none() || p.reserved_by.is_none()
                }
                Location::Consumed => {
                    p.position.is_some() || p.carrier_id.is_some() || p.reserved_by.is_some()
                }
            }
            || w.state.asset.condition != Condition::Fault && p.location != Location::Consumed
        {
            return Err(invalid());
        }
        if let Some(id) = &p.reserved_by {
            let t = w.tasks.get(id).ok_or_else(invalid)?;
            let r = t.run.as_ref().ok_or_else(invalid)?;
            if t.definition.status != TaskStatus::Active
                || !w.eligible(&t.definition, &r.agent)
                || match t.definition.behavior {
                    Kind::Deliver => {
                        !matches!(
                            p.location,
                            Location::Warehouse | Location::Ground | Location::Carried
                        ) || p.location == Location::Carried
                            && p.carrier_id.as_deref() != Some(&r.agent)
                    }
                    Kind::Repair => p.location != Location::Site,
                    _ => true,
                }
            {
                return Err(invalid());
            }
        }
        Ok(w)
    }
    #[napi]
    pub fn register(&mut self, input: String, tick: f64) -> Result<()> {
        let now = self.now(tick)?;
        let t: Task = decode(&input)?;
        if !Self::task_valid(&t)||t.behavior==Kind::Build
            || t.material_cost.as_ref().is_some_and(|c|self.state.materials.as_ref().is_none_or(|m|!m.cost_known(c)))
            || t.status != TaskStatus::Pending
            || t.assignment_id.is_some()
            || self.tasks.len() >= 100
            || self.tasks.contains_key(&t.id)
        {
            return Err(invalid());
        }
        self.tasks.insert(
            t.id.clone(),
            TaskState {
                version: 0,
                definition: t,
                run: None,
            },
        );
        self.last_tick = now;
        Ok(())
    }
    #[napi]
    pub fn command(&mut self, input: String, tick: f64) -> Result<String> {
        let now = self.now(tick)?;
        let c: Command = decode(&input)?;
        if !token(&c.task_id)
            || !token(&c.agent_id)
            || c.assignment_id == 0
            || c.assignment_id > MAX_ID
        {
            return Err(invalid());
        }
        if c.kind == "assign" {
            let t = self.tasks.get(&c.task_id).ok_or_else(invalid)?;
            if c.position.is_some()
                || c.assignment_id <= t.version
                || t.run.as_ref().is_some_and(|r| r.stage != Stage::Aborted)
                || !self.eligible(&t.definition, &c.agent_id)
            {
                return Err(invalid());
            }
            let p = &self.state.part;
            match t.definition.behavior {
                Kind::Deliver => {
                    if p.reserved_by.is_some()
                        || !matches!(p.location, Location::Warehouse | Location::Ground)
                    {
                        return Err(invalid());
                    }
                }
                Kind::Repair => {
                    if p.reserved_by.is_some()
                        || p.location != Location::Site
                        || self.state.asset.diagnosis != Diagnosis::Confirmed
                    {
                        return Err(invalid());
                    }
                }
                Kind::Verify => {
                    if self.state.asset.condition != Condition::Repaired {
                        return Err(invalid());
                    }
                }
                _ => {}
            }
            let mut next_materials=self.state.materials.clone();if let Some(cost)=&t.definition.material_cost{next_materials.as_mut().ok_or_else(invalid)?.reserve(&c.task_id,&c.agent_id,c.assignment_id,cost)?;}
            if matches!(t.definition.behavior, Kind::Deliver | Kind::Repair) {
                self.state.part.reserved_by = Some(c.task_id.clone())
            }
            self.state.materials=next_materials;
            let t = self.tasks.get_mut(&c.task_id).unwrap();
            t.version = c.assignment_id;
            t.run = Some(Run {
                agent: c.agent_id,
                version: c.assignment_id,
                stage: Stage::Assigned,
            });
            self.last_tick = now;
            return Ok("{}".into());
        }
        let (t, r) = self.run(&c)?;
        let cost=t.material_cost.clone();
        let behavior = t.behavior;
        let target = t.target;
        let stage = r.stage;
        if matches!(stage, Stage::Completed | Stage::Aborted) {
            return Err(invalid());
        }
        let mut next = self.state.clone();
        let next_stage;
        let mut dropped = false;
        let mut released = false;
        match c.kind.as_str() {
            "load" => {
                let p = Self::position(&c)?;
                if behavior != Kind::Deliver
                    || stage != Stage::Assigned
                    || next.part.reserved_by.as_deref() != Some(&c.task_id)
                    || !matches!(next.part.location, Location::Warehouse | Location::Ground)
                    || !Self::reached(p, next.part.position.ok_or_else(invalid)?)
                {
                    return Err(invalid());
                }
                next.part.location = Location::Carried;
                next.part.position = None;
                next.part.carrier_id = Some(c.agent_id.clone());
                next_stage = Stage::Loaded;
            }
            "deliver" => {
                let p = Self::position(&c)?;
                if behavior != Kind::Deliver
                    || stage != Stage::Loaded
                    || next.part.location != Location::Carried
                    || next.part.reserved_by.as_deref() != Some(&c.task_id)
                    || next.part.carrier_id.as_deref() != Some(&c.agent_id)
                    || !Self::reached(p, target)
                {
                    return Err(invalid());
                }
                next.part.location = Location::Site;
                next.part.position = Some(target);
                next.part.carrier_id = None;
                next.part.reserved_by = None;
                next_stage = Stage::Applied;
            }
            "effect" => {
                let p = Self::position(&c)?;
                if stage != Stage::Assigned || !Self::reached(p, target) {
                    return Err(invalid());
                }
                match behavior {
                    Kind::Detect => next.asset.diagnosis = Diagnosis::Suspected,
                    Kind::Confirm => next.asset.diagnosis = Diagnosis::Confirmed,
                    Kind::Repair => {
                        if next.part.location != Location::Site
                            || next.part.reserved_by.as_deref() != Some(&c.task_id)
                        {
                            return Err(invalid());
                        }
                        next.part.location = Location::Consumed;
                        next.part.position = None;
                        next.part.reserved_by = None;
                        next.asset.condition = Condition::Repaired;
                    }
                    Kind::Verify => {
                        if !matches!(
                            next.asset.condition,
                            Condition::Repaired | Condition::Operational
                        ) || next.part.location != Location::Consumed
                        {
                            return Err(invalid());
                        }
                        next.asset.condition = Condition::Operational;
                    }
                    _ => return Err(invalid()),
                }
                next_stage = Stage::Applied;
            }
            "abort" => {
                Self::position(&c)?;
                if !matches!(stage, Stage::Assigned | Stage::Loaded) {
                    return Err(invalid());
                }
                if next.part.reserved_by.as_deref() == Some(&c.task_id) {
                    released = true;
                    if next.part.location == Location::Carried {
                        if next.part.carrier_id.as_deref() != Some(&c.agent_id) {
                            return Err(invalid());
                        }
                        next.part.location = Location::Ground;
                        next.part.position = c.position;
                        next.part.carrier_id = None;
                        dropped = true
                    }
                    next.part.reserved_by = None;
                }
                next_stage = Stage::Aborted;
            }
            "finish" => {
                if c.position.is_some()
                    || match behavior {
                        Kind::Survey | Kind::Sample | Kind::Deploy | Kind::Build => stage != Stage::Assigned,
                        _ => stage != Stage::Applied,
                    }
                    || next.part.reserved_by.as_deref() == Some(&c.task_id)
                {
                    return Err(invalid());
                }
                if behavior==Kind::Build{let site=self.tasks.get(&c.task_id).and_then(|v|v.definition.build_site.as_deref()).ok_or_else(invalid)?;next.construction.as_mut().ok_or_else(invalid)?.finish(site,&c.task_id,&c.agent_id,c.assignment_id,now as u32).map_err(|_|invalid())?;}
                next_stage = Stage::Completed;
            }
            _ => return Err(invalid()),
        }
        if matches!(c.kind.as_str(),"finish"|"abort"){if let Some(cost)=&cost{next.materials.as_mut().ok_or_else(invalid)?.settle(&c.task_id,&c.agent_id,c.assignment_id,cost,c.kind=="finish")?;}}
        let result = encode(&serde_json::json!({"dropped":dropped,"released":released}))?;
        self.state = next;
        self.tasks
            .get_mut(&c.task_id)
            .unwrap()
            .run
            .as_mut()
            .unwrap()
            .stage = next_stage;
        self.last_tick = now;
        Ok(result)
    }
    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        self.active()?;
        encode(&self.state)
    }
    #[napi]
    pub fn free(&mut self) {
        self.closed = true;
        self.tasks.clear();
        self.agents.clear();
    }
}

crate::world_checkpoint::world_checkpoint!(WorldResources);
