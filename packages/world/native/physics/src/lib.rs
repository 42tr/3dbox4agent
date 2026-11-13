use napi::bindgen_prelude::*;
use napi_derive::napi;
use rapier3d::{control::{CharacterLength,KinematicCharacterController}, prelude::*};
use serde::Deserialize;
use std::collections::{HashMap,HashSet};
mod navigation;
mod heightfield;
mod surface_domain;
mod thermal;
mod operating_power;
mod materials;
mod relay;
mod construction;
mod rescue;
mod world_ledger;
mod world_motion;
mod world_tasks;
mod world_execution;
mod world_actions;
mod world_peer;
mod world_reports;
mod ordered_map;
mod world_dispatch;
mod world_resources;
mod world_perceptions;
mod world_environment;
mod world_requests;
mod world_control;
mod world_initialization;
mod world_checkpoint;
mod world_route;

#[derive(Clone, Deserialize)]
struct Block { id: Option<String>, x: f32, y: f32, w: f32, h: f32, height: f32 }
#[derive(Clone, Deserialize)]
struct Agent { id: String, x: f64, y: f64, role: String, mobility: Option<String> }
#[derive(Clone, Deserialize)]
struct State { #[serde(default="default_world_size",rename="worldSize")] world_size:f64, #[serde(default,rename="surfaceDomain",deserialize_with="surface_domain::present")] surface_domain:Option<surface_domain::Profile>, obstacles: Vec<Block>, agents: Vec<Agent>, #[serde(default)] roadblocks: Vec<Block>, #[serde(default,deserialize_with="heightfield::present")] heightfield:Option<heightfield::Heightfield> }

pub(crate) const MAX_WORLD_SIZE:f64=256.0;
pub(crate) fn default_world_size()->f64{100.0}
pub(crate) fn valid_world_size(size:f64)->bool{(100.0..=MAX_WORLD_SIZE).contains(&size)&&size.fract()==0.0}

fn parse<T: for<'a> Deserialize<'a>>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|_| Error::from_reason("invalid physics input"))
}
fn valid_block(b: &Block) -> bool {
    [b.x,b.y,b.w,b.h,b.height].iter().all(|x|x.is_finite() && x.abs()<1.0e6)
        && b.w>0.0 && b.h>0.0 && b.height>0.0
}
fn block(b: &Block,terrain:Option<&heightfield::Heightfield>) -> Collider {
    let [base,top]=terrain.map_or([0.0,0.0],|h|h.bounds(heightfield::Rect{x:b.x as f64,y:b.y as f64,w:b.w as f64,h:b.h as f64}));let top=top+b.height as f64;
    ColliderBuilder::cuboid(b.w/2.0,((top-base)/2.0)as f32,b.h/2.0)
        .translation(vector![b.x+b.w/2.0,((top+base)/2.0)as f32,b.y+b.h/2.0]).build()
}

#[napi]
#[derive(Clone)]
pub struct PhysicsWorld {
    world_size:f64,
    checkpoint_id: u64,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    query: QueryPipeline,
    agents: HashMap<String,ColliderHandle>,
    air: HashSet<String>,
    water: HashSet<String>,
    surface_domain:Option<surface_domain::Profile>,
    domain_colliders:HashMap<ColliderHandle,bool>,
    heightfield:Option<heightfield::Heightfield>,
    terrain_handle:Option<ColliderHandle>,
    roadblocks: HashMap<String,ColliderHandle>,
    controller: KinematicCharacterController,
    closed: bool,
}

