//! Deterministic world creation from configuration and a seed, never a host frame.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize,Deserializer,Serialize};
use serde_json::{json,Value,Map};
use std::collections::HashSet;
use crate::{PhysicsWorld,ordered_map::OrderedMap,world_perceptions::WorldPerceptions,world_reports::WorldReports,world_tasks::WorldTasks,world_motion::WorldMotion,world_environment::WorldEnvironment,world_control::WorldControl};
fn invalid()->Error{Error::from_reason("invalid world initialization input")}
fn encode<T:Serialize>(v:&T)->Result<String>{serde_json::to_string(v).map_err(|_|invalid())}
fn value(s:String)->Result<Value>{serde_json::from_str(&s).map_err(|_|invalid())}
fn present<'de,D,T>(d:D)->std::result::Result<Option<T>,D::Error>where D:Deserializer<'de>,T:Deserialize<'de>{T::deserialize(d).map(Some)}
fn token(s:&str,n:usize)->bool{!s.is_empty()&&s.len()<=n&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
fn name(s:&str)->bool{!s.is_empty()&&s.encode_utf16().count()<=100}
fn range(n:f64,min:f64,max:f64)->bool{n.is_finite()&&(min..=max).contains(&n)}
fn positive(n:f64,max:f64)->bool{range(n,0.0,max)&&n>0.0}
fn point(p:[f64;2],size:f64)->bool{p.iter().all(|n|range(*n,0.0,size))}
fn rect(x:f64,y:f64,w:f64,h:f64,size:f64)->bool{point([x,y],size)&&positive(w,size)&&positive(h,size)&&x+w<=size&&y+h<=size}
fn unique<'a>(mut v:impl Iterator<Item=&'a str>)->bool{let mut seen=HashSet::new();v.all(|s|seen.insert(s))}
fn five()->u32{5} fn twenty()->u32{20}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Communication{range:f64,delay:u32,loss_rate:f64,ttl:u32,max_per_tick:u32,max_bytes:u32,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]line_of_sight:Option<bool>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]bytes_per_tick:Option<u32>,
 #[serde(default="five")]status_interval:u32,#[serde(default="twenty")]status_max_age:u32,#[serde(default="five")]decision_max_age:u32}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct Resource{warehouse:[f64;2],site:[f64;2]}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct Obstacle{id:String,x:f64,y:f64,w:f64,h:f64,height:f64}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Agent{
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]spawn_area:Option<crate::surface_domain::SpawnArea>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) rescue:Option<crate::rescue::Profile>,
    #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub(crate) recoverable_fault:Option<bool>,
#[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]deployable_relay:Option<bool>,#[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]thermal:Option<crate::thermal::Profile>,role:String,label:String,count:u32,capabilities:Vec<String>,speed:f64,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]mobility:Option<String>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]sensor_range:Option<f64>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]communication_range:Option<f64>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]communication_bytes_per_tick:Option<u32>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]move_energy_per_unit:Option<f64>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]operating_energy_per_tick:Option<f64>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]work_energy_per_tick:Option<f64>}
impl Agent{fn air(&self)->bool{self.mobility.as_deref().map_or(self.role=="drone",|s|s=="air")}}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Task{#[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]build_site:Option<String>,#[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")] material_cost:Option<Vec<crate::materials::Item>>,id:String,behavior:String,name:String,role:String,capability:String,target:[f64;2],duration:u32,depends_on:Vec<String>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]priority:Option<u32>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]deadline:Option<u32>}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct Zone{id:String,name:String,x:f64,y:f64,w:f64,h:f64}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Terrain{id:String,name:String,x:f64,y:f64,w:f64,h:f64,speed_factor:f64,energy_factor:f64}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct Fixed{id:String,name:String,x:f64,y:f64,height:f64,range:f64,interval:u32}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Echelon{id:String,name:String,task_ids:Vec<String>}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Scene{
 #[serde(default,deserialize_with="present")]world_size:Option<f64>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]echelons:Option<Vec<Echelon>>,
 #[serde(default,deserialize_with="crate::surface_domain::present",skip_serializing_if="Option::is_none")]surface_domain:Option<crate::surface_domain::Profile>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]construction_sites:Option<Vec<crate::construction::Profile>>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]heightfield:Option<crate::heightfield::Heightfield>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]materials:Option<Vec<crate::materials::Profile>>,
 id:String,name:String,sensor_range:f64,communication:Communication,resource:Resource,obstacles:Vec<Obstacle>,agents:Vec<Agent>,tasks:Vec<Task>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]navigation:Option<String>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]risk_navigation:Option<String>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]risk_zones:Option<Vec<Zone>>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]terrain:Option<Vec<Terrain>>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]fixed_sensors:Option<Vec<Fixed>>}
