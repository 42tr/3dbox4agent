import React,{useEffect,useRef,useState} from 'react';
import {credentialBlock,credentialMessage,type CredentialResult} from './device-credentials';
import type {DeviceContext} from './device-actions';
type Props={context:DeviceContext;issue:(key:string,agentId:string,rescueSearch?:boolean)=>Promise<CredentialResult>;select:(agentId:string)=>void};
export function DeviceProcessControls({context:c,issue,select}:Props){
 const [pending,setPending]=useState(false),[command,setCommand]=useState(''),[feedback,setFeedback]=useState(''),[serial,setSerial]=useState(0),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const [rescueSearch,setRescueSearch]=useState(false),block=credentialBlock(c),disabled=!!block||pending,canRescue=!!c.agents.find(a=>a.id===c.selected)?.rescueWorkTicks;
 const sign=async()=>{if(disabled)return;setCommand('');setFeedback('正在签发…');setPending(true);try{const result=await issue(c.key,c.selected,canRescue&&rescueSearch);if(!alive.current)return;if(result.ok&&result.command){setCommand(result.command);setSerial(n=>n+1);setFeedback('凭据已签发。请在项目目录运行启动命令。')}else setFeedback(credentialMessage(result.reason))}catch{if(alive.current)setFeedback(credentialMessage())}finally{if(alive.current)setPending(false)}};
 const copy=async()=>{if(disabled||!command)return;try{if(!navigator.clipboard?.writeText)throw Error('unavailable');await navigator.clipboard.writeText(command);if(alive.current)setFeedback('已复制启动命令。')}catch{if(alive.current)setFeedback('无法自动复制，请展开启动命令并选中文本复制。')}};
 return <section className="mc-device-process" aria-label="独立设备进程"><div className="mc-report-heading"><h3 tabIndex={-1}>独立设备进程</h3><span>Python SDK · 当前世界</span></div><div className="mc-report-device"><label>进程设备<select aria-label="进程设备" value={c.selected} disabled={pending||c.busy||!c.agents.length} onChange={e=>select(e.target.value)}>{c.agents.length?c.agents.map(a=><option key={a.id} value={a.id}>{a.name} · {a.id}</option>):<option value="">暂无可见设备</option>}</select></label></div>
  {block&&!(block==='busy'&&pending)&&<p className="mc-assignment-notice">{credentialMessage(block)}</p>}
  <p className="mc-report-hint">在设备启动或单体分步模式中，进程接续已分配任务，并可自主补能、上报采样。再次签发会立即使当前设备的旧凭据失效。</p>
  {canRescue&&!block&&<label className="mc-report-hint"><input type="checkbox" checked={rescueSearch} disabled={disabled} onChange={e=>{setRescueSearch(e.target.checked);setCommand('');setFeedback('')}}/>启用巡查救援：空闲时巡查，发现本机可见故障后接近并救援；巡查遇到新任务或低电量会中止。</label>}
  <button className="mc-pill violet" disabled={disabled} onClick={()=>void sign()}>{pending?'正在签发…':'签发新设备凭据（旧凭据失效）'}</button>
  {feedback&&(!block||pending&&block==='busy')&&<p className="mc-assignment-feedback" role="status" aria-live="polite">{feedback}</p>}
  {command&&!block&&<div className="mc-process-command"><div className="mc-device-action-buttons"><button className="mc-pill" disabled={disabled} onClick={()=>void copy()}>复制设备启动命令</button><button className="mc-pill" disabled={disabled} onClick={()=>{setCommand('');setFeedback('已从本页清除命令；已签发凭据仍然有效。')}}>从本页清除命令</button></div><details key={serial}><summary>显示启动命令（含设备凭据）</summary><pre tabIndex={0} aria-label="设备进程启动命令">{command}</pre></details><p className="mc-report-hint">命令包含本设备凭据，请仅交给该设备进程。切换设备或运行后，本页不再保留此命令。</p></div>}
 </section>;
}