impl PhysicsWorld {
    // Query the actual collider triangles. Parry 0.17's triangle cast can return
    // t=0 for an origin on a face's infinite plane but outside the finite face,
    // and omits coplanar segments. Clip the projected ray to each finite face
    // before solving its affine height equation; the mesh remains a thin surface.
    fn terrain_ray(&self,ray:&Ray,max:f32)->Result<Option<f32>> {
        let Some(handle)=self.terrain_handle else{return if self.heightfield.is_none(){Ok(None)}else{Err(Error::from_reason("missing terrain collider"))}};
        let collider=self.colliders.get(handle).ok_or_else(||Error::from_reason("missing terrain collider"))?;
        let mesh=collider.shape().as_trimesh().ok_or_else(||Error::from_reason("invalid terrain collider"))?;
        let local=ray.inverse_transform_by(collider.position());let origin=local.origin;let dir=local.dir;let mut best=None;
        for tri in mesh.triangles(){
            let(ax,az)=(tri.a.x as f64,tri.a.z as f64);let(bx,bz)=(tri.b.x as f64-ax,tri.b.z as f64-az);let(cx,cz)=(tri.c.x as f64-ax,tri.c.z as f64-az);let det=bx*cz-bz*cx;
            let(px,pz)=(origin.x as f64-ax,origin.z as f64-az);let(dx,dz)=(dir.x as f64,dir.z as f64);
            let(u,v)=((px*cz-pz*cx)/det,(bx*pz-bz*px)/det);let(du,dv)=((dx*cz-dz*cx)/det,(bx*dz-bz*dx)/det);
            let(mut lo,mut hi)=(0.0_f64,best.unwrap_or(max)as f64);
            for(value,delta)in[(u,du),(v,dv),(1.0-u-v,-du-dv)]{
                if delta.abs()<1e-14{if value< -1e-10{lo=hi+1.0;break}}
                else{let t= -value/delta;if delta>0.0{lo=lo.max(t)}else{hi=hi.min(t)}}
            }
            if lo>hi+1e-10||hi<0.0||lo>max as f64{continue}lo=lo.max(0.0);hi=hi.min(max as f64);
            let(by,cy)=(tri.b.y as f64-tri.a.y as f64,tri.c.y as f64-tri.a.y as f64);
            let at=origin.y as f64-(tri.a.y as f64+by*u+cy*v);let delta=dir.y as f64-by*du-cy*dv;
            let hit=if delta.abs()<1e-12{if at.abs()<=1e-7{Some(lo)}else{None}}else{let t= -at/delta;if t>=lo-1e-10&&t<=hi+1e-10{Some(t.max(lo).min(hi))}else{None}};
            if let Some(t)=hit{let t=t as f32;if best.is_none_or(|old|t<old){best=Some(t)}}
        }Ok(best)
    }
}
#[napi]
impl PhysicsWorld {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        let state: State = parse(&input)?;
        if !valid_world_size(state.world_size)||(state.world_size!=100.0&&(state.heightfield.is_some()||state.surface_domain.is_some())){return Err(Error::from_reason("invalid world size"))}
        if let Some(h)=&state.heightfield{h.validate()?}
        if let Some(p)=&state.surface_domain{p.validate()?;if state.heightfield.is_some(){return Err(Error::from_reason("surface domains require a flat map"))}}
        let mut world = Self { world_size:state.world_size, checkpoint_id: crate::world_checkpoint::identity(), bodies: RigidBodySet::new(), colliders: ColliderSet::new(), query: QueryPipeline::new(),
            agents: HashMap::new(),air:HashSet::new(),water:HashSet::new(),surface_domain:state.surface_domain,domain_colliders:HashMap::new(),heightfield:state.heightfield,terrain_handle:None, roadblocks: HashMap::new(), closed: false, controller: KinematicCharacterController { offset: CharacterLength::Absolute(0.02), slide: true, ..Default::default() } };
        if let Some(h)=&world.heightfield{let(vertices,indices)=h.mesh();world.terrain_handle=Some(world.colliders.insert(ColliderBuilder::trimesh(vertices.into_iter().map(Point::from).collect(),indices).build()))}
        for b in &state.obstacles {
            if !valid_block(b) { return Err(Error::from_reason("invalid obstacle")); }
            world.colliders.insert(block(b,world.heightfield.as_ref()));
        }
        if let Some(p)=&world.surface_domain{for water_forbidden in [false,true]{for r in p.partition(!water_forbidden).into_iter().chain(surface_domain::world_bounds()){let h=world.colliders.insert(ColliderBuilder::cuboid(r.w as f32/2.0,2.0,r.h as f32/2.0).translation(vector![(r.x+r.w/2.0)as f32,1.0,(r.y+r.h/2.0)as f32]).build());world.domain_colliders.insert(h,water_forbidden);}}}
        for a in &state.agents {
            if a.id.is_empty() || ![a.x,a.y].iter().all(|x|x.is_finite() && x.abs()<1.0e6) { return Err(Error::from_reason("invalid agent")); }
            let mobility=a.mobility.as_deref().unwrap_or(if a.role=="drone"{"air"}else{"ground"});
            if !["air","ground","water"].contains(&mobility)||mobility=="water"&&world.surface_domain.is_none(){return Err(Error::from_reason("invalid surface mobility"))}
            if let Some(p)=&world.surface_domain{if !p.body_free(mobility,[a.x,a.y],0.8)?{return Err(Error::from_reason("agent outside surface domain"))}}
            let air=mobility=="air";if mobility=="water"{world.water.insert(a.id.clone());}
            if air{world.air.insert(a.id.clone());}
            let elevation=if air{16.0}else{world.heightfield.as_ref().map_or(1.0,|h|h.proxy_height(a.x as f32 as f64,a.y as f32 as f64)as f32)};
            let handle = world.colliders.insert(ColliderBuilder::ball(0.8).translation(vector![a.x as f32,elevation,a.y as f32]).build());
            if world.agents.insert(a.id.clone(),handle).is_some() { return Err(Error::from_reason("duplicate agent")); }
        }
        world.update_roadblocks(state.roadblocks)?;
        world.query.update(&world.colliders);
        Ok(world)
    }

    #[napi]
    pub fn sync_roadblocks(&mut self, input: String) -> Result<()> {
        if self.closed { return Err(Error::from_reason("physics world is closed")); }
        let blocks: Vec<Block> = parse(&input)?;
        self.update_roadblocks(blocks)
    }

    #[napi(js_name="move")]
    pub fn move_agent(&mut self, id: String, x: f64, y: f64, dx: f64, dy: f64) -> Result<Vec<f64>> {
        if self.closed { return Err(Error::from_reason("physics world is closed")); }
        if ![x,y,dx,dy].iter().all(|n|n.is_finite() && n.abs() < 1.0e6) { return Err(Error::from_reason("invalid movement")); }
        let handle = *self.agents.get(&id).ok_or_else(||Error::from_reason("missing physics collider"))?;
        let collider = &self.colliders[handle];
        let pos = *collider.position();
        if (pos.translation.x as f64-x).hypot(pos.translation.z as f64-y)>0.001 { return Err(Error::from_reason("physics and world positions diverged")); }
        let mut contacts = 0u32;
        let air=self.air.contains(&id);let water=self.water.contains(&id);
        let domain_filter=|h:ColliderHandle,_:&Collider|self.domain_colliders.get(&h).is_none_or(|only_water|!air&&*only_water==water);
        if !self.air.contains(&id){if let Some(h)=self.heightfield.clone(){
            if !h.traversable([x,y],[x+dx,y+dy],2.0){return Ok(vec![0.0,0.0,0.0])}
            let mut cuts=h.cuts([x,y],[x+dx,y+dy]);let count=(dx.hypot(dy)/0.2).ceil()as usize;for i in 1..count{cuts.push(i as f64/count as f64)}cuts.sort_by(f64::total_cmp);cuts.dedup_by(|a,b|(*a-*b).abs()<1e-12);
            for t in cuts.into_iter().skip(1){let at=*self.colliders[handle].position();let(tx,ty)=(x+dx*t,y+dy*t);let movement=self.controller.move_shape(1.0/20.0,&self.bodies,&self.colliders,&self.query,self.colliders[handle].shape(),&at,vector![(tx-at.translation.x as f64)as f32,(h.proxy_height(tx,ty)-at.translation.y as f64)as f32,(ty-at.translation.z as f64)as f32],QueryFilter::default().exclude_collider(handle).predicate(&domain_filter),|_|contacts+=1);let p=at.translation.vector+movement.translation;self.colliders[handle].set_translation(vector![p.x,h.proxy_height(p.x as f64,p.z as f64)as f32,p.z]);self.query.update(&self.colliders);if (p.x as f64-tx).hypot(p.z as f64-ty)>0.01{break}}
            let end=self.colliders[handle].translation();return Ok(vec![end.x as f64-pos.translation.x as f64,end.z as f64-pos.translation.z as f64,contacts as f64]);
        }}
        let movement = self.controller.move_shape(1.0/20.0,&self.bodies,&self.colliders,&self.query,
            collider.shape(),&pos,vector![dx as f32,0.0,dy as f32],QueryFilter::default().exclude_collider(handle).predicate(&domain_filter), |_| contacts+=1);
        let m = movement.translation;
        // Like the WASM backend, keep flat-map proxies at their configured elevation.
        // A slide along a roof edge can include a vertical Rapier correction even
        // though the World movement and snapshot only own x and y.
        self.colliders[handle].set_translation(pos.translation.vector+vector![m.x,0.0,m.z]);
        self.query.update(&self.colliders);
        Ok(vec![m.x as f64,m.z as f64,contacts as f64])
    }

    // Line of sight through static obstacles and roadblocks; device proxies do not occlude.
    #[napi]
    pub fn visible(&self, fx: f64, fy: f64, fz: f64, tx: f64, ty: f64, tz: f64) -> Result<bool> {
        if self.closed { return Err(Error::from_reason("physics world is closed")); }
        if ![fx,fy,fz,tx,ty,tz].iter().all(|v|v.is_finite() && v.abs()<1.0e6) {
            return Err(Error::from_reason("invalid visibility ray"));
        }
        let origin=point![fx as f32,fz as f32,fy as f32];
        let direction=vector![(tx-fx) as f32,(tz-fz) as f32,(ty-fy) as f32];
        let obstacle=|h: ColliderHandle, _: &Collider| !self.agents.values().any(|a|*a==h)&&!self.domain_colliders.contains_key(&h);
        let filter=QueryFilter::default().predicate(&obstacle);
        if self.heightfield.is_some(){
            let static_obstacle=|h:ColliderHandle,c:&Collider|Some(h)!=self.terrain_handle&&obstacle(h,c);
            let filter=QueryFilter::default().predicate(&static_obstacle);let ray=Ray::new(origin,direction);
            let blocked=if direction.norm_squared()==0.0{let mut found=false;self.query.intersections_with_point(&self.bodies,&self.colliders,&origin,filter,|_|{found=true;false});found}else{self.query.cast_ray(&self.bodies,&self.colliders,&ray,1.0,true,filter).is_some()};
            return Ok(!blocked&&self.terrain_ray(&ray,1.0)?.is_none())
        }
        if direction.norm_squared() == 0.0 {
            let mut blocked=false;
            self.query.intersections_with_point(&self.bodies,&self.colliders,&origin,filter, |_| {blocked=true;false});
            return Ok(!blocked);
        }
        let ray=Ray::new(origin,direction);
        Ok(self.query.cast_ray(&self.bodies,&self.colliders,&ray,1.0,true,filter).is_none())
    }

    // Horizontal, instantaneous range scan. -1 means no hit within range.
    #[napi]
    pub fn lidar(&self, id: String, height: f64, count: u32, max_range: f64) -> Result<Vec<f64>> {
        if self.closed { return Err(Error::from_reason("physics world is closed")); }
        if !(4..=72).contains(&count) || !height.is_finite() || !((if self.heightfield.is_some(){-10.0}else{0.0})..=1000.0).contains(&height)
            || !max_range.is_finite() || !(0.0..=1000.0).contains(&max_range) || max_range == 0.0 {
            return Err(Error::from_reason("invalid lidar parameters"));
        }
        let handle = *self.agents.get(&id).ok_or_else(||Error::from_reason("missing physics collider"))?;
        let pos = self.colliders[handle].translation();
        let origin = point![pos.x,height as f32,pos.z];
        let mut distances = Vec::with_capacity(count as usize);
        for i in 0..count {
            let angle = std::f32::consts::TAU * (i as f32)/(count as f32);
            let ray = Ray::new(origin, vector![angle.cos(), 0.0, angle.sin()]);
            let hit = if self.heightfield.is_some(){let obstacle=|h:ColliderHandle,_:&Collider|Some(h)!=self.terrain_handle&&!self.domain_colliders.contains_key(&h);self.query.cast_ray(&self.bodies,&self.colliders,&ray,max_range as f32,true,QueryFilter::default().exclude_collider(handle).predicate(&obstacle))}else{self.query.cast_ray(&self.bodies,&self.colliders,&ray,max_range as f32,true,QueryFilter::default().exclude_collider(handle).predicate(&|h,_|!self.domain_colliders.contains_key(&h)))};
            let terrain=if self.heightfield.is_some(){self.terrain_ray(&ray,max_range as f32)?}else{None};
            let distance=match(hit.map(|(_,d)|d),terrain){(Some(a),Some(b))=>Some(a.min(b)),(a,b)=>a.or(b)};
            distances.push(distance.map_or(-1.0, |distance| distance as f64));
        }
        Ok(distances)
    }

    #[napi]
    pub fn free(&mut self) {
        self.agents.clear();self.air.clear();self.water.clear();self.surface_domain=None;self.domain_colliders.clear();self.heightfield=None;self.terrain_handle=None; self.roadblocks.clear(); self.colliders = ColliderSet::new();
        self.query = QueryPipeline::new(); self.closed = true;
    }

    #[napi]
    pub fn correct_position(&mut self,id: String,x: f64,y: f64) -> Result<()> {
        if self.closed { return Err(Error::from_reason("physics world is closed")); }
        if ![x,y].iter().all(|n|n.is_finite() && n.abs()<1.0e6) { return Err(Error::from_reason("invalid position")); }
        let handle = *self.agents.get(&id).ok_or_else(||Error::from_reason("missing physics collider"))?;
        if let Some(p)=&self.surface_domain{let mobility=if self.air.contains(&id){"air"}else if self.water.contains(&id){"water"}else{"ground"};if !p.body_free(mobility,[x,y],0.8)?{return Err(Error::from_reason("position outside surface domain"))}}
        let height = if self.air.contains(&id){self.colliders[handle].translation().y}else{self.heightfield.as_ref().map_or(self.colliders[handle].translation().y,|h|h.proxy_height(x,y)as f32)};
        self.colliders[handle].set_translation(vector![x as f32,height,y as f32]);
        self.query.update(&self.colliders);
        Ok(())
    }

    /// [x, map-y, absolute proxy elevation]; does not expose another session.
    #[napi]
    pub fn body_position(&self,id:String)->Result<Vec<f64>>{if self.closed{return Err(Error::from_reason("physics world is closed"))}let handle=self.agents.get(&id).ok_or_else(||Error::from_reason("missing physics collider"))?;let p=self.colliders[*handle].translation();Ok(vec![p.x as f64,p.z as f64,p.y as f64])}
    #[napi]
    pub fn surface(&self,x:f64,y:f64)->Result<Vec<f64>>{if self.closed||![x,y].iter().all(|v|v.is_finite()&&(0.0..=self.world_size).contains(v)){return Err(Error::from_reason("invalid surface position"))}Ok(self.heightfield.as_ref().map_or([0.0;4],|h|h.surface(x,y)).to_vec())}
}
impl PhysicsWorld {
    fn update_roadblocks(&mut self, blocks: Vec<Block>) -> Result<()> {
        // Validate before modifying colliders, so malformed input is atomic.
        let mut live = HashSet::new();
        for b in &blocks { if !valid_block(b) { return Err(Error::from_reason("invalid roadblock")); }
            let id=b.id.as_ref().ok_or_else(||Error::from_reason("roadblock id required"))?;
            if !live.insert(id.clone()) { return Err(Error::from_reason("duplicate roadblock")); }
        }
        let removed: Vec<_> = self.roadblocks.keys().filter(|id|!live.contains(*id)).cloned().collect();
        for id in removed {
            let handle=self.roadblocks.remove(&id).unwrap();
            self.colliders.remove(handle,&mut IslandManager::new(),&mut self.bodies,true);
        }
        for b in &blocks { let id=b.id.as_ref().unwrap(); if !self.roadblocks.contains_key(id) {
            let handle=self.colliders.insert(block(b,self.heightfield.as_ref())); self.roadblocks.insert(id.clone(),handle);
        }}
        self.query.update(&self.colliders);
        Ok(())
    }
}

