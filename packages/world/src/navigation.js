/* Deterministic grid navigation with conservative expanded rectangular obstacles. */
(function(root){
'use strict';
const Elevation=typeof module!=='undefined'?require('./elevation'):root.SandboxElevation;
const GRID=2, RADIUS=2;
function inside(x,y,rect,radius=RADIUS){const pad=rect.padding??radius;return x>=rect.x-pad&&x<=rect.x+rect.w+pad&&y>=rect.y-pad&&y<=rect.y+rect.h+pad}
function free(x,y,obstacles,radius=RADIUS,worldSize=100){return x>=radius&&x<=worldSize-radius&&y>=radius&&y<=worldSize-radius&&!obstacles.some(o=>inside(x,y,o,radius))}
// Slab intersection checks the complete swept segment, not just its endpoints.
function clearSegment(a,b,obstacles,radius=RADIUS,worldSize=100){
 if(!free(a[0],a[1],obstacles,radius,worldSize)||!free(b[0],b[1],obstacles,radius,worldSize))return false;
 for(const o of obstacles){let lo=0,hi=1;const pad=o.padding??radius;for(const [start,delta,min,max] of [[a[0],b[0]-a[0],o.x-pad,o.x+o.w+pad],[a[1],b[1]-a[1],o.y-pad,o.y+o.h+pad]]){
   if(Math.abs(delta)<1e-10){if(start<min||start>max){lo=2;break}}else{let t1=(min-start)/delta,t2=(max-start)/delta;if(t1>t2)[t1,t2]=[t2,t1];lo=Math.max(lo,t1);hi=Math.min(hi,t2);if(lo>hi)break}
  }if(lo<=hi&&hi>=0&&lo<=1)return false;
 }return true;
}
class Heap{constructor(){this.a=[]} push(v){let i=this.a.push(v)-1;while(i){let p=(i-1)>>1;if(this.less(this.a[p],v))break;this.a[i]=this.a[p];i=p}this.a[i]=v} pop(){if(!this.a.length)return null;const top=this.a[0],last=this.a.pop();if(this.a.length){let i=0;while(true){let l=i*2+1,r=l+1;if(l>=this.a.length)break;let c=r<this.a.length&&this.less(this.a[r],this.a[l])?r:l;if(this.less(last,this.a[c]))break;this.a[i]=this.a[c];i=c}this.a[i]=last}return top}less(a,b){return a.f<b.f||(a.f===b.f&&(a.h<b.h||(a.h===b.h&&a.id<b.id)))}}
function planDistance(start,target,obstacles,worldSize){
 if(!free(...start,obstacles,RADIUS,worldSize)||!free(...target,obstacles,RADIUS,worldSize))return null;if(clearSegment(start,target,obstacles,RADIUS,worldSize))return [target.slice()];
 const side=Math.floor(worldSize/GRID)+1,key=(x,y)=>y*side+x,open=new Heap(),costs=new Map(),parents=new Map(),heuristic=(x,y)=>Math.hypot(target[0]-x*GRID,target[1]-y*GRID);
 function anchors(point){const cx=Math.round(point[0]/GRID),cy=Math.round(point[1]/GRID),out=[];for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){const x=cx+dx,y=cy+dy,p=[x*GRID,y*GRID];if(x>=0&&y>=0&&x<side&&y<side&&clearSegment(point,p,obstacles,RADIUS,worldSize))out.push({x,y,id:key(x,y),cost:Math.hypot(point[0]-p[0],point[1]-p[1])})}return out}
 const starts=anchors(start),ends=anchors(target),goalCosts=new Map(ends.map(x=>[x.id,x.cost]));if(!starts.length||!ends.length)return null;
 for(const item of starts){const old=costs.get(item.id);if(old===undefined||item.cost<old){const h=heuristic(item.x,item.y);costs.set(item.id,item.cost);parents.set(item.id,null);open.push({...item,g:item.cost,h,f:item.cost+h})}}
 const dirs=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]];let bestGoal=null,bestCost=Infinity;
 while(open.a.length){const cur=open.pop();if(cur.g!==costs.get(cur.id))continue;if(cur.f>bestCost+1e-9)break;if(goalCosts.has(cur.id)){const total=cur.g+goalCosts.get(cur.id);if(total<bestCost-1e-9||(Math.abs(total-bestCost)<1e-9&&(bestGoal===null||cur.id<bestGoal))){bestCost=total;bestGoal=cur.id}}
  for(const [dx,dy] of dirs){const nx=cur.x+dx,ny=cur.y+dy;if(nx<0||nx>=side||ny<0||ny>=side||!clearSegment([cur.x*GRID,cur.y*GRID],[nx*GRID,ny*GRID],obstacles,RADIUS,worldSize))continue;const id=key(nx,ny),ng=cur.g+GRID*Math.hypot(dx,dy);if(ng+1e-9>=(costs.get(id)??Infinity))continue;costs.set(id,ng);parents.set(id,cur.id);const h=heuristic(nx,ny);open.push({x:nx,y:ny,id,g:ng,h,f:ng+h})}
 }
 if(bestGoal===null)return null;const reverse=[];let id=bestGoal;while(id!==null){reverse.push([(id%side)*GRID,Math.floor(id/side)*GRID]);id=parents.get(id)}reverse.reverse();const path=[...reverse,target.slice()],out=[];let from=start,index=0;while(index<path.length){let far=index;for(let j=index+1;j<path.length;j++)if(clearSegment(from,path[j],obstacles,RADIUS,worldSize))far=j;if(Math.hypot(from[0]-path[far][0],from[1]-path[far][1])>1e-9)out.push(path[far]);from=path[far];index=far+1}return out.length?out:[target.slice()];
}
// Integrate time or energy along a straight segment through rectangular terrain zones.
function segmentCost(a,b,zones=[],metric='distance',heightfield=null){
 const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(!length||metric==='distance'||(!zones.length&&!Elevation.hasCosts(heightfield)))return length;if(!['time','energy'].includes(metric))throw Error('invalid navigation metric');
 const cuts=heightfield?Elevation.cuts(heightfield,a,b):[0,1];for(const z of zones){if(Math.abs(dx)>1e-12)for(const x of [z.x,z.x+z.w]){const t=(x-a[0])/dx,y=a[1]+t*dy;if(t>0&&t<1&&y>=z.y-1e-9&&y<=z.y+z.h+1e-9)cuts.push(t)}if(Math.abs(dy)>1e-12)for(const y of [z.y,z.y+z.h]){const t=(y-a[1])/dy,x=a[0]+t*dx;if(t>0&&t<1&&x>=z.x-1e-9&&x<=z.x+z.w+1e-9)cuts.push(t)}}
 cuts.sort((a,b)=>a-b);let cost=0;for(let i=1;i<cuts.length;i++){const span=cuts[i]-cuts[i-1];if(span<1e-12)continue;const mid=(cuts[i]+cuts[i-1])/2,x=a[0]+dx*mid,y=a[1]+dy*mid;const grade=Elevation.factor(heightfield,x,y);let speed=grade.speedFactor,energy=grade.energyFactor;for(const z of zones)if(x>=z.x&&x<=z.x+z.w&&y>=z.y&&y<=z.y+z.h){speed=Math.min(speed,z.speedFactor);energy=Math.max(energy,z.energyFactor)}cost+=length*span*(metric==='time'?1/speed:energy)}return cost;
}
function plan(start,target,obstacles,zones=[],metric='distance',heightfield=null,worldSize=100){
 if(heightfield){Elevation.validate(heightfield);const added=Elevation.blockedCells(heightfield).filter(b=>!obstacles.some(o=>o.x===b.x&&o.y===b.y&&o.w===b.w&&o.h===b.h&&(o.padding??RADIUS)===RADIUS));obstacles=obstacles.concat(added)}
 if(!['distance','time','energy'].includes(metric))throw Error('invalid navigation metric');if(metric==='distance'||(!zones.length&&!Elevation.hasCosts(heightfield)))return planDistance(start,target,obstacles,worldSize);
 if(!free(...start,obstacles,RADIUS,worldSize)||!free(...target,obstacles,RADIUS,worldSize))return null;
 const edge=(a,b)=>segmentCost(a,b,zones,metric,heightfield),direct=clearSegment(start,target,obstacles,RADIUS,worldSize)?edge(start,target):Infinity;
 const side=Math.floor(worldSize/GRID)+1,key=(x,y)=>y*side+x,open=new Heap(),costs=new Map(),parents=new Map(),heuristic=(x,y)=>Math.hypot(target[0]-x*GRID,target[1]-y*GRID);
 function anchors(point){const cx=Math.round(point[0]/GRID),cy=Math.round(point[1]/GRID),out=[];for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){const x=cx+dx,y=cy+dy,p=[x*GRID,y*GRID];if(x>=0&&y>=0&&x<side&&y<side&&clearSegment(point,p,obstacles,RADIUS,worldSize))out.push({x,y,id:key(x,y),cost:edge(point,p)})}return out}
 const starts=anchors(start),ends=anchors(target),goalCosts=new Map(ends.map(x=>[x.id,x.cost]));if(!starts.length||!ends.length)return Number.isFinite(direct)?[target.slice()]:null;
 for(const item of starts){const old=costs.get(item.id);if(old===undefined||item.cost<old){const h=heuristic(item.x,item.y);costs.set(item.id,item.cost);parents.set(item.id,null);open.push({...item,g:item.cost,h,f:item.cost+h})}}
 const dirs=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]];let bestGoal=null,bestCost=direct;
 while(open.a.length){const cur=open.pop();if(cur.g!==costs.get(cur.id))continue;if(cur.f>bestCost+1e-9)break;if(goalCosts.has(cur.id)){const total=cur.g+goalCosts.get(cur.id);if(total<bestCost-1e-9||(Math.abs(total-bestCost)<1e-9&&bestGoal!==null&&cur.id<bestGoal)){bestCost=total;bestGoal=cur.id}}
  for(const [dx,dy] of dirs){const nx=cur.x+dx,ny=cur.y+dy,p=[cur.x*GRID,cur.y*GRID],q=[nx*GRID,ny*GRID];if(nx<0||nx>=side||ny<0||ny>=side||!clearSegment(p,q,obstacles,RADIUS,worldSize))continue;const id=key(nx,ny),ng=cur.g+edge(p,q);if(ng+1e-9>=(costs.get(id)??Infinity))continue;costs.set(id,ng);parents.set(id,cur.id);const h=heuristic(nx,ny);open.push({x:nx,y:ny,id,g:ng,h,f:ng+h})}
 }
 if(bestGoal===null)return Number.isFinite(direct)?[target.slice()]:null;const reverse=[];for(let id=bestGoal;id!==null;id=parents.get(id))reverse.push([(id%side)*GRID,Math.floor(id/side)*GRID]);reverse.reverse();const path=[...reverse,target.slice()],out=[];let from=start,index=0;while(index<path.length){let far=index,routed=edge(from,path[index]);for(let j=index+1;j<path.length;j++){routed+=edge(path[j-1],path[j]);if(clearSegment(from,path[j],obstacles,RADIUS,worldSize)&&edge(from,path[j])<=routed+1e-8)far=j}if(Math.hypot(from[0]-path[far][0],from[1]-path[far][1])>1e-9)out.push(path[far]);from=path[far];index=far+1}return out.length?out:[target.slice()];
}
const api={GRID,RADIUS,free,clearSegment,segmentCost,plan};if(typeof module!=='undefined')module.exports=api;else root.SandboxNavigation=api;
})(typeof globalThis!=='undefined'?globalThis:this);
