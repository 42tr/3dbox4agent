//! Authoritative peer queues, bounded inboxes, request identities and outages.
//! Node supplies current device geometry; it cannot replace the stored packets.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize,Serialize,Deserializer};
fn present<'de,D,T>(d:D)->std::result::Result<Option<T>,D::Error>where D:Deserializer<'de>,T:Deserialize<'de>{T::deserialize(d).map(Some)}
use std::collections::{BTreeMap,HashSet};
const MAX_TICK:u64=10_000_000;
fn invalid()->Error{Error::from_reason("invalid world peer communication")}
fn token(v:&str)->bool{!v.is_empty()&&v.len()<=64&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
fn blank(v:&str)->bool{v.chars().all(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))}
fn clock(v:f64)->Result<u64>{if !v.is_finite()||v.fract()!=0.0||!(0.0..=MAX_TICK as f64).contains(&v){Err(invalid())}else{Ok(v as u64)}}
fn encode<T:Serialize>(v:&T)->Result<String>{serde_json::to_string(v).map_err(|_|invalid())}
fn decode<T:for<'de> Deserialize<'de>>(v:&str)->Result<T>{if v.len()>16*1024*1024{return Err(invalid())}serde_json::from_str(v).map_err(|_|invalid())}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Config{range:f64,delay:u64,loss_rate:f64,ttl:u64,max_per_tick:u64,max_bytes:usize,#[serde(skip_serializing_if="Option::is_none")]line_of_sight:Option<bool>,#[serde(skip_serializing_if="Option::is_none")]bytes_per_tick:Option<u64>,status_interval:u64,status_max_age:u64,decision_max_age:u64}
impl Config{fn valid(&self)->bool{self.range.is_finite()&&self.range>0.0&&self.range<=10000.0&&(1..=10000).contains(&self.delay)&&(1..=10000).contains(&self.ttl)&&self.loss_rate.is_finite()&&(0.0..=1.0).contains(&self.loss_rate)&&(1..=100).contains(&self.max_per_tick)&&(1..=4096).contains(&self.max_bytes)&&self.bytes_per_tick.is_none_or(|n|(1..=4096).contains(&n))&&[self.status_interval,self.status_max_age,self.decision_max_age].iter().all(|n|(1..=10000).contains(n))}}
#[derive(Clone,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Agent{id:String,#[serde(default,deserialize_with="present")]deployable_relay:Option<bool>,communication_range:Option<f64>,communication_bytes_per_tick:Option<u64>}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Packet{id:u64,from:String,to:String,text:String,sent_tick:u64,due_tick:u64,expires_tick:u64,#[serde(skip_serializing_if="Option::is_none")]tx_remaining:Option<u64>,#[serde(skip_serializing_if="Option::is_none")]via:Option<Vec<String>>,#[serde(skip_serializing_if="Option::is_none")]hop:Option<usize>,#[serde(skip_serializing_if="Option::is_none")]received_tick:Option<u64>}
impl Packet{fn route(&self)->Vec<&str>{std::iter::once(self.from.as_str()).chain(self.via.iter().flatten().map(String::as_str)).chain(std::iter::once(self.to.as_str())).collect()}}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Request{request_id:String,from:String,to:String,text:String,via:Vec<String>,message_id:u64}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Outage{agent_id:String,started_tick:u64,until_tick:u64}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Peer{config:Config,next_id:u64,queue:Vec<Packet>,inboxes:BTreeMap<String,Vec<Packet>>,sent_tick:i64,sent_by:BTreeMap<String,u64>,outages:Vec<Outage>,#[serde(skip_serializing_if="Option::is_none")]message_requests:Option<Vec<Request>>}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial{tick:u64,seed:u32,agents:Vec<Agent>,peer:Peer}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Device{id:String,x:f64,y:f64,disabled:bool,#[serde(default,deserialize_with="present",skip_serializing_if="Option::is_none")]relay_ready:Option<bool>}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Obstruction{id:u64,obstructed:bool}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Context{agents:Vec<Device>,obstructions:Vec<Obstruction>}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Send{from:String,to:String,text:String,via:Vec<String>,request_id:Option<String>,done:bool,agents:Vec<Device>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct SendCommand{from:String,to:String,text:String,via:Vec<String>,request_id:Option<String>}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Outcome{id:u64,hop:usize,due_tick:u64,tx_remaining:Option<u64>,transmitted:bool,state:String,reason:Option<String>}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase")]
struct Effect{packet:Packet,hop:usize,source:String,destination:String,transmitted:bool,state:String,reason:Option<String>}
#[napi]
#[derive(Clone)]
pub struct WorldPeer{
    checkpoint_id: u64,peer:Peer,agents:Vec<Agent>,seed:u32,last_tick:u64,last_step:u64,event_binding:Option<[u64;4]>,closed:bool}
impl WorldPeer{
 pub(crate) fn dispatch_context(&self,now:u64,agents:&[String],seed:u32)->Result<(u64,serde_json::Value)>{
  self.now(now as f64)?;if self.seed!=seed{return Err(invalid())}let id=self.time_identity(agents)?;Ok((id,serde_json::json!({"outages":self.peer.outages,"config":{"delay":self.peer.config.delay,"ttl":self.peer.config.ttl,"lossRate":self.peer.config.loss_rate,"decisionMaxAge":self.peer.config.decision_max_age},"reportsConfig":{"delay":self.peer.config.delay,"ttl":self.peer.config.ttl,"lossRate":self.peer.config.loss_rate,"statusInterval":self.peer.config.status_interval,"statusMaxAge":self.peer.config.status_max_age}})))
 }
 pub(crate) fn report_context(&self,now:u64,agents:&[String],seed:u32)->Result<(u64,serde_json::Value)>{
  self.now(now as f64)?;if seed!=self.seed{return Err(invalid())}let id=self.time_identity(agents)?;Ok((id,serde_json::json!({"outages":self.peer.outages,"config":{"delay":self.peer.config.delay,"ttl":self.peer.config.ttl,"lossRate":self.peer.config.loss_rate,"statusInterval":self.peer.config.status_interval,"statusMaxAge":self.peer.config.status_max_age}})))
 }
 fn event_context(&self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,control:&crate::world_control::WorldControl,ledger:&crate::world_ledger::WorldLedger)->Result<([u64;4],Vec<(usize,crate::world_motion::Motion,crate::world_execution::Execution)>,bool)>{
  let now=self.now(expected)?;let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();self.time_identity(&ids)?;
  if actors.iter().zip(&self.agents).any(|((_,_,e),a)|e.communication_range!=a.communication_range||e.communication_bytes_per_tick.map(u64::from)!=a.communication_bytes_per_tick||e.deployable_relay!=a.deployable_relay){return Err(invalid())}
  let(_,_,_,m)=motion.activation_components(ids.first().ok_or_else(invalid)?)?;let(e,_)=environment.time_context(now,&ids)?;let(c,l,done)=control.peer_events_context(now,&ids,self.seed,ledger)?;let binding=[m,e,c,l];if self.event_binding.is_some_and(|b|b!=binding){return Err(invalid())}Ok((binding,actors,done))
 }
 fn event_device(a:&crate::world_motion::Motion,e:&crate::world_execution::Execution)->Device{Device{id:a.id.clone(),x:a.x,y:a.y,disabled:e.disabled,relay_ready:e.deployable_relay.map(|_|e.relay_ready()&&a.battery>5.0)}}
 fn event_position(a:&crate::world_motion::Motion,e:&crate::world_execution::Execution)->[f64;3]{let air=e.mobility.as_deref().map_or(e.role=="drone",|m|m=="air");[a.x,a.y,if air{16.0}else{1.5}]}
 fn event_commit(&mut self,next:Self,control:&mut crate::world_control::WorldControl,next_control:crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger,next_ledger:crate::world_ledger::WorldLedger)->Result<()>{next_control.validate_commit(&next_ledger)?;*self=next;*control=next_control;*ledger=next_ledger;Ok(())}
 pub(crate) fn finalization_context(&self,now:u64,agents:&[String],seed:u32)->Result<u64>{if self.seed!=seed{return Err(invalid())}Ok(self.time_context(now,now,agents)?.0)}
 pub(crate) fn time_identity(&self,agents:&[String])->Result<u64>{self.active()?;if self.agents.iter().map(|a|&a.id).ne(agents.iter()){return Err(invalid())}Ok(self.checkpoint_id)}
 pub(crate) fn time_context(&self,tick:u64,step:u64,agents:&[String])->Result<(u64,serde_json::Value)>{
  self.now(tick as f64)?;if self.last_step!=step||self.agents.iter().map(|a|&a.id).ne(agents.iter()){return Err(invalid())}Ok((self.checkpoint_id,serde_json::json!(self.peer.outages.iter().filter(|o|tick+1>o.until_tick).collect::<Vec<_>>())))
 }
 fn active(&self)->Result<()>{if self.closed{Err(Error::from_reason("world peer communication is closed"))}else{Ok(())}}
 fn now(&self,n:f64)->Result<u64>{self.active()?;let n=clock(n)?;if n<self.last_tick{Err(invalid())}else{Ok(n)}}
 fn devices(&self,agents:&[Device])->bool{agents.len()==self.agents.len()&&agents.iter().zip(&self.agents).all(|(a,b)|a.id==b.id&&(b.deployable_relay==Some(true))==a.relay_ready.is_some()&&a.x.is_finite()&&a.y.is_finite()&&(0.0..=100.0).contains(&a.x)&&(0.0..=100.0).contains(&a.y))}
 fn packet_valid(&self,p:&Packet,now:u64,inbox:bool)->bool{
  let route=p.route();let hop=p.hop.unwrap_or(0);p.id>0&&p.id<self.peer.next_id&&p.sent_tick<=now&&p.expires_tick==p.sent_tick+self.peer.config.ttl&&p.due_tick>p.sent_tick&&p.due_tick<=MAX_TICK+20000&&p.text.len()<=self.peer.config.max_bytes&&!blank(&p.text)&&route.len()<=5&&route.iter().all(|id|self.agents.iter().any(|a|a.id==*id))&&route.iter().copied().collect::<HashSet<_>>().len()==route.len()&&hop<=route.len()-2&&p.via.as_ref().is_none_or(|v|!v.is_empty()&&p.hop.is_some())&&(p.via.is_some()||p.hop.is_none())&&p.tx_remaining.is_none_or(|n|n<=p.text.len()as u64)&&if inbox{p.received_tick.is_some_and(|t|t<=now&&t>=p.due_tick&&t<=p.expires_tick)&&hop==route.len()-2&&p.tx_remaining.is_none()}else{p.received_tick.is_none()}
 }
}
#[napi]
impl WorldPeer{
 #[napi(constructor)]
 pub fn new(input:String)->Result<Self>{
  let i:Initial=decode(&input)?;let p=&i.peer;let ids:HashSet<_>=i.agents.iter().map(|a|a.id.as_str()).collect();
  if i.tick>MAX_TICK||i.agents.is_empty()||i.agents.len()>50||ids.len()!=i.agents.len()||i.agents.iter().any(|a|!token(&a.id)||a.deployable_relay.is_some_and(|v|!v)||a.communication_range.is_some_and(|n|!n.is_finite()||n<=0.0||n>10000.0)||a.communication_bytes_per_tick.is_some_and(|n|!(1..=4096).contains(&n)))||!p.config.valid()||p.next_id==0||p.next_id>9_007_199_254_740_991||p.queue.len()>256||p.inboxes.len()!=ids.len()||p.inboxes.iter().any(|(id,rows)|!ids.contains(id.as_str())||rows.len()>20)||p.sent_tick< -1||p.sent_tick>i.tick as i64||p.sent_by.iter().any(|(id,n)|!ids.contains(id.as_str())||*n==0||*n>p.config.max_per_tick)||p.outages.len()>ids.len(){return Err(invalid())}
  let mut outage_ids=HashSet::new();for o in &p.outages{if !ids.contains(o.agent_id.as_str())||!outage_ids.insert(&o.agent_id)||o.started_tick>i.tick||o.until_tick<=o.started_tick||o.until_tick>o.started_tick+1000||o.until_tick<i.tick{return Err(invalid())}}
  let mut requests=HashSet::new();let mut request_ids=HashSet::new();if let Some(rows)=&p.message_requests{if rows.len()>1000{return Err(invalid())}for r in rows{let route:Vec<_>=std::iter::once(&r.from).chain(r.via.iter()).chain(std::iter::once(&r.to)).collect();if !token(&r.request_id)||!requests.insert((&r.from,&r.request_id))||!request_ids.insert(r.message_id)||r.message_id==0||r.message_id>=p.next_id||blank(&r.text)||r.text.len()>p.config.max_bytes||route.len()>5||route.iter().any(|id|!ids.contains(id.as_str()))||route.iter().copied().collect::<HashSet<_>>().len()!=route.len(){return Err(invalid())}}}
  let world=Self{ checkpoint_id: crate::world_checkpoint::identity(),peer:i.peer,agents:i.agents,seed:i.seed,last_tick:i.tick,last_step:i.tick,event_binding:None,closed:false};let mut packet_ids=HashSet::new();
  for p in &world.peer.queue{if !world.packet_valid(p,i.tick,false)||!packet_ids.insert(p.id){return Err(invalid())}}
  for(id,rows)in &world.peer.inboxes{for p in rows{if p.to!=*id||!world.packet_valid(p,i.tick,true)||!packet_ids.insert(p.id){return Err(invalid())}}}
  for r in world.peer.message_requests.iter().flatten(){if let Some(p)=world.peer.queue.iter().chain(world.peer.inboxes.values().flatten()).find(|p|p.id==r.message_id){if p.from!=r.from||p.to!=r.to||p.text!=r.text||p.via.as_deref().unwrap_or(&[])!=r.via{return Err(invalid())}}}
  Ok(world)
 }
 #[napi]
 pub fn send_events(&mut self,input:String,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
  let(binding,actors,done)=self.event_context(expected,motion,environment,control,ledger)?;let s:SendCommand=decode(&input)?;
  let devices:Vec<_>=actors.iter().map(|(_,a,e)|{let mut v=serde_json::json!({"id":a.id,"x":a.x,"y":a.y,"disabled":e.disabled});if e.deployable_relay.is_some(){v["relayReady"]=(e.relay_ready()&&a.battery>5.0).into()}v}).collect();
  let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
  let result=next.send(encode(&serde_json::json!({"from":s.from,"to":s.to,"text":s.text,"via":s.via,"requestId":s.request_id,"done":done,"agents":devices}))?,expected)?;let r:serde_json::Value=decode(&result)?;
  if r["ok"]==true&&r["duplicate"]!=true{let from=actors.iter().find(|(_,a,_)|a.id==s.from).ok_or_else(invalid)?;let to=actors.iter().find(|(_,a,_)|a.id==s.to).ok_or_else(invalid)?;let mut fact=serde_json::json!({"message":format!("{} 向 {} 发送消息",from.2.name,to.2.name),"type":"info","kind":"message_sent","messageId":r["messageId"],"from":s.from,"to":s.to,"bytes":s.text.len()});if let Some(id)=s.request_id{fact["requestId"]=id.into()}next_control.task_event(&mut next_ledger,fact)?;}
  next.event_binding=Some(binding);self.event_commit(next,control,next_control,ledger,next_ledger)?;Ok(result)
 }
 #[napi]
 pub fn interrupt_events(&mut self,agent_id:String,duration:f64,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
  let(binding,actors,done)=self.event_context(expected,motion,environment,control,ledger)?;
  let fail=|reason:&str|encode(&serde_json::json!({"ok":false,"reason":reason}));if done{return fail("world_finished")}let Some((_,_,actor))=actors.iter().find(|(_,a,_)|a.id==agent_id)else{return fail("unknown_agent")};if actor.disabled{return fail("agent_unavailable")}if !duration.is_finite()||duration.fract()!=0.0||!(1.0..=1000.0).contains(&duration){return fail("invalid_duration")}if self.peer.outages.iter().any(|o|o.agent_id==agent_id){return fail("already_interrupted")}
  let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();next.interrupt(agent_id.clone(),duration,expected)?;let until=expected as u64+duration as u64;
  next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("{} 通信中断 {} 步",actor.name,duration as u64),"type":"warning","kind":"communication_interrupted","agentId":agent_id,"untilTick":until}))?;next.event_binding=Some(binding);self.event_commit(next,control,next_control,ledger,next_ledger)?;encode(&serde_json::json!({"ok":true,"untilTick":until}))
 }
 #[napi]
 pub fn advance_events(&mut self,expected:f64,motion:&crate::world_motion::WorldMotion,environment:&crate::world_environment::WorldEnvironment,control:&mut crate::world_control::WorldControl,ledger:&mut crate::world_ledger::WorldLedger)->Result<String>{
  let(binding,actors,done)=self.event_context(expected,motion,environment,control,ledger)?;if done{return Err(invalid())}
  let devices:Vec<_>=actors.iter().map(|(_,a,e)|Self::event_device(a,e)).collect();let mut obstructions=Vec::new();
  for p in &self.peer.queue{let route=p.route();let hop=p.hop.unwrap_or(0);let a=actors.iter().find(|(_,a,_)|a.id==route[hop]).ok_or_else(invalid)?;let b=actors.iter().find(|(_,a,_)|a.id==route[hop+1]).ok_or_else(invalid)?;let obstructed=self.peer.config.line_of_sight==Some(true)&&!environment.peer_visible(Self::event_position(&a.1,&a.2),Self::event_position(&b.1,&b.2))?;obstructions.push(serde_json::json!({"id":p.id,"obstructed":obstructed}));}
  let context=serde_json::json!({"agents":devices.iter().map(|a|{let mut v=serde_json::json!({"id":a.id,"x":a.x,"y":a.y,"disabled":a.disabled});if let Some(ready)=a.relay_ready{v["relayReady"]=ready.into()}v}).collect::<Vec<_>>(),"obstructions":obstructions});
  let mut next=self.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();let result=next.advance(encode(&context)?,expected)?;let effects:Vec<Effect>=decode(&result)?;
  for effect in &effects{let p=&effect.packet;let hop=effect.hop;
   if effect.transmitted{next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("消息 {} 完成第 {} 跳发送",p.id,hop+1),"type":"info","kind":"message_hop_transmitted","messageId":p.id,"hop":hop+1,"from":effect.source,"to":effect.destination,"bytes":p.text.len()}))?;}
   if p.hop.unwrap_or(0)!=hop{let to=actors.iter().find(|(_,a,_)|a.id==effect.destination).ok_or_else(invalid)?;next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("消息 {} 经 {} 中继",p.id,to.2.name),"type":"info","kind":"message_relayed","messageId":p.id,"relay":effect.destination,"hop":p.hop,"from":p.from,"to":p.to}))?;}
   if effect.state=="delivered"{next_control.task_event(&mut next_ledger,serde_json::json!({"message":format!("消息 {} 已送达",p.id),"type":"success","kind":"message_delivered","messageId":p.id,"from":p.from,"to":p.to}))?;}
   else if effect.state=="failed"{let reason=effect.reason.as_deref().ok_or_else(invalid)?;let label=match reason{"expired"=>"过期","unavailable"=>"设备不可用","interrupted"=>"通信中断","out_of_range"=>"超出范围","obstructed"=>"视线遮挡","dropped"=>"丢包",_=>return Err(invalid())};let mut fact=serde_json::json!({"message":format!("消息 {} 未送达（{}）",p.id,label),"type":"warning","kind":"message_failed","messageId":p.id,"from":p.from,"to":p.to,"reason":reason});if p.via.as_ref().is_some_and(|v|!v.is_empty()){fact["hop"]=(hop+1).into();fact["hopFrom"]=effect.source.clone().into();fact["hopTo"]=effect.destination.clone().into()}next_control.task_event(&mut next_ledger,fact)?;}
  }
  next.event_binding=Some(binding);self.event_commit(next,control,next_control,ledger,next_ledger)?;Ok(result)
 }
 #[napi]
 pub fn send(&mut self,input:String,now:f64)->Result<String>{
  let now=self.now(now)?;let s:Send=decode(&input)?;if !self.devices(&s.agents){return Err(invalid())}
  let fail=|reason:&str|encode(&serde_json::json!({"ok":false,"reason":reason}));
  if s.request_id.as_deref().is_some_and(|id|!token(id)){return fail("invalid_request_id")}
  if let Some(id)=&s.request_id{if let Some(r)=self.peer.message_requests.iter().flatten().find(|r|r.from==s.from&&r.request_id==*id){return if r.to==s.to&&r.text==s.text&&r.via==s.via{encode(&serde_json::json!({"ok":true,"messageId":r.message_id,"duplicate":true}))}else{fail("request_id_conflict")}}}
  if s.done{return fail("world_finished")}
  let Some(from)=self.agents.iter().position(|a|a.id==s.from)else{return fail("unknown_agent")};let Some(to)=self.agents.iter().position(|a|a.id==s.to)else{return fail("unknown_agent")};
  if from==to{return fail("same_agent")}if s.agents[from].disabled{return fail("sender_unavailable")}if s.agents[to].disabled{return fail("recipient_unavailable")}
  let route:Vec<_>=std::iter::once(&s.from).chain(s.via.iter()).chain(std::iter::once(&s.to)).collect();if route.len()>5||route.iter().any(|id|!self.agents.iter().any(|a|a.id==**id))||route.iter().copied().collect::<HashSet<_>>().len()!=route.len(){return fail("invalid_relay_route")}
  if s.via.iter().any(|id|s.agents.iter().any(|a|a.id==*id&&(a.disabled||a.relay_ready==Some(false)))){return fail("relay_unavailable")}
  if blank(&s.text)||s.text.len()>self.peer.config.max_bytes{return fail("invalid_message")}
  if s.request_id.is_some()&&self.peer.message_requests.as_ref().is_some_and(|r|r.len()>=1000){return fail("message_request_limit")}
  let sent=if self.peer.sent_tick==now as i64{self.peer.sent_by.get(&s.from).copied().unwrap_or(0)}else{0};
  if sent>=self.peer.config.max_per_tick{return fail("rate_limit")}if self.peer.queue.len()>=256{return fail("queue_full")}if self.peer.next_id>=9_007_199_254_740_991{return Err(invalid())}
  if self.peer.sent_tick!=now as i64{self.peer.sent_tick=now as i64;self.peer.sent_by.clear();}
  let id=self.peer.next_id;let size=s.text.len()as u64;let rate=self.agents[from].communication_bytes_per_tick.or(self.peer.config.bytes_per_tick);let packet=Packet{id,from:s.from.clone(),to:s.to.clone(),text:s.text.clone(),sent_tick:now,due_tick:now+self.peer.config.delay+rate.map_or(0,|r|(size+r-1)/r-1),expires_tick:now+self.peer.config.ttl,tx_remaining:rate.map(|_|size),via:if s.via.is_empty(){None}else{Some(s.via.clone())},hop:if s.via.is_empty(){None}else{Some(0)},received_tick:None};
  *self.peer.sent_by.entry(s.from.clone()).or_default()+=1;self.peer.next_id+=1;self.peer.queue.push(packet);if let Some(request_id)=s.request_id{self.peer.message_requests.get_or_insert_with(Vec::new).push(Request{request_id,from:s.from,to:s.to,text:s.text,via:s.via,message_id:id});self.last_tick=now;return encode(&serde_json::json!({"ok":true,"messageId":id,"duplicate":false}))}
  self.last_tick=now;encode(&serde_json::json!({"ok":true,"messageId":id}))
 }
 #[napi]
 pub fn interrupt(&mut self,agent_id:String,duration:f64,now:f64)->Result<()> {
  let now=self.now(now)?;if !self.agents.iter().any(|a|a.id==agent_id)||!duration.is_finite()||duration.fract()!=0.0||!(1.0..=1000.0).contains(&duration)||self.peer.outages.iter().any(|o|o.agent_id==agent_id){return Err(invalid())}
  self.peer.outages.push(Outage{agent_id,started_tick:now,until_tick:now+duration as u64});self.last_tick=now;Ok(())
 }
 #[napi]
 pub fn restore(&mut self,now:f64)->Result<()> {let now=self.now(now)?;self.peer.outages.retain(|o|now<=o.until_tick);self.last_tick=now;Ok(())}
 #[napi]
 pub fn advance(&mut self,input:String,now:f64)->Result<String>{
  let now=self.now(now)?;let c:Context=decode(&input)?;if now!=self.last_step+1||!self.devices(&c.agents)||c.obstructions.len()!=self.peer.queue.len()||c.obstructions.iter().zip(&self.peer.queue).any(|(a,b)|a.id!=b.id){return Err(invalid())}
  let packets:Vec<_>=self.peer.queue.iter().zip(&c.obstructions).map(|(p,obstruction)|{let route=p.route();let hop=p.hop.unwrap_or(0);let from=self.agents.iter().position(|a|a.id==route[hop]).unwrap();let to=self.agents.iter().position(|a|a.id==route[hop+1]).unwrap();let a=&c.agents[from];let b=&c.agents[to];serde_json::json!({"id":p.id,"source":a.id,"hop":hop,"viaLength":route.len()-2,"dueTick":p.due_tick,"expiresTick":p.expires_tick,"txRemaining":p.tx_remaining,"size":p.text.len(),"rate":self.agents[from].communication_bytes_per_tick.or(self.peer.config.bytes_per_tick),"relayRate":self.agents[to].communication_bytes_per_tick.or(self.peer.config.bytes_per_tick),"unavailable":a.disabled||b.disabled||hop>0&&a.relay_ready==Some(false)||hop<route.len()-2&&b.relay_ready==Some(false),"interrupted":self.peer.outages.iter().any(|o|(o.agent_id==a.id||o.agent_id==b.id)&&now<=o.until_tick),"outOfRange":(a.x-b.x).hypot(a.y-b.y)>self.agents[from].communication_range.unwrap_or(self.peer.config.range).min(self.agents[to].communication_range.unwrap_or(self.peer.config.range)),"obstructed":self.peer.config.line_of_sight==Some(true)&&obstruction.obstructed})}).collect();
  let input=encode(&serde_json::json!({"tick":now,"seed":self.seed,"delay":self.peer.config.delay,"lossRate":self.peer.config.loss_rate,"packets":packets}))?;let outcomes:Vec<Outcome>=decode(&crate::message_queue_tick(input)?)?;
  let mut waiting=Vec::new();let mut relayed=Vec::new();let mut inboxes=self.peer.inboxes.clone();let mut effects=Vec::new();
  for(old,r)in self.peer.queue.iter().zip(outcomes){let route=old.route();let hop=old.hop.unwrap_or(0);let mut p=old.clone();p.due_tick=r.due_tick;p.tx_remaining=r.tx_remaining;if r.hop!=hop{p.hop=Some(r.hop)}
   if r.id!=p.id{return Err(invalid())}effects.push(Effect{packet:p.clone(),hop,source:route[hop].into(),destination:route[hop+1].into(),transmitted:r.transmitted,state:r.state.clone(),reason:r.reason});
   match r.state.as_str(){"waiting"=>waiting.push(p),"relayed"=>relayed.push(p),"delivered"=>{p.received_tick=Some(now);let inbox=inboxes.get_mut(&p.to).ok_or_else(invalid)?;inbox.push(p);if inbox.len()>20{inbox.remove(0);}},"failed"=>{},_=>return Err(invalid())}
  }
  let encoded=encode(&effects)?;waiting.extend(relayed);self.peer.queue=waiting;self.peer.inboxes=inboxes;self.last_tick=now;self.last_step=now;Ok(encoded)
 }
 #[napi]
 pub fn cancel(&mut self,now:f64)->Result<()>{let now=self.now(now)?;self.peer.queue.clear();self.last_tick=now;Ok(())}
 #[napi]
 pub fn snapshot(&self)->Result<String>{self.active()?;encode(&self.peer)}
 #[napi]
 pub fn free(&mut self){self.closed=true;self.event_binding=None;self.peer.queue.clear();self.peer.inboxes.clear();self.peer.outages.clear();self.peer.message_requests=None;self.peer.sent_by.clear();self.agents.clear();}
}

crate::world_checkpoint::world_checkpoint!(WorldPeer);
