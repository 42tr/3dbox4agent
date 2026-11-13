//! Typed execution components share the owning WorldMotion object and its
//! native travel distance; the host cannot overwrite the stored agent record.
use napi::{Error, Result};
use serde::{Deserialize, Deserializer, Serialize};

fn invalid() -> Error { Error::from_reason("invalid world execution input") }
fn present<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where D: Deserializer<'de>, T: Deserialize<'de> { T::deserialize(d).map(Some) }
fn token(s: &str, max: usize) -> bool { !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
fn finite(n: f64) -> bool { n.is_finite() && n >= 0.0 }
fn point(p: &[f64; 2]) -> bool { p.iter().all(|n| n.is_finite() && (0.0..=crate::MAX_WORLD_SIZE).contains(n)) }
const MAX_TICK: u32 = 10_000_000;

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum Status { Idle, Assigned, Working, Manual, Fault, Deployed }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Activity { task: u32, task_waiting: u32, manual: u32, charge_waiting: u32, idle: u32, unavailable: u32 }
impl Activity { fn counts(&self) -> [u32; 6] { [self.task,self.task_waiting,self.manual,self.charge_waiting,self.idle,self.unavailable] } }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Delivery { pub(crate) empty_distance: f64, pub(crate) loaded_distance: f64, pub(crate) empty_ticks: u32, pub(crate) loaded_ticks: u32 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag="kind", rename_all="snake_case", deny_unknown_fields)]
enum Owner {
    Task { #[serde(rename="taskId")] task_id: String, #[serde(rename="assignmentId")] assignment_id: u32 },
    Action { #[serde(rename="requestId")] request_id: String },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="snake_case")]
enum WaitMode { Route, Loading }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Wait { goal: [f64; 2], roadblock_id: String, started_tick: u32, owner: Owner, mode: WaitMode }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Execution {
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) operating_energy_per_tick:Option<f64>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) operating_state:Option<crate::operating_power::State>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) fault_generation:Option<u32>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) rescue:Option<crate::rescue::Profile>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) recoverable_fault:Option<bool>,

    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) deployable_relay:Option<bool>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) relay_state:Option<crate::relay::State>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] pub(crate) thermal:Option<crate::thermal::Profile>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] pub(crate) thermal_state:Option<crate::thermal::State>,
    #[serde(skip)] pub(crate) thermal_pending:Vec<crate::thermal::Effect>,
    pub id: String, pub(crate) name: String, pub(crate) role: String, pub(crate) capabilities: Vec<String>, pub(crate) speed: f64,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) mobility: Option<String>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) sensor_range: Option<f64>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) communication_range: Option<f64>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) communication_bytes_per_tick: Option<u32>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) move_energy_per_unit: Option<f64>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) work_energy_per_tick: Option<f64>,
    pub(crate) status: Status, pub(crate) disabled: bool, pub(crate) work: u32, pub(crate) route: Vec<[f64; 2]>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) delivery_travel: Option<Delivery>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] activity: Option<Activity>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] roadblock_wait_ticks: Option<u32>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) task_needs_route: Option<bool>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] roadblock_wait: Option<Wait>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) boundary_active: Option<bool>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) boundary_last_tick: Option<u32>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) collision_active: Option<bool>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) collision_replans: Option<u32>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) blocked_ticks: Option<u32>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) progress_waypoint: Option<String>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) best_waypoint_distance: Option<f64>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) terrain_distance: Option<f64>,
    #[serde(default, deserialize_with="present", skip_serializing_if="Option::is_none")] pub(crate) terrain_effect_distance: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Patch {
    #[serde(default,deserialize_with="present")]relay_state:Option<crate::relay::State>,
    #[serde(default,deserialize_with="present")] thermal_state:Option<crate::thermal::State>,
    status: Option<Status>, disabled: Option<bool>, work: Option<u32>, route: Option<Vec<[f64;2]>>,
    delivery_travel: Option<Delivery>, activity: Option<Activity>, roadblock_wait_ticks: Option<u32>,
    #[serde(default, deserialize_with="present")] task_needs_route: Option<Option<bool>>,
    #[serde(default, deserialize_with="present")] roadblock_wait: Option<Option<Wait>>,
    boundary_active: Option<bool>, boundary_last_tick: Option<u32>, collision_active: Option<bool>,
    collision_replans: Option<u32>, blocked_ticks: Option<u32>, progress_waypoint: Option<String>,
    best_waypoint_distance: Option<f64>, terrain_distance: Option<f64>, terrain_effect_distance: Option<f64>,
}

