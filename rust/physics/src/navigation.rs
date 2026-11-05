//! Bounded two-dimensional grid routing. Rapier owns collision response separately.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

const SIDE: usize = 51;
const GRID: f64 = 2.0;
const RADIUS: f64 = 2.0;
type Point = [f64; 2];

#[derive(Clone, Deserialize)]
struct Obstacle { x: f64, y: f64, w: f64, h: f64, padding: Option<f64> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct Zone { x: f64, y: f64, w: f64, h: f64, speed_factor: f64, energy_factor: f64 }
#[derive(Deserialize)]
#[serde(rename_all="lowercase")]
enum Metric { Distance, Time, Energy }
#[derive(Deserialize)]
struct Input { start: Point, target: Point, obstacles: Vec<Obstacle>, zones: Vec<Zone>, metric: Metric, #[serde(default)] heightfield:Option<crate::heightfield::Heightfield> }
fn prepare_input(mut v:Input)->Result<Input>{if let Some(h)=&v.heightfield{h.validate()?;for r in h.blocked_cells(){if !v.obstacles.iter().any(|o|o.x==r.x&&o.y==r.y&&o.w==r.w&&o.h==r.h&&o.padding.unwrap_or(RADIUS)==RADIUS){v.obstacles.push(Obstacle{x:r.x,y:r.y,w:r.w,h:r.h,padding:None})}}}Ok(v)}

fn finite(v: f64) -> bool { v.is_finite() && v.abs() < 1.0e6 }
fn distance(a: Point, b: Point) -> f64 { (b[0]-a[0]).hypot(b[1]-a[1]) }
fn position(id: usize) -> Point { [(id%SIDE) as f64*GRID, (id/SIDE) as f64*GRID] }
fn free(p: Point, obstacles: &[Obstacle]) -> bool {
    p.iter().all(|v| *v>=RADIUS && *v<=100.0-RADIUS) && !obstacles.iter().any(|o| {
        let pad=o.padding.unwrap_or(RADIUS);
        p[0]>=o.x-pad && p[0]<=o.x+o.w+pad && p[1]>=o.y-pad && p[1]<=o.y+o.h+pad
    })
}
fn clear(a: Point, b: Point, obstacles: &[Obstacle]) -> bool {
    if !free(a,obstacles) || !free(b,obstacles) { return false }
    for o in obstacles {
        let pad=o.padding.unwrap_or(RADIUS);
        let (mut lo,mut hi)=(0.0_f64,1.0_f64);
        for (start,delta,min,max) in [(a[0],b[0]-a[0],o.x-pad,o.x+o.w+pad),
                                    (a[1],b[1]-a[1],o.y-pad,o.y+o.h+pad)] {
            if delta.abs()<1e-10 { if start<min || start>max { lo=2.0; break } }
            else {
                let (t1,t2)=((min-start)/delta,(max-start)/delta);
                lo=lo.max(t1.min(t2));hi=hi.min(t1.max(t2));
                if lo>hi { break }
            }
        }
        if lo<=hi && hi>=0.0 && lo<=1.0 { return false }
    }
    true
}
fn segment_cost(a: Point, b: Point, zones: &[Zone], metric: &Metric,heightfield:Option<&crate::heightfield::Heightfield>) -> f64 {
    segment_cost_length(a,b,zones,metric,distance(a,b),heightfield)
}
fn segment_cost_length(a: Point, b: Point, zones: &[Zone], metric: &Metric,length:f64,heightfield:Option<&crate::heightfield::Heightfield>) -> f64 {
    let (dx,dy)=(b[0]-a[0],b[1]-a[1]);
    if length==0.0 || matches!(metric,Metric::Distance) || zones.is_empty()&&!heightfield.is_some_and(|h|h.has_costs()) { return length }
    let mut cuts=heightfield.map_or_else(||vec![0.0,1.0],|h|h.cuts(a,b));
    for z in zones {
        if dx.abs()>1e-12 { for x in [z.x,z.x+z.w] {
            let t=(x-a[0])/dx;let y=a[1]+t*dy;
            if t>0.0 && t<1.0 && y>=z.y-1e-9 && y<=z.y+z.h+1e-9 { cuts.push(t) }
        }}
        if dy.abs()>1e-12 { for y in [z.y,z.y+z.h] {
            let t=(y-a[1])/dy;let x=a[0]+t*dx;
            if t>0.0 && t<1.0 && x>=z.x-1e-9 && x<=z.x+z.w+1e-9 { cuts.push(t) }
        }}
    }
    cuts.sort_by(f64::total_cmp);
    let mut cost=0.0;
    for pair in cuts.windows(2) {
        let span=pair[1]-pair[0];if span<1e-12 { continue }
        let mid=(pair[1]+pair[0])/2.0;let (x,y)=(a[0]+dx*mid,a[1]+dy*mid);
        let grade=heightfield.map(|h|h.factor(x,y));let (mut speed,mut energy)=grade.map_or((1.0_f64,1.0_f64),|g|(g.speed,g.energy));
        for z in zones { if x>=z.x && x<=z.x+z.w && y>=z.y && y<=z.y+z.h {
            speed=speed.min(z.speed_factor);energy=energy.max(z.energy_factor);
        }}
        cost+=length*span*if matches!(metric,Metric::Time) {1.0/speed} else {energy};
    }
    cost
}

// Recovery uses the same bounded two-coordinate distance rounding as observed
// energy budgets, including the strict battery > cost + 1e-9 boundary.
pub(crate) fn recovery_energy(start:Point,path:&[Point],zones:serde_json::Value,rate:f64,heightfield:Option<&crate::heightfield::Heightfield>)->Result<f64>{
    let zones:Vec<Zone>=serde_json::from_value(zones).map_err(|_|Error::from_reason("invalid recovery terrain"))?;
    let(mut previous,mut cost)=(start,0.0);for p in path{let length=crate::world_perceptions::sensor_distance(p[0]-previous[0],p[1]-previous[1]);cost+=segment_cost_length(previous,*p,&zones,&Metric::Energy,length,heightfield)*rate;previous=*p;}Ok(cost)
}

pub(crate) fn environment_route_cost(start:Point,path:&[Point],zones:serde_json::Value,metric:serde_json::Value,heightfield:Option<&crate::heightfield::Heightfield>)->Result<f64>{
    let zones:Vec<Zone>=serde_json::from_value(zones).map_err(|_|Error::from_reason("invalid environment terrain"))?;
    let metric:Metric=serde_json::from_value(metric).map_err(|_|Error::from_reason("invalid environment metric"))?;
    let(mut previous,mut total)=(start,0.0);for p in path{total+=segment_cost_length(previous,*p,&zones,&metric,crate::world_perceptions::sensor_distance(p[0]-previous[0],p[1]-previous[1]),heightfield);previous=*p;}Ok(total)
}
pub(crate) fn environment_route_blocked(start:Point,path:&[Point],rect:serde_json::Value)->Result<bool>{
    let obstacle:Obstacle=serde_json::from_value(rect).map_err(|_|Error::from_reason("invalid environment roadblock"))?;
    let mut previous=start;for p in path{if !clear(previous,*p,std::slice::from_ref(&obstacle)){return Ok(true)}previous=*p;}Ok(false)
}

#[derive(Clone)]
struct Entry { id: usize, g: f64, h: f64, f: f64 }
impl PartialEq for Entry { fn eq(&self,other:&Self)->bool { self.cmp(other)==Ordering::Equal } }
impl Eq for Entry {}
impl PartialOrd for Entry { fn partial_cmp(&self,other:&Self)->Option<Ordering> { Some(self.cmp(other)) } }
impl Ord for Entry {
    fn cmp(&self,other:&Self)->Ordering {
        other.f.total_cmp(&self.f).then_with(||other.h.total_cmp(&self.h)).then_with(||other.id.cmp(&self.id))
    }
}
fn anchors(point: Point, v: &Input) -> Vec<(usize,f64)> {
    // Nonnegative world coordinates make round() agree with Math.round().
    let (cx,cy)=((point[0]/GRID).round() as i32,(point[1]/GRID).round() as i32);
    let mut out=Vec::new();
    for dx in -2..=2 { for dy in -2..=2 {
        let (x,y)=(cx+dx,cy+dy);
        if x<0 || y<0 || x>=SIDE as i32 || y>=SIDE as i32 { continue }
        let id=y as usize*SIDE+x as usize;let p=position(id);
        if clear(point,p,&v.obstacles) { out.push((id,segment_cost(point,p,&v.zones,&v.metric,v.heightfield.as_ref()))) }
    }}
    out
}
fn plan(v: &Input) -> Option<Vec<Point>> {
    if !free(v.start,&v.obstacles) || !free(v.target,&v.obstacles) { return None }
    let weighted=!matches!(v.metric,Metric::Distance) && (!v.zones.is_empty()||v.heightfield.as_ref().is_some_and(|h|h.has_costs()));
    let direct=if clear(v.start,v.target,&v.obstacles) {segment_cost(v.start,v.target,&v.zones,&v.metric,v.heightfield.as_ref())} else {f64::INFINITY};
    if !weighted && direct.is_finite() { return Some(vec![v.target]) }
    let starts=anchors(v.start,v);let ends=anchors(v.target,v);
    if starts.is_empty() || ends.is_empty() { return direct.is_finite().then_some(vec![v.target]) }
    let mut costs=vec![f64::INFINITY;SIDE*SIDE];
    let mut parents=vec![None;SIDE*SIDE];
    let mut goal_costs=vec![None;SIDE*SIDE];
    for (id,cost) in ends { goal_costs[id]=Some(cost) }
    let mut open=BinaryHeap::new();
    for (id,cost) in starts { if cost<costs[id] {
        let h=distance(position(id),v.target);costs[id]=cost;
        open.push(Entry {id,g:cost,h,f:cost+h});
    }}
    let (mut best_goal,mut best_cost)=(None,direct);
    let dirs=[(1,0),(0,1),(-1,0),(0,-1),(1,1),(-1,1),(-1,-1),(1,-1)];
    while let Some(cur)=open.pop() {
        if cur.g!=costs[cur.id] { continue }
        if cur.f>best_cost+1e-9 { break }
        if let Some(goal)=goal_costs[cur.id] {
            let total=cur.g+goal;
            let tie=(total-best_cost).abs()<1e-9 && match best_goal {
                Some(id)=>cur.id<id, None=>!weighted,
            };
            if total<best_cost-1e-9 || tie { best_cost=total;best_goal=Some(cur.id) }
        }
        let (x,y)=((cur.id%SIDE) as i32,(cur.id/SIDE) as i32);
        for (dx,dy) in dirs {
            let (nx,ny)=(x+dx,y+dy);
            if nx<0 || ny<0 || nx>=SIDE as i32 || ny>=SIDE as i32 { continue }
            let id=ny as usize*SIDE+nx as usize;let (p,q)=(position(cur.id),position(id));
            if !clear(p,q,&v.obstacles) { continue }
            // Preserve the distance planner's grid edge arithmetic.
            let edge=if weighted {segment_cost(p,q,&v.zones,&v.metric,v.heightfield.as_ref())} else {GRID*(dx as f64).hypot(dy as f64)};
            let ng=cur.g+edge;
            if ng+1e-9>=costs[id] { continue }
            costs[id]=ng;parents[id]=Some(cur.id);
            let h=distance(q,v.target);open.push(Entry {id,g:ng,h,f:ng+h});
        }
    }
    let Some(mut id)=best_goal else { return direct.is_finite().then_some(vec![v.target]) };
    let mut path=Vec::new();
    loop { path.push(position(id));match parents[id] {Some(parent)=>id=parent,None=>break} }
    path.reverse();path.push(v.target);
    let (mut from,mut index)=(v.start,0);let mut out=Vec::new();
    while index<path.len() {
        let mut far=index;let mut routed=segment_cost(from,path[index],&v.zones,&v.metric,v.heightfield.as_ref());
        for j in index+1..path.len() {
            if weighted { routed+=segment_cost(path[j-1],path[j],&v.zones,&v.metric,v.heightfield.as_ref()) }
            if clear(from,path[j],&v.obstacles) && (!weighted || segment_cost(from,path[j],&v.zones,&v.metric,v.heightfield.as_ref())<=routed+1e-8) { far=j }
        }
        if distance(from,path[far])>1e-9 { out.push(path[far]) }
        from=path[far];index=far+1;
    }
    Some(if out.is_empty() {vec![v.target]} else {out})
}

#[napi]
pub fn plan_ground_route(input: String) -> Result<String> {
    if input.len()>512*1024 { return Err(Error::from_reason("navigation input too large")) }
    let v: Input=serde_json::from_str(&input).map_err(|_|Error::from_reason("invalid navigation input"))?;
    if !v.start.iter().chain(v.target.iter()).all(|x|finite(*x)) || v.obstacles.len()>1024 || v.zones.len()>64
        || v.obstacles.iter().any(|o| ![o.x,o.y,o.w,o.h].iter().all(|x|finite(*x)) || o.w<=0.0 || o.h<=0.0
            || o.padding.is_some_and(|p|!p.is_finite() || !(0.0..=100.0).contains(&p)))
        || v.zones.iter().any(|z| ![z.x,z.y,z.w,z.h,z.speed_factor,z.energy_factor].iter().all(|x|finite(*x))
            || z.w<=0.0 || z.h<=0.0 || !(1e-6..=1.0).contains(&z.speed_factor) || !(1.0..=1000.0).contains(&z.energy_factor)) {
        return Err(Error::from_reason("invalid navigation input"))
    }
    let v=prepare_input(v)?;
    serde_json::to_string(&plan(&v)).map_err(|_|Error::from_reason("invalid navigation result"))
}

// Same finite escape/approach stencil as the shared engine. Values are fixed
// doubles from that stencil so libm trigonometric rounding cannot reorder ties.
const COLLISION_DIRECTIONS:[[f64;2];24]=[[1.0,0.0],[0.9659258262890683,0.25881904510252074],[0.8660254037844387,0.49999999999999994],[0.7071067811865476,0.7071067811865475],[0.5000000000000001,0.8660254037844386],[0.25881904510252074,0.9659258262890683],[6.123233995736766e-17,1.0],[-0.25881904510252063,0.9659258262890683],[-0.4999999999999998,0.8660254037844387],[-0.7071067811865475,0.7071067811865476],[-0.8660254037844387,0.49999999999999994],[-0.9659258262890682,0.258819045102521],[-1.0,1.2246467991473532e-16],[-0.9659258262890683,-0.2588190451025208],[-0.8660254037844388,-0.4999999999999997],[-0.7071067811865479,-0.7071067811865471],[-0.5000000000000004,-0.8660254037844385],[-0.25881904510252063,-0.9659258262890683],[-1.8369701987210297e-16,-1.0],[0.2588190451025203,-0.9659258262890684],[0.5000000000000001,-0.8660254037844386],[0.7071067811865474,-0.7071067811865477],[0.8660254037844384,-0.5000000000000004],[0.9659258262890681,-0.25881904510252157]];
pub(crate) fn collision_route(input:String,reach:bool,radius:f64,others:&[Point],escape_padding:Option<f64>,clear_goal:impl Fn(Point)->Result<bool>)->Result<Option<Vec<Point>>>{
    let mut v:Input=serde_json::from_str(&input).map_err(|_|Error::from_reason("invalid collision map"))?;
    v=prepare_input(v)?;let start=v.start;let goal=v.target;let planning=v.obstacles;
    let mut escape_planning=planning.clone();if let Some(padding)=escape_padding{for b in &mut escape_planning{b.padding=Some(padding)}}
    v.obstacles=planning.clone();
    for p in others{v.obstacles.push(Obstacle{x:p[0]-0.8,y:p[1]-0.8,w:1.6,h:1.6,padding:Some(0.9)})}
    let distance=|a:Point,b:Point|crate::world_perceptions::sensor_distance(a[0]-b[0],a[1]-b[1]);
    let escape_clear=|end:Point|{
        if !clear(start,end,&escape_planning){return false}
        let dx=end[0]-start[0];let dy=end[1]-start[1];let length=dx*dx+dy*dy;
        others.iter().all(|p|{let t=if length!=0.0{(((p[0]-start[0])*dx+(p[1]-start[1])*dy)/length).clamp(0.0,1.0)}else{0.0};distance([start[0]+t*dx,start[1]+t*dy],*p)>=1.59})
    };
    let mut entries:Vec<(Point,Vec<Point>,f64)>=Vec::new();
    if free(start,&v.obstacles){entries.push((start,Vec::new(),0.0))}else{
        for length in 1..=6{for unit in COLLISION_DIRECTIONS{let p=[start[0]+length as f64*unit[0],start[1]+length as f64*unit[1]];if free(p,&v.obstacles)&&escape_clear(p){entries.push((p,vec![p],length as f64))}}}
    }
    entries.sort_by(|a,b|(a.2+distance(a.0,goal)).total_cmp(&(b.2+distance(b.0,goal))));
    let mut targets=Vec::new();if free(goal,&v.obstacles){targets.push(goal)}
    if reach{for unit in COLLISION_DIRECTIONS{let p=[goal[0]+radius*unit[0],goal[1]+radius*unit[1]];if free(p,&v.obstacles)&&clear_goal(p)?{targets.push(p)}}}
    let mut best=None;let mut best_cost=f64::INFINITY;
    for (point,prefix,_) in entries.into_iter().take(24){
        let mut ordered=targets.clone();ordered.sort_by(|a,b|distance(point,*a).total_cmp(&distance(point,*b)));
        for target in ordered{v.start=point;v.target=target;if let Some(route)=plan(&v){
            let mut previous=point;let mut total=if prefix.is_empty(){0.0}else{segment_cost_length(start,point,&v.zones,&v.metric,distance(start,point),v.heightfield.as_ref())};
            for p in &route{total+=segment_cost_length(previous,*p,&v.zones,&v.metric,distance(previous,*p),v.heightfield.as_ref());previous=*p;}
            if total<best_cost{best_cost=total;let mut path=prefix.clone();path.extend(route);best=Some(path)}
        }}
    }
    Ok(best)
}
