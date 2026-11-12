import {deviceBlock,type DeviceContext} from './device-actions';
export type DeviceConnection={origin:string;sessionId:string};
export type CredentialResult={ok:boolean;reason?:string;command?:string};
const messages:Record<string,string>=Object.assign(Object.create(null),{read_only:'只读观察不能签发设备凭据。',imported_replay:'导入回放不能签发设备凭据。',history_view:'请返回设备实时视图后签发凭据。',session_stopped:'当前会话已停止，请重新连接。',world_finished:'本次运行已结束，请重新开始后签发。',busy:'正在处理其他操作，请稍候。',needs_service:'启动本机世界服务并连接后，可签发设备进程凭据。',selection_changed:'设备已变化，请检查当前设备后签发。',context_changed:'运行已切换，旧请求不会提供当前运行的凭据。',view_changed:'签发请求已处理，但当前视图已变化；请检查设备后再操作。',agent_unavailable:'设备当前不可用，不能签发启动命令。',invalid_response:'签发结果尚未确认，请检查会话后再操作。',unauthorized:'管理员凭据已失效，请重新连接。',forbidden:'当前凭据没有设备签发权限。',agent_not_found:'该设备已不在当前运行中。'});
export function credentialMessage(reason?:string):string{return messages[reason||'']||'签发结果尚未确认，请检查当前会话后再操作。'}
export function credentialBlock(c:DeviceContext):string|null{return deviceBlock(c)||(!c.remote||!c.connection?'needs_service':!c.agents.some(a=>a.id===c.selected)?'selection_changed':c.agents.find(a=>a.id===c.selected)?.disabled?'agent_unavailable':null)}
const shellArgument=(value:string)=>"'"+value.replace(/'/g,"'\"'\"'")+"'";
export function agentCommand(connection:DeviceConnection,agentId:string,token:unknown,rescueSearch=false):string|null{
 try{const url=new URL(connection.origin);if(url.origin!==connection.origin||!['http:','https:'].includes(url.protocol)||url.username||url.password)return null}catch{return null}
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(connection.sessionId)||!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 if(typeof rescueSearch!=='boolean')return null;
 return [['BOX_URL',connection.origin],['BOX_SESSION',connection.sessionId],['BOX_AGENT',agentId],['BOX_TOKEN',token]].map(([key,value])=>key+'='+shellArgument(value)).join(' ')+' python3 sdk/python/task_agent.py --auto-charge --auto-report-samples'+(rescueSearch?' --auto-rescue --rescue-search':'');
}
type Environment={read:()=>DeviceContext;setBusy:(value:boolean)=>void;issue:(agentId:string)=>Promise<{agentToken:unknown}>;onError?:(error:unknown)=>void};
export function createDeviceCredentialController(env:Environment){
 const pending=new Set<string>();
 return async function issue(key:string,agentId:string,rescueSearch=false):Promise<CredentialResult>{
  const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};const block=credentialBlock(c);if(block)return {ok:false,reason:block};if(pending.has(key))return {ok:false,reason:'busy'};if(c.selected!==agentId)return {ok:false,reason:'selection_changed'};
  if(typeof rescueSearch!=='boolean'||rescueSearch&&!c.agents.find(a=>a.id===agentId)?.rescueWorkTicks)return {ok:false,reason:'selection_changed'};
  const connection={...c.connection!},sameWorld=()=>env.read().key===key;pending.add(key);
  try{
   env.setBusy(true);const result=await env.issue(agentId);if(!sameWorld())return {ok:false,reason:'context_changed'};
   const latest=env.read();if(latest.selected!==agentId||latest.connection?.origin!==connection.origin||latest.connection?.sessionId!==connection.sessionId)return {ok:false,reason:'selection_changed'};
   if(credentialBlock({...latest,busy:false}))return {ok:false,reason:'view_changed'};
   if(rescueSearch&&!latest.agents.find(a=>a.id===agentId)?.rescueWorkTicks)return {ok:false,reason:'selection_changed'};
   const command=agentCommand(connection,agentId,result.agentToken,rescueSearch);return command?{ok:true,command}:{ok:false,reason:'invalid_response'};
  }catch(error){if(!sameWorld())return {ok:false,reason:'context_changed'};const e=error as {status?:number;message?:string};if(e.status!==400&&e.status!==409)env.onError?.(error);return sameWorld()?{ok:false,reason:messages[e.message||'']?e.message:'request_failed'}:{ok:false,reason:'context_changed'}}
  finally{pending.delete(key);if(sameWorld())env.setBusy(false)}
 };
}
