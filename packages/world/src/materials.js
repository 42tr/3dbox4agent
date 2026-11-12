/* Optional discrete task consumables. Remaining stock includes reserved units. */
(function(root){
'use strict';
const MAX=1000000,MAX_ID=Number.MAX_SAFE_INTEGER,bad=()=>{throw Error('invalid materials')},object=v=>v&&typeof v==='object'&&!Array.isArray(v),token=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s)&&!['__proto__','constructor','prototype'].includes(s),integer=(n,min=0,max=MAX)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function keys(v,expected){return object(v)&&Object.keys(v).length===expected.length&&Object.keys(v).every(k=>expected.includes(k))}
function validate(profile,tasks=[]){
 if(!Array.isArray(profile)||profile.length<1||profile.length>8||new Set(profile.map(x=>x?.id)).size!==profile.length||profile.some(x=>!keys(x,['id','name','quantity'])||!token(x.id)||typeof x.name!=='string'||!x.name||x.name.length>100||!integer(x.quantity)))bad();for(const t of tasks)if(t.materialCost!==undefined)validateCost(t.materialCost,profile);return true;
}
function validateCost(items,profile){if(!Array.isArray(items)||!items.length||items.length>8||!Array.isArray(profile)||new Set(items.map(x=>x?.id)).size!==items.length||items.some(x=>!keys(x,['id','amount'])||!token(x.id)||!integer(x.amount,1)||!profile.some(p=>p.id===x.id)))bad();return true}
function normalize(profile){validate(profile);return Object.freeze(profile.map(x=>Object.freeze({...x})))}
function initial(profile){return {stock:profile.map(x=>({id:x.id,name:x.name,initial:x.quantity,remaining:x.quantity})),reservations:[]}}
function metrics(state){if(!state)return null;return state.stock.map(x=>{const reserved=state.reservations.reduce((n,r)=>n+(r.items.find(i=>i.id===x.id)?.amount||0),0);return {...x,reserved,available:x.remaining-reserved,consumed:x.initial-x.remaining}})}
function available(state,cost){if(cost===undefined)return true;if(!state)return false;const rows=metrics(state);return cost.every(x=>{const row=rows.find(r=>r.id===x.id);return row&&row.available>=x.amount})}
function sameCost(a,b){return a.length===b.length&&a.every((x,i)=>x.id===b[i].id&&x.amount===b[i].amount)}
function validateState(state,tasks,profile){
 if(!keys(state,['stock','reservations'])||!Array.isArray(state.stock)||!state.stock.length||state.stock.length>8||new Set(state.stock.map(x=>x?.id)).size!==state.stock.length||state.stock.some(x=>!keys(x,['id','name','initial','remaining'])||!token(x.id)||typeof x.name!=='string'||!x.name||x.name.length>100||!integer(x.initial)||!integer(x.remaining)||x.remaining>x.initial)||!Array.isArray(state.reservations)||state.reservations.length>100)bad();
 if(profile!==undefined){validate(profile);if(state.stock.length!==profile.length||state.stock.some((x,i)=>x.id!==profile[i].id||x.name!==profile[i].name||x.initial!==profile[i].quantity))bad()}
 const seenTasks=new Set(),seenAgents=new Set();for(const r of state.reservations){if(!keys(r,['taskId','agentId','assignmentId','items'])||!token(r.taskId)||!token(r.agentId)||!integer(r.assignmentId,1,MAX_ID)||seenTasks.has(r.taskId)||seenAgents.has(r.agentId))bad();validateCost(r.items,state.stock);seenTasks.add(r.taskId);seenAgents.add(r.agentId)}if(metrics(state).some(x=>x.available<0))bad();
 if(tasks!==undefined){
  for(const t of tasks)if(t.materialCost!==undefined){validateCost(t.materialCost,state.stock);const r=state.reservations.find(r=>r.taskId===t.id);if(t.status==='active'){if(!r||r.agentId!==t.assignee||r.assignmentId!==t.assignmentId||!sameCost(r.items,t.materialCost))bad()}else if(r)bad()}
  if(state.reservations.some(r=>!tasks.some(t=>t.id===r.taskId&&t.materialCost!==undefined)))bad();
  for(const x of state.stock){const used=tasks.filter(t=>t.status==='done').reduce((n,t)=>n+(t.materialCost?.find(i=>i.id===x.id)?.amount||0),0);if(used!==x.initial-x.remaining)bad()}
 }return true;
}
function reserve(state,t,agentId,assignmentId){
 if(t.materialCost===undefined)return state;if(!state)bad();validateState(state);validateCost(t.materialCost,state.stock);if(!token(t.id)||!token(agentId)||!integer(assignmentId,1,MAX_ID)||state.reservations.length>=100||state.reservations.some(r=>r.taskId===t.id||r.agentId===agentId)||!available(state,t.materialCost))bad();return {...state,reservations:[...state.reservations,{taskId:t.id,agentId,assignmentId,items:t.materialCost.map(x=>({...x}))}]};
}
function settle(state,t,agentId,assignmentId,consume){
 if(t.materialCost===undefined)return state;if(!state||typeof consume!=='boolean')bad();validateState(state);const r=state.reservations.find(r=>r.taskId===t.id);if(!r||r.agentId!==agentId||r.assignmentId!==assignmentId||!sameCost(r.items,t.materialCost))bad();return {stock:consume?state.stock.map(x=>({...x,remaining:x.remaining-(r.items.find(i=>i.id===x.id)?.amount||0)})):state.stock,reservations:state.reservations.filter(x=>x!==r)};
}
function own(state,agentId){return state.reservations.filter(r=>r.agentId===agentId).map(r=>({taskId:r.taskId,assignmentId:r.assignmentId,items:r.items.map(x=>({...x,name:state.stock.find(s=>s.id===x.id).name}))}))}
const api={validate,validateCost,normalize,initial,validateState,metrics,available,reserve,settle,own};if(typeof module!=='undefined')module.exports=api;else root.SandboxMaterials=api;
})(typeof globalThis!=='undefined'?globalThis:this);
