import React,{useId,useState} from 'react';
import {CaretRight} from '@phosphor-icons/react';
import type {DeviceAction} from './device-actions';

type Reading = {id:string; category:string; source:string; result:string; tick:number; detail?:string; warning?:boolean; points?:NonNullable<DeviceAction['result']>['points']};
type Contact = {id:string; kind:string; role?:string; status?:string; current?:boolean; observedTick:number; distanceM:number; x:number; y:number};
type DeviceSnapshot = {
  profile:{id:string}; observedTick:number; observations:Contact[]; actions:DeviceAction[];
  samples?:{taskId:string; position:number[]; collectedTick:number}[];
};
type SensorReading = {sensorId:string; reportId:number; result:string; position:number[]; observedTick:number; receivedTick:number};
export type FixedSensor = {id:string; name:string; pose:{x:number;y:number;z:number}; profile:{rangeM:number;intervalTicks:number}; reading:SensorReading|null};

const contactNames = new Map([['drone','无人机'],['rover','勘察车'],['vehicle','运输车'],['robot','机器人'],['relay','中继车'],['boat','作业船']]);
const scanResults = new Map([['anomaly','发现异常'],['normal','状态正常'],['not_detected','未探测到目标']]);
const position = (p:unknown) => Array.isArray(p)&&p.length>=2&&p.every(Number.isFinite)?`${p.map(n=>n.toFixed(1)).join(' / ')} m`:undefined;
const validTick = (value:number|undefined,through:number):value is number =>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=through;

export function projectDeviceObservations(snapshot:DeviceSnapshot):Reading[] {
  const rows:Reading[]=[];
  const through=snapshot.observedTick;
  for(const contact of snapshot.observations){
    if(!validTick(contact.observedTick,through))continue;
    const role=contactNames.get(contact.role??'');
    const number=/-([0-9]+)$/.exec(contact.id)?.[1];
    const name=contact.kind==='target'?`目标 ${contact.id}`:role&&number?`${role} ${number}`:contact.id;
    const distance=contact.current&&Number.isFinite(contact.distanceM)?` · ${contact.distanceM.toFixed(1)} m`:'';
    const point=position([contact.x,contact.y]);
    rows.push({id:`contact:${contact.kind}:${contact.id}`,category:'perception',source:'周边感知',tick:contact.observedTick,
      result:name+distance, detail:[point,contact.status==='fault'?'故障':'',contact.current===false?'历史观测':''].filter(Boolean).join(' · '),warning:contact.status==='fault'});
  }
  for(const action of snapshot.actions){
    if(action.agentId!==snapshot.profile.id||action.type!=='scan'||action.status!=='completed')continue;
    const result=action.result;
    if(!result?.kind||!validTick(result.observedTick,through))continue;
    const id=`scan:${action.requestId}`,tick=result.observedTick;
    if(result.kind==='terrain_scan'){
      const points=result.points??[];
      rows.push({id,category:'terrain',source:'地形扫描',result:`${points.length} 个观测点`,detail:`${points.filter(p=>p.traversable).length} 个可直线通行`,points,tick});
    }else if(result.kind==='access_point'){
      rows.push({id,category:'terrain',source:'标记通行点',result:position(result.position)??'通行点已标记',
        detail:Number.isFinite(result.elevationM)?`高程 ${result.elevationM!.toFixed(1)} m`:undefined,tick});
    }else{
      rows.push({id,category:'scan',source:'主动扫描',result:scanResults.get(result.kind)??result.kind,
        detail:position(result.position),tick,warning:result.kind==='anomaly'});
    }
  }
  for(const sample of snapshot.samples??[]){
    if(!validTick(sample.collectedTick,through))continue;
    rows.push({id:`sample:${sample.taskId}:${sample.collectedTick}`,category:'sample',source:'采样',
      result:sample.taskId,detail:position(sample.position),tick:sample.collectedTick});
  }
  return rows.sort((a,b)=>b.tick-a.tick);
}

type SensorEvent = {kind?:string; sensorId?:string; reportId?:number; result?:string; position?:number[]; observedTick?:number; tick:number};

export function projectSensorObservations(sensor:FixedSensor,events:SensorEvent[],through:number):Reading[] {
  const reports=new Map<number,Reading>();
  function add(id:number,result:string,point:number[]|undefined,observedTick:number,receivedTick:number){
    if(!validTick(observedTick,through)||!validTick(receivedTick,through)||receivedTick<observedTick)return;
    reports.set(id,{id:`sensor:${id}`,category:'sensor',source:'固定传感器',result:scanResults.get(result)??result,
      detail:[position(point),`T+${receivedTick} 送达`].filter(Boolean).join(' · '),tick:observedTick,warning:result==='anomaly'});
  }
  for(const event of events){
    if(event.kind!=='fixed_sensor_delivered'||event.sensorId!==sensor.id||event.reportId===undefined||event.result===undefined||event.observedTick===undefined)continue;
    add(event.reportId,event.result,event.position,event.observedTick,event.tick);
  }
  const latest=sensor.reading;
  if(latest?.sensorId===sensor.id)add(latest.reportId,latest.result,latest.position,latest.observedTick,latest.receivedTick);
  return Array.from(reports.values()).sort((a,b)=>b.tick-a.tick);
}

export function DeviceObservations({rows,children}:{rows:Reading[];children?:React.ReactNode}){
  const [expanded,setExpanded]=useState(false);
  const tableId=useId();
  const categories=new Set<string>();
  const preview=rows.filter(row=>{
    if(categories.size>=2||categories.has(row.category))return false;
    categories.add(row.category);
    return true;
  });
  // Fill the second row with a recent reading if there is only one source.
  if(preview.length===1&&rows.length>1)preview.push(rows[1]);
  return <section className="mc-object-observations" aria-label="观测数据">
    <div className="mc-inspector-heading">
      <h4>观测数据</h4>
      {rows.length>preview.length&&<button type="button" className="mc-observation-expand" aria-controls={tableId}
        aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起记录':'查看全部'}<CaretRight size={13} aria-hidden="true"/></button>}
    </div>
    {rows.length?<table id={tableId}>
      <thead><tr><th scope="col">数据来源</th><th scope="col">观测结果</th><th scope="col">采集步</th></tr></thead>
      <tbody>{(expanded?rows:preview).map(row=><tr key={row.id}>
        <th scope="row">{row.source}</th>
        <td><span className={row.warning?'mc-observation-warning':undefined}>{row.result}</span>
          {row.detail&&<small>{row.detail}</small>}
          {!!row.points?.length&&<details><summary>观测点详情</summary><ul>{row.points.map((point,index)=><li key={index}>
            {position(point.position)} · 高程 {point.elevationM.toFixed(1)} m · 坡度 {point.slopeDeg.toFixed(1)}° · {point.traversable?'可通行':'不可通行'}
          </li>)}</ul></details>}
        </td>
        <td>T+{row.tick}</td>
      </tr>)}</tbody>
    </table>:<p className="mc-inspector-note">当前快照暂无该对象的观测记录。</p>}
    {children}
  </section>;
}
