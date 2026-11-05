/* Optional scene organization. Task DAGs remain the execution authority. */
(function(root){
'use strict';
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s)&&!['__proto__','constructor','prototype'].includes(s);
function validate(groups,tasks){
 if(!Array.isArray(groups)||groups.length<1||groups.length>8||!Array.isArray(tasks)||tasks.length<1||tasks.length>100)throw Error('invalid echelons');
 const all=new Set(tasks.map(t=>t.id)),seen=new Map(),names=new Set();
 for(let index=0;index<groups.length;index++){
  const g=groups[index];if(!g||typeof g!=='object'||Array.isArray(g)||Object.keys(g).length!==3||Object.keys(g).some(k=>!['id','name','taskIds'].includes(k))||!id(g.id)||names.has(g.id)||typeof g.name!=='string'||!g.name.length||g.name.length>100||!Array.isArray(g.taskIds)||!g.taskIds.length||g.taskIds.length>100)throw Error('invalid echelons');names.add(g.id);
  for(const taskId of g.taskIds){if(!id(taskId)||!all.has(taskId)||seen.has(taskId))throw Error('invalid echelon membership');seen.set(taskId,index)}
 }
 if(seen.size!==tasks.length)throw Error('incomplete echelon membership');
 for(const t of tasks)if(!Array.isArray(t.dependsOn)||t.dependsOn.some(p=>!seen.has(p)||seen.get(p)>seen.get(t.id)))throw Error('backward echelon dependency');
 return true;
}
function normalize(groups,tasks){validate(groups,tasks);return groups.map(g=>({id:g.id,name:g.name,taskIds:g.taskIds.slice()}))}
const api={validate,normalize};if(typeof module!=='undefined')module.exports=api;else root.SandboxEchelons=api;
})(typeof globalThis!=='undefined'?globalThis:this);
