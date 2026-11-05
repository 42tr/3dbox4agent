/* Stationary deployment of a mobile relay, using the existing device/message protocol. */
(function(root){
'use strict';
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const point=p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=0&&n<=100);
function spec(a){if(a.deployableRelay===undefined)return;if(a.deployableRelay!==true||!Array.isArray(a.capabilities)||!a.capabilities.includes('relay')||(a.mobility??(a.role==='drone'?'air':'ground'))!=='ground')throw Error('invalid deployable relay')}
function initial(){return {deployed:false}}
function state(v){if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.deployed!=='boolean')throw Error('invalid relay state');const keys=v.deployed?['deployed','taskId','assignmentId','deployedTick','position']:['deployed'];if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))||v.deployed&&(!token(v.taskId)||!Number.isInteger(v.assignmentId)||v.assignmentId<1||v.assignmentId>10000000||!Number.isInteger(v.deployedTick)||v.deployedTick<1||v.deployedTick>10000000||!point(v.position)))throw Error('invalid relay state');return v}
function deploy(a,t,tick){spec(a);state(a.relayState);if(a.deployableRelay!==true||a.relayState.deployed||t.behavior!=='deploy'||t.capability!=='relay'||t.assignee!==a.id||t.status!=='active'||!['working','assigned'].includes(a.status)||!point([a.x,a.y]))throw Error('invalid relay deployment');return state({deployed:true,taskId:t.id,assignmentId:t.assignmentId,deployedTick:tick,position:[a.x,a.y]})}
function ready(a){return !!a&&!a.disabled&&(!a.deployableRelay||a.relayState?.deployed===true&&a.battery>5)}
function validateWorld(w){
 for(const a of w.agents){spec(a);if(a.deployableRelay===undefined){if(a.relayState!==undefined||a.status==='deployed')throw Error('unexpected relay state');continue}const v=state(a.relayState);if(a.disabled!==(a.status==='fault'))throw Error('invalid relay availability');if(!v.deployed){if(a.status==='deployed')throw Error('relay is not deployed');continue}
  const t=w.tasks.find(t=>t.id===v.taskId),events=w.events.filter(e=>e.kind==='relay_deployed'&&e.agentId===a.id);
  if(!['deployed','fault'].includes(a.status)||a.route.length||a.work!==0||a.x!==v.position[0]||a.y!==v.position[1]||v.deployedTick>w.tick||!t||t.behavior!=='deploy'||t.status!=='done'||t.assignee!==a.id||t.assignmentId!==v.assignmentId||events.length!==1||events[0].taskId!==t.id||events[0].assignmentId!==v.assignmentId||events[0].tick!==v.deployedTick||JSON.stringify(events[0].position)!==JSON.stringify(v.position))throw Error('inconsistent relay deployment');
 }
 for(const t of w.tasks.filter(t=>t.behavior==='deploy'&&t.status==='done'))if(!w.agents.some(a=>a.id===t.assignee&&a.relayState?.deployed&&a.relayState.taskId===t.id&&a.relayState.assignmentId===t.assignmentId))throw Error('missing deployed relay');
 for(const e of w.events.filter(e=>e.kind==='relay_deployed'))if(!w.agents.some(a=>a.id===e.agentId&&a.relayState?.deployed&&a.relayState.taskId===e.taskId&&a.relayState.assignmentId===e.assignmentId))throw Error('invalid relay event');
 return true;
}
const api={spec,initial,state,deploy,ready,validateWorld};if(typeof module!=='undefined')module.exports=api;else root.SandboxRelay=api;
})(typeof globalThis!=='undefined'?globalThis:this);
