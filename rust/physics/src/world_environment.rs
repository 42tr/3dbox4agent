//! Owned map configuration and bounded, timed physical/terrain disturbances.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[path="world_environment_planning.rs"]
mod planning;

const MAX_TICK: u64 = 10_000_000;
const MAX_ID: u64 = 9_007_199_254_740_991;
fn invalid() -> Error { Error::from_reason("invalid world environment input") }
fn clock(n: f64) -> Result<u64> {
    if !n.is_finite() || n.fract()!=0.0 || !(0.0..=MAX_TICK as f64).contains(&n) {Err(invalid())} else {Ok(n as u64)}
}
fn decode<T: for<'a> Deserialize<'a>>(s: &str) -> Result<T> {
    if s.len()>2*1024*1024 {return Err(invalid());}
    serde_json::from_str(s).map_err(|_|invalid())
}
fn encode<T: Serialize>(v: &T) -> Result<String> {serde_json::to_string(v).map_err(|_|invalid())}
fn token(s: &str) -> bool {!s.is_empty() && s.len()<=64 && s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
fn name(s: &str) -> bool {!s.is_empty() && s.encode_utf16().count()<=100}
fn point(x: f64,y: f64) -> bool {[x,y].iter().all(|n|n.is_finite()&&(0.0..=100.0).contains(n))}
fn rect(x: f64,y: f64,w: f64,h: f64,min: f64) -> bool {
    point(x,y) && [w,h].iter().all(|n|n.is_finite()&&*n>0.0&&*n>=min) && x+w<=100.0 && y+h<=100.0
}
fn factors(speed: f64,energy: f64) -> bool {speed.is_finite()&&energy.is_finite()&&(0.2..=1.0).contains(&speed)&&(1.0..=5.0).contains(&energy)}
fn sequence(id: &str) -> Option<u64> {
    let n=id.strip_prefix("roadblock-")?.parse::<u64>().ok()?;
    (n>0 && n<=MAX_ID && id==format!("roadblock-{n}")).then_some(n)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Obstacle {id:String,x:f64,y:f64,w:f64,h:f64,height:f64}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Zone {id:String,name:String,x:f64,y:f64,w:f64,h:f64}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Terrain {id:String,name:String,x:f64,y:f64,w:f64,h:f64,speed_factor:f64,energy_factor:f64}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Roadblock {id:String,x:f64,y:f64,w:f64,h:f64,height:f64,started_tick:u64,until_tick:u64}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Effect {zone_id:String,started_tick:u64,until_tick:u64,speed_factor:f64,energy_factor:f64}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all="snake_case")]
enum Navigation {Distance,Time,Energy}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all="snake_case")]
enum RiskNavigation {Monitor,Avoid}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct State {
    #[serde(default,deserialize_with="crate::surface_domain::present",skip_serializing_if="Option::is_none")]surface_domain:Option<crate::surface_domain::Profile>,
    obstacles:Vec<Obstacle>,risk_zones:Vec<Zone>,sensor_range:f64,charging_station:[f64;2],
    #[serde(skip_serializing_if="Option::is_none")]terrain:Option<Vec<Terrain>>,
    #[serde(default,deserialize_with="crate::heightfield::present",skip_serializing_if="Option::is_none")]heightfield:Option<crate::heightfield::Heightfield>,
    #[serde(skip_serializing_if="Option::is_none")]navigation:Option<Navigation>,
    #[serde(skip_serializing_if="Option::is_none")]risk_navigation:Option<RiskNavigation>,
    #[serde(skip_serializing_if="Option::is_none")]roadblocks:Option<Vec<Roadblock>>,
    #[serde(skip_serializing_if="Option::is_none")]terrain_effects:Option<Vec<Effect>>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Agent {id:String,air:bool,#[serde(default)]water:bool}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Initial {tick:u64,state:State,agents:Vec<Agent>,last_roadblock_event:u64}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rect {x:f64,y:f64,w:f64,h:f64}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {id:String,x:f64,y:f64}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct AddRoadblock {rect:Rect,duration:u64,event_id:u64,agents:Vec<Position>}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct AddEffect {zone_id:String,duration:u64,speed_factor:f64,energy_factor:f64}
#[derive(Clone, Serialize)]
struct Due {roadblocks:Vec<Roadblock>,terrain:Vec<Effect>}

#[napi]
#[derive(Clone)]
pub struct WorldEnvironment {
    checkpoint_id: u64,state:State,agents:Vec<Agent>,tick:u64,last_roadblock_event:u64,planning_binding:Option<[u64;6]>,closed:bool}
impl WorldEnvironment {
    pub(crate) fn surface_domain(&self)->Result<Option<&crate::surface_domain::Profile>>{self.check()?;Ok(self.state.surface_domain.as_ref())}
    pub(crate) fn heightfield(&self)->Result<Option<&crate::heightfield::Heightfield>>{self.check()?;Ok(self.state.heightfield.as_ref())}
    pub(crate) fn elevation(&self,x:f64,y:f64)->f64{self.state.heightfield.as_ref().map_or(0.0,|h|h.height(x,y))}
    fn obstacle_top(&self,x:f64,y:f64,w:f64,d:f64,height:f64)->f64{height+self.state.heightfield.as_ref().map_or(0.0,|h|h.bounds(crate::heightfield::Rect{x,y,w,h:d})[1])}

