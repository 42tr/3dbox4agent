//! Discrete optional task consumables; held units remain part of physical stock.
use napi::{Error,Result};
use serde::{Deserialize,Serialize};
use std::collections::HashSet;
const MAX:u32=1_000_000;
const MAX_ID:u64=9_007_199_254_740_991;
fn invalid()->Error{Error::from_reason("invalid materials")}
fn token(s:&str)->bool{!s.is_empty()&&s.len()<=64&&!matches!(s,"__proto__"|"constructor"|"prototype")&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
fn name(s:&str)->bool{!s.is_empty()&&s.encode_utf16().count()<=100}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile{pub(crate) id:String,pub(crate) name:String,pub(crate) quantity:u32}
#[derive(Clone,PartialEq,Eq,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Item{pub(crate) id:String,pub(crate) amount:u32}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Stock{pub(crate) id:String,pub(crate) name:String,pub(crate) initial:u32,pub(crate) remaining:u32}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Lease{pub(crate) task_id:String,pub(crate) agent_id:String,pub(crate) assignment_id:u64,pub(crate) items:Vec<Item>}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct State{pub(crate) stock:Vec<Stock>,pub(crate) reservations:Vec<Lease>}
pub(crate) fn profile_valid(rows:&[Profile])->bool{!rows.is_empty()&&rows.len()<=8&&rows.iter().all(|x|token(&x.id)&&name(&x.name)&&x.quantity<=MAX)&&rows.iter().map(|x|&x.id).collect::<HashSet<_>>().len()==rows.len()}
pub(crate) fn cost_valid(items:&[Item])->bool{!items.is_empty()&&items.len()<=8&&items.iter().all(|x|token(&x.id)&&(1..=MAX).contains(&x.amount))&&items.iter().map(|x|&x.id).collect::<HashSet<_>>().len()==items.len()}
pub(crate) fn initial(rows:&[Profile])->State{State{stock:rows.iter().map(|x|Stock{id:x.id.clone(),name:x.name.clone(),initial:x.quantity,remaining:x.quantity}).collect(),reservations:Vec::new()}}
impl State{
 pub(crate) fn cost_known(&self,items:&[Item])->bool{cost_valid(items)&&items.iter().all(|i|self.stock.iter().any(|s|s.id==i.id))}
 pub(crate) fn held(&self,id:&str)->u32{self.reservations.iter().flat_map(|r|&r.items).filter(|i|i.id==id).map(|i|i.amount).sum()}
 pub(crate) fn valid(&self)->bool{
  !self.stock.is_empty()&&self.stock.len()<=8&&self.stock.iter().all(|x|token(&x.id)&&name(&x.name)&&x.initial<=MAX&&x.remaining<=x.initial)&&self.stock.iter().map(|x|&x.id).collect::<HashSet<_>>().len()==self.stock.len()&&self.reservations.len()<=100&&self.reservations.iter().all(|r|token(&r.task_id)&&token(&r.agent_id)&&(1..=MAX_ID).contains(&r.assignment_id)&&self.cost_known(&r.items))&&self.reservations.iter().map(|r|&r.task_id).collect::<HashSet<_>>().len()==self.reservations.len()&&self.reservations.iter().map(|r|&r.agent_id).collect::<HashSet<_>>().len()==self.reservations.len()&&self.stock.iter().all(|s|self.held(&s.id)<=s.remaining)
 }
 pub(crate) fn available(&self,items:&[Item])->bool{self.cost_known(items)&&items.iter().all(|i|self.stock.iter().any(|s|s.id==i.id&&s.remaining.saturating_sub(self.held(&s.id))>=i.amount))}
 pub(crate) fn reserve(&mut self,task:&str,agent:&str,version:u64,items:&[Item])->Result<()>{
  if !self.valid()||!token(task)||!token(agent)||!(1..=MAX_ID).contains(&version)||self.reservations.len()>=100||self.reservations.iter().any(|r|r.task_id==task||r.agent_id==agent)||!self.available(items){return Err(invalid())}self.reservations.push(Lease{task_id:task.into(),agent_id:agent.into(),assignment_id:version,items:items.into()});Ok(())
 }
 pub(crate) fn settle(&mut self,task:&str,agent:&str,version:u64,items:&[Item],consume:bool)->Result<()>{
  if !self.valid(){return Err(invalid())}let index=self.reservations.iter().position(|r|r.task_id==task).ok_or_else(invalid)?;let r=&self.reservations[index];if r.agent_id!=agent||r.assignment_id!=version||r.items!=items{return Err(invalid())}if consume{for s in &mut self.stock{if let Some(i)=items.iter().find(|i|i.id==s.id){s.remaining=s.remaining.checked_sub(i.amount).ok_or_else(invalid)?}}}self.reservations.remove(index);Ok(())
 }
 pub(crate) fn own(&self,agent:&str)->serde_json::Value{serde_json::Value::Array(self.reservations.iter().filter(|r|r.agent_id==agent).map(|r|serde_json::json!({"taskId":r.task_id,"assignmentId":r.assignment_id,"items":r.items.iter().map(|i|serde_json::json!({"id":i.id,"amount":i.amount,"name":self.stock.iter().find(|s|s.id==i.id).unwrap().name})).collect::<Vec<_>>()})).collect())}
}
