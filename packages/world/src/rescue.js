/* On-site mechanical reset. Reusable tools consume work energy, never create charge. */
(function(root){
'use strict';
const token=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
const ground=a=>(a.mobility??(a.role==='drone'?'air':'ground'))==='ground';
function validateProfile(scene){
 for(const a of scene.agents){
  if(a.recoverableFault!==undefined&&(a.recoverableFault!==true||!ground(a)))throw Error('invalid recoverable fault profile');
  if(a.rescue!==undefined&&(!a.rescue||typeof a.rescue!=='object'||Array.isArray(a.rescue)||Object.keys(a.rescue).some(k=>k!=='workTicks')||!Number.isSafeInteger(a.rescue.workTicks)||a.rescue.workTicks<1||a.rescue.workTicks>100||!ground(a)||!a.capabilities.includes('rescue')))throw Error('invalid rescue profile');
  if(a.capabilities.includes('rescue')&&a.rescue===undefined)throw Error('rescue capability requires reusable tool profile');
 }
}
function fields(a){return {...(a.recoverableFault!==undefined?{recoverableFault:a.recoverableFault}:{}),...(a.rescue!==undefined?{rescue:{workTicks:a.rescue.workTicks}}:{})}}
function faultAt(events,targetId,observedTick=Infinity){let fault=null;for(const e of events)if(e.tick<=observedTick){if(e.kind==='device_fault'&&e.agentId===targetId)fault=e;else if(e.kind==='rescue_completed'&&e.targetAgentId===targetId)fault=null}return fault}
function reason(s,a,action,reachable){
 const target=s.agents.find(t=>t.id===action.targetAgentId),fault=faultAt(s.events,action.targetAgentId);
 if(!a.rescue||!ground(a)||!a.capabilities.includes('rescue'))return 'missing_capability';
 if(!target||target.id===a.id||target.recoverableFault!==true||!ground(target))return 'not_recoverable';
 if(!target.disabled||target.status!=='fault'||target.faultGeneration!==action.faultGeneration||!fault||fault.seq!==action.faultSeq||fault.tick>action.observedTick)return 'fault_changed';
 if(target.battery<=5)return 'target_low_battery';
 if(!reachable)return 'out_of_reach';
 if(s.actions.some(other=>other!==action&&other.type==='rescue'&&other.status==='accepted'&&other.targetAgentId===target.id&&other.faultSeq===action.faultSeq))return 'rescue_in_progress';
 return null;
}
function validateWorld(s,expected){
 const actors=new Map(expected.agents.map(a=>[a.id,a])),completed=s.actions.filter(a=>a.type==='rescue'&&a.status==='completed'),events=s.events.filter(e=>e.kind==='rescue_completed');
 for(const a of s.agents){const initial=actors.get(a.id);if(!initial||JSON.stringify(fields(a))!==JSON.stringify(fields(initial)))throw Error('rescue profile changed');if(initial.recoverableFault?a.faultGeneration!==s.events.filter(e=>e.kind==='device_fault'&&e.agentId===a.id).length:a.faultGeneration!==undefined)throw Error('invalid mechanical fault generation')}
 for(const e of s.events.filter(e=>e.kind==='device_fault')){
  if(e.targeted!==undefined&&e.targeted!==true||e.taskId===undefined&&e.targeted!==true)throw Error('invalid targeted fault provenance');
  if(e.targeted){const initial=actors.get(e.agentId);if(!initial)throw Error('unknown fault device');if(initial.recoverableFault?e.expectedFaultGeneration!==s.events.filter(f=>f.kind==='device_fault'&&f.agentId===e.agentId&&f.seq<e.seq).length:e.expectedFaultGeneration!==undefined)throw Error('invalid fault condition')}
 }
 for(const a of s.actions){if(a.type!=='rescue'){if(['targetAgentId','observedTick','faultSeq','faultGeneration'].some(k=>a[k]!==undefined))throw Error('unexpected rescue identity');continue}
  if(!token(a.targetAgentId)||a.targetAgentId===a.agentId||!actors.has(a.targetAgentId)||!Number.isSafeInteger(a.observedTick)||a.observedTick<0||a.observedTick>a.submittedTick||!Number.isSafeInteger(a.faultGeneration)||a.faultGeneration<1||!Number.isSafeInteger(a.faultSeq)||a.faultSeq<1||a.target!==undefined||a.taskId!==undefined||a.resumeTaskId!==undefined||a.phase!==undefined||a.energyAdded!==undefined||a.result!==undefined)throw Error('invalid rescue intent');
  if(!token(a.agentId)||!token(a.requestId)||!Number.isSafeInteger(a.submittedTick)||a.submittedTick<0||a.submittedTick>s.tick||!Number.isSafeInteger(a.targetTick)||a.targetTick<=a.submittedTick||!Number.isSafeInteger(a.expiresTick)||a.expiresTick<a.targetTick||a.expiresTick>a.submittedTick+100)throw Error('invalid rescue schedule');
  const submitted=s.events.filter(e=>e.kind==='action_submitted'&&e.agentId===a.agentId&&e.requestId===a.requestId&&e.actionType==='rescue'&&e.tick===a.submittedTick);if(submitted.length!==1)throw Error('rescue submission provenance');
  if(a.status==='pending'){if(s.done||s.tick>=a.targetTick||a.updatedTick!==undefined||a.reason!==undefined||a.progress!==undefined)throw Error('invalid pending rescue')}
  else {if(!Number.isSafeInteger(a.updatedTick)||a.updatedTick<a.submittedTick||a.updatedTick>s.tick||['accepted','completed','failed'].includes(a.status)&&a.updatedTick<a.targetTick||a.status==='accepted'&&a.updatedTick>a.expiresTick)throw Error('invalid rescue update');if(['accepted','completed'].includes(a.status)?a.reason!==undefined:typeof a.reason!=='string'||!a.reason||a.reason.length>100)throw Error('invalid rescue reason');if(!s.events.some(e=>e.kind==='action_'+a.status&&e.agentId===a.agentId&&e.requestId===a.requestId&&e.actionType==='rescue'&&e.tick===a.updatedTick))throw Error('rescue lifecycle provenance')}
  const f=s.events.find(e=>e.seq===a.faultSeq&&e.kind==='device_fault'&&e.agentId===a.targetAgentId&&e.tick<=a.observedTick);if(!f||s.events.filter(e=>e.kind==='device_fault'&&e.agentId===a.targetAgentId&&e.seq<=f.seq).length!==a.faultGeneration)throw Error('missing rescue fault');
  const p=actors.get(a.agentId)?.rescue;
  if(a.progress!==undefined&&(!p||!Number.isSafeInteger(a.progress)||a.progress<0||a.progress>p.workTicks)||['accepted','completed'].includes(a.status)&&a.progress===undefined||a.status==='completed'&&a.progress!==p?.workTicks)throw Error('invalid rescue progress');
 }
 const active=new Set();for(const a of s.actions.filter(a=>a.type==='rescue'&&a.status==='accepted')){const key=a.targetAgentId+':'+a.faultSeq;if(active.has(key))throw Error('duplicate active rescue');active.add(key)}
 const episodes=new Set();
 if(events.length!==completed.length)throw Error('rescue receipt count');
 for(const e of events){const a=completed.find(a=>a.agentId===e.agentId&&a.requestId===e.requestId&&a.targetAgentId===e.targetAgentId&&a.faultSeq===e.faultSeq&&a.faultGeneration===e.faultGeneration&&a.updatedTick===e.tick),helper=actors.get(e.agentId),target=actors.get(e.targetAgentId),key=e.targetAgentId+':'+e.faultSeq;
  if(!a||!helper?.rescue||target?.recoverableFault!==true||!ground(helper)||!ground(target)||episodes.has(key)||e.workTicks!==helper.rescue.workTicks||!Array.isArray(e.position)||e.position.length!==2||e.position.some(n=>!Number.isFinite(n)||n<0||n>100)||!Number.isFinite(e.battery)||e.battery<=5||e.battery>100)throw Error('invalid rescue receipt');const accepted=s.events.find(x=>x.kind==='action_accepted'&&x.agentId===a.agentId&&x.requestId===a.requestId&&x.actionType==='rescue');const prior=faultAt(s.events.filter(x=>x.seq<e.seq),e.targetAgentId);if(!accepted||e.tick-accepted.tick+1<e.workTicks||prior?.seq!==e.faultSeq)throw Error('rescue work provenance');if(e.tick===s.tick){const live=s.agents.find(a=>a.id===e.targetAgentId);const later=s.events.filter(x=>x.kind==='low_energy_injected'&&x.agentId===e.targetAgentId&&x.seq>e.seq).at(-1);if(live.battery!==(later?later.level:e.battery)||live.x!==e.position[0]||live.y!==e.position[1])throw Error('rescue created energy or motion')}episodes.add(key);
 }
 // A reset must be explained by the latest mechanical fault's completion receipt.
 for(const a of s.agents){const faults=s.events.filter(e=>e.kind==='device_fault'&&e.agentId===a.id),f=faults.at(-1);if(!f)continue;const receipt=events.find(e=>e.targetAgentId===a.id&&e.faultSeq===f.seq);if(!a.disabled&&!receipt)throw Error('unrecorded device revival');if(receipt&&!s.events.some(e=>e.kind==='energy_depleted'&&e.agentId===a.id&&e.seq>receipt.seq)&&a.disabled)throw Error('recovered device remains faulted')}
 return true;
}
const api={validateProfile,fields,faultAt,reason,validateWorld};if(typeof module!=='undefined')module.exports=api;else root.SandboxRescue=api;
})(typeof window!=='undefined'?window:globalThis);
