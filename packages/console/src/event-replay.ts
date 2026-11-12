export type ReplayEvent={id:number;index:number;tick:number;seq?:number;kind:string;message:string;level:string;agentId?:string;taskId?:string};
export type ReplayView={key:string;base:number;scope:string;frame:number;frames:number;tick:number;firstTick:number;lastTick:number;busy:boolean;pending:boolean;imported:boolean;observer:boolean;offline:boolean;events:ReplayEvent[];notice:string;canImport?:boolean;canExport?:boolean;fileNotice?:string};
export type ReplayContext={key:string;scope:string;frames:any[];index:number;running:boolean;observer:boolean;imported:boolean;blocked:boolean;failed:boolean};
export type ReplayRequest={key:string;base:number;scope:string}&({kind:'frame';index:number}|{kind:'step';direction:1|-1;mode:'frame'|'tick'}|{kind:'event';id:number}|{kind:'latest'});
type Ops={step:(frames:any[],index:number,direction:1|-1,mode:'frame'|'tick')=>number;locateEvent:(frames:any[],index:number)=>{index:number;earliestRetained:boolean}};
type Result={ok:boolean;reason?:string;index?:number;tick?:number};
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const signature=(v:any)=>JSON.stringify(canonical(v));
/** Navigation changes the displayed frame only. A running administrator pauses once;
 * observers never pause the authoritative world. Anchors survive append, not reset/truncation. */
export function createReplayNavigator(io:{read:()=>ReplayContext;ops:Ops;pause:()=>Promise<boolean>;setIndex:(index:number)=>void;changed:()=>void}){
 const identities=new WeakMap<object,number>();let nextIdentity=1,nextEvent=1,recordKey='',events=new Map<number,{index:number;signature:string}>(),eventIds=new Map<string,number>(),notice:{key:string;scope:string;text:string;frame:any}|null=null;
 type Work={key:string;scope:string;base:number;target:any;event?:{tick:number;earliestRetained:boolean};promise:Promise<Result>};
 let active:Work|null=null;
 const base=(c:ReplayContext)=>{const first=c.frames[0];if(!first||typeof first!=='object')return 0;if(!identities.has(first))identities.set(first,nextIdentity++);return identities.get(first)!};
 const same=(c:ReplayContext,w:{key:string;scope:string;base:number})=>c.key===w.key&&c.scope===w.scope&&base(c)===w.base;
 function project():ReplayView{
  const c=io.read(),b=base(c),key=c.key+':'+b;
  if(recordKey!==key){recordKey=key;events=new Map();eventIds=new Map()}
  const rows:ReplayEvent[]=[];
  // An agent observation contains no event log. Do not even read world.events here.
  if(c.scope==='global')for(const [index,e] of (c.frames[c.frames.length-1]?.events||[]).entries()){
   const sig=signature(e),eventKey=index+':'+sig;let id=eventIds.get(eventKey);if(id===undefined){id=nextEvent++;eventIds.set(eventKey,id);events.set(id,{index,signature:sig})}
   rows.push({id,index,tick:e.tick,...(Number.isSafeInteger(e.seq)?{seq:e.seq}:{}),kind:e.kind||'event',message:e.message,level:e.type||'info',...(typeof e.agentId==='string'?{agentId:e.agentId}:{}),...(typeof e.taskId==='string'?{taskId:e.taskId}:{})});
  }
  return {key:c.key,base:b,scope:c.scope,frame:c.index,frames:c.frames.length,tick:c.frames[c.index]?.tick??0,firstTick:c.frames[0]?.tick??0,lastTick:c.frames[c.frames.length-1]?.tick??0,busy:c.blocked,pending:!!active,imported:c.imported,observer:c.observer,offline:c.failed,events:rows,notice:active&&same(c,active)?'正在定位快照…':notice&&notice.key===c.key&&notice.scope===c.scope&&notice.frame===c.frames[c.index]?notice.text:''};
 }
 function finish(c:ReplayContext,text:string){notice={key:c.key,scope:c.scope,text,frame:c.frames[c.index]};io.changed()}
 async function navigate(request:ReplayRequest):Promise<Result>{
  const c=io.read();if(!same(c,request)||!c.frames.length)return {ok:false,reason:'changed'};
  if(c.blocked&&!(active&&same(c,active)))return {ok:false,reason:'unavailable'};
  let index:number,event:Work['event'];
  try{
   if(request.kind==='event'){
    if(c.scope!=='global')return {ok:false,reason:'scope'};
    const ref=events.get(request.id),current=ref&&c.frames[c.frames.length-1]?.events?.[ref.index];
    if(!ref||!current||signature(current)!==ref.signature)return {ok:false,reason:'event_changed'};
    const found=io.ops.locateEvent(c.frames,ref.index);index=found.index;event={tick:current.tick,earliestRetained:found.earliestRetained};
   }else if(request.kind==='step')index=io.ops.step(c.frames,c.index,request.direction,request.mode);
   else index=request.kind==='latest'?c.frames.length-1:request.index;
   if(!Number.isSafeInteger(index)||index<0||index>=c.frames.length)return {ok:false,reason:'position'};
  }catch{return {ok:false,reason:'position'}}
  if(active){if(!same(c,active))return {ok:false,reason:'pending'};active.target=c.frames[index];active.event=event;return active.promise}
  // Install the work before yielding so multiple slider inputs share one pause.
  let resolve!:(r:Result)=>void;const promise=new Promise<Result>(r=>resolve=r),work:Work={key:c.key,scope:c.scope,base:base(c),target:c.frames[index],event,promise};active=work;
  const startedFailed=c.failed,needsPause=c.running&&!c.observer&&!c.failed&&(c.imported||request.kind!=='latest');
  finish(c,needsPause?'正在暂停并定位快照…':'正在定位快照…');
  void (async()=>{
   let result:Result={ok:false,reason:'changed'};
   try{
    const paused=needsPause?await io.pause():true,now=io.read();
    if(!same(now,work))return;
    if(!paused||now.blocked||now.failed!==startedFailed){finish(now,'未能完成定位，当前显示位置保持不变。');result={ok:false,reason:'pause_failed'};return}
    const target=now.frames.indexOf(work.target);
    if(target<0){finish(now,'目标快照已不在保留记录中，请重新选择。');result={ok:false,reason:'expired'};return}
    io.setIndex(target);const tick=work.target.tick,e=work.event;
    const text=e?(e.earliestRetained?'已定位到最早保留快照；事件可能更早发生。':tick===e.tick?'已定位到首个包含该事件的保留快照。':`事件记录于T+${e.tick}，首个保留快照为T+${tick}；没有该事件发生瞬间的快照。`):`已定位快照 ${target+1}/${now.frames.length} · T+${tick}。`;
    finish({...now,index:target},text);result={ok:true,index:target,tick};
   }catch{const now=io.read();if(same(now,work))finish(now,'无法定位快照，请检查服务状态后重新选择。');result={ok:false,reason:'failed'}}
   finally{if(active===work)active=null;io.changed();resolve(result)}
  })();
  return promise;
 }
 return {project,navigate};
}
