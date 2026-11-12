//! Optional abstract heat budget, coupled to actual energy use and fixed ticks.
use napi::{Error,Result};
use serde::{Deserialize,Serialize};
const MAX_TICK:u32=10_000_000;
fn invalid()->Error{Error::from_reason("invalid thermal state")}
#[derive(Clone,Debug,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Profile{pub ambient_c:f64,pub initial_c:f64,pub limit_c:f64,pub resume_c:f64,pub cooling_c_per_tick:f64,pub heat_c_per_energy:f64}
#[derive(Clone,Debug,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct State{pub temperature_c:f64,pub peak_c:f64,pub protected:bool,pub trips:u32,pub protection_ticks:u32,pub tick:u32}
#[derive(Clone,Debug)]
pub(crate) struct Effect{kind:&'static str,temperature:f64,limit:f64,resume:f64,reason:Option<&'static str>}
impl Effect{
 pub fn kind_order(&self)->u8{if self.kind=="thermal_protection_entered"{0}else{1}}
 pub fn event(&self,name:&str,id:&str)->serde_json::Value{let clear=self.kind=="thermal_protection_cleared";let mut v=serde_json::json!({"message":if clear{format!("{name} 温度已恢复至安全范围")}else{format!("{name} 进入热保护，等待散热")},"type":if clear{"success"}else{"warning"},"kind":self.kind,"agentId":id,"temperatureC":self.temperature,"limitC":self.limit,"resumeC":self.resume});if let Some(reason)=self.reason{v["reason"]=reason.into()}v}
}
impl Profile{
 pub fn validate(&self,work:f64)->Result<()>{
  if [self.ambient_c,self.initial_c,self.limit_c,self.resume_c,self.cooling_c_per_tick,self.heat_c_per_energy,work].iter().any(|n|!n.is_finite())||!(-150.0..=100.0).contains(&self.ambient_c)||self.initial_c<self.ambient_c||self.initial_c>self.limit_c||self.limit_c>200.0||self.resume_c<=self.ambient_c||self.resume_c>=self.limit_c||!(0.01..=20.0).contains(&self.cooling_c_per_tick)||!(0.01..=200.0).contains(&self.heat_c_per_energy)||!(0.001..=5.0).contains(&work)||self.limit_c-self.resume_c+1e-9<self.heat_c_per_energy*work{return Err(Error::from_reason("invalid thermal profile"))}Ok(())
 }
 pub fn initial(&self)->State{State{temperature_c:self.initial_c,peak_c:self.initial_c,protected:self.initial_c>=self.limit_c,trips:0,protection_ticks:0,tick:0}}
 pub fn observation(&self,s:&State)->Result<serde_json::Value>{let mut v=serde_json::to_value(self).map_err(|_|invalid())?;let state=serde_json::to_value(s).map_err(|_|invalid())?;for(k,val)in state.as_object().ok_or_else(invalid)?{v[k]=val.clone()}Ok(v)}
}
impl State{
 pub fn valid(&self,p:&Profile)->bool{[self.temperature_c,self.peak_c].iter().all(|n|n.is_finite())&&self.temperature_c>=p.ambient_c-1e-7&&self.temperature_c<=p.limit_c+1e-7&&self.peak_c>=self.temperature_c-1e-7&&self.peak_c<=p.limit_c+1e-7&&[self.trips,self.protection_ticks,self.tick].iter().all(|n|*n<=MAX_TICK)&&self.trips<=self.tick.saturating_add(1)&&self.protection_ticks<=self.tick.saturating_add(1)}
 fn effect(&self,p:&Profile,kind:&'static str,reason:Option<&'static str>)->Effect{Effect{kind,temperature:self.temperature_c,limit:p.limit_c,resume:p.resume_c,reason}}
 pub fn protect(&mut self,p:&Profile,reason:&'static str)->Result<Option<Effect>>{if self.protected{return Ok(None)}self.protected=true;self.trips=self.trips.checked_add(1).filter(|n|*n<=MAX_TICK).ok_or_else(invalid)?;Ok(Some(self.effect(p,"thermal_protection_entered",Some(reason))))}
 pub fn move_limit(&self,p:&Profile,energy_rate:f64,minimum:f64)->f64{if self.protected{0.0}else{((p.limit_c-self.temperature_c)/(p.heat_c_per_energy*energy_rate)-2.0*minimum-1e-9).max(0.0)}}
 pub fn guard_work(&mut self,p:&Profile,energy:f64)->Result<(bool,Option<Effect>)>{if energy<=0.0{return Ok((true,None))}if self.protected{return Ok((false,None))}if(p.limit_c-self.temperature_c)/p.heat_c_per_energy+1e-12>=energy{return Ok((true,None))}Ok((false,self.protect(p,"heat_budget")?))}
 pub fn spend(&mut self,p:&Profile,energy:f64)->Result<Option<Effect>>{if energy<=0.0{return Ok(None)}let value=self.temperature_c+energy*p.heat_c_per_energy;if !value.is_finite()||value>p.limit_c+1e-7{return Err(Error::from_reason("thermal budget exceeded"))}self.temperature_c=value.min(p.limit_c);self.peak_c=self.peak_c.max(self.temperature_c);if self.temperature_c>=p.limit_c-1e-9{self.protect(p,"limit")}else{Ok(None)}}
 pub fn finish(&mut self,p:&Profile,tick:u32)->Result<Option<Effect>>{if tick==self.tick{return Ok(None)}if tick!=self.tick+1||tick>MAX_TICK{return Err(Error::from_reason("invalid thermal tick"))}self.temperature_c=p.ambient_c.max(self.temperature_c-p.cooling_c_per_tick);if self.protected{self.protection_ticks=self.protection_ticks.checked_add(1).filter(|n|*n<=MAX_TICK).ok_or_else(invalid)?}self.tick=tick;if self.protected&&self.temperature_c<=p.resume_c{self.protected=false;Ok(Some(self.effect(p,"thermal_protection_cleared",None)))}else{Ok(None)}}
}