fn default_dispatch()->String{"rule".into()} fn default_physics()->String{"kinematic".into()} fn default_execution()->String{"auto".into()} fn default_policy()->String{"nearest".into()} fn default_seed()->u32{42}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Options{#[serde(default="default_dispatch")]dispatch_mode:String,#[serde(default="default_physics")]physics_mode:String,#[serde(default="default_execution")]execution_mode:String}
impl Default for Options{fn default()->Self{Self{dispatch_mode:default_dispatch(),physics_mode:default_physics(),execution_mode:default_execution()}}}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input{scene:Scene,#[serde(default="default_seed")]seed:u32,#[serde(default="default_policy")]policy:String,#[serde(default)]options:Options}
impl Scene{
 fn echelons_valid(&self)->bool{
  let Some(groups)=&self.echelons else{return true};if groups.is_empty()||groups.len()>8||!unique(groups.iter().map(|g|g.id.as_str())){return false}
  let tasks=self.tasks.iter().map(|t|t.id.as_str()).collect::<HashSet<_>>();let mut membership=std::collections::HashMap::new();
  for (index,g) in groups.iter().enumerate(){if !token(&g.id,64)||["__proto__","constructor","prototype"].contains(&g.id.as_str())||!name(&g.name)||g.task_ids.is_empty()||g.task_ids.len()>100{return false}for id in &g.task_ids{if !tasks.contains(id.as_str())||membership.insert(id.as_str(),index).is_some(){return false}}}
  membership.len()==self.tasks.len()&&self.tasks.iter().all(|t|membership.get(t.id.as_str()).is_some_and(|index|t.depends_on.iter().all(|p|membership.get(p.as_str()).is_some_and(|parent|parent<=index))))
 }
 fn construction_valid(&self)->bool{
  let Some(sites)=&self.construction_sites else{return self.tasks.iter().all(|t|t.behavior!="build"&&t.build_site.is_none())};if !crate::construction::profiles_valid(sites)||self.agents.iter().any(|a|!a.mobility.as_deref().map_or(a.role!="drone",|m|m=="ground")&&a.capabilities.iter().any(|c|c=="build")){return false}
  if self.tasks.iter().any(|t|if t.behavior=="build"{t.build_site.as_ref().is_none_or(|id|!sites.iter().any(|s|s.id==*id))}else{t.build_site.is_some()}){return false}
  sites.iter().all(|site|{let Some(o)=self.obstacles.iter().find(|o|o.id==site.obstacle_id)else{return false};let ts=self.tasks.iter().filter(|t|t.behavior=="build"&&t.build_site.as_deref()==Some(&site.id)).collect::<Vec<_>>();if ts.len()!=1{return false}let t=ts[0];let dx=(o.x-t.target[0]).max(0.0).max(t.target[0]-o.x-o.w);let dy=(o.y-t.target[1]).max(0.0).max(t.target[1]-o.y-o.h);let d=dx.hypot(dy);(1.1..=4.0).contains(&d)&&t.capability=="build"&&t.material_cost.as_ref().is_some_and(|v|!v.is_empty())&&self.agents.iter().any(|a|a.role==t.role&&a.mobility.as_deref().map_or(a.role!="drone",|m|m=="ground")&&a.capabilities.iter().any(|c|c=="build"))})
 }
 fn validate(&self)->Result<()>{
  let size=self.world_size.unwrap_or(100.0);
  if !crate::valid_world_size(size)||(size!=100.0&&(self.heightfield.is_some()||self.surface_domain.is_some())){return Err(invalid())}
  if !self.echelons_valid(){return Err(invalid())}
  if !self.construction_valid(){return Err(invalid())}
  if self.surface_domain.as_ref().is_some_and(|p|p.validate().is_err()||self.heightfield.is_some())||self.agents.iter().any(|a|a.spawn_area.as_ref().is_some_and(|v|!v.valid(size))||a.mobility.as_deref()==Some("water")&&self.surface_domain.is_none()){return Err(invalid())}
  if self.materials.as_ref().is_some_and(|m|!crate::materials::profile_valid(m))||self.tasks.iter().any(|t|t.material_cost.as_ref().is_some_and(|c|!crate::materials::cost_valid(c)||self.materials.as_ref().is_none_or(|m|c.iter().any(|i|!m.iter().any(|r|r.id==i.id))))){return Err(invalid())}
  if let Some(h)=&self.heightfield{h.validate()?}let c=&self.communication;
  if !token(&self.id,64)||!name(&self.name)||!positive(self.sensor_range,10000.0)||!point(self.resource.warehouse,size)||!point(self.resource.site,size)||!positive(c.range,10000.0)||!(1..=10000).contains(&c.delay)||!(1..=10000).contains(&c.ttl)||!range(c.loss_rate,0.0,1.0)||!(1..=100).contains(&c.max_per_tick)||!(1..=4096).contains(&c.max_bytes)||c.bytes_per_tick.is_some_and(|n|!(1..=4096).contains(&n))||[c.status_interval,c.status_max_age,c.decision_max_age].iter().any(|n|!(1..=10000).contains(n)){return Err(invalid())}
  if self.navigation.as_deref().is_some_and(|s|!["distance","time","energy"].contains(&s))||self.risk_navigation.as_deref().is_some_and(|s|!["monitor","avoid"].contains(&s))||self.obstacles.len()>64||!unique(self.obstacles.iter().map(|o|o.id.as_str()))||self.obstacles.iter().any(|o|!token(&o.id,64)||!rect(o.x,o.y,o.w,o.h,size)||!positive(o.height,1000.0)){return Err(invalid())}
  for a in &self.agents{if a.operating_energy_per_tick.is_some_and(|r|!crate::operating_power::valid_rate(r)){return Err(invalid())}if !crate::rescue::valid(a.rescue.as_ref(),a.recoverable_fault,a.mobility.as_deref().map_or(a.role!="drone",|m|m=="ground"),&a.capabilities){return Err(invalid())}if a.deployable_relay.is_some_and(|v|!v||!a.mobility.as_deref().map_or(a.role!="drone",|m|m=="ground")||!a.capabilities.iter().any(|c|c=="relay")){return Err(invalid())}if let Some(p)=&a.thermal{p.validate(a.work_energy_per_tick.unwrap_or(0.08))?}}
  if self.agents.is_empty()||self.agents.len()>100||!unique(self.agents.iter().map(|a|a.role.as_str()))||self.agents.iter().map(|a|a.count as u64).sum::<u64>()>50||self.agents.iter().any(|a|!token(&a.role,48)||!name(&a.label)||!(1..=100).contains(&a.count)||a.capabilities.is_empty()||a.capabilities.len()>32||a.capabilities.iter().any(|s|!token(s,64))||!positive(a.speed,100.0)||a.mobility.as_deref().is_some_and(|s|!["air","ground","water"].contains(&s))||[a.sensor_range,a.communication_range].iter().flatten().any(|n|!positive(*n,10000.0))||a.communication_bytes_per_tick.is_some_and(|n|!(1..=4096).contains(&n))||[a.move_energy_per_unit,a.work_energy_per_tick].iter().flatten().any(|n|!range(*n,0.001,5.0))){return Err(invalid())}
  if self.tasks.is_empty()||self.tasks.len()>100||self.tasks.iter().any(|t|!token(&t.id,64)||["__proto__","constructor","prototype"].contains(&t.id.as_str())||!name(&t.name)||!token(&t.role,48)||!token(&t.capability,64)||!["survey","detect","confirm","deliver","repair","verify","sample","deploy","build"].contains(&t.behavior.as_str())||(t.behavior=="sample"&&t.capability!="sample")||(t.behavior=="deploy"&&(t.capability!="relay"||!self.agents.iter().any(|a|a.role==t.role&&a.deployable_relay==Some(true))))||!point(t.target,size)||!(1..=10000).contains(&t.duration)||t.depends_on.len()>100||t.priority.is_some_and(|p|p>100)||t.deadline.is_some_and(|n|!(1..=10000000).contains(&n))){return Err(invalid())}
  if self.risk_zones.as_ref().is_some_and(|zs|zs.len()>32||!unique(zs.iter().map(|z|z.id.as_str()))||zs.iter().any(|z|!token(&z.id,64)||!name(&z.name)||!rect(z.x,z.y,z.w,z.h,size)))||self.terrain.as_ref().is_some_and(|zs|zs.len()>32||!unique(zs.iter().map(|z|z.id.as_str()))||zs.iter().any(|z|!token(&z.id,64)||!name(&z.name)||!rect(z.x,z.y,z.w,z.h,size)||!range(z.speed_factor,0.2,1.0)||!range(z.energy_factor,1.0,5.0)))||self.fixed_sensors.as_ref().is_some_and(|fs|fs.len()>32||!unique(fs.iter().map(|f|f.id.as_str()))||fs.iter().any(|f|!token(&f.id,64)||["__proto__","constructor","prototype"].contains(&f.id.as_str())||!name(&f.name)||!point([f.x,f.y],size)||!range(f.height,0.0,1000.0)||!positive(f.range,10000.0)||!(1..=10000).contains(&f.interval))){return Err(invalid())}Ok(())
 }
}
struct Random(u32);
impl Random{fn next(&mut self)->f64{self.0=self.0.wrapping_mul(1664525).wrapping_add(1013904223);self.0 as f64/4294967296.0}}
#[derive(Serialize)]
struct PerceptionInitial{#[serde(rename="worldSize")]world_size:f64,#[serde(skip_serializing_if="Option::is_none")]heightfield:Option<crate::heightfield::Heightfield>,tick:u32,ray:bool,agents:Vec<Value>,targets:Vec<Value>,obstacles:Vec<Value>,perceptions:OrderedMap<Value>}
#[derive(Serialize)]
struct Output{#[serde(flatten)]fields:Map<String,Value>,perceptions:OrderedMap<Value>}
fn create(input:&str,physics:Option<&PhysicsWorld>)->Result<String>{
 if input.len()>2*1024*1024{return Err(invalid())}let i:Input=serde_json::from_str(input).map_err(|_|invalid())?;i.scene.validate()?;let s=&i.scene;let size=s.world_size.unwrap_or(100.0);let o=&i.options;
 if !["nearest","battery"].contains(&i.policy.as_str())||!["rule","networked","external","networked_external","networked_reported"].contains(&o.dispatch_mode.as_str())||!["kinematic","rapier"].contains(&o.physics_mode.as_str())||!["auto","agent","primitive"].contains(&o.execution_mode.as_str())||physics.is_some()&&o.physics_mode!="rapier"{return Err(invalid())}
 let mut random=Random(i.seed);let mut agents:Vec<Value>=Vec::new();let mut layers:Vec<bool>=Vec::new();
 for spec in &s.agents{for index in 1..=spec.count{let mut at=None;for attempt in 1..=1001{let x=spec.spawn_area.as_ref().map_or_else(||12.0,|a|a.x)+ (random.next()*spec.spawn_area.as_ref().map_or(10.0,|a|(a.w/2.0).ceil())).floor()*2.0;let y=spec.spawn_area.as_ref().map_or_else(||20.0,|a|a.y)+(random.next()*spec.spawn_area.as_ref().map_or(30.0,|a|(a.h/2.0).ceil())).floor()*2.0;if attempt==1001{return Err(Error::from_reason("no free spawn position"))}
   let domain_free=s.surface_domain.as_ref().map(|p|p.clear(spec.mobility.as_deref().unwrap_or(if spec.air(){"air"}else{"ground"}),[x,y],[x,y],2.0)).transpose()?.unwrap_or(true);
   let free=domain_free&&(spec.air()||s.heightfield.as_ref().is_none_or(|h|h.traversable([x,y],[x,y],2.0)))&&range(x,2.0,size-2.0)&&range(y,2.0,size-2.0)&&!s.obstacles.iter().any(|b|x>=b.x-2.0&&x<=b.x+b.w+2.0&&y>=b.y-2.0&&y<=b.y+b.h+2.0)&&!agents.iter().zip(&layers).any(|(a,air)|*air==spec.air()&&(a["x"].as_f64().unwrap()-x).hypot(a["y"].as_f64().unwrap()-y)<2.0);if free{at=Some([x,y]);break}}
   let [x,y]=at.ok_or_else(invalid)?;let battery=85.0+(random.next()*15.0).floor();let mut a=json!({"id":format!("{}-{index}",spec.role),"name":format!("{} {index}",spec.label),"role":spec.role,"capabilities":spec.capabilities,"speed":spec.speed,"x":x,"y":y,"battery":battery,"initialBattery":battery,"status":"idle","disabled":false,"work":0,"distance":0,"deliveryTravel":{"emptyDistance":0,"loadedDistance":0,"emptyTicks":0,"loadedTicks":0},"route":[],"roadblockWaitTicks":0,"activity":{"task":0,"taskWaiting":0,"manual":0,"chargeWaiting":0,"idle":0,"unavailable":0}});
   let config=serde_json::to_value(spec).map_err(|_|invalid())?;for key in ["rescue","recoverableFault","deployableRelay","mobility","sensorRange","communicationRange","communicationBytesPerTick","moveEnergyPerUnit","workEnergyPerTick","operatingEnergyPerTick","thermal"]{if let Some(v)=config.get(key){a[key]=v.clone()}}if spec.operating_energy_per_tick.is_some(){a["operatingState"]=json!(crate::operating_power::State::initial())}if spec.recoverable_fault==Some(true){a["faultGeneration"]=0.into()}if spec.deployable_relay==Some(true){a["relayState"]=json!(crate::relay::State::initial())}if let Some(p)=&spec.thermal{a["thermalState"]=json!(p.initial())}agents.push(a);layers.push(spec.air());
 }}
 let tasks:Vec<Value>=s.tasks.iter().map(|t|{let mut t=serde_json::to_value(t).unwrap();t["status"]=json!("pending");t["assignee"]=Value::Null;t}).collect();let catalog:Vec<_>=agents.iter().map(|a|json!({"id":a["id"],"role":a["role"],"capabilities":a["capabilities"]})).collect();
 // Reuse the actual task-state validator for graph identity and cycles.
 WorldTasks::new(encode(&json!({"tick":0,"worldSize":size,"tasks":tasks,"agents":catalog}))?).map_err(|_|invalid())?;
 let inboxes:Map<String,Value>=agents.iter().map(|a|(a["id"].as_str().unwrap().into(),json!([]))).collect();
 let mut world=json!({"version":9,"peerMessageMetricsVersion":1,"boundaryMonitoringVersion":1,"footprintMonitoringVersion":1,"riskMonitoringVersion":2,"recoveryEventsVersion":1,"terrainRouteAssessmentsVersion":1,"sceneId":s.id,"seed":i.seed,"policy":i.policy,"physicsMode":o.physics_mode,"dispatchMode":o.dispatch_mode,"executionMode":o.execution_mode,"tick":0});
 if let Some(size)=s.world_size{world["worldSize"]=json!(size)}
 let components=json!({"riskZones":s.risk_zones.clone().unwrap_or_default(),"roadblocks":[],"collisionContacts":0,"sensorRange":s.sensor_range,"obstacles":s.obstacles,"chargingStation":s.resource.warehouse,"agents":agents,"tasks":tasks,"events":[],"faults":0,"replans":0,"done":false,"failed":false,"actions":[],"decisions":[]});for(k,v)in components.as_object().unwrap(){world[k]=v.clone()}
 if let Some(m)=&s.materials{world["materials"]=json!(crate::materials::initial(m))}if let Some(c)=&s.construction_sites{world["construction"]=json!(crate::construction::State::initial(c))}
 world["asset"]=json!({"condition":"fault","diagnosis":"unknown"});world["part"]=json!({"location":"warehouse","position":s.resource.warehouse,"carrierId":null,"reservedBy":null,"site":s.resource.site});world["communication"]=json!({"config":s.communication,"outages":[],"dispatchQueue":[],"dispatchAvoid":{},"nextDispatchId":1,"nextId":1,"queue":[],"inboxes":inboxes,"sentTick":-1,"sentBy":{}});
 if let Some(v)=&s.surface_domain{world["surfaceDomain"]=json!(v)}if let Some(v)=&s.heightfield{world["heightfield"]=json!(v)}if let Some(v)=&s.navigation{world["navigation"]=json!(v)}if let Some(v)=&s.risk_navigation{world["riskNavigation"]=json!(v)}if let Some(v)=&s.terrain{world["terrain"]=json!(v)}
 let mut report_state=json!({});if let Some(fs)=s.fixed_sensors.as_ref().filter(|fs|!fs.is_empty()){world["fixedSensors"]=json!(fs);world["fixedSensorState"]=json!({"nextId":1,"queue":[],"reports":{},"sent":0,"delivered":0,"failed":0});report_state["fixedSensors"]=world["fixedSensors"].clone();report_state["fixedSensorState"]=world["fixedSensorState"].clone()}
 if o.dispatch_mode=="networked_reported"{let c=&s.communication;let mut reports=WorldReports::new(encode(&json!({"tick":0,"seed":i.seed,"config":{"delay":c.delay,"ttl":c.ttl,"lossRate":c.loss_rate,"statusInterval":c.status_interval,"statusMaxAge":c.status_max_age},"site":s.resource.site,"agents":catalog,"state":report_state}))?)?;let sources:Vec<_>=agents.iter().map(|a|json!({"id":a["id"],"x":a["x"],"y":a["y"],"battery":a["battery"],"status":"idle","disabled":false,"activeAssignment":null,"routeBlockedSince":null})).collect();reports.schedule(encode(&sources)?,0.0)?;world["communication"]["reporting"]=value(reports.snapshot()?)?["reporting"].clone()}
 if let Some(p)=physics{
  let motion_fields=["id","x","y","battery","initialBattery","distance"];let rows:Vec<Value>=agents.iter().map(|a|Value::Object(a.as_object().unwrap().iter().filter(|(k,_)|motion_fields.contains(&k.as_str())).map(|(k,v)|(k.clone(),v.clone())).collect())).collect();let mut motion=WorldMotion::new(encode(&json!({"worldSize":size,"agents":rows}))?)?;let execution:Vec<Value>=agents.iter().map(|a|Value::Object(a.as_object().unwrap().iter().filter(|(k,_)|!["x","y","battery","initialBattery","distance"].contains(&k.as_str())).map(|(k,v)|(k.clone(),v.clone())).collect())).collect();motion.bind_execution(encode(&json!({"tick":0,"agents":execution}))?)?;
  let keys=["worldSize","surfaceDomain","obstacles","riskZones","terrain","heightfield","navigation","riskNavigation","chargingStation","sensorRange","roadblocks"];let state:Map<String,Value>=world.as_object().unwrap().iter().filter(|(k,_)|keys.contains(&k.as_str())).map(|(k,v)|(k.clone(),v.clone())).collect();let roster:Vec<_>=agents.iter().zip(&layers).map(|(a,air)|{let mut v=json!({"id":a["id"],"air":air});if a["mobility"]=="water"{v["water"]=json!(true)}v}).collect();let environment=WorldEnvironment::new(encode(&json!({"tick":0,"state":state,"agents":roster,"lastRoadblockEvent":0}))?)?;WorldControl::validate_initial_physics(p,&motion,&environment)?;world["sensorModel"]=json!("rapier-ray-v1");
 }
 let mut empty=OrderedMap::default();for a in &agents{empty.insert(a["id"].as_str().unwrap().into(),json!({"current":[],"memory":[]}));}
 let specs=agents.iter().zip(&layers).map(|(a,air)|json!({"id":a["id"],"role":a["role"],"height":if *air{16.0}else{1.5},"range":a.get("sensorRange").cloned().unwrap_or(json!(s.sensor_range))})).collect();let targets=s.tasks.iter().map(|t|json!({"id":t.id,"target":t.target})).collect();let obstacles=s.obstacles.iter().map(|b|json!({"x":b.x,"y":b.y,"w":b.w,"h":b.h,"height":b.height})).collect();let mut perceptions=WorldPerceptions::new(encode(&PerceptionInitial{world_size:size,heightfield:s.heightfield.clone(),tick:0,ray:physics.is_some(),agents:specs,targets,obstacles,perceptions:empty})?)?;
 let states:Vec<_>=agents.iter().map(|a|json!({"id":a["id"],"x":a["x"],"y":a["y"],"status":"idle","disabled":false})).collect();let frame=encode(&json!({"tick":0,"agents":states,"roadblocks":[]}))?;if let Some(p)=physics{perceptions.refresh_ray(frame,p)?}else{perceptions.refresh(frame)?}let state=value(perceptions.snapshot()?)?;let mut ordered=OrderedMap::default();for a in &agents{let id=a["id"].as_str().unwrap();ordered.insert(id.into(),state[id].clone());}
 encode(&Output{fields:world.as_object().unwrap().clone(),perceptions:ordered})
}
#[napi]
pub fn initialize_world(input:String)->Result<String>{create(&input,None)}
#[napi]
pub fn initialize_world_ray(input:String,physics:&PhysicsWorld)->Result<String>{create(&input,Some(physics))}
