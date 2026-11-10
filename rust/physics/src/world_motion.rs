//! Per-world typed motion/energy components. The host issues atomic updates;
//! numeric component values live here, rather than in a mutable JS shadow.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Motion {
    pub(crate) id: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) battery: f64,
    pub(crate) initial_battery: f64,
    pub(crate) distance: f64,
}

fn invalid() -> Error { Error::from_reason("invalid world motion input") }
fn valid(x: f64, y: f64, battery: f64, distance: f64) -> bool {
    [x, y, battery].iter().all(|n| n.is_finite() && (0.0..=100.0).contains(n))
        && distance.is_finite() && distance >= 0.0
}
fn index(value: f64) -> Result<usize> {
    if !value.is_finite() || value < 0.0 || value >= 50.0 || value.fract() != 0.0 { return Err(invalid()); }
    Ok(value as usize)
}

#[napi]
#[derive(Clone)]
pub struct WorldMotion {
    checkpoint_id: u64,
    agents: Vec<Motion>,
    execution: Option<Vec<super::world_execution::Execution>>,
    route_environment: Option<u64>,
    route_physics: Option<u64>,
    route_event_binding: Option<[u64;6]>,
    route_event_ticks: HashMap<usize,u64>,
    collision_event_binding: Option<[u64;6]>,
    collision_event_ticks: HashMap<usize,u64>,
    closed: bool,
}

impl WorldMotion {
    pub(crate) fn has_operating_energy(&self)->Result<bool>{self.active()?;Ok(self.execution.as_ref().ok_or_else(invalid)?.iter().any(|a|a.operating_energy_per_tick.is_some()))}