    pub(crate) fn air_task_approach_clear(&self,from:[f64;2],goal:[f64;2])->Result<bool>{
        self.check()?;if crate::world_perceptions::sensor_distance(from[0]-goal[0],from[1]-goal[1])>4.0{return Ok(false)}
        let blocks=self.state.obstacles.iter().map(|b|crate::world_perceptions::Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}).chain(self.blocks().map(|b|crate::world_perceptions::Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}));
        Ok(crate::world_perceptions::visible_heightfield([from[0],from[1],16.0],[goal[0],goal[1],16.0],blocks,self.state.heightfield.as_ref()))
    }
    pub(crate) fn perception_map(&self,now:u64,actors:&[(usize,crate::world_motion::Motion,crate::world_execution::Execution)])->Result<(f64,Vec<crate::world_perceptions::Block>,Vec<crate::world_perceptions::Block>)>{
        self.dispatch_context(now,actors)?;let obstacles=self.state.obstacles.iter().map(|b|crate::world_perceptions::Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}).collect();let roads=self.blocks().map(|b|crate::world_perceptions::Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}).collect();Ok((self.state.sensor_range,obstacles,roads))
    }
    pub(crate) fn physical_roadblocks(&self)->Result<String>{self.check()?;encode(&self.blocks().collect::<Vec<_>>())}
    pub(crate) fn legacy_risk_events(&self,before:&[(String,[f64;2])],motion:&crate::world_motion::WorldMotion)->Result<Vec<serde_json::Value>>{
        self.check()?;let actors=motion.lifecycle_agents()?;if before.len()!=actors.len()||before.iter().zip(&actors).any(|((id,_),(_,a,_))|id!=&a.id){return Err(invalid())}let mut events=Vec::new();
        for((_,start),(_,a,e))in before.iter().zip(&actors){for z in &self.state.risk_zones{let inside=|p:[f64;2]|p[0]>=z.x&&p[0]<=z.x+z.w&&p[1]>=z.y&&p[1]<=z.y+z.h;if !inside(*start)&&inside([a.x,a.y]){events.push(serde_json::json!({"message":format!("{} 进入风险区域「{}」",e.name,z.name),"type":"warning","kind":"risk_zone_entered","agentId":a.id,"zoneId":z.id}))}}}Ok(events)
    }
    pub(crate) fn observation_map(&self)->Result<serde_json::Value>{self.check()?;Ok(serde_json::json!({"sensorRange":self.state.sensor_range}))}
    pub(crate) fn observed_return_energy(&self,id:&str,start:[f64;2],rate:f64,speed:f64,operating:Option<f64>)->Result<Option<f64>>{
        // Published static geometry and base terrain only. Live closures and
        // effects must not leak through this authorized return estimate.
        let spec=self.agents.iter().find(|a|a.id==id).ok_or_else(invalid)?;
        let Some(path)=self.interaction_route(id,start,self.state.charging_station,2.8,false,true)?else{return Ok(None)};
        let terrain=if spec.air{serde_json::json!([])}else{serde_json::to_value(self.state.terrain.clone().unwrap_or_default()).map_err(|_|invalid())?};
        crate::operating_power::route_energy(start,&path,terrain,rate,speed,operating,if spec.air{None}else{self.state.heightfield.as_ref()})
    }
    pub(crate) fn dispatch_context(&self,now:u64,actors:&[(usize,crate::world_motion::Motion,crate::world_execution::Execution)])->Result<u64>{
        let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(id,_)=self.time_context(now,&ids)?;if self.agents.iter().zip(actors).any(|(a,(_,_,e))|a.air!=e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air")||a.water!=(e.mobility.as_deref()==Some("water"))){return Err(invalid())}Ok(id)
    }
    pub(crate) fn route_risk_name(&self,id:&str)->Result<&str>{self.check()?;self.state.risk_zones.iter().find(|z|z.id==id).map(|z|z.name.as_str()).ok_or_else(invalid)}
    pub(crate) fn ending_route(&self,agent:&str,start:[f64;2],target:[f64;2],baseline:bool)->Result<Option<Vec<[f64;2]>>>{
        self.interaction_route(agent,start,target,3.7,true,baseline)
    }
    pub(crate) fn observed_approach(&self,agent:&str,start:[f64;2],goal:[f64;2])->Result<Option<Option<[f64;2]>>>{
        let Some(domain)=&self.state.surface_domain else{return Ok(None)};let a=self.agents.iter().find(|a|a.id==agent).ok_or_else(invalid)?;
        if a.air||domain.clear(if a.water{"water"}else{"ground"},goal,goal,2.0)?{return Ok(None)}
        Ok(Some(self.interaction_route(agent,start,goal,3.7,false,true)?.and_then(|p|p.last().copied())))
    }
    pub(crate) fn task_route(&self,agent:&str,start:[f64;2],target:[f64;2],without_roadblocks:bool)->Result<Option<Vec<[f64;2]>>>{self.interaction_route(agent,start,target,3.7,!without_roadblocks,false)}
    pub(crate) fn interaction_route(&self,agent:&str,start:[f64;2],target:[f64;2],reach:f64,roadblocks:bool,baseline:bool)->Result<Option<Vec<[f64;2]>>>{
        let direct=self.planned_route(agent,start,target,roadblocks,baseline)?;
        let Some(domain)=&self.state.surface_domain else{return Ok(direct)};
        let spec=self.agents.iter().find(|a|a.id==agent).ok_or_else(invalid)?;let mode=if spec.air{"air"}else if spec.water{"water"}else{"ground"};
        if direct.is_some()||reach==0.0||domain.clear(mode,target,target,2.0)?{return Ok(direct)}
        let zones:serde_json::Value=if baseline{serde_json::to_value(self.state.terrain.clone().unwrap_or_default()).map_err(|_|invalid())?}else{decode(&self.effective_terrain()?)?};
        let metric=serde_json::to_value(self.state.navigation.unwrap_or(Navigation::Distance)).map_err(|_|invalid())?;let(mut best,mut best_cost)=(None,f64::INFINITY);
        for p in crate::surface_domain::approaches(target,reach){if !self.interaction_clear(p,target,false,roadblocks)?{continue}if let Some(path)=self.planned_route(agent,start,p,roadblocks,baseline)?{
            let cost=crate::navigation::environment_route_cost(start,&path,zones.clone(),metric.clone(),None)?;if cost<best_cost{best_cost=cost;best=Some(path)}
        }}Ok(best)
    }
    fn planned_route(&self,agent:&str,start:[f64;2],target:[f64;2],roadblocks:bool,baseline:bool)->Result<Option<Vec<[f64;2]>>>{
        self.check()?;let spec=self.agents.iter().find(|a|a.id==agent).ok_or_else(invalid)?;if spec.air{return Ok(Some(vec![target]))}
        let mut obstacles=serde_json::to_value(&self.state.obstacles).map_err(|_|invalid())?.as_array().cloned().ok_or_else(invalid)?;
        if let Some(p)=&self.state.surface_domain{obstacles.extend(p.masks(if spec.water{"water"}else{"ground"})?.iter().map(|r|serde_json::json!({"x":r.x,"y":r.y,"w":r.w,"h":r.h})));}
        if roadblocks{for b in self.blocks(){obstacles.push(serde_json::json!({"x":b.x,"y":b.y,"w":b.w,"h":b.h}))}}
        if matches!(self.state.risk_navigation,Some(RiskNavigation::Avoid)){for z in &self.state.risk_zones{obstacles.push(serde_json::json!({"x":z.x,"y":z.y,"w":z.w,"h":z.h}))}}
        let zones:serde_json::Value=if baseline{serde_json::to_value(self.state.terrain.clone().unwrap_or_default()).map_err(|_|invalid())?}else{decode(&self.effective_terrain()?)?};
        let metric=self.state.navigation.unwrap_or(Navigation::Distance);let input=serde_json::json!({"start":start,"target":target,"obstacles":obstacles,"zones":zones,"heightfield":self.state.heightfield,"metric":metric});decode(&crate::navigation::plan_ground_route(encode(&input)?)?)
    }
    pub(crate) fn collision_route(&self,actor:&str,start:[f64;2],goal:[f64;2],reach:bool,radius:f64,actors:&[(usize,crate::world_motion::Motion,crate::world_execution::Execution)])->Result<Option<Vec<[f64;2]>>>{
        self.check()?;let spec=self.agents.iter().find(|a|a.id==actor).ok_or_else(invalid)?;let air=spec.air;
        let mut obstacles:Vec<_>=self.state.obstacles.iter().filter(|b|!air||self.obstacle_top(b.x,b.y,b.w,b.h,b.height)>=15.2).map(|b|serde_json::json!({"x":b.x,"y":b.y,"w":b.w,"h":b.h})).collect();
        for b in self.blocks().filter(|b|!air||self.obstacle_top(b.x,b.y,b.w,b.h,b.height)>=15.2){obstacles.push(serde_json::json!({"x":b.x,"y":b.y,"w":b.w,"h":b.h}))}
        if !air&&matches!(self.state.risk_navigation,Some(RiskNavigation::Avoid)){for z in &self.state.risk_zones{obstacles.push(serde_json::json!({"x":z.x,"y":z.y,"w":z.w,"h":z.h}))}}
        if let Some(p)=&self.state.surface_domain{obstacles.extend(p.masks(if air{"air"}else if spec.water{"water"}else{"ground"})?.iter().map(|r|serde_json::json!({"x":r.x,"y":r.y,"w":r.w,"h":r.h})));}
        let zones:serde_json::Value=if air{serde_json::json!([])}else{decode(&self.effective_terrain()?)?};
        let input=serde_json::json!({"start":start,"target":goal,"obstacles":obstacles,"zones":zones,"heightfield":if air{None}else{self.state.heightfield.as_ref()},"metric":if air{Navigation::Distance}else{self.state.navigation.unwrap_or(Navigation::Distance)}});
        let others:Vec<_>=self.agents.iter().zip(actors).filter(|(spec,(_,a,_))|spec.air==air&&a.id!=actor).map(|(_,(_,a,_))|[a.x,a.y]).collect();
        crate::navigation::collision_route(encode(&input)?,reach,radius,&others,if air||self.state.surface_domain.is_some(){Some(0.8)}else{None},|p|if air{self.air_task_approach_clear(p,goal)}else{self.activation_reachable(p,goal,false)})
    }
    pub(crate) fn ending_recoverable(&self,agent:&str,start:[f64;2],battery:f64,rate:f64,speed:f64,operating:Option<f64>)->Result<bool>{
        let spec=self.agents.iter().find(|a|a.id==agent).ok_or_else(invalid)?;
        if operating.is_some_and(|n|n>=2.0){return Ok(false)}
        for baseline in [false,true]{if baseline&&(spec.air||self.effects().next().is_none()){break}let zones:serde_json::Value=if spec.air{serde_json::json!([])}else if baseline{serde_json::to_value(self.state.terrain.clone().unwrap_or_default()).map_err(|_|invalid())?}else{decode(&self.effective_terrain()?)?};
            if let Some(path)=self.interaction_route(agent,start,self.state.charging_station,2.8,true,baseline)?{if crate::operating_power::route_energy(start,&path,zones,rate,speed,operating,if spec.air{None}else{self.state.heightfield.as_ref()})?.is_some_and(|cost|battery>cost+operating.unwrap_or(0.0)+1e-9){return Ok(true)}}
        }Ok(false)
    }
    pub(crate) fn ending_rescue_approach(&self,agent:&str,start:[f64;2],goal:[f64;2],battery:f64,rate:f64,work_energy:f64,speed:f64,operating:Option<f64>)->Result<bool>{
        let Some(path)=self.ending_route(agent,start,goal,false)?else{return Ok(false)};
        let zones=decode(&self.effective_terrain()?)?;let cost=if operating.is_some()&&self.activation_reachable(start,goal,false)?{Some(0.0)}else{crate::operating_power::route_energy(start,&path,zones,rate,speed,operating,self.state.heightfield.as_ref())?};
        Ok(cost.is_some_and(|cost|battery>cost+work_energy+1e-9))
    }
    pub(crate) fn time_identity(&self,agents:&[String])->Result<u64>{self.check()?;if self.agents.iter().map(|a|&a.id).ne(agents.iter()){return Err(invalid())}Ok(self.checkpoint_id)}
    pub(crate) fn time_context(&self,tick:u64,agents:&[String])->Result<(u64,serde_json::Value)>{
        self.time(tick as f64)?;if self.tick!=tick||self.agents.iter().map(|a|&a.id).ne(agents.iter()){return Err(invalid())}Ok((self.checkpoint_id,serde_json::to_value(self.due_at(tick+1)).map_err(|_|invalid())?))
    }
    pub(crate) fn time_zone_name(&self,id:&str)->Result<&str>{self.check()?;self.state.terrain.iter().flatten().find(|z|z.id==id).map(|z|z.name.as_str()).ok_or_else(invalid)}
    pub(crate) fn activation_station(&self)->Result<[f64;2]>{self.check()?;Ok(self.state.charging_station)}
    pub(crate) fn activation_roadblock(&self)->Result<Option<String>>{self.check()?;Ok(self.blocks().next().map(|b|b.id.clone()))}
    pub(crate) fn activation_reachable(&self,from:[f64;2],goal:[f64;2],air:bool)->Result<bool>{self.interaction_clear(from,goal,air,true)}
    fn interaction_clear(&self,from:[f64;2],goal:[f64;2],air:bool,roadblocks:bool)->Result<bool>{
        self.check()?;if crate::world_perceptions::sensor_distance(from[0]-goal[0],from[1]-goal[1])>4.0{return Ok(false)}if air{return Ok(true)}if self.state.heightfield.as_ref().is_some_and(|h|!h.traversable(from,goal,0.0)){return Ok(false)}
        let blocks:Vec<_>=self.state.obstacles.iter().map(|b|[b.x,b.y,b.w,b.h]).chain(self.blocks().filter(|_|roadblocks).map(|b|[b.x,b.y,b.w,b.h])).collect();
        // The work-action reach test uses the physical rectangles at radius0,
        // including closed edges, rather than sight rays or planning padding.
        for p in [from,goal]{if p.iter().any(|n|!(0.0..=100.0).contains(n))||blocks.iter().any(|b|p[0]>=b[0]&&p[0]<=b[0]+b[2]&&p[1]>=b[1]&&p[1]<=b[1]+b[3]){return Ok(false)}}
        for b in blocks{let(mut lo,mut hi)=(0.0_f64,1.0_f64);for(start,delta,min,max)in[(from[0],goal[0]-from[0],b[0],b[0]+b[2]),(from[1],goal[1]-from[1],b[1],b[1]+b[3])]{if delta.abs()<1e-10{if start<min||start>max{lo=2.0;break}}else{let(a,c)=((min-start)/delta,(max-start)/delta);lo=lo.max(a.min(c));hi=hi.min(a.max(c));if lo>hi{break}}}if lo<=hi&&hi>=0.0&&lo<=1.0{return Ok(false)}}Ok(true)
    }
    pub(crate) fn stationary_identity(&self,index:usize,id:&str,tick:u64)->Result<u64>{
        self.time(tick as f64)?;if tick!=self.tick||self.agents.get(index).is_none_or(|a|a.id!=id){return Err(invalid())}Ok(self.checkpoint_id)
    }
    pub(crate) fn stationary_visible(&self,from:[f64;3],target:[f64;2],range:Option<f64>,physics:Option<&crate::PhysicsWorld>)->Result<bool>{
        self.check()?;let to=[target[0],target[1],1.0+self.elevation(target[0],target[1])];
        if crate::world_perceptions::sensor_distance(to[0]-from[0],to[1]-from[1])>range.unwrap_or(self.state.sensor_range){return Ok(false)}
        if let Some(p)=physics{return p.visible(from[0],from[1],from[2],to[0],to[1],to[2])}
        use crate::world_perceptions::Block;
        let blocks=self.state.obstacles.iter().map(|b|Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}).chain(self.blocks().map(|b|Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}));
        Ok(crate::world_perceptions::visible_heightfield(from,to,blocks,self.state.heightfield.as_ref()))
    }
    pub(crate) fn peer_visible(&self,from:[f64;3],to:[f64;3])->Result<bool>{
        self.check()?;let point=|p:[f64;3]|[p[0],p[1],p[2]+if p[2]==16.0{0.0}else{self.elevation(p[0],p[1])}];let(from,to)=(point(from),point(to));use crate::world_perceptions::Block;
        let blocks=self.state.obstacles.iter().map(|b|Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}).chain(self.blocks().map(|b|Block{x:b.x,y:b.y,w:b.w,h:b.h,height:b.height}));
        Ok(crate::world_perceptions::visible_heightfield(from,to,blocks,self.state.heightfield.as_ref()))
    }
    pub(crate) fn stationary_near_charger(&self,position:[f64;2])->Result<bool>{
        self.check()?;Ok(crate::world_perceptions::sensor_distance(position[0]-self.state.charging_station[0],position[1]-self.state.charging_station[1])<=3.0+1e-5)
    }
    pub(crate) fn route_map(&self,index:usize,id:&str,tick:u64)->Result<crate::world_route::Map>{
        self.time(tick as f64)?;if tick!=self.tick{return Err(invalid())}
        if self.agents.get(index).is_none_or(|a|a.id!=id){return Err(invalid())}
        let terrain=self.state.terrain.iter().flatten().map(|z|{
            let effect=self.effects().find(|e|e.zone_id==z.id);
            crate::world_route::Terrain{id:z.id.clone(),rect:[z.x,z.y,z.w,z.h],speed:z.speed_factor*effect.map_or(1.0,|e|e.speed_factor),energy:z.energy_factor*effect.map_or(1.0,|e|e.energy_factor),started:effect.map(|e|e.started_tick)}
        }).collect();
        Ok(crate::world_route::Map{identity:self.checkpoint_id,surface_domain:self.state.surface_domain.clone(),heightfield:self.state.heightfield.clone(),terrain,risks:self.state.risk_zones.iter().map(|z|(z.id.clone(),[z.x,z.y,z.w,z.h])).collect()})
    }
    fn time(&self,n:f64) -> Result<u64> {
        if self.closed {return Err(Error::from_reason("world environment is closed"));}
        let tick=clock(n)?;if tick<self.tick {return Err(invalid());}Ok(tick)
    }
    fn check(&self) -> Result<()> {if self.closed {Err(Error::from_reason("world environment is closed"))}else{Ok(())}}
    fn effects(&self) -> impl Iterator<Item=&Effect> {self.state.terrain_effects.iter().flatten()}
    fn blocks(&self) -> impl Iterator<Item=&Roadblock> {self.state.roadblocks.iter().flatten()}
    fn due_at(&self,tick:u64) -> Due {
        Due {roadblocks:self.blocks().filter(|b|tick>b.until_tick).cloned().collect(),terrain:self.effects().filter(|e|tick>e.until_tick).cloned().collect()}
    }
    fn valid_dates(start:u64,end:u64,tick:u64) -> bool {start<=tick&&end>=tick&&end>start&&end-start<=1000}
}
#[napi]
impl WorldEnvironment {
    #[napi(constructor)]
    pub fn new(input:String) -> Result<Self> {
        let i:Initial=decode(&input)?;let s=&i.state;if let Some(h)=&s.heightfield{h.validate()?}if let Some(p)=&s.surface_domain{p.validate()?;if s.heightfield.is_some(){return Err(invalid())}}
        if i.tick>MAX_TICK || i.last_roadblock_event>MAX_ID || i.agents.is_empty() || i.agents.len()>50 || s.obstacles.len()>64 || s.risk_zones.len()>32
            || s.terrain.as_ref().is_some_and(|t|t.len()>32) || s.roadblocks.as_ref().is_some_and(|b|b.len()>8) || s.terrain_effects.as_ref().is_some_and(|e|e.len()>32)
            || !s.sensor_range.is_finite() || s.sensor_range<=0.0 || s.sensor_range>10000.0 || !point(s.charging_station[0],s.charging_station[1]) {return Err(invalid());}
        let mut ids=HashSet::new();
        for a in &i.agents {if !token(&a.id)||!ids.insert(&a.id)||a.water&&(a.air||s.surface_domain.is_none()) {return Err(invalid());}}
        ids.clear();for b in &s.obstacles {if !token(&b.id)||!ids.insert(&b.id)||!rect(b.x,b.y,b.w,b.h,0.0)||!b.height.is_finite()||b.height<=0.0||b.height>1000.0 {return Err(invalid());}}
        ids.clear();for z in &s.risk_zones {if !token(&z.id)||!ids.insert(&z.id)||!name(&z.name)||!rect(z.x,z.y,z.w,z.h,0.0) {return Err(invalid());}}
        ids.clear();for z in s.terrain.iter().flatten() {if !token(&z.id)||!ids.insert(&z.id)||!name(&z.name)||!rect(z.x,z.y,z.w,z.h,0.0)||!factors(z.speed_factor,z.energy_factor) {return Err(invalid());}}
        let mut seen=HashSet::new();for e in s.terrain_effects.iter().flatten() {
            if !ids.contains(&e.zone_id)||!seen.insert(&e.zone_id)||!factors(e.speed_factor,e.energy_factor)||!Self::valid_dates(e.started_tick,e.until_tick,i.tick) {return Err(invalid());}
        }
        ids.clear();for b in s.roadblocks.iter().flatten() {
            let seq=sequence(&b.id).ok_or_else(invalid)?;
            if seq>i.last_roadblock_event || !ids.insert(&b.id)||!rect(b.x,b.y,b.w,b.h,2.0)||b.height!=4.0||!Self::valid_dates(b.started_tick,b.until_tick,i.tick) {return Err(invalid());}
        }
        Ok(Self{ checkpoint_id: crate::world_checkpoint::identity(),state:i.state,agents:i.agents,tick:i.tick,last_roadblock_event:i.last_roadblock_event,planning_binding:None,closed:false})
    }
    #[napi]
    pub fn snapshot(&self) -> Result<String> {self.check()?;encode(&self.state)}
    #[napi]
    pub fn effective_terrain(&self) -> Result<String> {
        self.check()?;let mut terrain=self.state.terrain.clone().unwrap_or_default();
        for z in &mut terrain {if let Some(e)=self.effects().find(|e|e.zone_id==z.id) {z.speed_factor*=e.speed_factor;z.energy_factor*=e.energy_factor;}}
        encode(&terrain)
    }
    #[napi]
    pub fn due(&self,tick:f64) -> Result<String> {let tick=self.time(tick)?;encode(&self.due_at(tick))}
    #[napi]
    pub fn roadblock(&mut self,input:String,tick:f64) -> Result<String> {
        let tick=self.time(tick)?;let p:AddRoadblock=decode(&input)?;let r=p.rect;
        if !rect(r.x,r.y,r.w,r.h,2.0)||!(1..=1000).contains(&p.duration)||self.blocks().count()>=8
            || p.event_id<=self.last_roadblock_event || p.event_id>MAX_ID || p.agents.len()!=self.agents.len() {return Err(invalid());}
        for (a,spec) in p.agents.iter().zip(&self.agents) {
            if a.id!=spec.id||!point(a.x,a.y)||!spec.air&&(a.x<2.0||a.x>98.0||a.y<2.0||a.y>98.0||a.x>=r.x-2.0&&a.x<=r.x+r.w+2.0&&a.y>=r.y-2.0&&a.y<=r.y+r.h+2.0) {return Err(invalid());}
        }
        let b=Roadblock{id:format!("roadblock-{}",p.event_id),x:r.x,y:r.y,w:r.w,h:r.h,height:4.0,started_tick:tick,until_tick:tick+p.duration};
        let result=encode(&b)?;self.state.roadblocks.get_or_insert_with(Vec::new).push(b);self.last_roadblock_event=p.event_id;self.tick=tick;Ok(result)
    }
    #[napi]
    pub fn effect(&mut self,input:String,tick:f64) -> Result<String> {
        let tick=self.time(tick)?;let p:AddEffect=decode(&input)?;
        if !(1..=1000).contains(&p.duration)||!factors(p.speed_factor,p.energy_factor)||!self.state.terrain.iter().flatten().any(|z|z.id==p.zone_id)||self.effects().any(|e|e.zone_id==p.zone_id) {return Err(invalid());}
        let e=Effect{zone_id:p.zone_id,started_tick:tick,until_tick:tick+p.duration,speed_factor:p.speed_factor,energy_factor:p.energy_factor};
        let result=encode(&e)?;self.state.terrain_effects.get_or_insert_with(Vec::new).push(e);self.tick=tick;Ok(result)
    }
    // Apply expiry in the engine's existing roadblock -> terrain order. Terrain
    // remains affected while a simultaneously reopened road is first replanned.
    #[napi]
    pub fn expire_roadblocks(&mut self,tick:f64) -> Result<String> {
        let tick=self.time(tick)?;let expired=self.due_at(tick).roadblocks;let result=encode(&expired)?;
        if let Some(rows)=&mut self.state.roadblocks {rows.retain(|b|tick<=b.until_tick);}self.tick=tick;Ok(result)
    }
    #[napi]
    pub fn expire_terrain(&mut self,tick:f64) -> Result<String> {
        let tick=self.time(tick)?;let expired=self.due_at(tick).terrain;let result=encode(&expired)?;
        if let Some(rows)=&mut self.state.terrain_effects {rows.retain(|e|tick<=e.until_tick);}self.tick=tick;Ok(result)
    }
    #[napi]
    pub fn free(&mut self) {self.closed=true;self.agents.clear();self.state.obstacles.clear();self.state.risk_zones.clear();self.state.terrain=None;self.state.heightfield=None;self.state.surface_domain=None;self.state.roadblocks=None;self.state.terrain_effects=None;}
}

crate::world_checkpoint::world_checkpoint!(WorldEnvironment);
