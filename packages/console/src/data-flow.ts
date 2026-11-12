/** A read-only projection of the displayed frame. Device scope never reads world queues. */
import {projectCommunicationRecovery,type CommunicationRecoveryView} from './communication-recovery';
export type FlowChannel='peer'|'dispatch'|'status'|'fixed'|'scan'|'sample';
export type FlowState='pending'|'delivered'|'failed';
export type FlowRow={key:string;channel:FlowChannel;id:string;from:string;to:string;state:FlowState;tick:number;due?:number;expires?:number;captured?:number;received?:number;reason?:string;task?:string;via?:string[];hop?:number;stale?:boolean};
export type FlowView={tick:number;scope:string|null;rows:FlowRow[];pending:number;delivered:number;failed:number;outages:{agentId:string;until:number}[];reporting:null|{active:boolean;sent:number;delivered:number;failed:number;pending:number;fresh:number;stored:number;maxAge:number};config:null|{delay:number;ttl:number;lossRate:number};available:boolean;recovery?:CommunicationRecoveryView|null};
export const flowChannels:{id:FlowChannel;label:string}[]=[{id:'peer',label:'设备消息'},{id:'dispatch',label:'任务指令'},{id:'status',label:'状态报告'},{id:'fixed',label:'固定传感器'},{id:'scan',label:'扫描报告'},{id:'sample',label:'采样报告'}];
const reasons:Record<string,string>=Object.assign(Object.create(null),{expired:'超过有效期',unavailable:'设备不可用',interrupted:'通信中断',out_of_range:'超出通信范围',obstructed:'链路被遮挡',dropped:'链路丢包',run_ended:'运行已结束',mode_changed:'指挥方式已切换',not_available:'分配条件已变化',route_unavailable:'路线不可达'});
export const flowReason=(reason?:string)=>reason?(reasons[reason]||'具体原因请查看事件记录'):'';
const time=(n:any):n is number=>Number.isSafeInteger(n)&&n>=0;
const list=(v:any):any[]=>Array.isArray(v)?v:[];
export function projectDataFlow(world:any,observation:any,selected='global'):FlowView{
 const tick=time(world?.tick)?world.tick:0,scope=selected==='global'?null:typeof selected==='string'?selected:'';
 const result:FlowView={tick,scope,rows:[],pending:0,delivered:0,failed:0,outages:[],reporting:null,config:null,available:false};
 const rows=new Map<string,FlowRow>();
 const add=(channel:FlowChannel,id:any,from:any,to:any,state:FlowState,p:any,at:any)=>{
  if(id===undefined||typeof from!=='string'||typeof to!=='string'||!time(at)||at>tick)return;
  const row:FlowRow={key:channel+':'+id,channel,id:String(id),from,to,state,tick:at};
  for(const [key,value]of [['due',p.dueTick],['expires',p.expiresTick],['captured',p.capturedTick??p.observedTick??p.collectedTick],['received',p.receivedTick]] as const)if(time(value)&&(key==='due'||key==='expires'||value<=tick))row[key]=value;
  if(typeof p.reason==='string')row.reason=p.reason;
  if(typeof p.taskId==='string')row.task=p.taskId;
  if(Array.isArray(p.via)&&p.via.every((v:any)=>typeof v==='string'))row.via=p.via.slice();
  if(time(p.hop))row.hop=p.hop;
  rows.set(row.key,row);
 };
 const reports=(source:any,channel:'scan'|'sample',owner?:string)=>{
  for(const r of list(source))if((!owner||r.agentId===owner)&&['pending','delivered','failed'].includes(r.status))add(channel,r.id,r.agentId,'指挥者',r.status,r,r.appliedTick??r.submittedTick);
 };
 if(scope!==null){
  // Do not fall back to global state when the selected observation is absent or stale.
  if(!observation||observation.self?.id!==scope||observation.tick!==tick)return result;
  result.available=true;
  for(const p of list(observation.inbox))if(p.to===scope)add('peer',p.id,p.from,p.to,'delivered',p,p.receivedTick);
  reports(observation.evidenceReports,'scan',scope);reports(observation.sampleReports,'sample',scope);
 }else{
  const net=world?.communication;if(!net)return result;result.available=true;
  const recovery=projectCommunicationRecovery(world);if(recovery)result.recovery=recovery;
  if(net.config)result.config={delay:net.config.delay,ttl:net.config.ttl,lossRate:net.config.lossRate};
  // Events supply outcomes after queues are consumed. Payloads and free-form log text stay out.
  for(const e of list(world.events)){
   const peer={message_sent:'pending',message_relayed:'pending',message_delivered:'delivered',message_failed:'failed'} as const;
   const dispatch={dispatch_sent:'pending',dispatch_delivered:'delivered',dispatch_failed:'failed'} as const;
   const fixed={fixed_sensor_sent:'pending',fixed_sensor_delivered:'delivered',fixed_sensor_failed:'failed'} as const;
   if(Object.prototype.hasOwnProperty.call(peer,e.kind))add('peer',e.messageId,e.from,e.to,peer[e.kind as keyof typeof peer],e,e.tick);
   else if(Object.prototype.hasOwnProperty.call(dispatch,e.kind))add('dispatch',e.dispatchId,'指挥者',e.agentId,dispatch[e.kind as keyof typeof dispatch],e,e.tick);
   else if(Object.prototype.hasOwnProperty.call(fixed,e.kind))add('fixed',e.reportId,e.sensorId,'指挥者',fixed[e.kind as keyof typeof fixed],e,e.tick);
  }
  for(const p of list(net.queue))add('peer',p.id,p.from,p.to,'pending',p,p.sentTick);
  for(const inbox of Object.values(net.inboxes||{}))for(const p of list(inbox))add('peer',p.id,p.from,p.to,'delivered',p,p.receivedTick);
  for(const p of list(net.dispatchQueue))add('dispatch',p.id,'指挥者',p.agentId,'pending',p,p.observedTick);
  reports(world.evidenceReports,'scan');reports(world.sampleReports,'sample');
  for(const p of list(world.fixedSensorState?.queue))add('fixed',p.id,p.sensorId,'指挥者','pending',p,p.observedTick);
  // Latest fixed receipts replace older receipts in the engine; their event records above remain.
  for(const p of Object.values<any>(world.fixedSensorState?.reports||{}))add('fixed',p.reportId,p.sensorId,'指挥者','delivered',p,p.receivedTick);
  const reporting=net.reporting;
  if(reporting){
   let fresh=0,stored=0;
   for(const p of Object.values<any>(reporting.reports||{})){
    if(!time(p.capturedTick)||!time(p.receivedTick)||p.capturedTick>tick||p.receivedTick>tick)continue;
    const stale=tick-p.capturedTick>reporting.maxAge;if(!stale)fresh++;stored++;
    add('status','latest:'+p.id,p.id,'指挥者','delivered',p,p.receivedTick);
    const row=rows.get('status:latest:'+p.id);if(row)row.stale=stale;
   }
   for(const p of list(reporting.queue))add('status',p.id,p.agentId,'指挥者','pending',p,p.capturedTick);
   result.reporting={active:world.dispatchMode==='networked_reported',sent:reporting.sent,delivered:reporting.delivered,failed:reporting.failed,pending:list(reporting.queue).length,fresh,stored,maxAge:reporting.maxAge};
  }
  result.outages=list(net.outages).filter(o=>typeof o.agentId==='string'&&time(o.untilTick)&&o.untilTick>=tick).map(o=>({agentId:o.agentId,until:o.untilTick}));
 }
 result.rows=[...rows.values()].sort((a,b)=>b.tick-a.tick||a.key.localeCompare(b.key,undefined,{numeric:true}));
 for(const row of result.rows)result[row.state]++;
 return result;
}
export function filterFlow(view:FlowView,channel:string,state:string,limit=40){
 const rows=view.rows.filter(r=>(channel==='all'||r.channel===channel)&&(state==='all'||r.state===state));
 return {total:rows.length,rows:rows.slice(0,Math.max(0,Math.min(100,limit)))};
}
