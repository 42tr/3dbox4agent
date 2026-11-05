/* Deterministic task dependency layout and status descriptions for snapshots. */
(function(root){
'use strict';
function layout(tasks){
 if(!Array.isArray(tasks)||tasks.length>100)throw Error('invalid tasks');const byId=new Map();for(const task of tasks){if(!task||typeof task.id!=='string'||!Array.isArray(task.dependsOn)||byId.has(task.id))throw Error('invalid task graph');byId.set(task.id,task)}
 const levels=new Map(),visiting=new Set();function level(id){if(levels.has(id))return levels.get(id);const task=byId.get(id);if(!task||visiting.has(id))throw Error('invalid task graph');visiting.add(id);let n=0;for(const dep of task.dependsOn)n=Math.max(n,level(dep)+1);visiting.delete(id);levels.set(id,n);return n}
 for(const task of tasks)level(task.id);const columns=[];for(const task of tasks){const n=levels.get(task.id);(columns[n]||(columns[n]=[])).push(task)}const maxRows=Math.max(1,...columns.map(c=>c.length)),nodeWidth=188,nodeHeight=66,gapX=52,gapY=28,padding=20,nodes=[],positions=new Map();
 for(let col=0;col<columns.length;col++){const list=columns[col],offset=(maxRows-list.length)*(nodeHeight+gapY)/2;for(let row=0;row<list.length;row++){const task=list[row],node={id:task.id,x:padding+col*(nodeWidth+gapX),y:padding+offset+row*(nodeHeight+gapY),width:nodeWidth,height:nodeHeight,level:col};nodes.push(node);positions.set(task.id,node)}}
 const edges=[];for(const task of tasks)for(const from of task.dependsOn){const a=positions.get(from),b=positions.get(task.id);edges.push({from,to:task.id,x1:a.x+a.width,y1:a.y+a.height/2,x2:b.x,y2:b.y+b.height/2})}
 return {nodes,edges,width:padding*2+Math.max(1,columns.length)*nodeWidth+Math.max(0,columns.length-1)*gapX,height:padding*2+maxRows*nodeHeight+(maxRows-1)*gapY};
}
function describe(s,task){const byId=new Map(s.tasks.map(t=>[t.id,t])),missing=task.dependsOn.map(id=>byId.get(id)).filter(t=>!t||t.status!=='done');if(task.status==='done')return '已完成';if(task.status==='active'){const a=s.agents.find(x=>x.id===task.assignee);return (a?.status==='assigned'?'等待设备启动':'执行中')+(a?' · '+a.name:'')}
 if(s.done)return '实验结束时未完成';if(missing.length)return '等待前置任务：'+missing.map(t=>t?.name||'未知任务').join('、');const packet=(s.communication?.dispatchQueue||[]).find(p=>p.taskId===task.id);if(packet)return '任务指令在途 · '+(s.agents.find(a=>a.id===packet.agentId)?.name||packet.agentId);return '依赖已满足 · 等待分配或资源';}
const api={layout,describe};if(typeof module!=='undefined')module.exports=api;else root.SandboxTaskGraph=api;
})(typeof globalThis!=='undefined'?globalThis:this);
