//! A bounded piecewise planar map, shared by navigation, kinematic grounding and rays.
use napi::bindgen_prelude::*;
use serde::{Deserialize,Deserializer,Serialize};

fn default_slope()->f64{20.0}
pub(crate) fn present<'de,D>(d:D)->std::result::Result<Option<Heightfield>,D::Error>where D:Deserializer<'de>{Heightfield::deserialize(d).map(Some)}
#[derive(Clone,Debug,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Heightfield{
 pub(crate) rows:usize,pub(crate) cols:usize,pub(crate) heights:Vec<f64>,
 #[serde(default="default_slope")]pub(crate) max_slope_degrees:f64,
}
#[derive(Clone,Copy,Debug)]
pub(crate) struct Grade{pub(crate) speed:f64,pub(crate) energy:f64,pub(crate) blocked:bool,pub(crate) degrees:f64}
#[derive(Clone,Copy,Debug,Serialize)]
pub(crate) struct Rect{pub(crate) x:f64,pub(crate) y:f64,pub(crate) w:f64,pub(crate) h:f64}
impl Heightfield{
 pub(crate) fn validate(&self)->Result<()>{
  if !(2..=17).contains(&self.rows)||!(2..=17).contains(&self.cols)||self.heights.len()!=self.rows*self.cols||self.heights.iter().any(|n|!n.is_finite()||!(-10.0..=10.0).contains(n))||!self.max_slope_degrees.is_finite()||!(1.0..=60.0).contains(&self.max_slope_degrees){return Err(Error::from_reason("invalid heightfield"))}Ok(())
 }
 fn inside(x:f64,y:f64)->bool{(0.0..=100.0).contains(&x)&&(0.0..=100.0).contains(&y)}
 fn cell(&self,x:f64,y:f64)->(usize,usize,f64,f64,f64,f64){
  let(w,d)=(100.0/(self.cols-1)as f64,100.0/(self.rows-1)as f64);let col=((x/w).floor()as usize).min(self.cols-2);let row=((y/d).floor()as usize).min(self.rows-2);(row,col,w,d,(x-col as f64*w)/w,(y-row as f64*d)/d)
 }
 fn values(&self,row:usize,col:usize)->(f64,f64,f64,f64){let i=row*self.cols+col;(self.heights[i],self.heights[i+1],self.heights[i+self.cols],self.heights[i+self.cols+1])}
 pub(crate) fn surface(&self,x:f64,y:f64)->[f64;4]{
  if !Self::inside(x,y){return [0.0;4]}let(row,col,w,d,u,v)=self.cell(x,y);let(a,b,c,z)=self.values(row,col);
  let(height,dx,dy)=if u+v<=1.0{(a+(b-a)*u+(c-a)*v,(b-a)/w,(c-a)/d)}else{(z+(c-z)*(1.0-u)+(b-z)*(1.0-v),(z-c)/w,(z-b)/d)};
  [height,dx,dy,crate::world_perceptions::sensor_distance(dx,dy).atan()*180.0/std::f64::consts::PI]
 }
 pub(crate) fn height(&self,x:f64,y:f64)->f64{self.surface(x,y)[0]}
 fn cell_grade(&self,row:usize,col:usize)->Grade{
  let(w,d)=(100.0/(self.cols-1)as f64,100.0/(self.rows-1)as f64);let(a,b,c,z)=self.values(row,col);
  let grade=crate::world_perceptions::sensor_distance((b-a)/w,(c-a)/d).max(crate::world_perceptions::sensor_distance((z-c)/w,(z-b)/d));let degrees=grade.atan()*180.0/std::f64::consts::PI;
  Grade{speed:1.0/(1.0+grade*grade).sqrt(),energy:1.0+2.0*grade,blocked:degrees>self.max_slope_degrees+1e-9,degrees}
 }
 pub(crate) fn factor(&self,x:f64,y:f64)->Grade{
  if !Self::inside(x,y){return Grade{speed:1.0,energy:1.0,blocked:false,degrees:0.0}}let(row,col,_,_,_,_)=self.cell(x,y);self.cell_grade(row,col)
 }
 pub(crate) fn has_costs(&self)->bool{for r in 0..self.rows-1{for c in 0..self.cols-1{let g=self.cell_grade(r,c);if !g.blocked&&g.energy>1.0+1e-12{return true}}}false}
 pub(crate) fn blocked_cells(&self)->Vec<Rect>{
  let(w,d)=(100.0/(self.cols-1)as f64,100.0/(self.rows-1)as f64);let mut out=Vec::new();for row in 0..self.rows-1{for col in 0..self.cols-1{if self.cell_grade(row,col).blocked{out.push(Rect{x:col as f64*w,y:row as f64*d,w,h:d})}}}out
 }
 pub(crate) fn cuts(&self,a:[f64;2],b:[f64;2])->Vec<f64>{
  let(dx,dy)=(b[0]-a[0],b[1]-a[1]);let(w,d)=(100.0/(self.cols-1)as f64,100.0/(self.rows-1)as f64);let mut cuts=vec![0.0,1.0];
  let mut add=|t:f64|{if t>0.0&&t<1.0{cuts.push(t)}};
  if dx.abs()>1e-12{for c in 0..self.cols{add((c as f64*w-a[0])/dx)}}if dy.abs()>1e-12{for r in 0..self.rows{add((r as f64*d-a[1])/dy)}}
  let delta=dx/w+dy/d;if delta.abs()>1e-12{for r in 0..self.rows-1{for c in 0..self.cols-1{let t=(1.0-(a[0]-c as f64*w)/w-(a[1]-r as f64*d)/d)/delta;let(x,y)=(a[0]+t*dx,a[1]+t*dy);if x>=c as f64*w-1e-9&&x<=(c+1)as f64*w+1e-9&&y>=r as f64*d-1e-9&&y<=(r+1)as f64*d+1e-9{add(t)}}}}
  cuts.sort_by(f64::total_cmp);let mut out=Vec::new();for(i,t)in cuts.iter().enumerate(){if i==0||t-cuts[i-1]>1e-12{out.push(*t)}}out
 }
 pub(crate) fn visible(&self,from:[f64;3],to:[f64;3])->bool{
  let cuts=self.cuts([from[0],from[1]],[to[0],to[1]]);let at=|t:f64|[from[0]+(to[0]-from[0])*t,from[1]+(to[1]-from[1])*t,from[2]+(to[2]-from[2])*t];
  for pair in cuts.windows(2){let mid=at((pair[0]+pair[1])/2.0);if !Self::inside(mid[0],mid[1]){continue}let p=at(pair[0]);let q=at(pair[1]);let(pa,pb)=(p[2]-self.height(p[0],p[1]),q[2]-self.height(q[0],q[1]));if pa.abs()<=1e-8||pb.abs()<=1e-8||(pa<0.0)!=(pb<0.0){return false}}true
 }
 pub(crate) fn mesh(&self)->(Vec<[f32;3]>,Vec<[u32;3]>){
  let(w,d)=(100.0/(self.cols-1)as f64,100.0/(self.rows-1)as f64);let mut vertices=Vec::new();let mut triangles=Vec::new();for row in 0..self.rows{for col in 0..self.cols{vertices.push([(col as f64*w)as f32,self.heights[row*self.cols+col]as f32,(row as f64*d)as f32])}}
  for row in 0..self.rows-1{for col in 0..self.cols-1{let i=(row*self.cols+col)as u32;let c=self.cols as u32;triangles.push([i,i+c,i+1]);triangles.push([i+1,i+c,i+c+1])}}(vertices,triangles)
 }
 pub(crate) fn bounds(&self,rect:Rect)->[f64;2]{
  fn clip(points:Vec<[f64;3]>,axis:usize,bound:f64,sign:f64)->Vec<[f64;3]>{let mut out=Vec::new();for i in 0..points.len(){let a=points[i];let b=points[(i+1)%points.len()];let da=sign*(a[axis]-bound);let db=sign*(b[axis]-bound);let ina=da>=0.0;let inb=db>=0.0;if ina{out.push(a)}if ina!=inb{let t=da/(da-db);out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t])}}out}
  let(w,d)=(100.0/(self.cols-1)as f64,100.0/(self.rows-1)as f64);let(mut low,mut high)=(f64::INFINITY,f64::NEG_INFINITY);
  for row in 0..self.rows-1{for col in 0..self.cols-1{let(x,y)=(col as f64*w,row as f64*d);if x+w<rect.x||x>rect.x+rect.w||y+d<rect.y||y>rect.y+rect.h{continue}let(a,b,c,z)=self.values(row,col);let a=[x,y,a];let b=[x+w,y,b];let c=[x,y+d,c];let z=[x+w,y+d,z];for tri in [[a,c,b],[b,c,z]]{let mut poly=tri.to_vec();for(axis,bound,sign)in[(0,rect.x,1.0),(0,rect.x+rect.w,-1.0),(1,rect.y,1.0),(1,rect.y+rect.h,-1.0)]{poly=clip(poly,axis,bound,sign)}for p in poly{low=low.min(p[2]);high=high.max(p[2]);}}}}
  if low.is_finite(){[low,high]}else{[0.0,0.0]}
 }
 pub(crate) fn proxy_height(&self,x:f64,y:f64)->f64{let r=0.8;let rx=(x-r).max(0.0);let ry=(y-r).max(0.0);self.bounds(Rect{x:rx,y:ry,w:(x+r).min(100.0)-rx,h:(y+r).min(100.0)-ry})[1]+1.0}
 pub(crate) fn traversable(&self,a:[f64;2],b:[f64;2],radius:f64)->bool{
  if [a,b].iter().any(|p|p.iter().any(|v|*v<radius||*v>100.0-radius)){return false}
  for o in self.blocked_cells(){let(mut lo,mut hi)=(0.0_f64,1.0_f64);for(start,delta,min,max)in[(a[0],b[0]-a[0],o.x-radius,o.x+o.w+radius),(a[1],b[1]-a[1],o.y-radius,o.y+o.h+radius)]{if delta.abs()<1e-10{if start<min||start>max{lo=2.0;break}}else{let(t1,t2)=((min-start)/delta,(max-start)/delta);lo=lo.max(t1.min(t2));hi=hi.min(t1.max(t2));if lo>hi{break}}}if lo<=hi&&hi>=0.0&&lo<=1.0{return false}}true
 }

}
