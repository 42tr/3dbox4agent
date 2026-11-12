//! Coupled base electrical load before observations, communication and actions.
use super::*;
use crate::{world_motion::WorldMotion,world_environment::WorldEnvironment,world_tasks::WorldTasks,world_actions::WorldActions,world_resources::WorldResources};

impl WorldControl{
 pub(crate) fn operating_energy_phase(&mut self,now:u32,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,ledger:&mut WorldLedger)->Result<()>{
  let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();
  let(control,owner,_,_,done)=self.assignment_context(now,&ids,ledger)?;
  if now==0||done{return Err(invalid())}
  let motion_id=actors.first().map(|(_,a,_)|a.id.as_str()).ok_or_else(invalid).and_then(|id|motion.activation_components(id).map(|(_,_,_,id)|id))?;
  let(env,_)=environment.time_context(now as u64,&ids)?;let task_id=tasks.time_identity()?;let action_id=actions.interruption_identity(&ids,now)?;let(resource_id,_)=resources.assignment_context(None,now)?;
  self.interruption_components(task_id,[motion_id,env,resource_id,action_id,control,owner])?;
  if !motion.has_operating_energy()?{return Ok(())}
  let mut next=self.clone();let mut m=motion.clone();let mut t=tasks.clone();let mut a=actions.clone();let mut r=resources.clone();let mut l=ledger.clone();
  for id in m.operating_phase(now)?{
   let result:Value=serde_json::from_str(&t.operating_depleted(&id,now,&mut m,environment,&mut r,&mut a,&next,&l)?).map_err(|_|invalid())?;
   if result["ok"]!=true{return Err(invalid())}let(_,_,actor,_)=m.activation_components(&id)?;
   for effect in result["effects"].as_array().ok_or_else(invalid)?{
    let event=match effect["kind"].as_str().ok_or_else(invalid)?{
     "action_status"=>a.operating_action_event(effect["index"].as_u64().ok_or_else(invalid)? as usize,&actor.name)?,
     "part_dropped"=>serde_json::json!({"kind":"part_dropped","message":"运输中断，备件留在当前位置","type":"warning","agentId":id,"taskId":effect["taskId"]}),
     "wait_cancelled"=>WorldActions::lifecycle_wait_fact(&actor.name,&id,&effect["wait"])?,
     "energy_depleted"=>{let mut event=effect.clone();event["message"]=format!("{} 基础运行耗电后电量耗尽{}",actor.name,if effect.get("taskId").is_some(){"，任务重新分配"}else{""}).into();event["type"]="warning".into();event},
     _=>return Err(invalid()),
    };next.task_event(&mut l,event)?;
   }
  }
  next.validate_commit(&l)?;*self=next;*motion=m;*tasks=t;*actions=a;*resources=r;*ledger=l;Ok(())
 }
}
#[napi]
impl WorldControl{
 #[napi]
 pub fn advance_operating_energy(&mut self,expected:f64,motion:&mut WorldMotion,environment:&WorldEnvironment,tasks:&mut WorldTasks,actions:&mut WorldActions,resources:&mut WorldResources,ledger:&mut WorldLedger)->Result<()>{
  if !expected.is_finite()||expected.fract()!=0.0||!(1.0..=MAX_TICK as f64).contains(&expected){return Err(invalid())}
  self.operating_energy_phase(expected as u32,motion,environment,tasks,actions,resources,ledger)
 }
}
