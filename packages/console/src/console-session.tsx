import React, {useEffect, useSyncExternalStore} from 'react';

type Session = {loading:boolean;authenticated:boolean;configured:boolean;username?:string;error?:string};
let session:Session = {loading:true,authenticated:false,configured:false};
let pending:Promise<void>|undefined;
let redirecting = false;
const listeners = new Set<()=>void>();
function publish(value:Session){session=value;listeners.forEach(notify=>notify());}
const subscribe = (notify:()=>void)=>{listeners.add(notify);return()=>{listeners.delete(notify)};};
const snapshot = ()=>session;

export function loginUrl(){return '/login?returnTo='+encodeURIComponent(location.pathname+location.search+location.hash);}
export function requireLogin(){
  publish({...session,loading:false,authenticated:false});
  if(!redirecting&&location.protocol!=='file:'){redirecting=true;location.replace(loginUrl());}
}
async function loadSession(){
  if(location.protocol==='file:'){publish({loading:false,authenticated:false,configured:false});return;}
  try {
    const response=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw Error('请通过已启用账号登录的 Console 服务打开。');
    const value=await response.json();
    publish({...value,loading:false});
  }catch(error){publish({loading:false,authenticated:false,configured:false,error:error instanceof Error?error.message:'无法检查登录状态'});}
}
export function useConsoleSession(required=false){
  const value=useSyncExternalStore(subscribe,snapshot);
  useEffect(()=>{pending??=loadSession();},[]);
  useEffect(()=>{if(required&&!value.loading&&!value.authenticated&&value.configured)requireLogin();},[required,value.loading,value.authenticated,value.configured]);
  return value;
}
export async function consoleFetch(route:string,options:RequestInit={}){
  const response=await fetch('/console-api'+route,{...options,credentials:'same-origin',cache:'no-store',
    headers:{'content-type':'application/json',...options.headers}});
  if(response.status===401){requireLogin();throw Error('登录已过期，正在跳转到登录页。');}
  return response;
}
export function ConsoleAccount(){
  const value=useConsoleSession();
  if(value.loading||!value.configured)return null;
  return value.authenticated?<button className="mc-pill" title={'当前账号：'+value.username} onClick={()=>{
    void fetch('/auth/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'})
      .then(response=>{if(response.ok)requireLogin();else alert('退出失败，请重试。');}).catch(()=>alert('无法连接登录服务，请重试。'));
  }}>{value.username} · 退出登录</button>:<a className="mc-pill" href={loginUrl()}>登录</a>;
}