    pub(crate) fn finish_thermal_events(&mut self,now:u32)->Result<Vec<serde_json::Value>>{
        self.active()?;let mut execution=self.execution.as_ref().ok_or_else(invalid)?.clone();let mut result=Vec::new();
        for e in &mut execution{
            if let(Some(p),Some(state))=(&e.thermal,&mut e.thermal_state){if let Some(event)=state.finish(p,now)?{e.thermal_pending.push(event)}}
            e.thermal_pending.sort_by_key(|e|e.kind_order());
            for event in &e.thermal_pending{result.push(event.event(&e.name,&e.id))}
            e.thermal_pending.clear();
        }
        serde_json::to_string(&result).map_err(|_|invalid())?;self.execution=Some(execution);Ok(result)
    }
    pub(crate) fn environment_identity(&self,binding:[u64;6])->Result<u64>{
        self.active()?;if self.route_environment.is_some_and(|id|id!=binding[0])||self.route_event_binding.is_some_and(|b|b!=binding)||self.collision_event_binding.is_some_and(|b|b!=binding){return Err(invalid())}Ok(self.checkpoint_id)
    }
    pub(crate) fn lifecycle_agents(&self)->Result<Vec<(usize,Motion,super::world_execution::Execution)>>{
        self.active()?;let execution=self.execution.as_ref().ok_or_else(invalid)?;
        if execution.len()!=self.agents.len(){return Err(invalid())}
        self.agents.iter().zip(execution).enumerate().map(|(i,(a,e))|{if a.id!=e.id{return Err(invalid())}Ok((i,a.clone(),e.clone()))}).collect()
    }
    pub(crate) fn activation_components(&self,id:&str)->Result<(usize,Motion,super::world_execution::Execution,u64)>{
        self.active()?;let i=self.agents.iter().position(|a|a.id==id).ok_or_else(invalid)?;
        let execution=self.execution.as_ref().and_then(|a|a.get(i)).ok_or_else(invalid)?;
        if execution.id!=id{return Err(invalid())}Ok((i,self.agents[i].clone(),execution.clone(),self.checkpoint_id))
    }
    pub(crate) fn work_components(&self,id:&str)->Result<(usize,Motion,super::world_execution::Execution,u64)>{
        self.active()?;let i=self.agents.iter().position(|a|a.id==id).ok_or_else(invalid)?;
        let e=self.execution.as_ref().and_then(|a|a.get(i)).ok_or_else(invalid)?;
        if e.id!=id||!e.work_eligible(){return Err(invalid())}
        Ok((i,self.agents[i].clone(),e.clone(),self.checkpoint_id))
    }
    pub(crate) fn stationary_components(&self,id:&str)->Result<(usize,Motion,super::world_execution::Execution,u64)>{
        self.active()?;let i=self.agents.iter().position(|a|a.id==id).ok_or_else(invalid)?;
        let e=self.execution.as_ref().and_then(|a|a.get(i)).ok_or_else(invalid)?;
        if e.id!=id||!e.stationary_eligible(){return Err(invalid())}
        Ok((i,self.agents[i].clone(),e.clone(),self.checkpoint_id))
    }
    pub(crate) fn commit_stationary(&mut self,index:usize,agent:Motion,execution:super::world_execution::Execution)->Result<()>{
        self.active()?;
        if self.agents.get(index).is_none_or(|a|a.id!=agent.id)||agent.id!=execution.id||!valid(agent.x,agent.y,agent.battery,agent.distance)||!execution.valid(agent.distance)||execution.relay_state.as_ref().is_some_and(|s|s.deployed&&s.position!=Some([agent.x,agent.y]))||self.execution.as_ref().is_none_or(|a|index>=a.len()){return Err(invalid())}
        self.agents[index]=agent;self.execution.as_mut().unwrap()[index]=execution;Ok(())
    }
    fn active(&self) -> Result<()> {
        if self.closed { Err(Error::from_reason("world motion is closed")) } else { Ok(()) }
    }
    // Derive route facts from the owned participants. Movement, physical state,
    // monitoring flags, deduplication and event counters share a single commit.
    fn route_events_phase(&mut self,agent_index:f64,expected:f64,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,mut physics:Option<&mut crate::PhysicsWorld>)->Result<String>{
        use crate::world_execution::Status as S;
        use crate::world_tasks::{Status as T,Behavior};
        let actors=self.lifecycle_agents()?;let i=index(agent_index)?;
        let(_,current,execution)=actors.get(i).ok_or_else(invalid)?;
        let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();
        let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();
        let(t,_)=tasks.revocation_context("",&actors,&catalog)?;
        let(c,l,mode,boundary,footprint,risks,rapier)=control.route_events_context(expected,&ids,&catalog,ledger)?;
        let now=expected as u64;
        let(e,_)=environment.time_context(now,&ids)?;
        let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();
        let(r,_)=resources.proposal_catalog(now,&all,&roster)?;
        let(a,_)=actions.ending_context(now as u32,&ids)?;
        let binding=[e,r,t,a,c,l];let physics_id=physics.as_ref().map_or(0,|p|p.checkpoint_id);
        if execution.disabled||execution.lifecycle_waiting()||rapier!=physics.is_some()
            ||self.route_event_binding.is_some_and(|b|b!=binding)
            ||self.route_event_ticks.get(&i).is_some_and(|tick|*tick>=now)
            ||self.route_environment.is_some_and(|id|id!=e)||self.route_physics.is_some_and(|id|id!=physics_id){return Err(invalid())}
        tasks.environment_binding([self.checkpoint_id,e,r,a,c,l])?;actions.collision_identity([self.checkpoint_id,e,r,t,c,l])?;
        let task=all.iter().find(|t|t.status==T::Active&&t.assignee.as_deref()==Some(current.id.as_str()));
        let delivery=match execution.status{
            S::Working=>{let task=task.ok_or_else(invalid)?;resources.work_owner(task,current,execution,now as u32)?;task.behavior==Behavior::Deliver},
            S::Manual=>{let(moving,resume)=actions.route_intent(&current.id)?.ok_or_else(invalid)?;
                match (resume.as_deref(),task){
                    (Some(id),Some(task)) if id==task.id&&(!moving||mode=="primitive")=>{resources.work_owner(task,current,execution,now as u32)?;moving&&task.behavior==Behavior::Deliver},
                    (None,None)=>false,
                    _=>return Err(invalid()),
                }
            },
            _=>return Err(invalid()),
        };
        let map=environment.route_map(i,&current.id,now)?;
        let mut exposures=Vec::new();
        if map.terrain.iter().any(|z|z.started.is_some()){
            for event in ledger.entries()?{if event["kind"]=="terrain_effect_exposure"&&event["agentId"]==current.id{
                if let(Some(id),Some(start))=(event["zoneId"].as_str(),event["startedTick"].as_u64()){
                    if map.terrain.iter().any(|z|z.id==id&&z.started==Some(start))&&!exposures.iter().any(|(key,t)|key==id&&*t==start){exposures.push((id.to_owned(),start))}
                }
            }}
        }
        let context=crate::world_route::Context::parse(&serde_json::json!({"tick":now,"delivery":delivery,"loaded":resources.route_loaded(&current.id)?,"boundary":boundary,"footprint":footprint,"risks":risks,"exposures":exposures}).to_string())?;
        let mut next=current.clone();let mut state=execution.clone();let mut physical=physics.as_ref().map(|p|(**p).clone());
        let air=execution.mobility.as_deref().map_or(execution.role=="drone",|m|m=="air");
        let mut approach=None;
        if rapier&&air&&current.battery>0.0&&execution.status==S::Working&&!execution.route.is_empty(){
            let task=task.ok_or_else(invalid)?;let goal=resources.work_owner(task,current,execution,now as u32)?.1;
            let others:Vec<_>=actors.iter().filter(|(_,a,e)|a.id!=current.id&&e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air")).collect();
            let occupied:Vec<_>=others.iter().filter(|(_,a,_)|crate::world_perceptions::sensor_distance(a.x-goal[0],a.y-goal[1])<1.6+1e-9).map(|(_,a,_)|a.id.clone()).collect();
            if !occupied.is_empty()&&others.iter().all(|(_,a,_)|crate::world_perceptions::sensor_distance(a.x-current.x,a.y-current.y)>=1.59)&&environment.air_task_approach_clear([current.x,current.y],goal)?{
                approach=Some(serde_json::json!({"kind":"task_approach_reached","taskId":task.id,"assignmentId":task.assignment_id,"phase":task.phase.flatten(),"target":goal,"position":[current.x,current.y],"mobility":"air","occupiedBy":occupied}));
            }
        }
        let bodies:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),a.x,a.y,e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air"))).collect();
        let events=if let Some(event)=approach{
            state.route.clear();state.blocked_ticks=Some(0);state.progress_waypoint=Some(String::new());state.best_waypoint_distance=Some(0.0);state.collision_active=Some(false);vec![event]
        }else{crate::world_route::advance(&mut next,&mut state,&map,&context,&bodies,physical.as_mut())?};
        if !valid(next.x,next.y,next.battery,next.distance)||!state.valid(next.distance){return Err(invalid())}
        let mut next_control=control.clone();let mut next_ledger=ledger.clone();
        for effect in &events{
            let kind=effect["kind"].as_str().ok_or_else(invalid)?;
            let(message,level)=match kind{
                "boundary_exit_prevented"=>(format!("{} 的出界位移已被限制",execution.name),"warning"),
                "risk_zone_entered"=>(format!("{} 进入风险区域「{}」",execution.name,environment.route_risk_name(effect["zoneId"].as_str().ok_or_else(invalid)?)?),"warning"),
                "footprint_boundary_exit"=>(format!("{} 的二维轮廓伸出场景边界",execution.name),"warning"),
                "terrain_effect_exposure"=>(format!("{} 进入受扰动地表区域",execution.name),"info"),
                "collision_contact"=>(format!("{} 遇到障碍，运动已受限",execution.name),"warning"),
                "task_approach_reached"=>(format!("{} 已在占用目标附近就位",execution.name),"info"),
                _=>return Err(invalid()),
            };
            let mut event=effect.clone();event["message"]=message.into();event["type"]=level.into();event["agentId"]=current.id.clone().into();
            next_control.task_event(&mut next_ledger,event)?;
        }
        next_control.validate_commit(&next_ledger)?;
        let encoded=serde_json::to_string(&events).map_err(|_|invalid())?;
        self.agents[i]=next;self.execution.as_mut().unwrap()[i]=state;
        self.route_environment=Some(e);self.route_physics=Some(physics_id);self.route_event_binding=Some(binding);self.route_event_ticks.insert(i,now);
        *control=next_control;*ledger=next_ledger;
        if let(Some(target),Some(saved))=(physics.as_mut(),physical){**target=saved}
        Ok(encoded)
    }
}

