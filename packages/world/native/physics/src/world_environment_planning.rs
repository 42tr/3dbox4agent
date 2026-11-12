//! Environment transitions plan from owned routes/maps and publish the whole
//! route/wait/event batch. No target, route or planner callback crosses N-API.
use super::*;
use crate::world_actions::WorldActions;
use crate::world_control::WorldControl;
use crate::world_execution::{Execution,Status};
use crate::world_ledger::WorldLedger;
use crate::world_motion::{Motion,WorldMotion};
use crate::world_resources::WorldResources;
use crate::world_tasks::{Task,WorldTasks};
use serde_json::{json,Value};

#[derive(Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
enum Disturbance {
    Roadblock{rect:Rect,duration:u64},
    Terrain{#[serde(rename="zoneId")]zone_id:String,duration:u64,#[serde(rename="speedFactor")]speed_factor:f64,#[serde(rename="energyFactor")]energy_factor:f64},
}
struct Context {actors:Vec<(usize,Motion,Execution)>,tasks:Vec<Task>,binding:[u64;6],assess:bool,done:bool}
impl WorldEnvironment {
    fn planning_context(&self,now:u64,motion:&WorldMotion,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,control:&WorldControl,ledger:&WorldLedger,pending:bool)->Result<Context>{
        let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();
        let e=self.dispatch_context(now,&actors)?;let(t,_)=tasks.revocation_context("",&actors,&catalog)?;let(c,l,done,assess)=control.environment_context(now,&ids,&catalog,ledger,pending)?;
        let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|cap|cap=="inspect"))).collect();let(r,_)=resources.proposal_catalog(now,&all,&roster)?;let(a,_)=actions.ending_context(now as u32,&ids)?;
        let m=motion.environment_identity([e,r,t,a,c,l])?;tasks.environment_binding([m,e,r,a,c,l])?;actions.collision_identity([m,e,r,t,c,l])?;
        let binding=[m,r,t,a,c,l];if self.planning_binding.is_some_and(|b|b!=binding){return Err(invalid())}Ok(Context{actors,tasks:all,binding,assess,done})
    }
    fn terrain_routes(&self,now:u64,transition:&str,zones:&[String],motion:&mut WorldMotion,control:&mut WorldControl,ledger:&mut WorldLedger,assess:bool)->Result<()>{
        let metric=self.state.navigation.unwrap_or(Navigation::Distance);if matches!(metric,Navigation::Distance){return Ok(())}
        let terrain:Value=decode(&self.effective_terrain()?)?;let policy=serde_json::to_value(metric).map_err(|_|invalid())?;
        for(i,agent,mut execution)in motion.lifecycle_agents()?{
            if self.agents[i].air||execution.disabled||!matches!(execution.status,Status::Manual|Status::Working)||execution.route.is_empty(){continue}
            let start=[agent.x,agent.y];let goal=*execution.route.last().ok_or_else(invalid)?;let path=self.planned_route(&agent.id,start,goal,true,false)?;
            let previous=crate::navigation::environment_route_cost(start,&execution.route,terrain.clone(),policy.clone(),self.state.heightfield.as_ref())?;
            let next=path.as_ref().map(|p|crate::navigation::environment_route_cost(start,p,terrain.clone(),policy.clone(),self.state.heightfield.as_ref())).transpose()?;
            let result=match next{None=>"unreachable",Some(cost)if cost>=previous-1e-6=>"retained",_=>"changed"};
            if assess{control.task_event(ledger,json!({"message":format!("{} 地表路线评估：{}",execution.name,match result{"changed"=>"调整","retained"=>"保持原路线",_=>"未找到路线"}),"type":if result=="unreachable"{"warning"}else{"info"},"kind":"terrain_route_assessed","agentId":agent.id,"transition":transition,"zoneIds":zones,"policy":metric,"result":result,"previousCost":previous,"newCost":next}))?}
            if result!="changed"{continue}
            execution.route=path.ok_or_else(invalid)?;execution.blocked_ticks=Some(0);execution.progress_waypoint=Some(String::new());
            control.task_event(ledger,json!({"message":format!("{} 因地表条件变化调整路线",execution.name),"type":"info","kind":"terrain_route_replanned","agentId":agent.id,"transition":transition,"policy":metric,"previousCost":previous,"newCost":next}))?;
            motion.commit_stationary(i,agent,execution)?;
        }
        let _=now;Ok(())
    }
    pub(crate) fn restored_road_routes(&mut self,now:u64,expired:bool,motion:&mut WorldMotion,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,control:&mut WorldControl,ledger:&mut WorldLedger)->Result<()>{
        let context=self.planning_context(now,motion,tasks,actions,resources,control,ledger,true)?;
        let mut next_motion=motion.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
        for(i,agent,mut execution)in context.actors{
            let Some((wait,valid,route))=execution.environment_wait(&context.tasks,actions)?else{continue};
            let resumed=if valid&&expired{let goal=serde_json::from_value(wait["goal"].clone()).map_err(|_|invalid())?;if let Some(path)=self.interaction_route(&agent.id,[agent.x,agent.y],goal,if let Some(id)=wait["owner"]["requestId"].as_str(){actions.interaction_radius(id)?}else{3.7},true,false)?{if route{execution.route=path}true}else{false}}else{false};
            if valid&&!resumed{continue}execution.activation_clear_wait()?;
            next_control.task_event(&mut next_ledger,json!({"message":format!("{} {}",execution.name,if resumed{"恢复通行"}else{"结束道路等待"}),"type":if resumed{"success"}else{"info"},"kind":"roadblock_wait_ended","agentId":agent.id,"roadblockId":wait["roadblockId"],"startedTick":wait["startedTick"],"outcome":if resumed{"resumed"}else{"cancelled"}}))?;
            next_motion.commit_stationary(i,agent,execution)?;
        }
        self.planning_binding=Some(context.binding);*motion=next_motion;*control=next_control;*ledger=next_ledger;Ok(())
    }
    pub(crate) fn restored_terrain_routes(&mut self,now:u64,zones:&[String],motion:&mut WorldMotion,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,control:&mut WorldControl,ledger:&mut WorldLedger)->Result<()>{
        let context=self.planning_context(now,motion,tasks,actions,resources,control,ledger,true)?;let mut next_motion=motion.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
        if !zones.is_empty(){self.terrain_routes(now,"ended",zones,&mut next_motion,&mut next_control,&mut next_ledger,context.assess)?}
        self.planning_binding=Some(context.binding);*motion=next_motion;*control=next_control;*ledger=next_ledger;Ok(())
    }
}
#[napi]
impl WorldEnvironment {
    #[napi]
    pub fn inject_events(&mut self,input:String,expected:f64,motion:&mut WorldMotion,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,control:&mut WorldControl,ledger:&mut WorldLedger)->Result<String>{
        let now=self.time(expected)?;let command:Disturbance=decode(&input)?;let context=self.planning_context(now,motion,tasks,actions,resources,control,ledger,false)?;
        if context.done{return Ok("{\"ok\":false,\"reason\":\"world_finished\"}".into())}
        let mut next=self.clone();let mut next_motion=motion.clone();let mut next_control=control.clone();let mut next_ledger=ledger.clone();
        let result=match command{
            Disturbance::Roadblock{rect:r,duration}=>{
                if !rect(r.x,r.y,r.w,r.h,2.0)||!(1..=1000).contains(&duration){return Ok("{\"ok\":false,\"reason\":\"invalid_roadblock\"}".into())}
                if self.blocks().count()>=8{return Ok("{\"ok\":false,\"reason\":\"roadblock_limit\"}".into())}
                let rect=json!({"x":r.x,"y":r.y,"w":r.w,"h":r.h});
                for(i,agent,_)in &context.actors{if !self.agents[*i].air&&crate::navigation::environment_route_blocked([agent.x,agent.y],&[[agent.x,agent.y]],rect.clone())?{return Ok("{\"ok\":false,\"reason\":\"agent_in_roadblock\"}".into())}}
                let barrier:Value=decode(&next.roadblock(encode(&json!({"rect":rect,"duration":duration,"eventId":next_ledger.entries()?.len()+1,"agents":context.actors.iter().map(|(_,a,_)|json!({"id":a.id,"x":a.x,"y":a.y})).collect::<Vec<_>>()}))?,expected)?)?;
                // Preflight every affected route/owner before any event is appended.
                let mut routes=Vec::new();for(i,agent,execution)in &context.actors{
                    if execution.disabled||self.agents[*i].air||execution.route.is_empty()||!crate::navigation::environment_route_blocked([agent.x,agent.y],&execution.route,rect.clone())?{continue}
                    let Some(owner)=execution.environment_owner(&context.tasks,actions)?else{return encode(&json!({"ok":false,"reason":"route_owner_unavailable","agentId":agent.id}))};
                    let goal=*execution.route.last().ok_or_else(invalid)?;let path=next.planned_route(&agent.id,[agent.x,agent.y],goal,true,false)?;routes.push((*i,agent.clone(),execution.clone(),owner,goal,path));
                }
                let mut event=barrier.clone();event["message"]="临时道路封闭已生效".into();event["type"]="warning".into();event["kind"]="roadblock_started".into();next_control.task_event(&mut next_ledger,event)?;
                let(mut replanned,mut waiting)=(0,0);for(i,agent,mut execution,(request,task),goal,path)in routes{
                    if let Some(path)=path{execution.route=path;execution.blocked_ticks=Some(0);execution.progress_waypoint=Some(String::new());replanned+=1;next_control.task_event(&mut next_ledger,json!({"message":format!("{} 绕行临时封闭区域",execution.name),"type":"info","kind":"roadblock_replanned","roadblockId":barrier["id"],"agentId":agent.id}))?}
                    else{execution.activation_wait(goal,barrier["id"].as_str().ok_or_else(invalid)?.to_owned(),now as u32,request,task)?;waiting+=1;next_control.task_event(&mut next_ledger,json!({"message":format!("{} 道路不可达，等待封闭解除",execution.name),"type":"warning","kind":"roadblock_wait_started","agentId":agent.id,"roadblockId":barrier["id"],"goal":goal,"mode":"route"}))?}
                    next_motion.commit_stationary(i,agent,execution)?;
                }
                json!({"ok":true,"roadblock":barrier,"replanned":replanned,"waiting":waiting})
            },
            Disturbance::Terrain{zone_id,duration,speed_factor,energy_factor}=>{
                if !self.state.terrain.iter().flatten().any(|z|z.id==zone_id){return Ok("{\"ok\":false,\"reason\":\"unknown_zone\"}".into())}
                if !(1..=1000).contains(&duration)||!factors(speed_factor,energy_factor){return Ok("{\"ok\":false,\"reason\":\"invalid_effect\"}".into())}
                if self.effects().any(|e|e.zone_id==zone_id){return Ok("{\"ok\":false,\"reason\":\"zone_already_affected\"}".into())}
                let effect:Value=decode(&next.effect(encode(&json!({"zoneId":zone_id,"duration":duration,"speedFactor":speed_factor,"energyFactor":energy_factor}))?,expected)?)?;
                let mut event=effect.clone();event["message"]=format!("{} 通行条件恶化 {} 步",self.time_zone_name(&zone_id)?,duration).into();event["type"]="warning".into();event["kind"]="terrain_effect_started".into();next_control.task_event(&mut next_ledger,event)?;
                next.terrain_routes(now,"started",&[zone_id],&mut next_motion,&mut next_control,&mut next_ledger,context.assess)?;json!({"ok":true,"effect":effect})
            },
        };
        next_control.validate_commit(&next_ledger)?;let encoded=encode(&result)?;next.planning_binding=Some(context.binding);*self=next;*motion=next_motion;*control=next_control;*ledger=next_ledger;Ok(encoded)
    }
}
