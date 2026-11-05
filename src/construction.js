/* Configured construction inside an existing, reserved collision perimeter. */
(function(root){
'use strict';
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validateProfile(scene){
 const sites=scene.constructionSites,tasks=scene.tasks||[],builds=tasks.filter(t=>t.behavior==='build');
 if(sites===undefined){if(builds.length||tasks.some(t=>t.buildSite!==undefined))throw Error('construction requires configured sites');return true}
 if(scene.agents.some(a=>a.capabilities.includes('build')&&(a.mobility??(a.role==='drone'?'air':'ground'))!=='ground'))throw Error('builders must use ground mobility');
 if(!Array.isArray(sites)||sites.length<1||sites.length>32||new Set(sites.map(s=>s?.id)).size!==sites.length||new Set(sites.map(s=>s?.obstacleId)).size!==sites.length)throw Error('invalid construction sites');
 for(const site of sites){
  if(!site||!token(site.id)||!token(site.obstacleId)||typeof site.name!=='string'||!site.name||site.name.length>100)throw Error('invalid construction site');
  const obstacle=scene.obstacles.find(o=>o.id===site.obstacleId),linked=builds.filter(t=>t.buildSite===site.id);
  if(!obstacle||linked.length!==1)throw Error('construction site requires one existing perimeter and build task');
  const t=linked[0],dx=Math.max(obstacle.x-t.target[0],0,t.target[0]-obstacle.x-obstacle.w),dy=Math.max(obstacle.y-t.target[1],0,t.target[1]-obstacle.y-obstacle.h),distance=Math.hypot(dx,dy);
  if(distance<1.1||distance>4||t.capability!=='build'||!Array.isArray(t.materialCost)||!t.materialCost.length||!scene.agents.some(a=>a.role===t.role&&a.capabilities.includes('build')&&(a.mobility??(a.role==='drone'?'air':'ground'))==='ground'))throw Error('construction requires a nearby external work pad, ground builder and materials');
 }
 for(const t of tasks)if(t.behavior==='build'?(!token(t.buildSite)||!sites.some(s=>s.id===t.buildSite)):t.buildSite!==undefined)throw Error('invalid construction task binding');
 return true;
}
const normalize=sites=>sites.map(s=>({id:s.id,name:s.name,obstacleId:s.obstacleId}));
const initial=sites=>({sites:normalize(sites).map(s=>({...s,status:'planned'}))});
function validateState(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Array.isArray(value.sites)||value.sites.length<1||value.sites.length>32||new Set(value.sites.map(s=>s?.id)).size!==value.sites.length||new Set(value.sites.map(s=>s?.obstacleId)).size!==value.sites.length)throw Error('invalid construction state');
 for(const s of value.sites){const keys=s?.status==='built'?['id','name','obstacleId','status','taskId','agentId','assignmentId','builtTick']:['id','name','obstacleId','status'];if(!s||!token(s.id)||!token(s.obstacleId)||typeof s.name!=='string'||!s.name||s.name.length>100||!['planned','built'].includes(s.status)||Object.keys(s).length!==keys.length||Object.keys(s).some(k=>!keys.includes(k))||s.status==='built'&&(!token(s.taskId)||!token(s.agentId)||!Number.isSafeInteger(s.assignmentId)||s.assignmentId<1||s.assignmentId>10000000||!Number.isSafeInteger(s.builtTick)||s.builtTick<1||s.builtTick>10000000))throw Error('invalid construction site state')}
 return true;
}
function finish(value,t,a,at){
 validateState(value);const site=value.sites.find(s=>s.id===t.buildSite);
 if(t.behavior!=='build'||t.capability!=='build'||t.status!=='active'||t.assignee!==a.id||!a.capabilities.includes('build')||a.disabled||!site||site.status!=='planned')throw Error('invalid construction completion');
 const next={sites:value.sites.map(s=>s.id===site.id?{...s,status:'built',taskId:t.id,agentId:a.id,assignmentId:t.assignmentId,builtTick:at}:{...s})};validateState(next);return next;
}
function validateWorld(w,profile){
 if(w.construction===undefined){if(profile!==undefined||w.tasks.some(t=>t.behavior==='build'||t.buildSite!==undefined)||w.events.some(e=>e.kind==='construction_completed'))throw Error('missing construction state');return true}
 validateState(w.construction);if(profile===undefined)profile=normalize(w.construction.sites);
 if(!equal(normalize(w.construction.sites),normalize(profile)))throw Error('changed construction profile');
 const ids=new Set(w.construction.sites.map(s=>s.id));
 for(const site of w.construction.sites){const linked=w.tasks.filter(t=>t.behavior==='build'&&t.buildSite===site.id),events=w.events.filter(e=>e.kind==='construction_completed'&&e.siteId===site.id);if(linked.length!==1)throw Error('invalid construction binding');const t=linked[0];if(site.status==='planned'){if(t.status==='done'||events.length)throw Error('missing construction result');continue}
  const e=events[0];if(t.status!=='done'||site.taskId!==t.id||site.agentId!==t.assignee||site.assignmentId!==t.assignmentId||site.builtTick>w.tick||!w.agents.some(a=>a.id===site.agentId&&a.capabilities.includes('build'))||events.length!==1||e.taskId!==t.id||e.agentId!==site.agentId||e.assignmentId!==site.assignmentId||e.obstacleId!==site.obstacleId||e.tick!==site.builtTick||!w.events.some(v=>v.kind==='task_completed'&&v.taskId===t.id&&v.agentId===site.agentId&&v.tick===site.builtTick))throw Error('inconsistent construction provenance');
 }
 if(w.tasks.some(t=>t.behavior==='build'?!ids.has(t.buildSite):t.buildSite!==undefined)||w.events.some(e=>e.kind==='construction_completed'&&!ids.has(e.siteId)))throw Error('unknown construction reference');return true;
}
function visualPlan(value,focused=false){
 if(value===undefined)return [];
 const sites=value?.sites;if(!Array.isArray(sites)||sites.length>32||sites.some(s=>!s||!token(s.obstacleId)))return [];
 // Static perimeter IDs may be shown; focused rendering never reads live status or provenance.
 return sites.map(s=>({obstacleId:s.obstacleId,state:focused?'unknown':s.status==='built'?'built':s.status==='planned'?'planned':'unknown'}));
}
const api={validateProfile,normalize,initial,validateState,finish,validateWorld,visualPlan};if(typeof module!=='undefined')module.exports=api;else root.SandboxConstruction=api;
})(typeof globalThis!=='undefined'?globalThis:this);
