import {coordinatorBlock,type CoordinatorContext} from './task-coordination';
export type CoordinatorCredentialResult={ok:boolean;reason?:string;command?:string};
export const coordinatorCredentialBlock=(c:CoordinatorContext)=>coordinatorBlock(c)||(!c.remote||!c.connection?'needs_service':null);
export function coordinatorCommand(connection:{origin:string;sessionId:string},token:unknown):string|null{
 try{const url=new URL(connection.origin);if(url.origin!==connection.origin||!['http:','https:'].includes(url.protocol)||url.username||url.password)return null}catch{return null}
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(connection.sessionId)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const quote=(v:string)=>"'"+v.replace(/'/g,"'\"'\"'")+"'";return [['BOX_URL',connection.origin],['BOX_SESSION',connection.sessionId],['BOX_COORDINATOR_TOKEN',token]].map(([k,v])=>k+'='+quote(v)).join(' ')+' python3 sdk/python/planner_coordinator.py';
}
type Environment={read:()=>CoordinatorContext;setBusy:(v:boolean)=>void;issue:()=>Promise<{coordinatorToken:unknown}>;onError?:(e:unknown)=>void};
export function createCoordinatorCredentialController(env:Environment){const pending=new Set<string>();return async(key:string):Promise<CoordinatorCredentialResult>=>{
 const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};const block=coordinatorCredentialBlock(c);if(block||pending.has(key))return {ok:false,reason:block||'busy'};const connection={...c.connection!},same=()=>env.read().key===key;pending.add(key);
 try{env.setBusy(true);const r=await env.issue();if(!same())return {ok:false,reason:'context_changed'};const now=env.read();if(now.connection?.origin!==connection.origin||now.connection?.sessionId!==connection.sessionId||coordinatorCredentialBlock({...now,busy:false}))return {ok:false,reason:'context_changed'};const command=coordinatorCommand(connection,r.coordinatorToken);return command?{ok:true,command}:{ok:false,reason:'invalid_response'}}catch(e){if(!same())return {ok:false,reason:'context_changed'};env.onError?.(e);return same()?{ok:false,reason:'request_failed'}:{ok:false,reason:'context_changed'}}finally{pending.delete(key);if(same())env.setBusy(false)}
 }}