// Assignment eligibility is kept independent of navigation and world mutation.
// Node passes the current authoritative state on each call; this module does
// not retain a second mutable copy of the world.
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RuleTask { id: String, status: String, depends_on: Vec<String>, capability: String, behavior: String, #[serde(default)] material_cost:Option<Vec<materials::Item>> }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RuleAgent { #[serde(default)] deployable_relay:Option<bool>, id: String, disabled: bool, status: String, battery: f64, capabilities: Vec<String> }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RulePart { location: String, reserved_by: Option<String> }
#[derive(Clone, Deserialize)]
struct RuleAsset { diagnosis: String, condition: String }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct AssignmentInput { #[serde(default)] materials:Option<materials::State>, done: bool, tasks: Vec<RuleTask>, agents: Vec<RuleAgent>, part: RulePart,
    asset: RuleAsset, task_id: serde_json::Value, agent_id: serde_json::Value }

#[napi]
pub fn assignment_precondition(input: String) -> Result<String> {
    let world: AssignmentInput = parse(&input)?;
    if world.materials.as_ref().is_some_and(|m|!m.valid()){return Err(Error::from_reason("invalid materials"))}
    let reason = (|| -> Option<&'static str> {
        if world.done { return Some("world_finished"); }
        let task = match world.tasks.iter().find(|t| world.task_id.as_str() == Some(t.id.as_str())) {
            Some(t) => t, None => return Some("unknown_task") };
        let agent = match world.agents.iter().find(|a| world.agent_id.as_str() == Some(a.id.as_str())) {
            Some(a) => a, None => return Some("unknown_agent") };
        if task.status != "pending" || !task.depends_on.iter().all(|id| world.tasks.iter().any(|t| &t.id == id && t.status == "done")) { return Some("task_not_ready"); }
        if agent.disabled || agent.status != "idle" { return Some("agent_unavailable"); }
        if agent.battery <= 5.0 { return Some("low_battery"); }
        if !agent.capabilities.contains(&task.capability) || task.behavior=="deploy"&&agent.deployable_relay!=Some(true) { return Some("missing_capability"); }
        if task.behavior == "deliver" && (!matches!(world.part.location.as_str(), "warehouse" | "ground") || world.part.reserved_by.is_some()) { return Some("part_unavailable"); }
        if task.behavior == "repair" {
            if world.asset.diagnosis != "confirmed" { return Some("anomaly_unconfirmed"); }
            if world.part.location != "site" || world.part.reserved_by.is_some() { return Some("part_unavailable"); }
        }
        if task.behavior == "verify" && world.asset.condition != "repaired" { return Some("repair_required"); }
        if task.material_cost.as_ref().is_some_and(|cost|world.materials.as_ref().is_none_or(|m|!m.available(cost))){return Some("materials_unavailable")}
        None
    })();
    Ok(reason.unwrap_or("").to_string())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct TransitionInput { task_id: String, agent_id: String, behavior: String,
    execution_mode: String, route: Vec<[f64; 2]>, assignment_id: u64 }

// Construct the assignment transition. The host computes a route and commits
// the returned fields in the same synchronous operation as eligibility checks.
#[napi]
pub fn assignment_transition(input: String) -> Result<String> {
    let data: TransitionInput = parse(&input)?;
    if data.task_id.is_empty() || data.agent_id.is_empty() || data.assignment_id == 0 || data.assignment_id > 9_007_199_254_740_991 ||
        !matches!(data.execution_mode.as_str(), "auto" | "agent" | "primitive") || data.route.len() > 4096 ||
        data.route.iter().flatten().any(|n| !n.is_finite()) {
        return Err(Error::from_reason("invalid assignment transition"));
    }
    let phase = match data.behavior.as_str() { "deliver" => Some("to_pickup"), "repair" => Some("repairing"), _ => None };
    let route = if data.execution_mode == "primitive" { Vec::<[f64;2]>::new() } else { data.route };
    let output = serde_json::json!({
        "taskId": data.task_id, "agentId": data.agent_id, "assignmentId": data.assignment_id,
        "taskStatus": "active", "agentStatus": if data.execution_mode == "auto" {"working"} else {"assigned"},
        "route": route, "work": 0, "collisionReplans": 0, "phase": phase,
        "reservePart": phase.is_some()
    });
    serde_json::to_string(&output).map_err(|_| Error::from_reason("invalid assignment transition"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RevocationTask { id: String, status: String, assignee: Option<String>, assignment_id: Option<u64> }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RevocationAgent { id: String, roadblock_wait: Option<serde_json::Value> }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RevocationAction { agent_id: String, request_id: String, status: String, resume_task_id: Option<String> }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RevocationInput { tick: u64, decision_max_age: u64, task_id: String, agent_id: String,
    assignment_id: u64, observed_tick: u64, require_blocked_since: Option<u64>,
    task: Option<RevocationTask>, agent: Option<RevocationAgent>, actions: Vec<RevocationAction> }

#[napi]
pub fn revocation_precondition(input: String) -> Result<String> {
    let w: RevocationInput = parse(&input)?;
    let reason = (|| -> Option<&'static str> {
        if w.observed_tick > w.tick || w.tick - w.observed_tick > w.decision_max_age { return Some("stale_observation"); }
        let (t,a)=match (&w.task,&w.agent) { (Some(t),Some(a)) => (t,a), _ => return Some("assignment_changed") };
        if t.id != w.task_id || a.id != w.agent_id || t.status != "active" || t.assignee.as_deref()!=Some(a.id.as_str()) || t.assignment_id!=Some(w.assignment_id) { return Some("assignment_changed"); }
        if let Some(required)=w.require_blocked_since {
            let current=a.roadblock_wait.as_ref().and_then(|wait| {
                let owner=wait.get("owner")?;
                let owned=if owner.get("kind").and_then(|x|x.as_str())==Some("task") {
                    owner.get("taskId").and_then(|x|x.as_str())==Some(t.id.as_str()) && owner.get("assignmentId").and_then(|x|x.as_u64())==t.assignment_id
                } else {
                    let request=owner.get("requestId").and_then(|x|x.as_str());
                    w.actions.iter().any(|action|action.agent_id==a.id && Some(action.request_id.as_str())==request && action.status=="accepted" && action.resume_task_id.as_deref()==Some(t.id.as_str()))
                };
                if owned { wait.get("startedTick").and_then(|x|x.as_u64()) } else { None }
            });
            if current!=Some(required) { return Some("route_condition_changed"); }
        }
        None
    })();
    Ok(reason.unwrap_or("").to_string())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct RevocationTransitionInput { task_id: String, agent_id: String, assignment_id: u64, replans: u64,
    reserved_by: Option<String>, location: String, carrier_id: Option<String>, x:f64, y:f64 }

#[napi]
pub fn revocation_transition(input: String) -> Result<String> {
    let v: RevocationTransitionInput=parse(&input)?;
    if v.task_id.is_empty() || v.agent_id.is_empty() || v.assignment_id==0 || v.assignment_id>9_007_199_254_740_991 ||
        v.replans>=9_007_199_254_740_991 || !v.x.is_finite() || !v.y.is_finite() { return Err(Error::from_reason("invalid revocation transition")); }
    let release=v.reserved_by.as_deref()==Some(v.task_id.as_str());
    let drop=release && v.location=="carried" && v.carrier_id.as_deref()==Some(v.agent_id.as_str());
    let out=serde_json::json!({"taskId":v.task_id,"agentId":v.agent_id,"assignmentId":v.assignment_id,
        "releasePart":release,"dropPart":drop,"dropPosition":if drop {Some([v.x,v.y])} else {None},
        "taskStatus":"pending","agentStatus":"idle","replans":v.replans+1});
    serde_json::to_string(&out).map_err(|_|Error::from_reason("invalid revocation transition"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct WorkTickInput { task_id:String, agent_id:String, behavior:String, phase:Option<String>,
    work:u64, battery:f64, work_energy:f64, duration:u64 }

// Decide one task-work tick; navigation and event publication remain with the host.
#[napi]
pub fn task_work_tick(input:String)->Result<String> {
    let v:WorkTickInput=parse(&input)?;
    if v.task_id.is_empty() || v.agent_id.is_empty() || v.work>=9_007_199_254_740_991 ||
        v.duration==0 || v.duration>9_007_199_254_740_991 || !v.battery.is_finite() ||
        !v.work_energy.is_finite() || v.battery<0.0 || v.work_energy<0.0 {
        return Err(Error::from_reason("invalid task work input"));
    }
    let mut phase=v.phase.clone();
    if v.behavior=="deliver" {
        if phase.as_deref()==Some("to_pickup") {phase=Some("loading".into())}
        if phase.as_deref()==Some("to_site") {phase=Some("unloading".into())}
    }
    let next_work=v.work+1;
    let battery=(v.battery-v.work_energy).max(0.0);
    let mut effect="none";
    if battery>0.0 {
        if v.behavior=="deliver" && phase.as_deref()==Some("loading") {
            if next_work>=4 {effect="route_to_site"}
        } else if v.behavior=="deliver" && phase.as_deref()==Some("unloading") {
            if next_work>=5 {effect="delivered"}
        } else if next_work>=v.duration {
            effect=match v.behavior.as_str(){"build"=>"build","deploy"=>"deploy","sample"=>"sample","detect"=>"detect","confirm"=>"confirm","repair"=>"repair","verify"=>"verify",_=>"complete"};
        }
    }
    let completed=matches!(effect,"delivered"|"sample"|"detect"|"confirm"|"repair"|"verify"|"complete"|"deploy"|"build");
    let output=serde_json::json!({"taskId":v.task_id,"agentId":v.agent_id,"setPhase":phase!=v.phase,"phase":phase,
        "work":next_work,"battery":battery,"effect":effect,"completion":if completed {
            Some(serde_json::json!({"taskStatus":"done","agentStatus":if v.behavior=="deploy"{"deployed"}else{"idle"},"work":0,"phase":null}))
        } else {None}});
    serde_json::to_string(&output).map_err(|_|Error::from_reason("invalid task work result"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct ActionActivationInput {
    tick:u64, expires_tick:u64, action_type:String, execution_mode:String,
    agent_id:String, agent_disabled:bool, agent_status:String, battery:f64,
    capabilities:Vec<String>, task_status:Option<String>, task_assignee:Option<String>,
    has_assigned_task:bool, within_reach:bool,
}

// Admission checks apply at the action's target tick; route planning remains with the host.
#[napi]
pub fn action_activation_precondition(input:String)->Result<String> {
    let v:ActionActivationInput=parse(&input)?;
    if !matches!(v.action_type.as_str(),"move"|"scan"|"charge"|"execute_task"|"work_task"|"rescue") ||
        !matches!(v.execution_mode.as_str(),"auto"|"agent"|"primitive") || !v.battery.is_finite() {
        return Err(Error::from_reason("invalid action activation input"));
    }
    let reason=if v.tick>v.expires_tick {Some("expired")}
    else if matches!(v.action_type.as_str(),"execute_task"|"work_task") {
        let expected=if v.action_type=="work_task" {"primitive"} else {"agent"};
        if v.execution_mode!=expected {Some("agent_execution_disabled")}
        else if v.agent_disabled {Some("agent_unavailable")}
        else if v.task_status.as_deref()!=Some("active") || v.task_assignee.as_deref()!=Some(v.agent_id.as_str()) || v.agent_status!="assigned" {Some("task_not_assigned")}
        else if v.battery<=5.0 {Some("low_battery")}
        else if v.action_type=="work_task" && !v.within_reach {Some("out_of_reach")}
        else {None}
    } else {
        let assigned_move=v.action_type=="move" && v.execution_mode=="primitive" && v.has_assigned_task;
        let assigned_charge=v.action_type=="charge" && matches!(v.execution_mode.as_str(),"agent"|"primitive") && v.has_assigned_task;
        if v.agent_disabled || (v.agent_status!="idle" && !assigned_move && !assigned_charge) {Some("agent_unavailable")}
        else if v.battery<=5.0 && v.action_type!="charge" {Some("low_battery")}
        else if v.action_type=="charge" && v.battery>=80.0 {Some("battery_sufficient")}
        else if v.action_type=="scan" && !v.capabilities.iter().any(|c|c=="inspect"||c=="confirm") {Some("missing_capability")}
        else {None}
    };
    Ok(reason.unwrap_or("").to_string())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct StationaryActionInput {
    agent_id:String, request_id:String, action_type:String, battery:f64,
    progress:Option<u64>, work_energy:Option<f64>, phase:Option<String>,
    energy_added:Option<f64>, charger_busy:bool,
}

// Advance scanning or the shared charging station by one world tick.
#[napi]
pub fn stationary_action_tick(input:String)->Result<String> {
    let v:StationaryActionInput=parse(&input)?;
    if v.agent_id.is_empty() || v.request_id.is_empty() || !v.battery.is_finite() || v.battery<0.0 {
        return Err(Error::from_reason("invalid stationary action input"));
    }
    let output=match v.action_type.as_str() {
        "scan" => {
            let progress=v.progress.ok_or_else(||Error::from_reason("invalid scan input"))?;
            let energy=v.work_energy.ok_or_else(||Error::from_reason("invalid scan input"))?;
            if progress>=9_007_199_254_740_991 || !energy.is_finite() || energy<0.0 {return Err(Error::from_reason("invalid scan input"));}
            let battery=(v.battery-energy).max(0.0);let progress=progress+1;
            let effect=if battery<=0.0 {"energy_depleted"} else if progress>=3 {"completed"} else {"pending"};
            serde_json::json!({"agentId":v.agent_id,"requestId":v.request_id,"type":"scan","battery":battery,"progress":progress,"effect":effect})
        },
        "charge" => {
            let mut phase=v.phase.ok_or_else(||Error::from_reason("invalid charge input"))?;
            let mut added=v.energy_added.ok_or_else(||Error::from_reason("invalid charge input"))?;
            if !matches!(phase.as_str(),"waiting"|"charging") || !added.is_finite() || added<0.0 || v.battery>80.0 {return Err(Error::from_reason("invalid charge input"));}
            let mut battery=v.battery;
            if phase=="waiting" && !v.charger_busy {phase="charging".into();}
            let mut effect="pending";
            if phase=="charging" {let amount=2.0_f64.min(80.0-battery);battery+=amount;added+=amount;if battery>=80.0-1e-9 {battery=80.0;effect="completed";}}
            serde_json::json!({"agentId":v.agent_id,"requestId":v.request_id,"type":"charge","battery":battery,"phase":phase,"energyAdded":added,"effect":effect})
        },
        _=>return Err(Error::from_reason("invalid stationary action input"))
    };
    serde_json::to_string(&output).map_err(|_|Error::from_reason("invalid stationary action result"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct MessageHop {
    id:u64, source:String, hop:u64, via_length:u64, due_tick:u64, expires_tick:u64,
    tx_remaining:Option<u64>, size:u64, rate:Option<u64>, relay_rate:Option<u64>,
    unavailable:bool, interrupted:bool, out_of_range:bool, obstructed:bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct MessageBatch { tick:u64, seed:u32, delay:u64, loss_rate:f64, packets:Vec<MessageHop> }

fn message_roll(seed:u32,id:u32)->f64 {
    let mut x=seed ^ id.wrapping_mul(0x9e3779b9);
    x=(x ^ (x>>16)).wrapping_mul(0x7feb352d);
    x=(x ^ (x>>15)).wrapping_mul(0x846ca68b);
    ((x ^ (x>>16)) as f64)/4294967296.0
}

// Process the entire peer queue together so packets share per-sender bandwidth.
#[napi]
pub fn message_queue_tick(input:String)->Result<String> {
    use std::collections::HashMap;
    let batch:MessageBatch=parse(&input)?;
    if batch.delay==0 || !batch.loss_rate.is_finite() || !(0.0..=1.0).contains(&batch.loss_rate) || batch.packets.len()>256 {
        return Err(Error::from_reason("invalid message batch"));
    }
    let mut budget:HashMap<String,u64>=HashMap::new();let mut results=Vec::new();
    for p in batch.packets {
        if p.hop>p.via_length || p.via_length>3 || p.rate==Some(0) || p.relay_rate==Some(0) || p.size==0 {
            return Err(Error::from_reason("invalid message hop"));
        }
        let mut hop=p.hop;let mut due=p.due_tick;let mut remaining=p.tx_remaining;let mut transmitted=false;let mut blocked=false;let mut state="waiting";let mut reason=None;
        if batch.tick>p.expires_tick {state="failed";reason=Some("expired");}
        else {
            if let (Some(rate),Some(left))=(p.rate,remaining) {
                let available=*budget.entry(p.source.clone()).or_insert(rate);let amount=available.min(left);let after=left-amount;budget.insert(p.source.clone(),available-amount);
                if after>0 {remaining=Some(after);due=batch.tick+batch.delay+(after+rate-1)/rate-1;blocked=true;}
                else {remaining=None;due=batch.tick+batch.delay-1;transmitted=true;}
            }
            if !blocked && batch.tick>=due {
                reason=if p.unavailable {Some("unavailable")} else if p.interrupted {Some("interrupted")} else if p.out_of_range {Some("out_of_range")} else if p.obstructed {Some("obstructed")} else if message_roll(batch.seed,(p.id.wrapping_add(hop.wrapping_mul(3_000_000))) as u32)<batch.loss_rate {Some("dropped")} else {None};
                if reason.is_some(){state="failed";}
                else if hop<p.via_length {hop+=1;due=batch.tick+batch.delay;if let Some(rate)=p.relay_rate {remaining=Some(p.size);due+=(p.size+rate-1)/rate-1;state="relayed";} }
                else {state="delivered";}
            }
        }
        results.push(serde_json::json!({"id":p.id,"hop":hop,"dueTick":due,"txRemaining":remaining,"transmitted":transmitted,"state":state,"reason":reason}));
    }
    serde_json::to_string(&results).map_err(|_|Error::from_reason("invalid message batch result"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct CentralPacket { id:u64, due_tick:u64, expires_tick:u64, unavailable:bool, interrupted:bool }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct CentralBatch { tick:u64, seed:u32, loss_rate:f64, offset:u64, packets:Vec<CentralPacket> }

// Abstract central links share timing and loss rules but not peer-link range or bandwidth.
#[napi]
pub fn central_link_tick(input:String)->Result<String> {
    let batch:CentralBatch=parse(&input)?;
    if !batch.loss_rate.is_finite() || !(0.0..=1.0).contains(&batch.loss_rate) ||
       !matches!(batch.offset,1_000_000|2_000_000|4_000_000|5_000_000|6_000_000) || batch.packets.len()>1000 {
        return Err(Error::from_reason("invalid central link batch"));
    }
    let mut results=Vec::with_capacity(batch.packets.len());
    for p in batch.packets {
        let state=if batch.tick>p.expires_tick {"expired"} else if batch.tick<p.due_tick {"waiting"}
            else if p.unavailable {"unavailable"} else if p.interrupted {"interrupted"}
            else if message_roll(batch.seed,p.id.wrapping_add(batch.offset) as u32)<batch.loss_rate {"dropped"}
            else {"delivered"};
        results.push(serde_json::json!({"id":p.id,"state":state}));
    }
    serde_json::to_string(&results).map_err(|_|Error::from_reason("invalid central link result"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct TerminationTask { status:String, ready:bool, has_candidate:bool }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct TerminationInput { tasks:Vec<TerminationTask>, action_statuses:Vec<String>,
    has_recoverable_agent:bool, has_roadblock:bool }

// Classify the end-of-tick world. The host supplies navigation-dependent eligibility
// and applies events, resource cleanup, and any recovery bookkeeping.
#[napi]
pub fn world_termination(input:String)->Result<String> {
    let v:TerminationInput=parse(&input)?;
    if v.tasks.is_empty() || v.tasks.len()>100 || v.action_statuses.len()>10000 ||
        v.tasks.iter().any(|t|!matches!(t.status.as_str(),"pending"|"active"|"done") ||
            (t.ready && t.status!="pending") || (t.has_candidate && !t.ready)) {
        return Err(Error::from_reason("invalid termination input"));
    }
    let result=if v.tasks.iter().all(|t|t.status=="done") {"completed"}
    else if v.tasks.iter().any(|t|t.status=="active") || v.action_statuses.iter().any(|s|s=="pending"||s=="accepted") ||
        v.tasks.iter().any(|t|t.ready&&t.has_candidate) {"continue"}
    else if v.has_recoverable_agent {"wait_charge"}
    else if v.has_roadblock {"wait_roadblock"}
    else {"failed"};
    Ok(result.to_string())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct TimedTask { deadline:Option<u64>, status:String }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct TimedTransitionsInput { tick:u64, roadblocks:Vec<u64>, terrain:Vec<u64>, outages:Vec<u64>, tasks:Vec<TimedTask> }

// Return ordered input indices. Effects remain active through untilTick;
// deadlines are recorded only on the step immediately following the deadline.
#[napi]
pub fn timed_transitions(input:String)->Result<String> {
    let v:TimedTransitionsInput=parse(&input)?;
    if v.roadblocks.len()>8 || v.terrain.len()>100 || v.outages.len()>1000 || v.tasks.len()>100 || v.tick>9_007_199_254_740_991 {
        return Err(Error::from_reason("invalid timed transitions input"));
    }
    let expired=|items:&Vec<u64>|->Vec<usize>{items.iter().enumerate().filter_map(|(i,until)|if v.tick>*until{Some(i)}else{None}).collect()};
    let deadlines:Vec<usize>=v.tasks.iter().enumerate().filter_map(|(i,t)|
        if t.status!="done" && t.deadline.and_then(|d|d.checked_add(1))==Some(v.tick){Some(i)}else{None}).collect();
    serde_json::to_string(&serde_json::json!({"roadblocks":expired(&v.roadblocks),"terrain":expired(&v.terrain),"outages":expired(&v.outages),"deadlines":deadlines}))
        .map_err(|_|Error::from_reason("invalid timed transitions result"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct MotionTerrain { x:f64, y:f64, w:f64, h:f64, speed_factor:f64, energy_factor:f64 }
#[derive(Clone, Deserialize)]
struct TerrainSegmentInput { x:f64, y:f64, ux:f64, uy:f64, distance:f64, zones:Vec<MotionTerrain>, #[serde(default,rename="minimumStep")] minimum_step:f64 }

// Split a ground movement at the nearest terrain edge and select the most
// restrictive speed and energy factors among the zones occupied just ahead.
#[napi]
pub fn terrain_segment(input:String)->Result<String> {
    let v:TerrainSegmentInput=parse(&input)?;
    if ![v.x,v.y,v.ux,v.uy,v.distance,v.minimum_step].iter().all(|n|n.is_finite()) || !(0.0..=2e-5).contains(&v.minimum_step) || v.distance<0.0 || v.zones.len()>32 ||
        v.zones.iter().any(|z|![z.x,z.y,z.w,z.h,z.speed_factor,z.energy_factor].iter().all(|n|n.is_finite()) || z.w<=0.0 || z.h<=0.0 || z.speed_factor<=0.0 || z.energy_factor<=0.0) {
        return Err(Error::from_reason("invalid terrain segment input"));
    }
    let zones:Vec<_>=v.zones.iter().map(|z|crate::world_route::Terrain{id:String::new(),rect:[z.x,z.y,z.w,z.h],speed:z.speed_factor,energy:z.energy_factor,started:None}).collect();
    let segment=crate::world_route::segment([v.x,v.y],[v.ux,v.uy],v.distance,&zones,v.minimum_step);
    let mut output=serde_json::json!({"speed":segment.speed,"energy":segment.energy,"boundary":segment.boundary,"inside":segment.inside});if segment.micro{output["micro"]=true.into()}
    serde_json::to_string(&output).map_err(|_|Error::from_reason("invalid terrain segment result"))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct MotionBudget { distance:f64, boundary:f64, remaining:f64, speed_factor:f64,
    battery:f64, energy_rate:f64, energy_factor:f64, ux:f64, uy:f64 }

// Limit a proposed route segment by distance, remaining time and available energy.
#[napi]
pub fn motion_budget(distance:f64,boundary:f64,remaining:f64,speed_factor:f64,battery:f64,energy_rate:f64,energy_factor:f64,ux:f64,uy:f64)->Result<Vec<f64>> {
    let v=MotionBudget{distance,boundary,remaining,speed_factor,battery,energy_rate,energy_factor,ux,uy};
    if ![v.distance,v.boundary,v.remaining,v.speed_factor,v.battery,v.energy_rate,v.energy_factor,v.ux,v.uy].iter().all(|n|n.is_finite()) ||
        v.distance<=0.0 || v.boundary<=0.0 || v.remaining<0.0 || v.speed_factor<=0.0 || v.battery<0.0 || v.energy_rate<=0.0 || v.energy_factor<=0.0 {
        return Err(Error::from_reason("invalid motion budget"));
    }
    let desired=v.distance.min(v.boundary).min(v.remaining*v.speed_factor).min(v.battery/(v.energy_rate*v.energy_factor));
    Ok(vec![desired,v.ux*desired,v.uy*desired])
}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct MotionAccounting { battery:f64, actual_distance:f64, energy_rate:f64, energy_factor:f64,
    remaining:f64, desired_distance:f64, speed_factor:f64 }

// The host supplies the actual bounded/Rapier displacement, not the requested one.
#[napi]
pub fn motion_accounting(battery:f64,actual_distance:f64,energy_rate:f64,energy_factor:f64,remaining:f64,desired_distance:f64,speed_factor:f64)->Result<Vec<f64>> {
    let v=MotionAccounting{battery,actual_distance,energy_rate,energy_factor,remaining,desired_distance,speed_factor};
    if ![v.battery,v.actual_distance,v.energy_rate,v.energy_factor,v.remaining,v.desired_distance,v.speed_factor].iter().all(|n|n.is_finite()) ||
        v.battery<0.0 || v.actual_distance<0.0 || v.energy_rate<=0.0 || v.energy_factor<=0.0 || v.remaining<0.0 || v.desired_distance<0.0 || v.speed_factor<=0.0 {
        return Err(Error::from_reason("invalid motion accounting"));
    }
    let battery=(v.battery-v.actual_distance*v.energy_rate*v.energy_factor).max(0.0);
    let remaining=v.remaining-v.desired_distance/v.speed_factor;
    Ok(vec![battery,remaining])
}

#[derive(Clone, Deserialize)]
struct RiskRect { x:f64, y:f64, w:f64, h:f64 }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct MovementGuard { #[serde(default="default_world_size")] world_size:f64, x:f64, y:f64, dx:f64, dy:f64, risk_zones:Vec<RiskRect> }

// Clip the actual physics displacement to the world and find risk rectangles
// intersected by the clipped segment, in scene order.
#[napi]
pub fn guard_movement(input:String)->Result<String> {
    let v:MovementGuard=parse(&input)?;
    if !valid_world_size(v.world_size)||![v.x,v.y,v.dx,v.dy].iter().all(|n|n.is_finite()) || v.risk_zones.len()>32 ||
        v.risk_zones.iter().any(|z|![z.x,z.y,z.w,z.h].iter().all(|n|n.is_finite()) || z.w<=0.0 || z.h<=0.0) {
        return Err(Error::from_reason("invalid movement guard input"));
    }
    let (ex,ey)=(v.x+v.dx,v.y+v.dy);
    let outside=ex<0.0||ex>v.world_size||ey<0.0||ey>v.world_size;
    let crossing=ex< -1e-7||ex>v.world_size+1e-7||ey< -1e-7||ey>v.world_size+1e-7;
    let (x,y,dx,dy)=if outside {
        let mut f=1.0_f64;
        for (start,delta) in [(v.x,v.dx),(v.y,v.dy)] {if delta>0.0 {f=f.min((v.world_size-start)/delta)}else if delta<0.0 {f=f.min((0.0-start)/delta)}}
        f=f.max(0.0).min(1.0);
        let x=(v.x+v.dx*f).max(0.0).min(v.world_size);let y=(v.y+v.dy*f).max(0.0).min(v.world_size);
        (x,y,x-v.x,y-v.y)
    }else{(ex,ey,v.dx,v.dy)};
    let mut risks=Vec::<usize>::new();
    if dx!=0.0||dy!=0.0 {for (i,z) in v.risk_zones.iter().enumerate(){
        if v.x>=z.x&&v.x<=z.x+z.w&&v.y>=z.y&&v.y<=z.y+z.h {continue}
        let (mut lo,mut hi)=(0.0_f64,1.0_f64);
        for (p,d,min,max) in [(v.x,dx,z.x,z.x+z.w),(v.y,dy,z.y,z.y+z.h)] {
            if d==0.0 {if p<min||p>max {lo=1.0;hi=0.0;break}}
            else {let a=(min-p)/d;let b=(max-p)/d;lo=lo.max(a.min(b));hi=hi.min(a.max(b));if lo>hi {break}}
        }
        if lo<=hi {risks.push(i)}
    }}
    serde_json::to_string(&serde_json::json!({"outside":outside,"crossing":crossing,"x":x,"y":y,"dx":dx,"dy":dy,"risks":risks}))
        .map_err(|_|Error::from_reason("invalid movement guard result"))
}

crate::world_checkpoint::world_checkpoint!(PhysicsWorld);
