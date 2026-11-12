//! Immutable reusable tool profile and mechanical-fault episode identity.
use napi::{Error,Result};
use serde::{Deserialize,Serialize};
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Profile{pub(crate) work_ticks:u32}
pub(crate) fn valid(profile:Option<&Profile>,recoverable:Option<bool>,ground:bool,capabilities:&[String])->bool{
 recoverable.is_none_or(|v|v&&ground)&&match profile{Some(p)=>ground&&(1..=100).contains(&p.work_ticks)&&capabilities.iter().any(|c|c=="rescue"),None=>!capabilities.iter().any(|c|c=="rescue")}
}
pub(crate) fn fault_seq(events:&[serde_json::Value],target:&str)->Option<(u32,u32)>{
 for e in events.iter().rev(){match e["kind"].as_str(){Some("rescue_completed") if e["targetAgentId"].as_str()==Some(target)=>return None,Some("device_fault") if e["agentId"].as_str()==Some(target)=>return Some((u32::try_from(e["seq"].as_u64()?).ok()?,u32::try_from(e["tick"].as_u64()?).ok()?)),_=>{}}}None
}
pub(crate) fn verify_fault(events:&[serde_json::Value],target:&str,seq:u32,observed:u32)->Result<bool>{
 if seq==0{return Err(Error::from_reason("invalid rescue fault identity"))}Ok(fault_seq(events,target).is_some_and(|(s,t)|s==seq&&t<=observed))
}
