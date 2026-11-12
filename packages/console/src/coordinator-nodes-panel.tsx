import React,{useEffect,useRef,useState} from 'react';
import type {CoordinatorMeta} from './task-coordination';
import {nodeRegistryBlock,nodeRegistryMessage,type NodeView,type RegistryOperation,type RegistryResult,type CoordinatorRoster} from './coordinator-nodes';

const states:Record<string,string>={accepted:'已接受',pending:'在途',rejected:'被拒绝',failed:'失败'};
const kinds={decision:'分配',proposal:'提案',revocation:'撤回'};
export function CommandNodesPanel({view:v,manage}:{view?:NodeView;manage?:()=>void}){
 const [selected,setSelected]=useState('all');
 if(!v||v.kind!=='global')return <p className="mc-node-empty">指挥节点记录只在全局视图显示。</p>;
 const chosen=v.nodes.some(n=>n.key===selected)?selected:'all',records=v.records.filter(r=>chosen==='all'||r.nodeKey===chosen);
 return <section className="mc-command-nodes" aria-label="指挥节点快照"><header><div><h2>指挥节点</h2><p>当前显示快照 T+{v.tick} · 按指令来源汇总</p></div>{manage&&<button className="mc-pill" onClick={manage}>当前凭据名单</button>}</header>
  <p>记录表示已提交的协议操作。任务分片由规划器约定；具名指挥共享有限指挥观察，不能读取全局世界或管理凭据。未命名入口可能来自默认协调者或管理员，记录无法区分。进程运行状态未采集。</p>
  {v.management&&<aside className="mc-node-management" aria-label="导入的管理进程记录"><strong>导入的管理进程记录 · 未认证</strong><p>{'text'in v.management?v.management.text:'管理进程记录未通过校验，未展示故障或接管结论。'}</p></aside>}
  {!v.nodes.length?<p className="mc-node-empty">当前快照还没有外部指挥记录。</p>:<div className="mc-node-grid">{v.nodes.map(n=><article key={n.key}><h3>{n.name}</h3><dl><div><dt>已接受分配</dt><dd>{n.accepted}</dd></div><div><dt>在途</dt><dd>{n.pending}</dd></div><div><dt>拒绝／失败</dt><dd>{n.rejected}</dd></div><div><dt>提案／撤回</dt><dd>{n.proposals} / {n.revocations}</dd></div></dl><p>最近记录 T+{n.lastTick}</p><strong>当前分配来源 · {n.active.length}</strong>{n.active.length?<ul>{n.active.map(t=><li key={t.id}>{t.name} → {t.agentId}<small>分配版本 {t.assignmentId}</small></li>)}</ul>:<p>没有与当前分配版本匹配的接受记录。</p>}</article>)}</div>}
  {v.unattributedActive>0&&<p>{v.unattributedActive} 项当前分配没有匹配到外部指挥来源；可能来自规则、人工分配或缺失的记录。</p>}
  <label className="mc-node-filter">记录筛选<select aria-label="指挥节点记录筛选" value={chosen} onChange={e=>setSelected(e.target.value)}><option value="all">全部指挥入口</option>{v.nodes.map(n=><option key={n.key} value={n.key}>{n.name}</option>)}</select></label>
  <ol className="mc-node-records">{records.map((r,i)=><li key={r.kind+'/'+r.nodeKey+'/'+r.requestId+'/'+i}><time>T+{r.tick}</time><span>{v.nodes.find(n=>n.key===r.nodeKey)?.name||r.nodeKey.replace(/^named:/,'')} · {kinds[r.kind]} · {r.taskName}{r.agentId?' → '+r.agentId:''}<small>{states[r.status]} · {r.requestId}</small></span></li>)}</ol>
  {(v.omittedNodes>0||v.omittedRecords>0)&&<p>最多展示32个入口及最近100条记录；另有 {v.omittedNodes} 个入口、{v.omittedRecords} 条记录。</p>}
 </section>;
}