impl Execution {
    pub(crate) fn relay_ready(&self)->bool{self.deployable_relay.is_none()||self.relay_state.as_ref().is_some_and(|s|s.deployed)}
    fn valid_relay(&self)->bool{match(self.deployable_relay,&self.relay_state){(None,None)=>self.status!=Status::Deployed,(Some(true),Some(s))=>s.valid()&&self.capabilities.iter().any(|c|c=="relay")&&self.mobility.as_deref().map_or(self.role!="drone",|m|m=="ground")&&if s.deployed{matches!(self.status,Status::Deployed|Status::Fault)&&self.route.is_empty()&&self.work==0}else{self.status!=Status::Deployed},_=>false}}
    pub(crate) fn thermal_protected(&self)->bool{self.thermal_state.as_ref().is_some_and(|s|s.protected)}
    pub(crate) fn thermal_move_limit(&self,rate:f64,minimum:f64)->Result<f64>{match(&self.thermal,&self.thermal_state){(None,None)=>Ok(f64::INFINITY),(Some(p),Some(s))=>Ok(s.move_limit(p,rate,minimum)),_=>Err(invalid())}}
    pub(crate) fn thermal_protect(&mut self,reason:&'static str)->Result<()>{if let(Some(p),Some(s))=(&self.thermal,&mut self.thermal_state){if let Some(event)=s.protect(p,reason)?{self.thermal_pending.push(event)}}Ok(())}
    pub(crate) fn thermal_work(&mut self,energy:f64)->Result<bool>{match(&self.thermal,&mut self.thermal_state){(None,None)=>Ok(true),(Some(p),Some(s))=>{let(allowed,event)=s.guard_work(p,energy)?;if let Some(event)=event{self.thermal_pending.push(event)}Ok(allowed)},_=>Err(invalid())}}
    pub(crate) fn thermal_spend(&mut self,energy:f64)->Result<()>{match(&self.thermal,&mut self.thermal_state){(None,None)=>Ok(()),(Some(p),Some(s))=>{if let Some(event)=s.spend(p,energy)?{self.thermal_pending.push(event)}Ok(())},_=>Err(invalid())}}
    fn valid_thermal(&self)->bool{match(&self.thermal,&self.thermal_state){(None,None)=>true,(Some(p),Some(s))=>p.validate(self.work_energy_per_tick.unwrap_or(0.08)).is_ok()&&s.valid(p),_=>false}}
    pub(crate) fn sample_task_frame(&mut self,waiting_charge:bool)->Result<()>{
        if self.roadblock_wait.is_some(){if let Some(n)=self.roadblock_wait_ticks.as_mut(){*n=n.checked_add(1).filter(|n|*n<=MAX_TICK).ok_or_else(invalid)?}}
        let waiting=self.roadblock_wait.is_some();
        if let Some(a)=self.activity.as_mut(){let counter=if self.disabled{&mut a.unavailable}else if waiting||self.status==Status::Assigned{&mut a.task_waiting}else if self.status==Status::Working{&mut a.task}else if self.status==Status::Manual&&waiting_charge{&mut a.charge_waiting}else if self.status==Status::Manual{&mut a.manual}else{&mut a.idle};*counter=counter.checked_add(1).filter(|n|*n<=MAX_TICK).ok_or_else(invalid)?}Ok(())
    }

    pub(crate) fn environment_owner(&self,tasks:&[crate::world_tasks::Task],actions:&crate::world_actions::WorldActions)->Result<Option<(String,Option<(String,u32)>)>>{
        if self.status==Status::Manual{return Ok(actions.environment_owner(&self.id,None).map(|r|(r,None)))}
        tasks.iter().find(|t|t.status==crate::world_tasks::Status::Active&&t.assignee.as_deref()==Some(self.id.as_str())).map(|t|Ok((String::new(),Some((t.id.clone(),t.assignment_id.ok_or_else(invalid)?))))).transpose()
    }
    pub(crate) fn environment_wait(&self,tasks:&[crate::world_tasks::Task],actions:&crate::world_actions::WorldActions)->Result<Option<(serde_json::Value,bool,bool)>>{
        let Some(wait)=self.roadblock_wait.as_ref()else{return Ok(None)};
        let valid=!self.disabled&&match &wait.owner{Owner::Action{request_id}=>self.status==Status::Manual&&actions.environment_owner(&self.id,Some(request_id)).is_some(),Owner::Task{task_id,assignment_id}=>matches!(self.status,Status::Working|Status::Assigned)&&tasks.iter().any(|t|t.id==*task_id&&t.status==crate::world_tasks::Status::Active&&t.assignee.as_deref()==Some(self.id.as_str())&&t.assignment_id==Some(*assignment_id))};
        Ok(Some((serde_json::to_value(wait).map_err(|_|invalid())?,valid,matches!(wait.mode,WaitMode::Route))))
    }
    pub(crate) fn task_blocked_since(&self,task:&crate::world_tasks::Task,actions:&crate::world_actions::WorldActions)->Option<u32>{
        let wait=self.roadblock_wait.as_ref()?;let owns=match &wait.owner{Owner::Task{task_id,assignment_id}=>task_id==&task.id&&Some(*assignment_id)==task.assignment_id,Owner::Action{request_id}=>actions.resumes_task(&self.id,request_id,&task.id)};
        owns.then_some(wait.started_tick)
    }
    pub(crate) fn lifecycle_clear_action_wait(&mut self,request:&str)->Result<Option<serde_json::Value>>{
        if self.roadblock_wait.as_ref().is_some_and(|w|matches!(&w.owner,Owner::Action{request_id} if request_id==request)){self.activation_clear_wait()}else{Ok(None)}
    }
    pub(crate) fn lifecycle_waiting(&self)->bool{self.roadblock_wait.is_some()}
    pub(crate) fn loading_wait(&mut self,goal:[f64;2],roadblock:String,tick:u32,task:String,assignment:u32)->Result<serde_json::Value>{self.activation_wait(goal,roadblock,tick,String::new(),Some((task,assignment)))?;self.roadblock_wait.as_mut().ok_or_else(invalid)?.mode=WaitMode::Loading;serde_json::to_value(&self.roadblock_wait).map_err(|_|invalid())}
    pub(crate) fn activation_clear_wait(&mut self)->Result<Option<serde_json::Value>>{self.roadblock_wait.take().map(serde_json::to_value).transpose().map_err(|_|invalid())}
    pub(crate) fn activation_wait(&mut self,goal:[f64;2],roadblock:String,tick:u32,request:String,task:Option<(String,u32)>)->Result<serde_json::Value>{
        self.route.clear();self.blocked_ticks=Some(0);
        self.roadblock_wait=Some(Wait{goal,roadblock_id:roadblock,started_tick:tick,owner:task.map_or(Owner::Action{request_id:request},|(task_id,assignment_id)|Owner::Task{task_id,assignment_id}),mode:WaitMode::Route});
        serde_json::to_value(&self.roadblock_wait).map_err(|_|invalid())
    }
    pub(crate) fn stationary_eligible(&self)->bool{!self.disabled&&self.status==Status::Manual&&self.route.is_empty()&&self.roadblock_wait.is_none()}
    pub(crate) fn work_eligible(&self)->bool{!self.disabled&&self.status==Status::Working&&self.route.is_empty()&&self.roadblock_wait.is_none()}
    pub fn valid(&self, distance: f64) -> bool {
        let limit = distance + 1e-6 * distance.max(1.0);
        (match(self.recoverable_fault,self.fault_generation){(Some(true),Some(n))=>n<=MAX_TICK,(None,None)=>true,_=>false}) && crate::rescue::valid(self.rescue.as_ref(),self.recoverable_fault,self.mobility.as_deref().map_or(self.role!="drone",|m|m=="ground"),&self.capabilities) && self.valid_relay() && self.valid_thermal() && match(&self.operating_energy_per_tick,&self.operating_state){(None,None)=>true,(Some(rate),Some(state))=>state.valid(*rate),_=>false} && token(&self.id,64) && token(&self.role,48) && !self.name.is_empty() && self.name.encode_utf16().count()<=104
            && !self.capabilities.is_empty() && self.capabilities.len()<=32 && self.capabilities.iter().all(|c|token(c,64))
            && self.speed.is_finite() && self.speed>0.0 && self.speed<=100.0
            && self.mobility.as_deref().is_none_or(|m| matches!(m,"air"|"ground"|"water"))
            && [self.sensor_range,self.communication_range].iter().all(|v|v.is_none_or(|n|n.is_finite()&&n>0.0&&n<=10000.0))
            && self.communication_bytes_per_tick.is_none_or(|n|(1..=4096).contains(&n))
            && [self.move_energy_per_unit,self.work_energy_per_tick].iter().all(|v|v.is_none_or(|n|n.is_finite()&&(0.001..=5.0).contains(&n)))
            && self.disabled == (self.status == Status::Fault) && (!self.disabled || self.route.is_empty())
            && self.work<=MAX_TICK && self.route.len()<=4096 && self.route.iter().all(point)
            && self.activity.as_ref().is_none_or(|a|a.counts().iter().all(|n|*n<=MAX_TICK))
            && self.delivery_travel.as_ref().is_none_or(|d|finite(d.empty_distance)&&finite(d.loaded_distance)&&d.empty_distance+d.loaded_distance<=limit&&d.empty_ticks<=MAX_TICK&&d.loaded_ticks<=MAX_TICK)
            && self.roadblock_wait_ticks.is_none_or(|n|n<=MAX_TICK)
            && self.boundary_last_tick.is_none_or(|n|n<=MAX_TICK)
            && self.collision_replans.is_none_or(|n|n<=MAX_TICK) && self.blocked_ticks.is_none_or(|n|n<=MAX_TICK)
            && self.progress_waypoint.as_ref().is_none_or(|s|s.len()<=128)
            && self.best_waypoint_distance.is_none_or(finite)
            && [self.terrain_distance,self.terrain_effect_distance].iter().all(|v|v.is_none_or(|n|finite(n)&&n<=limit))
            && self.roadblock_wait.as_ref().is_none_or(|w|point(&w.goal)&&token(&w.roadblock_id,64)&&w.started_tick<=MAX_TICK&&match &w.owner{Owner::Task{task_id,assignment_id}=>token(task_id,64)&&*assignment_id>0,Owner::Action{request_id}=>token(request_id,64)})
    }
    pub fn activity_tick(&self) -> Option<u64> { self.activity.as_ref().map(|a|a.counts().iter().map(|n|*n as u64).sum()) }
    pub fn updated(&self, input: &str, distance: f64) -> Result<(Self,String)> {
        if input.len()>256*1024 { return Err(invalid()); }
        // Null is only a deletion command for explicitly removable components.
        let value: serde_json::Value=serde_json::from_str(input).map_err(|_|invalid())?;
        let fields=value.as_object().ok_or_else(invalid)?;
        if fields.is_empty() || fields.iter().any(|(key,v)|v.is_null()&&!matches!(key.as_str(),"taskNeedsRoute"|"roadblockWait")) { return Err(invalid()); }
        let updates_activity=fields.contains_key("activity");
        let updates_delivery=fields.contains_key("deliveryTravel");
        let p: Patch=serde_json::from_value(value).map_err(|_|invalid())?;
        let mut next=self.clone();
        macro_rules! required { ($($field:ident),*) => { $(if let Some(v)=p.$field {next.$field=v;})* }; }
        macro_rules! optional { ($($field:ident),*) => { $(if let Some(v)=p.$field {next.$field=Some(v);})* }; }
        required!(status,disabled,work,route);
        optional!(relay_state,thermal_state,delivery_travel,activity,roadblock_wait_ticks,boundary_active,boundary_last_tick,collision_active,collision_replans,blocked_ticks,progress_waypoint,best_waypoint_distance,terrain_distance,terrain_effect_distance);
        if let Some(v)=p.task_needs_route {next.task_needs_route=v;}
        if let Some(v)=p.roadblock_wait {next.roadblock_wait=v;}
        if self.relay_state.as_ref().is_some_and(|s|s.deployed)&&next.relay_state!=self.relay_state || next.relay_state!=self.relay_state&&(!matches!(self.status,Status::Working|Status::Assigned)||next.status!=Status::Deployed){return Err(invalid())}
        if !next.valid(distance) || self.disabled&&!next.disabled || next.work!=self.work&&next.work!=0&&next.work!=self.work.saturating_add(1) { return Err(invalid()); }
        for (before,after) in [(self.terrain_distance,next.terrain_distance),(self.terrain_effect_distance,next.terrain_effect_distance)] {
            if before.is_some_and(|b|after.is_none_or(|a|a<b)) { return Err(invalid()); }
        }
        for (before,after) in [(self.roadblock_wait_ticks,next.roadblock_wait_ticks),(self.boundary_last_tick,next.boundary_last_tick)] {
            if before.is_some_and(|b|after.is_none_or(|a|a<b)) { return Err(invalid()); }
        }
        if updates_activity {
            let (Some(before),Some(after))=(&self.activity,&next.activity) else {return Err(invalid());};
            let b=before.counts();let a=after.counts();
            if a.iter().zip(b).any(|(a,b)|*a<b) || a.iter().map(|n|*n as u64).sum::<u64>()!=b.iter().map(|n|*n as u64).sum::<u64>()+1 {return Err(invalid());}
        }
        if updates_delivery {
            let (Some(b),Some(a))=(&self.delivery_travel,&next.delivery_travel) else {return Err(invalid());};
            if a.empty_distance<b.empty_distance||a.loaded_distance<b.loaded_distance||a.empty_ticks<b.empty_ticks||a.loaded_ticks<b.loaded_ticks {return Err(invalid());}
        }
        if let(Some(before),Some(after))=(&self.thermal_state,&next.thermal_state){if after.peak_c<before.peak_c||after.trips<before.trips||after.protection_ticks<before.protection_ticks||after.tick<before.tick||after.tick>before.tick+1{return Err(invalid())}}
        let encoded=serde_json::to_string(&next).map_err(|_|invalid())?;
        Ok((next,encoded))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Initial { pub tick: u32, pub agents: Vec<Execution> }
impl Initial {
    pub fn parse(input: &str) -> Result<Self> {
        if input.len()>16*1024*1024 {return Err(invalid());}
        let initial: Self=serde_json::from_str(input).map_err(|_|invalid())?;
        if initial.tick>MAX_TICK || initial.agents.iter().any(|a|a.thermal_state.as_ref().is_some_and(|s|s.tick!=initial.tick)||a.operating_state.as_ref().is_some_and(|s|s.tick!=initial.tick)||a.activity_tick().is_some_and(|n|n!=initial.tick as u64)
            || a.roadblock_wait_ticks.is_some_and(|n|n>initial.tick)
            || a.boundary_last_tick.is_some_and(|n|n>initial.tick)
            || a.roadblock_wait.as_ref().is_some_and(|w|w.started_tick>initial.tick)
            || a.delivery_travel.as_ref().is_some_and(|d|d.empty_ticks as u64+d.loaded_ticks as u64>initial.tick as u64)) {return Err(invalid());}
        Ok(initial)
    }
}
