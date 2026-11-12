/* Optional abstract electrical base load, separate from motion/work heat. */
(function(root){
'use strict';
const MAX_TICK=10000000;
function spec(a){if(a.operatingEnergyPerTick!==undefined&&(!Number.isFinite(a.operatingEnergyPerTick)||a.operatingEnergyPerTick<.001||a.operatingEnergyPerTick>5))throw Error('invalid operating energy profile');return true}
function fields(a){spec(a);return a.operatingEnergyPerTick===undefined?{}:{operatingEnergyPerTick:a.operatingEnergyPerTick}}
function initial(){return {energySpent:0,tick:0}}
function state(a,tick){
 spec(a);const s=a.operatingState;if(a.operatingEnergyPerTick===undefined){if(s!==undefined)throw Error('unexpected operating state');return true}
 if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==2||Object.keys(s).some(k=>!['energySpent','tick'].includes(k))||!Number.isFinite(s.energySpent)||s.energySpent<0||!Number.isSafeInteger(s.tick)||s.tick<0||s.tick>MAX_TICK||tick!==undefined&&s.tick!==tick||s.energySpent>a.operatingEnergyPerTick*s.tick+1e-7*Math.max(1,a.operatingEnergyPerTick*s.tick))throw Error('invalid operating state');return true;
}
function advance(a,tick){
 state(a);if(a.operatingEnergyPerTick===undefined)return null;
 if(!Number.isSafeInteger(tick)||tick!==a.operatingState.tick+1||tick>MAX_TICK||!Number.isFinite(a.battery)||a.battery<0||a.battery>100||typeof a.disabled!=='boolean')throw Error('invalid operating tick');
 const spent=a.disabled?0:Math.min(a.battery,a.operatingEnergyPerTick),battery=Math.max(0,a.battery-spent);
 return {battery,operatingState:{energySpent:a.operatingState.energySpent+spent,tick},depleted:!a.disabled&&battery<=0};
}
function validateWorld(w,initialWorld){
 for(const a of w.agents){state(a,w.tick);if(initialWorld){const template=initialWorld.agents.find(x=>x.id===a.id);if(!template||a.operatingEnergyPerTick!==template.operatingEnergyPerTick)throw Error('changed operating profile')}}return true;
}
function validateTransition(previous,next){
 const dt=next.tick-previous.tick;if(!Number.isSafeInteger(dt)||dt<0)throw Error('invalid operating clock');
 const added=Array.isArray(previous.events)&&Array.isArray(next.events)?next.events.slice(previous.events.length):[];
 for(const a of next.agents){
  if(a.operatingEnergyPerTick===undefined)continue;const before=previous.agents.find(x=>x.id===a.id);if(!before||before.operatingEnergyPerTick!==a.operatingEnergyPerTick)throw Error('changed operating profile');
  const change=a.operatingState.energySpent-before.operatingState.energySpent,tolerance=1e-7+Number.EPSILON*16*Math.max(1,a.operatingState.energySpent,before.operatingState.energySpent)*Math.max(1,dt);
  if(change< -tolerance||change>a.operatingEnergyPerTick*dt+tolerance)throw Error('invalid operating energy change');
  if(dt<=1){
   let battery=before.battery,disabled=before.disabled;
   // Sampled histories may omit management snapshots from the preceding tick.
   // The retained event prefix records these pre-power interventions.
   if(dt===1)for(const event of added){if(event.agentId!==a.id||event.tick!==previous.tick)continue;if(event.kind==='device_fault')disabled=true;else if(event.kind==='low_energy_injected'&&!disabled&&Number.isFinite(event.level)&&event.level>=1&&event.level<=5&&event.level<=battery)battery=event.level}
   const expected=dt===0||disabled?0:Math.min(battery,before.operatingEnergyPerTick);if(Math.abs(change-expected)>tolerance)throw Error('invalid operating energy debit');
  }
 }return true;
}
function metrics(w){const rows=w.agents.filter(a=>a.operatingEnergyPerTick!==undefined).map(a=>({agentId:a.id,energyPerTick:a.operatingEnergyPerTick,energySpent:a.operatingState.energySpent}));return rows.length?{energySpent:rows.reduce((sum,a)=>sum+a.energySpent,0),agents:rows}:null}
const api={spec,fields,initial,state,advance,validateWorld,validateTransition,metrics};if(typeof module!=='undefined')module.exports=api;else root.SandboxOperatingPower=api;
})(typeof globalThis!=='undefined'?globalThis:this);
