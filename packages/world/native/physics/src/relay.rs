use serde::{Deserialize,Serialize,Deserializer};
fn present<'de,D,T>(d:D)->Result<Option<T>,D::Error>where D:Deserializer<'de>,T:Deserialize<'de>{T::deserialize(d).map(Some)}
#[derive(Clone,PartialEq,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct State{
 pub deployed:bool,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub task_id:Option<String>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub assignment_id:Option<u32>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub deployed_tick:Option<u32>,
 #[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]pub position:Option<[f64;2]>,
}
impl State{
 pub fn initial()->Self{Self{deployed:false,task_id:None,assignment_id:None,deployed_tick:None,position:None}}
 pub fn deploy(task:String,assignment:u32,tick:u32,position:[f64;2])->Self{Self{deployed:true,task_id:Some(task),assignment_id:Some(assignment),deployed_tick:Some(tick),position:Some(position)}}
 pub fn valid(&self)->bool{if !self.deployed{return self.task_id.is_none()&&self.assignment_id.is_none()&&self.deployed_tick.is_none()&&self.position.is_none()}self.task_id.as_ref().is_some_and(|s|!s.is_empty()&&s.len()<=64&&!matches!(s.as_str(),"__proto__"|"constructor"|"prototype")&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'))&&self.assignment_id.is_some_and(|n|(1..=10000000).contains(&n))&&self.deployed_tick.is_some_and(|n|(1..=10000000).contains(&n))&&self.position.is_some_and(|p|p.iter().all(|n|n.is_finite()&&(0.0..=100.0).contains(n)))}
}
