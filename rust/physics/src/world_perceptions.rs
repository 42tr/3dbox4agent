//! Owned local sensor observations and bounded, last-seen memory.
use crate::{ordered_map::OrderedMap, PhysicsWorld};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, collections::HashSet};
const MAX_TICK: u32 = 10_000_000;
const TTL: u32 = 30;
fn invalid() -> Error { Error::from_reason("invalid world perceptions input") }
fn decode<T: for<'a> Deserialize<'a>>(input: &str) -> Result<T> {
    if input.len() > 16 * 1024 * 1024 { return Err(invalid()); }
    serde_json::from_str(input).map_err(|_| invalid())
}
fn encode<T: Serialize>(value: &T) -> Result<String> { serde_json::to_string(value).map_err(|_| invalid()) }
fn token(s: &str) -> bool { !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') }
fn xy(x: f64, y: f64) -> bool { [x,y].iter().all(|n| n.is_finite() && (0.0..=100.0).contains(n)) }
// Match the existing Node/V8 two-number Math.hypot rounding at the exact
// range boundary. Inputs here are finite, bounded world coordinates.
// https://github.com/nodejs/node/blob/v24.14.1/deps/v8/src/builtins/math.tq
pub(crate) fn sensor_distance(x: f64, y: f64) -> f64 {
    let scale=x.abs().max(y.abs());
    if scale==0.0 {return 0.0;}
    let a=x.abs()/scale;let b=y.abs()/scale;
    (a*a+b*b).sqrt()*scale
}
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all="snake_case")]
enum Status { Idle, Assigned, Working, Manual, Fault, Deployed }
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all="snake_case")]
enum Kind { Agent, Target }
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all="snake_case")]
enum Source { Sensor }
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Item {
    #[serde(default,skip_serializing_if="Option::is_none")] fault_generation:Option<u32>,
    kind: Kind, id: String, x: f64, y: f64, observed_tick: u32, source: Source,
    #[serde(skip_serializing_if="Option::is_none")] role: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] status: Option<Status>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Perception { current: Vec<Item>, memory: Vec<Item> }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct AgentSpec { id: String, role: String, height: f64, range: f64 }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target { id: String, target: [f64;2] }
#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Block { pub(crate) x: f64, pub(crate) y: f64, pub(crate) w: f64, pub(crate) h: f64, pub(crate) height: f64 }
impl Block {
    fn valid(&self) -> bool {
        xy(self.x,self.y) && [self.w,self.h,self.height].iter().all(|n| n.is_finite() && *n>0.0)
            && self.x+self.w<=100.0 && self.y+self.h<=100.0 && self.height<=1000.0
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial {
    tick: u32, agents: Vec<AgentSpec>, targets: Vec<Target>, obstacles: Vec<Block>,
    ray: bool, perceptions: OrderedMap<Perception>,
    #[serde(default,deserialize_with="crate::heightfield::present")]heightfield:Option<crate::heightfield::Heightfield>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentState { #[serde(default,rename="faultGeneration")] fault_generation:Option<u32>,id: String, x: f64, y: f64, status: Status, disabled: bool }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame { tick: u32, agents: Vec<AgentState>, roadblocks: Vec<Block> }

// English default collation for the allowed ASCII identifiers: punctuation,
// digits, case-folded letters, then lowercase-first case weights. Applying
// case weights only after the full primary key preserves localeCompare('en').
fn id_order(a: &str, b: &str) -> Ordering {
    fn weight(c: u8) -> u8 { match c { b'_'=>0,b'-'=>1,b'0'..=b'9'=>2+c-b'0',_=>12+c.to_ascii_lowercase()-b'a' } }
    a.bytes().map(weight).cmp(b.bytes().map(weight)).then_with(|| {
        a.bytes().map(|c| c.is_ascii_uppercase()).cmp(b.bytes().map(|c| c.is_ascii_uppercase()))
    })
}
fn item_order(a: &Item, b: &Item) -> Ordering {
    (a.kind as u8).cmp(&(b.kind as u8)).then_with(|| id_order(&a.id,&b.id))
}
pub(crate) fn visible(from: [f64;3], to: [f64;3], obstacles: impl Iterator<Item=impl std::borrow::Borrow<Block>>) -> bool {
    for o in obstacles {
        let o=o.borrow();let mut lo=0.0_f64;let mut hi=1.0_f64;
        for (start,delta,min,max) in [(from[0],to[0]-from[0],o.x,o.x+o.w),(from[1],to[1]-from[1],o.y,o.y+o.h)] {
            if delta.abs()<1e-10 { if start<min || start>max {lo=2.0;break;} }
            else {
                let mut a=(min-start)/delta;let mut b=(max-start)/delta;
                if a>b {std::mem::swap(&mut a,&mut b);}
                lo=lo.max(a);hi=hi.min(b);if lo>hi {break;}
            }
        }
        if lo<=hi && hi>=0.0 && lo<=1.0 {
            let a=lo.max(0.0);let b=hi.min(1.0);
            if (from[2]+(to[2]-from[2])*a).min(from[2]+(to[2]-from[2])*b)<=o.height {return false;}
        }
    }
    true
}
// Raised prisms and the thin terrain surface use the same published triangles
// as the physical world. The legacy no-field geometry remains byte-compatible.
pub(crate) fn visible_heightfield(from:[f64;3],to:[f64;3],blocks:impl Iterator<Item=impl std::borrow::Borrow<Block>>,field:Option<&crate::heightfield::Heightfield>)->bool{
 let Some(h)=field else{return visible(from,to,blocks)};
 if !h.visible(from,to){return false}
 for b in blocks{let b=b.borrow();let bounds=h.bounds(crate::heightfield::Rect{x:b.x,y:b.y,w:b.w,h:b.h});let(mut lo,mut hi)=(0.0_f64,1.0_f64);
  for(start,delta,min,max)in[(from[0],to[0]-from[0],b.x,b.x+b.w),(from[1],to[1]-from[1],b.y,b.y+b.h),(from[2],to[2]-from[2],bounds[0],bounds[1]+b.height)]{
   if delta.abs()<1e-10{if start<min||start>max{lo=2.0;break}}else{let(a,c)=((min-start)/delta,(max-start)/delta);lo=lo.max(a.min(c));hi=hi.min(a.max(c));if lo>hi{break}}
  }if lo<=hi&&hi>=0.0&&lo<=1.0{return false}
 }true
}
#[napi]
#[derive(Clone)]
pub struct WorldPerceptions {
    checkpoint_id: u64,
    tick: u32, agents: Vec<AgentSpec>, targets: Vec<Target>, obstacles: Vec<Block>, ray: bool,
    heightfield:Option<crate::heightfield::Heightfield>,state: OrderedMap<Perception>, closed: bool,
}
impl WorldPerceptions {
    pub(crate) fn proposal_catalog(&self,now:u32,tasks:&[crate::world_tasks::Task],agents:&[(String,String,bool)])->Result<u64>{
        self.check()?;if now<self.tick||now>MAX_TICK||self.agents.len()!=agents.len()||self.agents.iter().zip(agents).any(|(a,(id,role,_))|a.id!=*id||a.role!=*role)||self.targets.len()!=tasks.len()||self.targets.iter().zip(tasks).any(|(target,task)|target.id!=task.id||target.target!=task.target){return Err(invalid())}Ok(self.checkpoint_id)
    }
    fn check(&self) -> Result<()> { if self.closed { Err(Error::from_reason("world perceptions is closed")) } else { Ok(()) } }
    fn valid_item(&self, item: &Item, observer: &str) -> bool {
        if item.fault_generation.is_some_and(|n|n==0||item.kind!=Kind::Agent||item.status!=Some(Status::Fault)) || !xy(item.x,item.y) || item.observed_tick>self.tick || self.tick-item.observed_tick>TTL {return false;}
        match item.kind {
            Kind::Agent=>item.id!=observer && self.agents.iter().any(|a| a.id==item.id && item.role.as_ref()==Some(&a.role)) && item.status.is_some(),
            Kind::Target=>item.role.is_none() && item.status.is_none() && self.targets.iter().any(|t| t.id==item.id && t.target==[item.x,item.y]),
        }
    }
    fn owned_frame(&self,now:u32,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,ray:bool)->Result<Frame>{
        self.check()?;let actors=motion.lifecycle_agents()?;let(range,obstacles,roadblocks)=environment.perception_map(now as u64,&actors)?;
        if self.heightfield.as_ref()!=environment.heightfield()?||self.ray!=ray||self.obstacles!=obstacles||actors.len()!=self.agents.len(){return Err(invalid())}let mut agents=Vec::new();
        for((_,a,e),spec)in actors.into_iter().zip(&self.agents){let air=e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air");if spec.id!=a.id||spec.role!=e.role||spec.height!=(if air{16.0}else{1.5})||spec.range!=e.sensor_range.unwrap_or(range){return Err(invalid())}use crate::world_execution::Status as S;let status=match e.status{S::Idle=>Status::Idle,S::Assigned=>Status::Assigned,S::Working=>Status::Working,S::Manual=>Status::Manual,S::Fault=>Status::Fault,S::Deployed=>Status::Deployed};agents.push(AgentState{id:a.id,x:a.x,y:a.y,status,disabled:e.disabled,fault_generation:e.fault_generation})}
        Ok(Frame{tick:now,agents,roadblocks})
    }
    pub(crate) fn validate_owned(&self,now:u32,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,ray:bool)->Result<()>{self.owned_frame(now,motion,environment,ray)?;Ok(())}
    pub(crate) fn refresh_owned(&mut self,now:u32,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,ray:bool,physics:Option<&PhysicsWorld>)->Result<()>{let frame=self.owned_frame(now,motion,environment,ray)?;self.update_frame(frame,if ray{physics}else{None})}
    fn update(&mut self, input: &str, physics: Option<&PhysicsWorld>) -> Result<()> {let frame:Frame=decode(input)?;self.update_frame(frame,physics)}
    fn update_frame(&mut self,frame:Frame,physics:Option<&PhysicsWorld>)->Result<()>{
        self.check()?;
        if self.ray!=physics.is_some() || frame.tick<self.tick || frame.tick>MAX_TICK || frame.agents.len()!=self.agents.len()
            || frame.agents.iter().zip(&self.agents).any(|(a,s)| a.id!=s.id || !xy(a.x,a.y))
            || frame.roadblocks.len()>8 || frame.roadblocks.iter().any(|b| !b.valid()) {return Err(invalid());}
        let mut next=OrderedMap::default();
        for ((self_spec,who),(_,previous)) in self.agents.iter().zip(&frame.agents).zip(&self.state) {
            let mut current=Vec::new();
            if !who.disabled {
                let point=|x:f64,y:f64,z:f64|[x,y,z+if z==16.0{0.0}else{self.heightfield.as_ref().map_or(0.0,|h|h.height(x,y))}];
                let from=point(who.x,who.y,self_spec.height);
                let can_see=|to: [f64;3]| -> Result<bool> {
                    if sensor_distance(to[0]-from[0],to[1]-from[1])>self_spec.range {return Ok(false);}
                    match physics {
                        Some(p)=>p.visible(from[0],from[1],from[2],to[0],to[1],to[2]),
                        None=>Ok(visible_heightfield(from,to,self.obstacles.iter().chain(&frame.roadblocks),self.heightfield.as_ref())),
                    }
                };
                for (spec,a) in self.agents.iter().zip(&frame.agents) {
                    if a.id!=who.id && can_see(point(a.x,a.y,spec.height))? {
                        current.push(Item{fault_generation:if a.status==Status::Fault{a.fault_generation.filter(|n|*n>0)}else{None},kind:Kind::Agent,id:a.id.clone(),x:a.x,y:a.y,role:Some(spec.role.clone()),status:Some(a.status),observed_tick:frame.tick,source:Source::Sensor});
                    }
                }
                for t in &self.targets {
                    if can_see(point(t.target[0],t.target[1],1.0))? {
                        current.push(Item{fault_generation:None,kind:Kind::Target,id:t.id.clone(),x:t.target[0],y:t.target[1],role:None,status:None,observed_tick:frame.tick,source:Source::Sensor});
                    }
                }
            }
            let mut memory: Vec<_>=previous.memory.iter().filter(|i| frame.tick-i.observed_tick<=TTL).cloned().collect();
            for item in &current {
                if let Some(old)=memory.iter_mut().find(|i| i.kind==item.kind && i.id==item.id) {*old=item.clone();}
                else {memory.push(item.clone());}
            }
            memory.sort_by(item_order);
            next.insert(who.id.clone(),Perception{current,memory});
        }
        // Encoding succeeds before committing either the memory or tick.
        encode(&next)?;self.state=next;self.tick=frame.tick;Ok(())
    }
}
#[napi]
impl WorldPerceptions {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        let i: Initial=decode(&input)?;if let Some(h)=&i.heightfield{h.validate()?}
        if i.tick>MAX_TICK || i.agents.is_empty() || i.agents.len()>50 || i.targets.is_empty() || i.targets.len()>100
            || i.obstacles.len()>64 || i.obstacles.iter().any(|b|!b.valid()) || i.perceptions.len()!=i.agents.len() {return Err(invalid());}
        let mut ids=HashSet::new();
        for a in &i.agents {if !token(&a.id)||!token(&a.role)||!ids.insert(&a.id)||![1.5,16.0].contains(&a.height)||!a.range.is_finite()||a.range<=0.0||a.range>10000.0 {return Err(invalid());}}
        ids.clear();for t in &i.targets {if !token(&t.id)||!ids.insert(&t.id)||!xy(t.target[0],t.target[1]) {return Err(invalid());}}
        let world=Self{ checkpoint_id: crate::world_checkpoint::identity(),tick:i.tick,agents:i.agents,targets:i.targets,obstacles:i.obstacles,ray:i.ray,heightfield:i.heightfield,state:i.perceptions,closed:false};
        for (spec,(id,p)) in world.agents.iter().zip(&world.state) {
            if &spec.id!=id || p.current.len()>world.agents.len()+world.targets.len()-1 || p.memory.len()>world.agents.len()+world.targets.len()-1 {return Err(invalid());}
            let mut seen=HashSet::new();
            for item in &p.memory {
                if !world.valid_item(item,id)||!seen.insert((item.kind as u8,&item.id)) {return Err(invalid());}
            }
            if p.memory.windows(2).any(|w|item_order(&w[0],&w[1])!=Ordering::Less) {return Err(invalid());}
            seen.clear();
            let mut previous=None;
            for item in &p.current {
                if !world.valid_item(item,id)||item.observed_tick!=world.tick||!seen.insert((item.kind as u8,&item.id))||!p.memory.contains(item) {return Err(invalid());}
                let index=match item.kind {
                    Kind::Agent=>world.agents.iter().position(|a|a.id==item.id).ok_or_else(invalid)?,
                    Kind::Target=>world.agents.len()+world.targets.iter().position(|t|t.id==item.id).ok_or_else(invalid)?,
                };
                if previous.is_some_and(|last|last>=index) {return Err(invalid());}previous=Some(index);
            }
        }
        Ok(world)
    }
    #[napi]
    pub fn refresh(&mut self, input: String) -> Result<()> { self.update(&input,None) }
    #[napi]
    pub fn refresh_ray(&mut self, input: String, physics: &PhysicsWorld) -> Result<()> { self.update(&input,Some(physics)) }
    #[napi]
    pub fn register(&mut self, input: String, tick: u32) -> Result<()> {
        self.check()?;let t: Target=decode(&input)?;
        if tick<self.tick || tick>MAX_TICK || self.targets.len()>=100 || !token(&t.id)||!xy(t.target[0],t.target[1])||self.targets.iter().any(|old|old.id==t.id) {return Err(invalid());}
        self.targets.push(t);Ok(())
    }
    #[napi]
    pub fn snapshot(&self) -> Result<String> { self.check()?;encode(&self.state) }
    #[napi]
    pub fn free(&mut self) {self.closed=true;self.heightfield=None;self.state.clear();self.agents.clear();self.targets.clear();self.obstacles.clear();}
}

crate::world_checkpoint::world_checkpoint!(WorldPerceptions);
