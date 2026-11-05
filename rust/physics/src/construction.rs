use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
fn present<'de,D,T>(d:D)->Result<Option<T>,D::Error> where D:Deserializer<'de>,T:Deserialize<'de>{T::deserialize(d).map(Some)}
fn token(s:&str)->bool{!s.is_empty()&&s.len()<=64&&!matches!(s,"__proto__"|"constructor"|"prototype")&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Profile {pub id:String,pub name:String,pub obstacle_id:String}
impl Profile{pub fn valid(&self)->bool{token(&self.id)&&token(&self.obstacle_id)&&!self.name.is_empty()&&self.name.encode_utf16().count()<=100}}
pub(crate) fn profiles_valid(sites:&[Profile])->bool{!sites.is_empty()&&sites.len()<=32&&sites.iter().all(Profile::valid)&&sites.iter().map(|s|&s.id).collect::<HashSet<_>>().len()==sites.len()&&sites.iter().map(|s|&s.obstacle_id).collect::<HashSet<_>>().len()==sites.len()}
#[derive(Clone,Copy,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum Status {Planned,Built}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Site {
 pub id:String,pub name:String,pub obstacle_id:String,pub status:Status,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub task_id:Option<String>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub agent_id:Option<String>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub assignment_id:Option<u64>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub built_tick:Option<u32>,
}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct State {pub sites:Vec<Site>}
impl State{
 pub fn initial(sites:&[Profile])->Self{Self{sites:sites.iter().map(|s|Site{id:s.id.clone(),name:s.name.clone(),obstacle_id:s.obstacle_id.clone(),status:Status::Planned,task_id:None,agent_id:None,assignment_id:None,built_tick:None}).collect()}}
 pub fn valid(&self)->bool{profiles_valid(&self.sites.iter().map(|s|Profile{id:s.id.clone(),name:s.name.clone(),obstacle_id:s.obstacle_id.clone()}).collect::<Vec<_>>())&&self.sites.iter().all(|s|if s.status==Status::Planned{s.task_id.is_none()&&s.agent_id.is_none()&&s.assignment_id.is_none()&&s.built_tick.is_none()}else{s.task_id.as_deref().is_some_and(token)&&s.agent_id.as_deref().is_some_and(token)&&s.assignment_id.is_some_and(|v|(1..=10000000).contains(&v))&&s.built_tick.is_some_and(|v|(1..=10000000).contains(&v))})}
 pub fn finish(&mut self,site:&str,task:&str,actor:&str,assignment:u64,tick:u32)->Result<(),()>{
  if !self.valid()||!token(task)||!token(actor)||!(1..=10000000).contains(&assignment)||!(1..=10000000).contains(&tick){return Err(())}
  let s=self.sites.iter_mut().find(|s|s.id==site).ok_or(())?;if s.status!=Status::Planned{return Err(())}s.status=Status::Built;s.task_id=Some(task.into());s.agent_id=Some(actor.into());s.assignment_id=Some(assignment);s.built_tick=Some(tick);Ok(())
 }
}
