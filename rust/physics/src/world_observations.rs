//! Scoped device reads from bound native participants. No host snapshot, route,
//! visibility proof, report source or replacement observation is accepted.
use super::*;
use crate::{world_motion::WorldMotion,world_environment::WorldEnvironment,world_tasks::WorldTasks,world_actions::WorldActions,world_resources::WorldResources,world_peer::WorldPeer,world_reports::WorldReports,world_perceptions::WorldPerceptions};
use serde_json::json;
fn value(input:String)->Result<Value>{serde_json::from_str(&input).map_err(|_|invalid())}
fn selected(rows:&Value,id:&str)->Vec<Value>{rows.as_array().into_iter().flatten().filter(|r|r["agentId"].as_str()==Some(id)).cloned().collect()}
impl WorldControl {
    pub(super) fn observation_context(&self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,ledger:&WorldLedger)->Result<[u64;9]>{
        self.validate_commit(ledger)?;let now=self.linked(ledger)?;
        let actors=motion.lifecycle_agents()?;let ids:Vec<_>=actors.iter().map(|(_,a,_)|a.id.clone()).collect();let(all,_)=tasks.ending_tasks()?;let catalog:Vec<_>=all.iter().map(|t|t.id.clone()).collect();
        let(c,l,_,_)=self.proposal_context(now as u32,&ids,&catalog,ledger)?;
        let e=environment.dispatch_context(now,&actors)?;let(t,_)=tasks.revocation_context("",&actors,&catalog)?;let(a,_)=actions.ending_context(now as u32,&ids)?;
        let roster:Vec<_>=actors.iter().map(|(_,a,e)|(a.id.clone(),e.role.clone(),e.capabilities.iter().any(|c|c=="inspect"))).collect();let(r,site)=resources.proposal_catalog(now,&all,&roster)?;
        let(p,config)=peer.report_context(now,&ids,self.state.seed)?;let report=reports.dispatch_context(now,&actors,site,self.state.seed,&config["config"],ledger)?;let perception=perceptions.proposal_catalog(now as u32,&all,&roster)?;
        let m=motion.environment_identity([e,r,t,a,c,l])?;tasks.environment_binding([m,e,r,a,c,l])?;actions.collision_identity([m,e,r,t,c,l])?;
        Ok([m,e,t,a,r,p,report,perception,l])
    }
}
#[napi]
impl WorldControl {
    #[napi]
    pub fn bind_agent_observations(&mut self,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,ledger:&WorldLedger)->Result<()>{
        let binding=self.observation_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,ledger)?;
        if self.observation_binding.is_some_and(|old|old!=binding){return Err(invalid())}
        self.observation_binding=Some(binding);Ok(())
    }
    #[napi]
    pub fn agent_observations_bound(&self)->Result<bool>{self.active()?;Ok(self.observation_binding.is_some())}
    #[napi]
    pub fn agent_observation(&self,agent_id:String,expected:f64,motion:&WorldMotion,environment:&WorldEnvironment,tasks:&WorldTasks,actions:&WorldActions,resources:&WorldResources,peer:&WorldPeer,reports:&WorldReports,perceptions:&WorldPerceptions,ledger:&WorldLedger)->Result<String>{
        let binding=self.observation_context(motion,environment,tasks,actions,resources,peer,reports,perceptions,ledger)?;
        let now=self.linked(ledger)?;if self.observation_binding!=Some(binding)||expected!=now as f64{return Err(invalid())}
        let actors=motion.lifecycle_agents()?;let Some((_,agent,execution))=actors.iter().find(|(_,a,_)|a.id==agent_id)else{return Ok("null".into())};
        let config=value(peer.snapshot()?)?;let environment_view=environment.observation_map()?;let actor_view=serde_json::to_value(execution).map_err(|_|invalid())?;
        let mut self_view=json!({"id":agent.id,"role":execution.role,"x":agent.x,"y":agent.y,"battery":agent.battery,"status":execution.status,"sensorRange":execution.sensor_range.map_or(environment_view["sensorRange"].clone(),Value::from),"communicationRange":execution.communication_range.map_or(config["config"]["range"].clone(),Value::from),"communicationBytesPerTick":execution.communication_bytes_per_tick.map_or(config["config"].get("bytesPerTick").cloned().unwrap_or(Value::Null),Value::from),"moveEnergyPerUnit":execution.move_energy_per_unit.unwrap_or(0.045),"workEnergyPerTick":execution.work_energy_per_tick.unwrap_or(0.08),"capabilities":execution.capabilities,"routeBlockedSince":actor_view["roadblockWait"].get("startedTick").cloned().unwrap_or(Value::Null),"returnEnergyEstimate":environment.observed_return_energy(&agent.id,[agent.x,agent.y],execution.move_energy_per_unit.unwrap_or(0.045),execution.speed,execution.operating_energy_per_tick)?,"communicationInterrupted":config["outages"].as_array().into_iter().flatten().any(|o|o["agentId"].as_str()==Some(agent_id.as_str())&&o["untilTick"].as_u64().is_some_and(|until|now<=until))});
        if let Some(rate)=execution.operating_energy_per_tick{self_view["operatingEnergyPerTick"]=json!(rate);self_view["operatingState"]=json!(execution.operating_state)}
        if let Some(p)=&execution.rescue{self_view["rescue"]=json!(p)}if execution.recoverable_fault==Some(true){self_view["recoverableFault"]=true.into();self_view["faultGeneration"]=json!(execution.fault_generation.ok_or_else(invalid)?)}
        if execution.deployable_relay==Some(true){self_view["deployableRelay"]=true.into();self_view["relayState"]=json!(execution.relay_state.as_ref().ok_or_else(invalid)?)}
        if let(Some(p),Some(s))=(&execution.thermal,&execution.thermal_state){self_view["thermal"]=p.observation(s)?}
        if let Some(v)=resources.observed_materials(&agent.id)?{self_view["materialReservations"]=v}
        if let Some(h)=environment.heightfield()?{let surface=h.surface(agent.x,agent.y);self_view["elevation"]=json!(surface[0]);self_view["slopeDegrees"]=json!(surface[3])}
        if let Some(mobility)=&execution.mobility{self_view["mobility"]=mobility.clone().into()}
        if let Some(line)=config["config"].get("lineOfSight"){self_view["communicationLineOfSight"]=line.clone()}
        let(all,_)=tasks.ending_tasks()?;let resource=value(resources.snapshot()?)?;let primitive=matches!(self.state.execution_mode,Some(Execution::Primitive));let air=execution.mobility.as_deref().map_or(execution.role=="drone",|m|m=="air");
        let mut assigned=Vec::new();for task in &all{let t=serde_json::to_value(task).map_err(|_|invalid())?;if t["assignee"].as_str()!=Some(agent_id.as_str()){continue}
            let mut row=json!({"id":t["id"],"name":t["name"],"target":t["target"],"status":t["status"]});
            if primitive&&task.status==crate::world_tasks::Status::Active{
                let waypoint=if task.behavior==crate::world_tasks::Behavior::Deliver&&matches!(task.phase.flatten(),Some(crate::world_tasks::Phase::ToPickup|crate::world_tasks::Phase::Loading)){resource["part"]["position"].clone()}else{t["target"].clone()};
                let within=if waypoint.is_null(){false}else{let goal:[f64;2]=serde_json::from_value(waypoint.clone()).map_err(|_|invalid())?;environment.activation_reachable([agent.x,agent.y],goal,air)?};
                if !waypoint.is_null(){let goal:[f64;2]=serde_json::from_value(waypoint.clone()).map_err(|_|invalid())?;if let Some(p)=environment.observed_approach(&agent.id,[agent.x,agent.y],goal)?{row["approachPoint"]=json!(p)}}
                row["behavior"]=t["behavior"].clone();row["phase"]=t["phase"].clone();row["waypoint"]=waypoint;row["withinReach"]=within.into();
            }assigned.push(row);
        }
        let perception=value(perceptions.snapshot()?)?;let data=&perception[&agent_id];let current:Vec<Value>=data["current"].as_array().cloned().unwrap_or_default();
        let mut memory=Vec::new();for item in data["memory"].as_array().into_iter().flatten(){let mut row=item.clone();row["current"]=current.iter().any(|c|c["kind"]==item["kind"]&&c["id"]==item["id"]).into();row["age"]=(now-item["observedTick"].as_u64().ok_or_else(invalid)?).into();memory.push(row)}
        let report=value(reports.snapshot()?)?;let mode=match self.state.execution_mode.unwrap_or(Execution::Auto){Execution::Auto=>"auto",Execution::Agent=>"agent",Execution::Primitive=>"primitive"};
        let mut observation=json!({"version":2,"tick":now,"done":ledger.done()?,"executionMode":mode,"self":self_view,"nearby":current.iter().filter(|r|r["kind"]=="agent").collect::<Vec<_>>(),"visibleTargets":current.iter().filter(|r|r["kind"]=="target").collect::<Vec<_>>(),"assignedTasks":assigned,"memory":memory,"inbox":config["inboxes"][&agent_id],"actions":selected(&value(actions.snapshot()?)?,&agent_id),"evidenceReports":selected(&report["evidenceReports"],&agent_id)});
        if all.iter().any(|t|t.behavior==crate::world_tasks::Behavior::Sample){observation["sampleReports"]=json!(selected(&report["sampleReports"],&agent_id));observation["samples"]=json!(ledger.entries()?.iter().filter(|e|e["kind"]=="sample_collected"&&e["agentId"].as_str()==Some(agent_id.as_str())).map(|e|json!({"taskId":e["taskId"],"position":e["position"],"collectedTick":e["tick"]})).collect::<Vec<_>>())}
        encode(&observation)
    }
}