type Props={context?:CoordinatorMeta;request:(key:string,op:RegistryOperation)=>Promise<RegistryResult>};
export function NodeRegistryControls({context:c,request}:Props){
 const [roster,setRoster]=useState<CoordinatorRoster|null>(null),[id,setId]=useState('node-1'),[count,setCount]=useState('1'),[index,setIndex]=useState('0'),[command,setCommand]=useState(''),[feedback,setFeedback]=useState(''),[pending,setPending]=useState(false),[serial,setSerial]=useState(0),alive=useRef(true);
 const block=c?nodeRegistryBlock(c):'needs_service',writeBlock=c?nodeRegistryBlock(c,true):'needs_service';
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{if(block&&block!=='busy'){setRoster(null);setCommand('');setFeedback('')}},[block]);
 useEffect(()=>{if(writeBlock&&writeBlock!=='busy')setCommand('')},[writeBlock]);
 if(!c)return null;
 const visible=!block||block==='busy'&&pending,disabled=!!writeBlock||pending;
 const run=async(op:RegistryOperation)=>{
  if(pending||block)return;setCommand('');setFeedback('正在处理指挥凭据…');setPending(true);
  try{const r=await request(c.key,op);if(!alive.current)return;
   if(r.ok&&r.roster){setRoster(r.roster);setFeedback('名单已刷新；凭据有效不表示进程在线。')}
   else if(r.ok){setRoster(null);setCommand(r.command||'');setSerial(n=>n+1);setFeedback(op.kind==='issue'?'具名指挥凭据已签发；同名旧凭据已失效。请刷新名单后继续管理。':'凭据已撤销；已排队指令仍由世界规则处理。请刷新名单后继续管理。')}
   else {if(r.reason==='roster_changed'||r.reason==='node_not_found')setRoster(null);setFeedback(nodeRegistryMessage(r.reason))}
  }catch{if(alive.current)setFeedback(nodeRegistryMessage())}finally{if(alive.current)setPending(false)}
 };
 const copy=async()=>{try{await navigator.clipboard.writeText(command);if(alive.current)setFeedback('已复制具名规划器命令。')}catch{if(alive.current)setFeedback('请展开命令并选中文本复制。')}};
 const number=(s:string)=>/^\d+$/.test(s)?Number(s):NaN;
 return <section className="mc-node-registry" id="command-nodes" aria-label="当前指挥凭据"><h2 tabIndex={-1}>当前指挥凭据</h2><p>管理员读取当前会话的凭据名单。名单属于服务管理状态，独立于世界快照和历史回放；不会显示令牌或密钥摘要。节点是否运行、规划器分片及其故障检测由外部进程管理。</p>
  {block&&block!=='busy'&&<p>{nodeRegistryMessage(block)}</p>}
  <button className="mc-pill violet" disabled={!!block||pending} onClick={()=>void run({kind:'read'})}>刷新指挥凭据名单</button>
  {visible&&<><p role="status" aria-live="polite">{feedback}</p>{roster&&<><p>读取于 T+{roster.tick} · 世界版本 {roster.worldRevision} · 凭据版本 {roster.rosterRevision}</p><p>默认协调者凭据：{roster.legacyCredentialActive?'已签发':'未签发'}。同一具名节点轮换凭据保留其记录标识，任务分片不构成服务器授权隔离。</p>
   <ul className="mc-node-roster">{roster.named.map(n=><li key={n.id}><code>{n.id}</code><span>凭据有效 · 进程状态未知</span><button className="mc-pill" disabled={disabled} onClick={()=>void run({kind:'revoke',id:n.id,rosterRevision:roster.rosterRevision})}>撤销 {n.id} 凭据</button></li>)}</ul>{!roster.named.length&&<p>尚未签发具名指挥凭据。</p>}
   <form onSubmit={e=>{e.preventDefault();void run({kind:'issue',id,rosterRevision:roster.rosterRevision,shardCount:number(count),shardIndex:number(index)})}}><fieldset disabled={disabled}><legend>签发或轮换具名指挥凭据</legend><label>节点标识<input aria-label="指挥节点标识" value={id} maxLength={40} onChange={e=>setId(e.target.value)}/></label><label>规划器分片数<input aria-label="指挥规划器分片数" type="number" min={1} max={16} value={count} onChange={e=>setCount(e.target.value)}/></label><label>规划器分片索引<input aria-label="指挥规划器分片索引" type="number" min={0} max={15} value={index} onChange={e=>setIndex(e.target.value)}/></label><button className="mc-pill violet">签发具名规划器命令</button></fieldset></form></>}
   {command&&!writeBlock&&<div className="mc-process-command"><p>规划器通过指挥协议分配任务，需要外部指挥模式。多个规划器使用相同分片数和不同索引。</p><button className="mc-pill" onClick={()=>void copy()}>复制具名规划器命令</button><button className="mc-pill" onClick={()=>{setCommand('');setFeedback('命令已从页面清除，凭据仍然有效。')}}>清除具名命令</button><details key={serial}><summary>显示具名规划器命令（含凭据）</summary><pre tabIndex={0}>{command}</pre></details></div>}
  </>}
 </section>;
}