#[napi]
impl WorldMotion {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        if input.len() > 65536 { return Err(invalid()) }
        let agents: Vec<Motion> = serde_json::from_str(&input).map_err(|_| invalid())?;
        if agents.is_empty() || agents.len() > 50 { return Err(invalid()) }
        let mut ids = HashSet::new();
        for a in &agents {
            if a.id.is_empty() || a.id.len() > 64
                || !a.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                || !ids.insert(&a.id) || !valid(a.x, a.y, a.battery, a.distance)
                || !a.initial_battery.is_finite() || !(0.0..=100.0).contains(&a.initial_battery) {
                return Err(invalid());
            }
        }
        Ok(Self { checkpoint_id: crate::world_checkpoint::identity(), agents, execution: None, route_environment: None, route_physics: None, route_event_binding: None, route_event_ticks: HashMap::new(), collision_event_binding:None,collision_event_ticks:HashMap::new(),closed: false })
    }

    #[napi]
    pub fn read(&self, agent_index: f64, field: String) -> Result<f64> {
        self.active()?;
        let a = self.agents.get(index(agent_index)?).ok_or_else(invalid)?;
        match field.as_str() {
            "x" => Ok(a.x), "y" => Ok(a.y), "battery" => Ok(a.battery),
            "initialBattery" => Ok(a.initial_battery), "distance" => Ok(a.distance),
            _ => Err(invalid()),
        }
    }

    // All validation precedes mutation: a rejected command cannot partially move
    // a device, charge it, or decrease its already accumulated travel distance.
    #[napi]
    pub fn commit(&mut self, agent_index: f64, x: f64, y: f64, battery: f64, distance: f64) -> Result<()> {
        self.active()?;
        let i=index(agent_index)?;
        if self.execution.as_ref().and_then(|e|e.get(i)).and_then(|e|e.relay_state.as_ref()).is_some_and(|s|s.deployed&&s.position!=Some([x,y])){return Err(invalid())}
        let a = self.agents.get_mut(i).ok_or_else(invalid)?;
        if self.execution.as_ref().and_then(|e|e.get(i)).and_then(|e|e.relay_state.as_ref()).is_some_and(|s|s.deployed)&&distance!=a.distance{return Err(invalid())}
        if !valid(x, y, battery, distance) || distance < a.distance { return Err(invalid()); }
        a.x = x;
        a.y = y;
        a.battery = battery;
        a.distance = distance;
        Ok(())
    }

    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        self.active()?;
        serde_json::to_string(&self.agents).map_err(|_| invalid())
    }

    #[napi]
    pub fn bind_execution(&mut self, input: String) -> Result<()> {
        self.active()?;
        if self.execution.is_some() {return Err(Error::from_reason("world execution is already bound"));}
        let initial=super::world_execution::Initial::parse(&input)?;
        if initial.agents.len()!=self.agents.len() || initial.agents.iter().zip(&self.agents).any(|(a,m)|a.id!=m.id||!a.valid(m.distance)||a.relay_state.as_ref().is_some_and(|s|s.deployed&&s.position!=Some([m.x,m.y]))) {return Err(Error::from_reason("invalid world execution input"));}
        self.execution=Some(initial.agents);
        Ok(())
    }

    #[napi]
    pub fn update_execution(&mut self, agent_index: f64, input: String) -> Result<String> {
        self.active()?;
        let i=index(agent_index)?;
        let motion=self.agents.get(i).ok_or_else(invalid)?;
        let agents=self.execution.as_mut().ok_or_else(||Error::from_reason("world execution is not bound"))?;
        let current=agents.get(i).ok_or_else(invalid)?;
        let (next,encoded)=current.updated(&input,motion.distance)?;
        if next.relay_state.as_ref().is_some_and(|s|s.deployed&&s.position!=Some([motion.x,motion.y])){return Err(invalid())}
        agents[i]=next;
        Ok(encoded)
    }

    #[napi]
    pub fn finish_thermals(&mut self,expected:f64)->Result<String>{
        if !expected.is_finite()||expected.fract()!=0.0||!(0.0..=10_000_000.0).contains(&expected){return Err(invalid())}
        let events=self.finish_thermal_events(expected as u32)?;serde_json::to_string(&events).map_err(|_|invalid())
    }
    #[napi]
    pub fn snapshot_execution(&self) -> Result<String> {
        self.active()?;
        let agents=self.execution.as_ref().ok_or_else(||Error::from_reason("world execution is not bound"))?;
        serde_json::to_string(agents).map_err(|_|invalid())
    }

    fn route_phase(&mut self,agent_index:f64,input:String,environment:&crate::world_environment::WorldEnvironment,mut physics:Option<&mut crate::PhysicsWorld>)->Result<String>{
        self.active()?;let i=index(agent_index)?;
        let current=self.agents.get(i).ok_or_else(invalid)?;
        let execution=self.execution.as_ref().and_then(|a|a.get(i)).ok_or_else(invalid)?;
        let context=crate::world_route::Context::parse(&input)?;
        let map=environment.route_map(i,&current.id,context.tick)?;
        let physics_id=physics.as_ref().map_or(0,|p|p.checkpoint_id);
        if self.route_environment.is_some_and(|id|id!=map.identity)||self.route_physics.is_some_and(|id|id!=physics_id){return Err(invalid())}
        let mut next=current.clone();let mut state=execution.clone();let mut physical=physics.as_ref().map(|p|(**p).clone());
        let bodies:Vec<_>=self.agents.iter().zip(self.execution.as_ref().unwrap()).map(|(a,e)|(a.id.clone(),a.x,a.y,e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air"))).collect();
        let events=crate::world_route::advance(&mut next,&mut state,&map,&context,&bodies,physical.as_mut())?;
        if !valid(next.x,next.y,next.battery,next.distance)||!state.valid(next.distance){return Err(invalid())}
        let encoded=serde_json::to_string(&events).map_err(|_|invalid())?;
        self.agents[i]=next;self.execution.as_mut().unwrap()[i]=state;self.route_environment=Some(map.identity);self.route_physics=Some(physics_id);
        if let (Some(target),Some(saved))=(physics.as_mut(),physical){**target=saved;}
        Ok(encoded)
    }
    #[napi]
    pub fn advance_route(&mut self,agent_index:f64,input:String,environment:&crate::world_environment::WorldEnvironment)->Result<String>{self.route_phase(agent_index,input,environment,None)}
    #[napi]
    pub fn advance_route_rapier(&mut self,agent_index:f64,input:String,environment:&crate::world_environment::WorldEnvironment,physics:&mut crate::PhysicsWorld)->Result<String>{self.route_phase(agent_index,input,environment,Some(physics))}

    // Actual task/action ownership determines the recovery goal and work reach;
    // callers supply only the actor index, clock and owned component references.
    #[napi]
    pub fn replan_collision_events(&mut self,agent_index:f64,expected:f64,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
        use crate::world_execution::Status as S;
        use crate::world_tasks::{Status as T,Behavior as B,Phase as P};
        let actors=self.lifecycle_agents()?;let i=index(agent_index)?;let(_,current,execution)=actors.get(i).ok_or_else(invalid)?;
        let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();
        let(t,_)=tasks.revocation_context("",&actors,&catalog)?;let(c,l,mode,_,_,_,rapier)=control.route_events_context(expected,&ids,&catalog,ledger)?;let now=expected as u64;
        let e=environment.dispatch_context(now,&actors)?;let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,_)=resources.proposal_catalog(now,&all,&roster)?;let(a,_)=actions.ending_context(now as u32,&ids)?;let binding=[e,r,t,a,c,l];
        if !rapier||self.route_environment.is_some_and(|id|id!=e)||self.route_event_binding.is_some_and(|b|b!=binding)||self.collision_event_binding.is_some_and(|b|b!=binding)||self.collision_event_ticks.get(&i).is_some_and(|tick|*tick>=now){return Err(invalid())}
        tasks.event_context(now as u32,self,environment,resources,actions,control,ledger)?;actions.collision_identity([self.checkpoint_id,e,r,t,c,l])?;
        let no=||Ok("{\"replanned\":false}".to_owned());let air=execution.mobility.as_deref().map_or(execution.role=="drone",|m|m=="air");
        if execution.disabled||execution.lifecycle_waiting()||execution.blocked_ticks!=Some(10)||execution.collision_replans.unwrap_or(0)>=3||execution.route.is_empty(){return no()}
        let task=all.iter().find(|t|t.status==T::Active&&t.assignee.as_deref()==Some(current.id.as_str()));
        let occupied=|goal:[f64;2]|actors.iter().any(|(_,a,e)|a.id!=current.id&&e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air")==air&&crate::world_perceptions::sensor_distance(a.x-goal[0],a.y-goal[1])<1.6+1e-9);
        let(goal,reach,radius)=match execution.status{
            S::Working=>{let task=task.ok_or_else(invalid)?;let(_,goal)=resources.work_owner(task,current,execution,now as u32)?;
                let ground_pickup=if task.behavior==B::Deliver&&task.phase.flatten()==Some(P::ToPickup){resources.assignment_context(None,now as u32)?.1["state"]["part"]["location"]=="ground"}else{false};
                (goal,task.behavior==B::Repair||task.behavior==B::Deliver&&(task.phase.flatten()==Some(P::ToSite)||ground_pickup)||occupied(goal),3.7)},
            S::Manual=>{let(moving,resume,target)=actions.collision_intent(&current.id)?.ok_or_else(invalid)?;
                let waypoint=match(resume.as_deref(),task){(Some(id),Some(task))if id==task.id&&(!moving||mode=="primitive")=>Some(resources.work_owner(task,current,execution,now as u32)?.1),(None,None)=>None,_=>return Err(invalid())};
                if moving{let waypoint=waypoint.ok_or_else(invalid)?;let goal=target.ok_or_else(invalid)?;(goal,goal==waypoint,3.7)}else{if current.battery<=0.0{return no()}(environment.activation_station()?,true,2.7)}},
            _=>return Err(invalid()),
        };
        let Some(route)=environment.collision_route(&current.id,[current.x,current.y],goal,reach,radius,&actors)?else{return no()};
        let mut next=self.clone();let mut state=execution.clone();state.route=route;state.collision_replans=Some(state.collision_replans.unwrap_or(0)+1);state.blocked_ticks=Some(0);state.progress_waypoint=Some(String::new());next.commit_stationary(i,current.clone(),state)?;
        let mut next_control=control.clone();let mut next_ledger=ledger.clone();next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 绕行受阻设备",execution.name),"type":"info","kind":"collision_replan","agentId":current.id}))?;next_control.validate_commit(&next_ledger)?;
        next.collision_event_binding=Some(binding);next.collision_event_ticks.insert(i,now);*self=next;*control=next_control;*ledger=next_ledger;Ok("{\"replanned\":true}".to_owned())
    }

    #[napi]
    pub fn advance_route_events(&mut self,agent_index:f64,expected:f64,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{self.route_events_phase(agent_index,expected,environment,resources,tasks,actions,control,ledger,None)}
    #[napi]
    pub fn advance_route_events_rapier(&mut self,agent_index:f64,expected:f64,environment:&crate::world_environment::WorldEnvironment,resources:&crate::world_resources::WorldResources,tasks:&crate::world_tasks::WorldTasks,actions:&crate::world_actions::WorldActions,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,physics:&mut crate::PhysicsWorld)->Result<String>{self.route_events_phase(agent_index,expected,environment,resources,tasks,actions,control,ledger,Some(physics))}

    #[napi]
    pub fn free_execution(&mut self) {self.execution=None;self.route_event_ticks.clear();self.collision_event_ticks.clear();}

    #[napi]
    pub fn free(&mut self) {
        self.closed = true;
        self.execution=None;
        self.route_event_ticks.clear();self.route_event_binding=None;self.collision_event_ticks.clear();self.collision_event_binding=None;
        self.agents.clear();
        self.agents.shrink_to_fit();
    }
}

crate::world_checkpoint::world_checkpoint!(WorldMotion);
