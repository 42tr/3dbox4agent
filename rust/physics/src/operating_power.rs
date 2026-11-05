//! Optional per-tick electrical base load. Movement/work thermal sources are separate.
use serde::{Deserialize,Serialize};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::world_motion::WorldMotion;

pub(crate) fn valid_rate(rate:f64)->bool{rate.is_finite()&&(0.001..=5.0).contains(&rate)}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct State{pub(crate) energy_spent:f64,pub(crate) tick:u32}
impl State{
 pub(crate) fn initial()->Self{Self{energy_spent:0.0,tick:0}}
 pub(crate) fn valid(&self,rate:f64)->bool{valid_rate(rate)&&self.tick<=10_000_000&&self.energy_spent.is_finite()&&self.energy_spent>=0.0&&self.energy_spent<=rate*self.tick as f64+1e-7*(rate*self.tick as f64).max(1.0)}
 pub(crate) fn advance(&self,rate:f64,battery:f64,disabled:bool,now:u32)->Option<(Self,f64,bool)>{
  if !self.valid(rate)||self.tick.checked_add(1)!=Some(now)||now>10_000_000||!battery.is_finite()||!(0.0..=100.0).contains(&battery){return None}
  let spent=if disabled{0.0}else{battery.min(rate)};let remaining=(battery-spent).max(0.0);Some((Self{energy_spent:self.energy_spent+spent,tick:now},remaining,!disabled&&remaining<=0.0))
 }
}
pub(crate) fn route_energy(start:[f64;2],path:&[[f64;2]],zones:serde_json::Value,rate:f64,speed:f64,operating:Option<f64>,heightfield:Option<&crate::heightfield::Heightfield>)->Result<Option<f64>>{
 let cost=if let Some(base)=operating{let move_cost=crate::navigation::recovery_energy(start,path,zones.clone(),rate,heightfield)?;let time=crate::navigation::environment_route_cost(start,path,zones,serde_json::json!("time"),heightfield)?;move_cost+base*(time/speed-1e-9).ceil().max(0.0)}else{crate::navigation::recovery_energy(start,path,zones,rate,heightfield)?};Ok(if cost.is_finite(){Some(cost)}else{None})
}
impl WorldMotion{
 pub(crate) fn operating_phase(&mut self,now:u32)->Result<Vec<String>>{
  let mut next=self.clone();let mut depleted=Vec::new();
  for(index,mut actor,mut execution)in next.lifecycle_agents()?{
   match(execution.operating_energy_per_tick,execution.operating_state.as_ref()){
    (None,None)=>continue,
    (Some(rate),Some(state))=>{let(state,battery,empty)=state.advance(rate,actor.battery,execution.disabled,now).ok_or_else(||Error::from_reason("invalid operating tick"))?;execution.operating_state=Some(state);actor.battery=battery;if empty{depleted.push(actor.id.clone())}},
    _=>return Err(Error::from_reason("invalid operating profile")),
   }
   next.commit_stationary(index,actor,execution)?;
  }
  *self=next;Ok(depleted)
 }
}
#[napi]
impl WorldMotion{
 #[napi]
 pub fn advance_operating_state(&mut self,now:f64)->Result<String>{
  if !now.is_finite()||now.fract()!=0.0||!(1.0..=10_000_000.0).contains(&now){return Err(Error::from_reason("invalid operating clock"))}
  serde_json::to_string(&self.operating_phase(now as u32)?).map_err(|_|Error::from_reason("invalid operating result"))
 }
}
