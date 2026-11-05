//! The complete per-device route phase. Typed native state is committed once.
use napi::{Error,Result};
use serde::Deserialize;
use serde_json::{Value,json};
use crate::{world_motion::Motion,world_execution::Execution,PhysicsWorld};

fn invalid()->Error{Error::from_reason("invalid native route phase")}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Context{
 pub tick:u64,delivery:bool,loaded:bool,boundary:bool,footprint:bool,risks:bool,
 exposures:Vec<(String,u64)>,
}
impl Context{
 pub fn parse(s:&str)->Result<Self>{
  if s.len()>2*1024*1024{return Err(invalid())}
  let c:Self=serde_json::from_str(s).map_err(|_|invalid())?;
  if c.tick>10_000_000||c.exposures.len()>32||c.exposures.iter().any(|(id,t)|id.len()>64||*t>c.tick){return Err(invalid())}Ok(c)
 }
}
pub(crate) struct Terrain{pub id:String,pub rect:[f64;4],pub speed:f64,pub energy:f64,pub started:Option<u64>}
pub(crate) struct Map{pub identity:u64,pub surface_domain:Option<crate::surface_domain::Profile>,pub heightfield:Option<crate::heightfield::Heightfield>,pub terrain:Vec<Terrain>,pub risks:Vec<(String,[f64;4])>}
// V8's bounded two-argument hypot; identical rounding matters at route corners.
fn distance(x:f64,y:f64)->f64{let scale=x.abs().max(y.abs());if scale==0.0{0.0}else{let a=x.abs()/scale;let b=y.abs()/scale;(a*a+b*b).sqrt()*scale}}
fn contains(p:[f64;2],r:[f64;4])->bool{p[0]>=r[0]&&p[0]<=r[0]+r[2]&&p[1]>=r[1]&&p[1]<=r[1]+r[3]}
fn intersects(p:[f64;2],d:[f64;2],r:[f64;4])->bool{
 let(mut lo,mut hi)=(0.0_f64,1.0_f64);
 for (p,d,min,max) in [(p[0],d[0],r[0],r[0]+r[2]),(p[1],d[1],r[1],r[1]+r[3])]{
  if d==0.0{if p<min||p>max{return false}}
  else{let a=(min-p)/d;let b=(max-p)/d;lo=lo.max(a.min(b));hi=hi.min(a.max(b));if lo>hi{return false}}
 }lo<=hi
}
fn footprint(from:[f64;2],to:[f64;2])->bool{
 let safe=|p:[f64;2]|p[0]>=0.8&&p[0]<=99.2&&p[1]>=0.8&&p[1]<=99.2;
 if safe(to){return false}if safe(from){return true}
 let(mut lo,mut hi)=(0.0_f64,1.0_f64);
 for(start,delta)in [(from[0],to[0]-from[0]),(from[1],to[1]-from[1])]{
  if delta.abs()<1e-12{if start<=0.8||start>=99.2{return false}}
  else{let a=(0.8-start)/delta;let b=(99.2-start)/delta;lo=lo.max(a.min(b));hi=hi.min(a.max(b));if lo>=hi{return false}}
 }
 let t=(lo+hi)/2.0;let x=from[0]+t*(to[0]-from[0]);let y=from[1]+t*(to[1]-from[1]);
 lo<hi&&hi<1.0&&x>0.8&&x<99.2&&y>0.8&&y<99.2
}
pub(crate) struct Segment{pub speed:f64,pub energy:f64,pub boundary:f64,pub inside:Vec<usize>,pub micro:bool}
pub(crate) fn segment(p:[f64;2],u:[f64;2],d:f64,zones:&[Terrain],minimum:f64)->Segment{
 let(mut speed,mut energy,mut boundary)=(1.0_f64,1.0_f64,d);let mut inside=Vec::new();let px=p[0]+u[0]*1e-7;let py=p[1]+u[1]*1e-7;
 for(i,z)in zones.iter().enumerate(){let[x,y,w,h]=z.rect;
  if contains([px,py],z.rect){speed=speed.min(z.speed);energy=energy.max(z.energy);inside.push(i)}
  if u[0].abs()>1e-12{for edge in [x,x+w]{let t=(edge-p[0])/u[0];let y2=p[1]+t*u[1];if t>1e-7&&t<boundary&&y2>=y-1e-8&&y2<=y+h+1e-8{boundary=t}}}
  if u[1].abs()>1e-12{for edge in [y,y+h]{let t=(edge-p[1])/u[1];let x2=p[0]+t*u[0];if t>1e-7&&t<boundary&&x2>=x-1e-8&&x2<=x+w+1e-8{boundary=t}}}
 }
 // Resolve only a sub-resolution terrain edge, never a wall, waypoint, or
 // free displacement. Bill the most restrictive touched zone for this <=20um
 // transition; the ordinary loop then consumes the rest of the tick budget.
 let micro=minimum>0.0&&boundary<d&&boundary<minimum;
 if micro{boundary=d.min(minimum);let delta=[u[0]*boundary,u[1]*boundary];inside.clear();speed=1.0;energy=1.0;for(i,z)in zones.iter().enumerate(){if intersects(p,delta,z.rect){inside.push(i);speed=speed.min(z.speed);energy=energy.max(z.energy)}}}
 Segment{speed,energy,boundary,inside,micro}
}
fn field_segment(p:[f64;2],u:[f64;2],d:f64,map:&Map,minimum:f64)->Segment{
 let mut s=segment(p,u,d,&map.terrain,minimum);let Some(h)=&map.heightfield else{return s};
 let mut boundary=d;for t in h.cuts(p,[p[0]+u[0]*d,p[1]+u[1]*d]){let length=t*d;if length>1e-7&&length<boundary{boundary=length}}
 let g=h.factor(p[0]+u[0]*1e-7,p[1]+u[1]*1e-7);let(mut speed,mut energy)=(g.speed,g.energy);let micro=minimum>0.0&&boundary<d&&boundary<minimum;
 if micro{boundary=d.min(minimum);let target=[p[0]+u[0]*boundary,p[1]+u[1]*boundary];let ts=h.cuts(p,target);for pair in ts.windows(2){let t=(pair[0]+pair[1])/2.0;let g=h.factor(p[0]+(target[0]-p[0])*t,p[1]+(target[1]-p[1])*t);speed=speed.min(g.speed);energy=energy.max(g.energy)}}
 s.speed=s.speed.min(speed);s.energy=s.energy.max(energy);s.boundary=s.boundary.min(boundary);s.micro=s.micro||micro;s
}
pub(crate) fn advance(a:&mut Motion,e:&mut Execution,map:&Map,c:&Context,mut physics:Option<&mut PhysicsWorld>)->Result<Vec<Value>>{
 if a.id!=e.id||e.disabled||c.exposures.iter().any(|(id,t)|!map.terrain.iter().any(|z|&z.id==id&&z.started==Some(*t))){return Err(invalid())}
 let air=e.mobility.as_deref().unwrap_or(if e.role=="drone"{"air"}else{"ground"})=="air";
 if e.mobility.as_deref()==Some("water")&&map.surface_domain.is_none(){return Err(invalid())}
 if let Some(p)=physics.as_ref(){if p.surface_domain!=map.surface_domain||p.water.contains(&a.id)!=(e.mobility.as_deref()==Some("water")){return Err(invalid())}}
 let initial=e.route.first().copied();let mut remaining=if e.thermal_protected(){0.0}else{e.speed};let mut contact=false;let mut moved=0.0;let mut events=Vec::new();
 let mut exposures=c.exposures.clone();
 while remaining>1e-9&&!e.route.is_empty(){
  let target=e.route[0];let dx=target[0]-a.x;let dy=target[1]-a.y;let d=distance(dx,dy);
  if d<1e-6{e.route.remove(0);continue}
  let ux=dx/d;let uy=dy/d;let step=if air{Segment{speed:1.0,energy:1.0,boundary:d,inside:Vec::new(),micro:false}}else{field_segment([a.x,a.y],[ux,uy],d,map,if physics.is_some(){2e-5}else{0.0})};
  let(speed,energy,boundary)=(step.speed,step.energy,step.boundary);
  let rate=e.move_energy_per_unit.unwrap_or(0.045);let minimum=if physics.is_some(){2e-5}else{1e-6};let heat_limit=e.thermal_move_limit(rate*energy,minimum)?;
  if heat_limit<=minimum{e.thermal_protect("heat_budget")?;break}
  let desired=d.min(boundary).min(remaining*speed).min(a.battery/(rate*energy)).min(heat_limit);
  let raw=if let Some(p)=physics.as_mut(){p.move_agent(a.id.clone(),a.x,a.y,ux*desired,uy*desired)?}else if map.surface_domain.as_ref().is_some_and(|p|!p.clear(if air{"air"}else if e.mobility.as_deref()==Some("water"){"water"}else{"ground"},[a.x,a.y],[a.x+ux*desired,a.y+uy*desired],0.8).unwrap_or(false)){vec![0.0,0.0,1.0]}else{vec![ux*desired,uy*desired,0.0]};
  let(mut mx,mut my)=(raw[0],raw[1]);let ex=a.x+mx;let ey=a.y+my;let outside=ex<0.0||ex>100.0||ey<0.0||ey>100.0;
  let crossing=ex< -1e-7||ex>100.0+1e-7||ey< -1e-7||ey>100.0+1e-7;
  if outside{
   let mut fraction=1.0_f64;for(start,delta)in [(a.x,mx),(a.y,my)]{if delta>0.0{fraction=fraction.min((100.0-start)/delta)}else if delta<0.0{fraction=fraction.min((0.0-start)/delta)}}fraction=fraction.max(0.0).min(1.0);
   let x=(a.x+mx*fraction).max(0.0).min(100.0);let y=(a.y+my*fraction).max(0.0).min(100.0);
   if let Some(p)=physics.as_mut(){p.correct_position(a.id.clone(),x,y)?}
   if c.boundary&&crossing&&(!e.boundary_active.unwrap_or(false)||(e.boundary_last_tick.unwrap_or(0) as i64)<(c.tick as i64)-1){events.push(json!({"kind":"boundary_exit_prevented","attempted":{"x":ex,"y":ey},"position":{"x":x,"y":y}}))}
   e.boundary_active=Some(crossing);if crossing{e.boundary_last_tick=Some(c.tick as u32)}mx=x-a.x;my=y-a.y;
  }else{e.boundary_active=Some(false)}
  let actual=distance(mx,my);let from=[a.x,a.y];let to=[(a.x+mx).max(0.0).min(100.0),(a.y+my).max(0.0).min(100.0)];
  if c.risks&&(mx!=0.0||my!=0.0){for(id,rect)in &map.risks{if !contains(from,*rect)&&intersects(from,[mx,my],*rect){events.push(json!({"kind":"risk_zone_entered","zoneId":id}))}}}
  if c.footprint&&(mx!=0.0||my!=0.0)&&footprint(from,to){events.push(json!({"kind":"footprint_boundary_exit","from":{"x":from[0],"y":from[1]},"to":{"x":to[0],"y":to[1]},"radius":0.8}))}
  e.thermal_spend(a.battery.min(actual*rate*energy))?;a.x=to[0];a.y=to[1];a.distance+=actual;a.battery=(a.battery-actual*rate*energy).max(0.0);
  let inside=if step.micro{map.terrain.iter().enumerate().filter(|(_,z)|intersects(from,[mx,my],z.rect)).map(|(i,_)|i).collect()}else{step.inside};
  if !inside.is_empty()||(!air&&map.heightfield.as_ref().is_some_and(|h|h.factor((from[0]+to[0])/2.0,(from[1]+to[1])/2.0).energy>1.0)){e.terrain_distance=Some(e.terrain_distance.unwrap_or(0.0)+actual)}
  let effects=inside.iter().filter_map(|i|map.terrain[*i].started.map(|t|(&map.terrain[*i].id,t))).collect::<Vec<_>>();
  if actual>1e-9&&!effects.is_empty(){e.terrain_effect_distance=Some(e.terrain_effect_distance.unwrap_or(0.0)+actual);for(id,t)in effects{if !exposures.iter().any(|(key,start)|key==id&&*start==t){events.push(json!({"kind":"terrain_effect_exposure","zoneId":id,"startedTick":t}));exposures.push((id.clone(),t))}}}
  moved+=actual;remaining-=desired/speed;contact=contact||raw[2]>0.0;
  if distance(target[0]-a.x,target[1]-a.y)<1e-5{e.route.remove(0);}
  // Residual energy below one meaningful movement unit can otherwise leave a
  // collider stationary forever without a contact or depletion. Rapier's
  // controller ignores translations <=1e-5, so its reserve uses twice that.
  if a.battery<=1e-9_f64.max(rate*energy*if physics.is_some(){2e-5}else{1e-6}){a.battery=0.0;break}if actual<1e-6{break}
 }
 if c.delivery&&moved>0.0{if let Some(d)=e.delivery_travel.as_mut(){if c.loaded{d.loaded_distance+=moved;d.loaded_ticks+=1}else{d.empty_distance+=moved;d.empty_ticks+=1}}}
 if contact&&!e.collision_active.unwrap_or(false){events.push(json!({"kind":"collision_contact"}))}e.collision_active=Some(contact);
 let current=e.route.first().copied();let key=current.map_or_else(String::new,|p|format!("{},{}",ryu_js::Buffer::new().format_finite(p[0]),ryu_js::Buffer::new().format_finite(p[1])));
 if !contact||current.is_none()||current!=initial||e.progress_waypoint.as_deref()!=Some(&key){
  e.blocked_ticks=Some(0);e.progress_waypoint=Some(key);e.best_waypoint_distance=Some(current.map_or(0.0,|p|distance(p[0]-a.x,p[1]-a.y)));
 }else{let p=current.unwrap();let d=distance(p[0]-a.x,p[1]-a.y);if d<e.best_waypoint_distance.unwrap_or(f64::INFINITY)-0.05{e.best_waypoint_distance=Some(d);e.blocked_ticks=Some(0)}else{e.blocked_ticks=Some(e.blocked_ticks.unwrap_or(0)+1)}}
 Ok(events)
}
