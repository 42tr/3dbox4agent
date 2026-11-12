import {projectDataFlow,type FlowRow} from './data-flow';
export type MessagePeer={id:string;name:string;source:'global'|'sensor'|'memory'|'inbox'|'route';disabled:boolean;relayReady?:boolean;observedTick?:number};
export type MessageInput={to:string;text:string;via:string[];requestId:string};
export type MessageDraft={to:string;text:string;via:string[]};
export type MessageMeta={key:string;observer:boolean;imported:boolean;latest:boolean;failed:boolean;done:boolean;busy:boolean;focused:boolean;selected:string;senders:{id:string;name:string;disabled:boolean}[]};
export type MessageContext=MessageMeta&{tick:number;maxBytes:number|null;peers:MessagePeer[];records:FlowRow[];inbox:{id:number;from:string;receivedTick:number;text:string;via:string[]}[];available:boolean;unconfirmed?:MessageInput};
export type MessageResult={ok:boolean;reason?:string;messageId?:number;requestId?:string;duplicate?:boolean;refreshPending?:boolean;retryable?:boolean};
const token=(v:any)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const tick=(v:any)=>Number.isSafeInteger(v)&&v>=0;
const receivedRoute=(m:any):string[]=>Array.isArray(m.via)&&m.via.length<=3&&m.via.every(token)?m.via.slice():[];
export const messageBytes=(text:string)=>new TextEncoder().encode(text).length;
/** Scoped contacts and inbox are derived only from the selected actor's observation. */
export function projectMessages(world:any,observation:any,meta:MessageMeta):MessageContext{
 const at=world.tick,available=observation?.self?.id===meta.selected&&observation.tick===at,peers=new Map<string,MessagePeer>();
 const add=(p:MessagePeer)=>{if(token(p.id)&&p.id!==meta.selected)peers.set(p.id,p)};
 if(meta.focused){
  if(available){
   for(const m of observation.inbox||[])if(m.to===meta.selected&&tick(m.receivedTick)&&m.receivedTick<=at){for(const id of receivedRoute(m))add({id,name:id,source:'route',disabled:false,observedTick:m.receivedTick});add({id:m.from,name:m.from,source:'inbox',disabled:false,observedTick:m.receivedTick})}
   for(const m of observation.memory||[])if(m.kind==='agent'&&tick(m.observedTick)&&m.observedTick<=at)add({id:m.id,name:m.id,source:'memory',disabled:m.status==='fault'||m.status==='disabled',observedTick:m.observedTick});
   for(const m of observation.nearby||[])if(m.kind==='agent'&&tick(m.observedTick)&&m.observedTick<=at)add({id:m.id,name:m.id,source:'sensor',disabled:m.status==='fault'||m.status==='disabled',observedTick:m.observedTick});
  }
 }else for(const a of world.agents||[])add({id:a.id,name:a.name,source:'global',disabled:!!a.disabled,...(a.deployableRelay?{relayReady:a.relayState?.deployed===true&&a.battery>5}:{})});
 const view=projectDataFlow(world,observation,meta.focused?meta.selected:'global');
 return {...meta,senders:meta.senders.filter(a=>!meta.focused||a.id===meta.selected).map(a=>({id:a.id,name:a.name,disabled:a.disabled})),tick:at,maxBytes:meta.focused?null:world.communication?.config?.maxBytes??null,peers:[...peers.values()].sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true})),records:view.rows.filter(r=>r.channel==='peer'&&(r.from===meta.selected||r.to===meta.selected)),inbox:available?(observation.inbox||[]).filter((p:any)=>p.to===meta.selected&&tick(p.receivedTick)&&p.receivedTick<=at).map((p:any)=>({id:p.id,from:p.from,receivedTick:p.receivedTick,text:p.text,via:receivedRoute(p)})).reverse():[],available};
}
export function messageBlock(c:MessageContext,retry=false):string|null{
 if(c.observer)return 'read_only';if(c.imported)return 'imported_replay';if(!c.latest)return 'history_view';if(c.failed)return 'session_stopped';if(c.busy)return 'busy';
 if(!c.senders.some(a=>a.id===c.selected))return 'selection_changed';if(!retry&&c.done)return 'world_finished';if(!retry&&c.senders.find(a=>a.id===c.selected)?.disabled)return 'sender_unavailable';return null;
}
export function messageRouteIssue(c:MessageContext,from:string,toId:string,via:string[]):string|null{
 const to=c.peers.find(a=>a.id===toId);if(!to||to.id===from)return 'recipient_unknown';if(to.disabled)return 'recipient_unavailable';
 if(!Array.isArray(via)||via.length>3||via.some(id=>!token(id)||id.length>64)||new Set([from,toId,...via]).size!==via.length+2)return 'invalid_relay_route';
 for(const id of via){const relay=c.peers.find(a=>a.id===id);if(!relay)return 'invalid_relay_route';if(relay.disabled||relay.relayReady===false)return 'relay_unavailable'}
 return null;
}
export function prepareMessage(c:MessageContext,from:string,draft:MessageDraft,requestId:string):{input?:MessageInput;reason?:string}{
 if(c.selected!==from)return {reason:'selection_changed'};
 if(!draft||typeof draft.text!=='string'||typeof draft.to!=='string'||!token(requestId)||requestId.length>64)return {reason:'invalid_message'};
 if(!draft.text.trim()||messageBytes(draft.text)>(c.maxBytes??4096))return {reason:'invalid_message'};
 const reason=messageRouteIssue(c,from,draft.to,draft.via);if(reason)return {reason};
 return {input:{to:draft.to,text:draft.text,via:draft.via.slice(),requestId}};
}
const messages:Record<string,string>=Object.assign(Object.create(null),{read_only:'只读观察不能发送设备消息。',imported_replay:'导入回放不能发送消息。',history_view:'当前为历史快照，请返回实时视图后发送。',session_stopped:'当前会话已停止，请重新连接。',world_finished:'本次运行已结束，不能发送新消息。',busy:'正在处理其他操作，请稍候。',selection_changed:'发送设备已变化，请检查当前设备。',context_changed:'运行已切换，旧请求结果不用于当前运行。',recipient_unknown:'接收方不在当前可见联系人中。',recipient_unavailable:'接收设备已退出。',sender_unavailable:'发送设备已退出。',relay_unavailable:'中继尚未部署、已退出或不可用。',invalid_relay_route:'最多选择三台已知中继；路径中的设备不能重复，也不能与发送方或接收方相同。',invalid_message:'消息不能为空，UTF-8字节数须符合当前上限。',invalid_request_id:'请求标识无效，尚未发送。',same_agent:'发送方和接收方不能相同。',unknown_agent:'设备已不在当前运行中。',rate_limit:'本步发送配额已满，请推进仿真后再试。',queue_full:'消息队列已满，请等待已有消息处理。',message_request_limit:'本次运行的消息请求数量已达上限。',request_id_conflict:'该请求标识已用于不同消息，请检查通信记录。',unconfirmed_request:'该设备有尚未确认的提交，请先核对并重试同一消息。',no_unconfirmed_request:'没有待核对的消息提交。',request_unconfirmed:'提交结果尚未确认；重试将使用同一请求标识，避免重复入队。',unauthorized:'管理员凭据已失效，请重新连接。',forbidden:'当前凭据没有发送权限。'});
export const messageNotice=(reason?:string)=>messages[reason||'']||'提交结果尚未确认，请检查最新通信记录。';
const copy=(p:MessageInput):MessageInput=>({...p,via:p.via.slice()});
type SendResult={ok:boolean;reason?:string;messageId?:number;duplicate?:boolean};
type Environment={read:()=>MessageContext;id:()=>string;setBusy:(v:boolean)=>void;send:(from:string,input:MessageInput)=>SendResult|Promise<SendResult>;refresh:()=>void|Promise<void>;onError?:(error:unknown)=>void};
export function createMessageController(env:Environment){
 const pending=new Set<string>(),unconfirmed=new Map<string,MessageInput>();let currentKey='';
 function forWorld(key:string){if(key!==currentKey){unconfirmed.clear();currentKey=key}}
 function uncertain(key:string,from:string){forWorld(key);const p=unconfirmed.get(from);return p?copy(p):undefined}
 async function submit(key:string,from:string,draft:MessageDraft|{retry:true}):Promise<MessageResult>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};forWorld(key);
  const retry=!!draft&&'retry' in draft&&draft.retry===true,block=messageBlock(c,retry);if(block)return {ok:false,reason:block};if(pending.has(key))return {ok:false,reason:'busy'};if(c.selected!==from)return {ok:false,reason:'selection_changed'};
  let input:MessageInput;
  if(retry){const prior=unconfirmed.get(from);if(!prior)return {ok:false,reason:'no_unconfirmed_request'};input=copy(prior)}
  else{
   if(unconfirmed.has(from))return {ok:false,reason:'unconfirmed_request'};
   const requestId=env.id();if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(requestId))return {ok:false,reason:'invalid_request_id'};
   const prepared=prepareMessage(c,from,draft as MessageDraft,requestId);if(!prepared.input)return {ok:false,reason:prepared.reason};input=prepared.input;
  }
  const same=()=>env.read().key===key;
  pending.add(key);unconfirmed.set(from,copy(input));
  const refresh=async()=>{try{await env.refresh();return true}catch(e){if(same())env.onError?.(e);return false}};
  try{
   env.setBusy(true);const result=await env.send(from,copy(input));if(!same())return {ok:false,reason:'context_changed'};
   if(result?.ok===false){unconfirmed.delete(from);await refresh();return same()?{ok:false,reason:result?.reason,requestId:input.requestId}:{ok:false,reason:'context_changed'}}
   if(!result?.ok||!Number.isSafeInteger(result.messageId)||result.messageId!<1||typeof result.duplicate!=='boolean')throw Error('invalid_message_response');
   unconfirmed.delete(from);const synced=await refresh();return same()?{ok:true,messageId:result.messageId,duplicate:result.duplicate,requestId:input.requestId,...(!synced?{refreshPending:true}:{})}:{ok:false,reason:'context_changed'};
  }catch(error){
   if(!same())return {ok:false,reason:'context_changed'};const e=error as {status?:number;message?:string},definite=e.status===400||e.status===409;
   if(definite)unconfirmed.delete(from);else env.onError?.(error);
   if(!same())return {ok:false,reason:'context_changed'};await refresh();if(!same())return {ok:false,reason:'context_changed'};
   return {ok:false,reason:definite?(messages[e.message||'']?e.message:'request_rejected'):'request_unconfirmed',requestId:input.requestId,...(!definite?{retryable:true}:{})};
  }finally{pending.delete(key);if(same())env.setBusy(false)}
 }
 return {submit,uncertain};
}
