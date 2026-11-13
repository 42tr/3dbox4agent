import {regionKind} from '@42tr/3dbox4agent-world/surface-domain';
/** Administrator interventions use the displayed world; admission remains authoritative. */
export type DisturbanceAgent={recoverableFault?:true;faultGeneration?:number;status?:string;id:string;name:string;battery:number;disabled:boolean;roadblockWait?:unknown};
export type DisturbanceZone={id:string;name:string;surface?:'ground'|'water'|'mixed'};
export type TimedDisturbance={startedTick:number;untilTick:number};
export type DisturbanceContext={worldSize?:number;key:string;observer:boolean;imported:boolean;focused:boolean;latest:boolean;failed:boolean;done:boolean;busy:boolean;running:boolean;tick:number;agents:DisturbanceAgent[];zones:DisturbanceZone[];outages:(TimedDisturbance&{agentId:string})[];effects:(TimedDisturbance&{zoneId:string;speedFactor?:number;energyFactor?:number})[];roads:(TimedDisturbance&{id:string;x:number;y:number;w:number;h:number})[];events:{seq:number;tick:number;message:string;kind:string}[]};
export type DisturbanceDraft={kind:'fault';agentId:string;expectedFaultGeneration?:number}|{kind:'outage';agentId:string;duration:string}|{kind:'energy';agentId:string;level:string}|{kind:'terrain';zoneId:string;duration:string}|{kind:'road';x:string;y:string;w:string;h:string;duration:string};
export type DisturbanceCommand={route:'fault';input:{agentId:string;expectedFaultGeneration?:number}}|{route:'communication-outage';input:{agentId:string;duration:number}}|{route:'low-energy';input:{agentId:string;level:number}}|{route:'terrain-effect';input:{zoneId:string;duration:number}}|{route:'roadblock';input:{rect:{x:number;y:number;w:number;h:number};duration:number}};
export type DisturbanceResult={ok:boolean;reason?:string;refreshPending?:boolean};
export function disturbanceBlock(c:DisturbanceContext):string|null{if(c.observer)return 'read_only';if(c.imported)return 'imported_replay';if(c.focused)return 'agent_view';if(!c.latest)return 'history_view';if(c.failed)return 'session_stopped';if(c.done)return 'world_finished';if(c.busy)return 'busy';return null}
const eventKinds=new Set(['device_fault','rescue_completed','communication_interrupted','communication_restored','low_energy_injected','low_energy_replan','terrain_effect_started','terrain_effect_ended','terrain_route_assessed','terrain_route_replanned','roadblock_started','roadblock_ended','roadblock_replanned','roadblock_wait_started','roadblock_wait_ended']);
export function projectDisturbances(world:any,meta:Omit<DisturbanceContext,'tick'|'agents'|'zones'|'outages'|'effects'|'roads'|'events'>):DisturbanceContext{
 const base={...meta,...(world.worldSize!==undefined?{worldSize:world.worldSize}:{}),tick:world.tick,agents:[],zones:[],outages:[],effects:[],roads:[],events:[]};if(meta.focused)return base;
 return {...base,agents:(world.agents||[]).map((a:any)=>({id:a.id,name:a.name,battery:a.battery,disabled:a.disabled,...(a.recoverableFault?{recoverableFault:true as const,faultGeneration:a.faultGeneration,status:a.status}:{}),...(a.roadblockWait?{roadblockWait:true}:{})})),zones:(world.terrain||[]).map((z:any)=>({id:z.id,name:z.name,...(world.surfaceDomain?{surface:regionKind(world.surfaceDomain,z)}:{})})),outages:(world.communication?.outages||[]).map((o:any)=>({agentId:o.agentId,startedTick:o.startedTick,untilTick:o.untilTick})),effects:(world.terrainEffects||[]).map((e:any)=>({zoneId:e.zoneId,startedTick:e.startedTick,untilTick:e.untilTick,...(Number.isFinite(e.speedFactor)&&e.speedFactor>=.2&&e.speedFactor<=1&&Number.isFinite(e.energyFactor)&&e.energyFactor>=1&&e.energyFactor<=5?{speedFactor:e.speedFactor,energyFactor:e.energyFactor}:{})})),roads:(world.roadblocks||[]).map((b:any)=>({id:b.id,x:b.x,y:b.y,w:b.w,h:b.h,startedTick:b.startedTick,untilTick:b.untilTick})),events:(world.events||[]).filter((e:any)=>eventKinds.has(e.kind)).slice(-12).map((e:any)=>({seq:e.seq,tick:e.tick,message:e.message,kind:e.kind}))};
}
const number=(s:string)=>typeof s==='string'&&s.trim()?Number(s):NaN;
const duration=(s:string)=>{const n=number(s);return Number.isInteger(n)&&n>=1&&n<=1000?n:null};
export function prepareDisturbance(c:DisturbanceContext,d:DisturbanceDraft):{command?:DisturbanceCommand;reason?:string}{
 if(!d||!['fault','outage','energy','terrain','road'].includes(d.kind))return {reason:'invalid_input'};
 if(d.kind==='fault'){
  const a=c.agents.find(a=>a.id===d.agentId);if(!a)return {reason:'selection_changed'};
  if(a.recoverableFault){if(!Number.isSafeInteger(d.expectedFaultGeneration)||d.expectedFaultGeneration!<0||d.expectedFaultGeneration!>10_000_000)return {reason:'invalid_fault'};if(d.expectedFaultGeneration!==a.faultGeneration)return {reason:'fault_changed'}}else if(d.expectedFaultGeneration!==undefined)return {reason:'invalid_fault'};
  if(a.disabled)return {reason:'agent_unavailable'};return {command:{route:'fault',input:{agentId:a.id,...(a.recoverableFault?{expectedFaultGeneration:d.expectedFaultGeneration}:{})}}};
 }
 if(d.kind==='energy'||d.kind==='outage'){
  const a=c.agents.find(a=>a.id===d.agentId);if(!a)return {reason:'selection_changed'};if(a.disabled)return {reason:'agent_unavailable'};
  if(d.kind==='energy'){const level=number(d.level);if(!Number.isFinite(level)||level<1||level>5||level>=a.battery)return {reason:'invalid_energy_level'};return {command:{route:'low-energy',input:{agentId:a.id,level}}}}
  const n=duration(d.duration);if(n===null)return {reason:'invalid_duration'};if(c.outages.some(o=>o.agentId===a.id))return {reason:'already_interrupted'};return {command:{route:'communication-outage',input:{agentId:a.id,duration:n}}};
 }
 if(d.kind==='terrain'){
  if(!c.zones.some(z=>z.id===d.zoneId))return {reason:'unknown_zone'};const n=duration(d.duration);if(n===null)return {reason:'invalid_duration'};if(c.effects.some(e=>e.zoneId===d.zoneId))return {reason:'zone_already_affected'};return {command:{route:'terrain-effect',input:{zoneId:d.zoneId,duration:n}}};
 }
 if(d.kind==='road'){
  const [x,y,w,h]=[d.x,d.y,d.w,d.h].map(number),n=duration(d.duration);if(n===null)return {reason:'invalid_duration'};if(![x,y,w,h].every(Number.isFinite)||x<0||y<0||w<2||h<2||x+w>(c.worldSize??100)||y+h>(c.worldSize??100))return {reason:'invalid_roadblock'};if(c.roads.length>=8)return {reason:'roadblock_limit'};return {command:{route:'roadblock',input:{rect:{x,y,w,h},duration:n}}};
 }
 return {reason:'invalid_input'};
}
const messages:Record<string,string>=Object.assign(Object.create(null),{invalid_fault:'设备或故障代次格式无效，请重新选择。',fault_changed:'设备的故障代次已变化，请查看最新状态后再决定是否注入新故障。',read_only:'当前为只读观察，不能注入扰动。',imported_replay:'导入回放不可修改，请重新开始后操作。',agent_view:'请返回全局视图后注入扰动。',history_view:'当前显示历史快照，请返回实时视图后操作。',session_stopped:'当前会话无法继续控制，请重新连接。',world_finished:'本次运行已结束，请重新开始后操作。',busy:'正在处理其他操作，请稍候。',context_changed:'运行或视图已切换，请检查当前状态。',selection_changed:'设备状态已变化，请重新选择。',agent_unavailable:'该设备已退出，不能注入此扰动。',unknown_agent:'该设备已不在当前运行中。',unknown_zone:'当前没有所选地表区域。',invalid_duration:'持续步数须为1到1000的整数。',invalid_energy_level:'剩余电量须为1到5，且低于设备当前电量。',already_interrupted:'该设备已经处于通信中断，请等待恢复。',zone_already_affected:'该区域已经受到扰动，请等待恢复。',invalid_roadblock:'坐标须在0到100内，宽和长至少为2，矩形不能越界。',agent_in_roadblock:'区域覆盖地面设备或其安全留距，请调整封闭范围。',route_owner_unavailable:'现有路线无法关联任务或动作，请检查世界状态。',roadblock_limit:'最多同时封闭8处，请等待已有道路恢复。',stale_revision:'世界已推进，请查看最新状态后重新提交；可先暂停世界。',world_step_failed:'世界执行失败，已保留最后提交状态，请重新连接后检查。',unauthorized:'管理员凭据已失效，请重新连接。',forbidden:'当前凭据没有注入扰动的权限。'});
export function disturbanceMessage(reason?:string):string{return messages[reason||'']||'结果未确认，请检查最新状态与事件后再操作。'}
type Environment={read:()=>DisturbanceContext;setBusy:(v:boolean)=>void;send:(command:DisturbanceCommand)=>DisturbanceResult|Promise<DisturbanceResult>;refresh:()=>void|Promise<void>;onError?:(e:unknown)=>void};
export function createDisturbanceController(env:Environment){
 const pending=new Set<string>();
 return async(key:string,draft:DisturbanceDraft):Promise<DisturbanceResult>=>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};const block=disturbanceBlock(c);if(block)return {ok:false,reason:block};if(pending.has(key))return {ok:false,reason:'busy'};
  const prepared=prepareDisturbance(c,draft);if(!prepared.command)return {ok:false,reason:prepared.reason};
  const current=()=>env.read().key===key,applicable=()=>{const now=env.read();return now.key===key&&!disturbanceBlock({...now,busy:false})};pending.add(key);
  const refresh=async()=>{try{await env.refresh();return true}catch(e){if(current())env.onError?.(e);return false}};
  try{
   env.setBusy(true);const result=await env.send(prepared.command);if(!applicable())return {ok:false,reason:'context_changed'};
   if(!result||typeof result.ok!=='boolean'){await refresh();return {ok:false,reason:applicable()?'request_failed':'context_changed'}};
   const synced=await refresh();if(!applicable())return {ok:false,reason:'context_changed'};
   return result.ok?{ok:true,...(!synced?{refreshPending:true}:{})}:{ok:false,reason:messages[result.reason||'']?result.reason:'request_failed'};
  }catch(error){
   if(!current())return {ok:false,reason:'context_changed'};const e=error as {message?:string;status?:number};if(e.status!==400&&e.status!==409)env.onError?.(error);if(!applicable())return {ok:false,reason:'context_changed'};
   await refresh();return applicable()?{ok:false,reason:messages[e.message||'']?e.message:'request_failed'}:{ok:false,reason:'context_changed'};
  }finally{pending.delete(key);if(current())env.setBusy(false)}
 };
}
