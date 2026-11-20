import React, {useEffect, useRef, useState} from 'react';
import {consoleFetch,useConsoleSession} from './console-session';

type Run = {run_id:string; owner_label:string; status:string; phase:string; control_epoch:number; tick:number; world_revision:number; objective:{instruction:string}; conditions?:{task_id:string;done:boolean}[]; archive_status:string; can_observe:boolean; result?:{success:boolean;reason:string}; reason?:string};
type RunEvent = {seq:number;run_id:string;kind:string;tick:number;world_revision:number;occurred_at_ms:number;payload:Record<string,any>};
type Integration = {id:string;label:string;expires_at:number;revoked:boolean};
type Access = {format:string;sessionId:string;observerToken:string};
type View = {run:Run|null;events:RunEvent[];connection:string};
let view:View={run:null,events:[],connection:''};
const listeners=new Set<()=>void>();
function publish(next:View){view=next;listeners.forEach(fn=>fn())}
const labels:Record<string,string>={starting:'创建世界',running:'执行中',stopping:'正在归档',completed:'已完成',failed:'失败',cancelled:'已取消',timeout:'达到预算上限',waiting_for_agent:'等待 Agent 下一步',advancing:'世界正在推进',paused:'已暂停',reconciling:'正在确认上次操作',archiving:'正在归档',finished:'运行结束'};
const kinds:Record<string,string>={'agent.note':'Agent 摘要','tool.started':'开始调用','tool.completed':'调用返回','tool.failed':'调用失败','tool.observed':'读取观察','world.updated':'World 变化','run.created':'创建运行','run.session_created':'世界已创建','run.recovered':'运行已恢复','run.recovery_unavailable':'等待连接 World','run.reconciling':'确认上次操作','run.idle_paused':'等待超时，已暂停','run.stopping':'准备结束运行','run.advancing':'推进世界','run.started':'运行就绪','objective.evaluated':'目标验收','run.finished':'运行结束','run.interrupted':'控制操作','run.advance_finished':'本段推进结束'};
const terminal=(r:Run)=>['completed','failed','cancelled','timeout'].includes(r.status);
export function readRunLink(){return /^#run=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(location.hash)?.[1]||''}

async function request<T>(route:string,options:RequestInit={}):Promise<T>{
  const response=await consoleFetch('/runs/v1'+route,options);
  const data=await response.json();if(!response.ok)throw Error(data.code||data.error||'请求失败');return data;
}

type OpenRunLink = (kind:'observer'|'report',load:()=>Promise<unknown>,signal:AbortSignal)=>Promise<void>;

export function AgentRunLink({runId,open}:{runId:string;open:OpenRunLink}){
  const session=useConsoleSession(!!runId),{authenticated}=session;
  const [notice,setNotice]=useState(''),[error,setError]=useState(false);
  useEffect(()=>{
    if(!runId||!authenticated)return;
    const abort=new AbortController(),{signal}=abort;
    const route='/runs/'+runId;
    let timer:ReturnType<typeof setTimeout>;
    setError(false);
    setNotice('正在打开运行的三维观察…');
    async function connect(){
      try{
        const run=await request<Run>(route,{signal});
        if(signal.aborted)return;
        if(run.archive_status==='ready'){
          await open('report',()=>request(route+'/report',{signal}),signal);
        }else if(run.status==='starting'||run.status==='stopping'&&run.archive_status==='pending'){
          timer=setTimeout(connect,1000);
          return;
        }else if(run.can_observe&&run.status!=='stopping'){
          try{
            await open('observer',()=>request(route+'/observer',{method:'POST',body:'{}',signal}),signal);
          }catch(e){
            if(signal.aborted)return;
            const latest=await request<Run>(route,{signal});
            if(latest.status!=='stopping'&&!terminal(latest))throw e;
            if(!signal.aborted)timer=setTimeout(connect,1000);
            return;
          }
        }else{
          throw Error('此运行没有可用的实时观察或回放。');
        }
        if(!signal.aborted)setNotice('');
      }catch(e){
        if(signal.aborted)return;
        const message=e instanceof Error?e.message:'请求失败';
        setError(true);
        setNotice(message==='run_not_found'?'找不到此运行。':'无法打开三维观察：'+message);
      }
    }
    void connect();
    return()=>{abort.abort();clearTimeout(timer)};
  },[authenticated,runId,open]);
  if(!runId||session.loading)return null;
  if(!authenticated&&!session.configured)return <p className="mc-agent-empty" role="alert">{session.error||'请通过已配置登录的 Console 打开观察链接。'}</p>;
  return notice?<p className="mc-agent-empty" role={error?'alert':'status'}>{notice}</p>:null;
}

export function AgentRunTimeline({focusAgent,showEmpty=true}:{focusAgent?:(id:string)=>void;showEmpty?:boolean}){
  const [current,setCurrent]=useState(view);
  useEffect(()=>{const update=()=>setCurrent(view);listeners.add(update);update();return()=>{listeners.delete(update)}},[]);
  const {run,events,connection}=current;
  if(!run)return showEmpty?<div className="mc-agent-empty">从左侧“Agent 任务”选择运行并打开实时观察，即可查看工具调用和任务进展。</div>:null;
  return <section className="mc-agent-timeline" aria-label="Agent 执行过程">
    <div className="mc-agent-run-heading"><b>{run.objective.instruction}</b><span>{terminal(run)?labels[run.status]:labels[run.phase]||run.phase} · T+{run.tick}</span></div>
    <p className="mc-agent-meta">{run.owner_label} · {run.conditions?.filter(c=>c.done).length||0}/{run.conditions?.length||0} 个目标完成 · {connection}</p>
    {run.result&&<p className={run.result.success?'mc-agent-success':''}>验收：{run.result.success?'World 已确认目标完成':run.result.reason}</p>}
    <ol className="mc-agent-events">{events.filter(e=>e.kind!=='world.updated'||e.payload.events?.length).slice(-150).map(e=><li key={e.seq}>
      <time title={new Date(e.occurred_at_ms).toLocaleString()}>T+{e.tick??0}</time><div><b>{kinds[e.kind]||e.kind}</b><span>{e.payload.tool||e.payload.kind||''}</span>
      {e.kind==='agent.note'?<p>{e.payload.text}</p>:e.kind==='world.updated'?e.payload.events?.map((w:any,i:number)=><p key={i}>{w.message||w.kind}</p>):<p>{e.payload.code||e.payload.stop_reason||e.payload.reason||e.payload.outcome||''}</p>}
      {e.payload.agent_id&&focusAgent&&<button className="mc-pill" onClick={()=>focusAgent(e.payload.agent_id)}>查看 {e.payload.agent_id}</button>}
      <details><summary>记录详情 · #{e.seq}</summary><pre>{JSON.stringify(e.payload,null,2)}</pre></details></div>
    </li>)}</ol>
    <small>工具返回“接受”后，执行结果由 World 后续事件确认。摘要为 Agent 提交的说明。</small>
  </section>;
}

export function AgentRunPanel({active,canObserve,openObserver,openReplay}:{active:boolean;canObserve:boolean;openObserver:(access:Access)=>Promise<void>;openReplay:(load:()=>Promise<unknown>)=>Promise<void>}){
  const [runs,setRuns]=useState<Run[]>([]),[selected,setSelected]=useState(readRunLink),[integrations,setIntegrations]=useState<Integration[]>([]),[label,setLabel]=useState('我的 Agent'),[issued,setIssued]=useState<{token:string;integration:Integration}|null>(null),[error,setError]=useState(''),[actionError,setActionError]=useState(''),[busy,setBusy]=useState(false);
  const session=useConsoleSession(active||!!selected),authenticated=session.authenticated;
  const current=runs.find(r=>r.run_id===selected);const selectedRef=useRef(selected);selectedRef.current=selected;
  const requests=useRef(new Map<string,string>());
  const endpoint=location.protocol==='file:'?'请从在线 Console 打开':location.origin+'/control/mcp/control';
  useEffect(()=>{const change=()=>{const id=readRunLink();if(id)setSelected(id)};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change)},[]);
  useEffect(()=>{
    if(!authenticated||!active&&!selected)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function update(){try{const data=await request<{runs:Run[]}>('/runs',{signal:abort.signal});if(abort.signal.aborted)return;setRuns(data.runs);setError('');const chosen=data.runs.find(r=>r.run_id===selectedRef.current);if(chosen)publish({...view,run:chosen});}catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'无法读取运行')}finally{if(!abort.signal.aborted)timer=setTimeout(update,1000)}}
    void update();return()=>{abort.abort();clearTimeout(timer)};
  },[authenticated,active,selected]);
  useEffect(()=>{
    if(!authenticated||!selected)return;const abort=new AbortController();let cursor=0,timer:ReturnType<typeof setTimeout>;
    publish({run:runs.find(r=>r.run_id===selected)||null,events:[],connection:'连接记录流…'});
    async function connect(){try{
      const response=await consoleFetch(`/runs/v1/runs/${encodeURIComponent(selected)}/events/stream?after=${cursor}`,{signal:abort.signal});
      if(abort.signal.aborted)return;if(!response.ok||!response.body)throw Error('执行记录连接失败');publish({...view,connection:'实时记录'});
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(!abort.signal.aborted){const {value,done}=await reader.read();if(done||abort.signal.aborted)break;buffer+=decoder.decode(value,{stream:true});let boundary;
        while((boundary=buffer.search(/\r?\n\r?\n/))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+(buffer[boundary]==='\r'?4:2));const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data)continue;const event=JSON.parse(data) as RunEvent;if(event.run_id!==selected||event.seq<=cursor)continue;cursor=event.seq;publish({...view,events:[...view.events,event].slice(-300)});}
      }
    }catch(e){if(!abort.signal.aborted)publish({...view,connection:'连接中断，正在补拉记录…'})}finally{if(!abort.signal.aborted)timer=setTimeout(connect,1000)}}
    void connect();return()=>{abort.abort();clearTimeout(timer)};
  },[authenticated,selected]);
  useEffect(()=>{if(active&&authenticated)void request<{integrations:Integration[]}>('/integrations').then(v=>setIntegrations(v.integrations)).catch(()=>setIntegrations([]))},[active,authenticated]);
  async function perform(fn:()=>Promise<void>){setBusy(true);setActionError('');try{await fn()}catch(e){setActionError(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}}
  async function command(name:string){if(!current)return;const key=current.run_id+':'+name+':'+current.control_epoch;let id=requests.current.get(key);if(!id){id=crypto.randomUUID();requests.current.set(key,id)}const next=await request<Run>(`/runs/${current.run_id}/commands/${name}`,{method:'POST',body:JSON.stringify({control_epoch:current.control_epoch,request_id:id})});requests.current.delete(key);setRuns(rows=>rows.map(r=>r.run_id===next.run_id?next:r));publish({...view,run:next});}
  return <section className="mc-runner-panel mc-agent-panel" aria-label="Agent 任务">
    <p>将 Control 配置为 MCP 服务，在外部 Agent 中提出任务。这里查看同一次运行的三维状态、工具记录和验收结果。</p>
    {!authenticated&&<p role="status">{session.loading?'正在检查登录状态…':session.error||'请联系管理员配置 Console 登录账号。'}</p>}
    {!!(error||actionError)&&<p role="alert">{error||actionError}</p>}
    <h2>任务运行</h2>
    <ul className="mc-runner-runs">{runs.map(run=><li key={run.run_id} className={selected===run.run_id?'mc-agent-selected':''}><div><b>{run.objective.instruction}</b><small>{run.owner_label} · {run.run_id.slice(0,8)}</small><small>{terminal(run)?labels[run.status]:labels[run.phase]||run.phase} · T+{run.tick}</small></div><button className="mc-pill" onClick={()=>setSelected(run.run_id)}>选择运行</button></li>)}</ul>
    {authenticated&&!runs.length&&<p>暂无运行。签发接入凭据后，让外部 Agent 创建任务。</p>}
    {selected&&!current&&authenticated&&<p>正在查找链接中的运行。</p>}
    {current&&<div className="mc-agent-detail"><h2>{current.objective.instruction}</h2><div className="mc-runner-actions">
      <button className="mc-pill violet" disabled={busy||!current.can_observe||!canObserve} onClick={()=>void perform(async()=>openObserver(await request<Access>(`/runs/${selected}/observer`,{method:'POST',body:'{}'})))}>打开三维观察与执行记录</button>
      <button className="mc-pill" disabled={busy||current.archive_status!=='ready'} onClick={()=>void perform(()=>openReplay(()=>request(`/runs/${selected}/report`)))}>打开回放</button>
      <button className="mc-pill" disabled={busy||terminal(current)||current.status==='stopping'} onClick={()=>void perform(()=>command(current.phase==='paused'?'resume_run':'pause_run'))}>{current.phase==='paused'?'恢复':'暂停'}</button>
      <button className="mc-pill" disabled={busy||terminal(current)||current.status==='stopping'} onClick={()=>void perform(()=>command('cancel_run'))}>停止运行</button>
    </div><AgentRunTimeline/></div>}
    <details><summary>Agent 接入配置</summary><label>MCP 地址<input readOnly value={endpoint}/></label><p>支持 Streamable HTTP，认证头为 Authorization: Bearer &lt;接入令牌&gt;。外部 Agent 使用独立接入凭据。</p>
      <form className="mc-runner-form" onSubmit={e=>{e.preventDefault();void perform(async()=>{const value=await request<{token:string;integration:Integration}>('/integrations',{method:'POST',body:JSON.stringify({label})});setIssued(value);setIntegrations(rows=>[...rows,value.integration])})}}><label>Agent 名称<input value={label} maxLength={100} onChange={e=>setLabel(e.target.value)}/></label><button className="mc-pill violet" disabled={busy||!authenticated||!label.trim()}>签发接入凭据</button></form>
      {issued&&<div><p>令牌仅在本次签发后显示，请保存到 Agent 的凭据配置。</p><label>接入令牌<input readOnly type="password" value={issued.token}/></label><button className="mc-pill" onClick={()=>void perform(()=>navigator.clipboard.writeText(issued.token))}>复制令牌</button><details><summary>stdio 配置示例</summary><pre>{JSON.stringify({mcpServers:{'3dbox':{command:'/absolute/path/threebox-mcp-stdio',env:{BOX_CONTROL_URL:location.origin+'/control',BOX_CONTROL_TOKEN:'<接入令牌>'}}}},null,2)}</pre></details></div>}
      <ul className="mc-runner-runs">{integrations.map(i=><li key={i.id}><div>{i.label}<small>{i.revoked?'已撤销':'有效至 '+new Date(i.expires_at*1000).toLocaleDateString()}</small></div><button className="mc-pill" disabled={busy||i.revoked} onClick={()=>void perform(async()=>{await request('/integrations/'+i.id,{method:'DELETE'});setIntegrations(rows=>rows.map(r=>r.id===i.id?{...r,revoked:true}:r));if(issued?.integration.id===i.id)setIssued(null)})}>撤销接入</button></li>)}</ul>
    </details>
  </section>;
}
