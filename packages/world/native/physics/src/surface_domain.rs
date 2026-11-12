//! Exact flat land/water arrangement. Virtual boundaries must not occlude sensors.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize,Serialize};
use std::collections::HashSet;
fn invalid()->Error{Error::from_reason("invalid surface domain")}
pub(crate) fn present<'de,D:serde::Deserializer<'de>>(d:D)->std::result::Result<Option<Profile>,D::Error>{Profile::deserialize(d).map(Some)}
#[derive(Clone,Debug,PartialEq,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Region{pub id:String,pub name:String,pub x:f64,pub y:f64,pub w:f64,pub h:f64}
#[derive(Clone,Debug,PartialEq,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile{pub water:Vec<Region>}
#[derive(Clone,Copy,Debug,Deserialize,Serialize)]
pub(crate) struct Rect{pub x:f64,pub y:f64,pub w:f64,pub h:f64}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SpawnArea{pub x:f64,pub y:f64,pub w:f64,pub h:f64}
impl SpawnArea{pub(crate) fn valid(&self)->bool{[self.x,self.y,self.w,self.h].iter().all(|n|n.is_finite())&&self.x>=2.0&&self.y>=2.0&&self.w>0.0&&self.h>0.0&&self.x+self.w<=98.0&&self.y+self.h<=98.0}}
pub(crate) fn approaches(goal:[f64;2],radius:f64)->Vec<[f64;2]>{[[1.0,0.0],[0.8,0.6],[0.6,0.8],[0.0,1.0],[-0.6,0.8],[-0.8,0.6],[-1.0,0.0],[-0.8,-0.6],[-0.6,-0.8],[0.0,-1.0],[0.6,-0.8],[0.8,-0.6]].map(|[x,y]|[goal[0]+x*radius,goal[1]+y*radius]).to_vec()}
impl Profile{
 pub(crate) fn body_free(&self,mobility:&str,at:[f64;2],radius:f64)->Result<bool>{
  if ![at[0],at[1],radius].iter().all(|n|n.is_finite())||radius<=0.0||radius>5.0{return Err(invalid())}let masks=self.masks(mobility)?;if mobility=="air"{return Ok(true)}let tolerance=1e-4;
  if at.iter().any(|n|*n<radius-tolerance||*n>100.0-radius+tolerance){return Ok(false)}
  Ok(masks.iter().all(|r|(r.x-at[0]).max(0.0).max(at[0]-r.x-r.w).hypot((r.y-at[1]).max(0.0).max(at[1]-r.y-r.h))>=radius-tolerance))
 }
 pub(crate) fn validate(&self)->Result<()>{
  if self.water.is_empty()||self.water.len()>16{return Err(invalid())}let mut ids=HashSet::new();
  for r in &self.water{if r.id.is_empty()||r.id.len()>64||!r.id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-')||!ids.insert(&r.id)||r.name.is_empty()||r.name.encode_utf16().count()>100||![r.x,r.y,r.w,r.h].iter().all(|v|v.is_finite())||r.x<0.0||r.y<0.0||r.w<=0.0||r.h<=0.0||r.x+r.w>100.0||r.y+r.h>100.0{return Err(invalid())}}Ok(())
 }
 pub(crate) fn partition(&self,water:bool)->Vec<Rect>{
  let(mut xs,mut ys)=(vec![0.0,100.0],vec![0.0,100.0]);for r in &self.water{xs.extend([r.x,r.x+r.w]);ys.extend([r.y,r.y+r.h]);}xs.sort_by(f64::total_cmp);xs.dedup();ys.sort_by(f64::total_cmp);ys.dedup();
  let mut out:Vec<Rect>=Vec::new();let mut previous:Vec<(f64,f64,usize)>=Vec::new();
  for row in ys.windows(2){let y=(row[0]+row[1])/2.0;let mut runs=Vec::new();let mut left=None;
   for cell in xs.windows(2){let x=(cell[0]+cell[1])/2.0;let inside=self.water.iter().any(|r|x>r.x&&x<r.x+r.w&&y>r.y&&y<r.y+r.h);
    if inside==water{if left.is_none(){left=Some(cell[0])}}else if let Some(start)=left.take(){runs.push((start,cell[0]));}
   }if let Some(start)=left{runs.push((start,100.0));}let mut next=Vec::new();
   for(x,end)in runs{if let Some((_,_,index))=previous.iter().find(|(a,b,_)|*a==x&&*b==end){out[*index].h=row[1]-out[*index].y;next.push((x,end,*index));}else{next.push((x,end,out.len()));out.push(Rect{x,y:row[0],w:end-x,h:row[1]-row[0]});}}previous=next;
  }out
 }
 pub(crate) fn masks(&self,mobility:&str)->Result<Vec<Rect>>{match mobility{"air"=>Ok(Vec::new()),"ground"=>Ok(self.partition(true)),"water"=>Ok(self.partition(false)),_=>Err(invalid())}}
 pub(crate) fn clear(&self,mobility:&str,a:[f64;2],b:[f64;2],radius:f64)->Result<bool>{
  if ![a[0],a[1],b[0],b[1],radius].iter().all(|n|n.is_finite())||!(0.0..=5.0).contains(&radius){return Err(invalid())}let masks=self.masks(mobility)?;if mobility=="air"{return Ok(true)}if [a[0],a[1],b[0],b[1]].iter().any(|n|*n<radius||*n>100.0-radius){return Ok(false)}
  Ok(!masks.iter().any(|r|hit(a,b,*r,radius)))
 }
}
fn hit(a:[f64;2],b:[f64;2],r:Rect,p:f64)->bool{
 let(mut lo,mut hi)=(0.0_f64,1.0_f64);for(start,delta,min,max)in[(a[0],b[0]-a[0],r.x-p,r.x+r.w+p),(a[1],b[1]-a[1],r.y-p,r.y+r.h+p)]{
  if delta.abs()<1e-12{if start<min||start>max{return false}}else{let(t,u)=((min-start)/delta,(max-start)/delta);lo=lo.max(t.min(u));hi=hi.min(t.max(u));if lo>hi{return false}}
 }lo<=hi&&hi>=0.0&&lo<=1.0
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input{profile:Profile,mobility:String,start:[f64;2],target:[f64;2],radius:f64}
#[napi]
pub fn surface_domain_geometry(input:String)->Result<String>{
 if input.len()>65536{return Err(invalid())}let i:Input=serde_json::from_str(&input).map_err(|_|invalid())?;i.profile.validate()?;serde_json::to_string(&serde_json::json!({"masks":i.profile.masks(&i.mobility)?,"clear":i.profile.clear(&i.mobility,i.start,i.target,i.radius)?})).map_err(|_|invalid())
}

// Outside-domain strips form a closed world perimeter for both surface modes.
pub(crate) fn world_bounds()->[Rect;4]{[Rect{x:-100.0,y:-100.0,w:100.0,h:300.0},Rect{x:100.0,y:-100.0,w:100.0,h:300.0},Rect{x:0.0,y:-100.0,w:100.0,h:100.0},Rect{x:0.0,y:100.0,w:100.0,h:100.0}]}
