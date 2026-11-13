/* Flat land/water domains. These masks constrain movement; they are not walls or sensors. */
(function(root){
'use strict';
function fail(){throw Error('invalid surface domain')}
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function validate(profile){
 if(!object(profile)||Object.keys(profile).some(k=>k!=='water')||!Array.isArray(profile.water)||!profile.water.length||profile.water.length>16)fail();
 const ids=new Set();for(const r of profile.water){
  if(!object(r)||Object.keys(r).some(k=>!['id','name','x','y','w','h'].includes(k))||typeof r.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(r.id)||ids.has(r.id)||typeof r.name!=='string'||!r.name.length||r.name.length>100||![r.x,r.y,r.w,r.h].every(Number.isFinite)||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x+r.w>100||r.y+r.h>100)fail();ids.add(r.id);
 }
 return true;
}
function normalize(profile){validate(profile);return {water:profile.water.map(r=>({id:r.id,name:r.name,x:r.x,y:r.y,w:r.w,h:r.h}))}}
function mode(mobility){if(!['ground','water','air'].includes(mobility))fail();return mobility}
// Exact rectangle arrangement. Every open cell has a constant union membership.
// Adjacent equal horizontal runs merge vertically; input order never changes masks.
function partition(profile,water){
 validate(profile);const xs=[...new Set([0,100,...profile.water.flatMap(r=>[r.x,r.x+r.w])])].sort((a,b)=>a-b),ys=[...new Set([0,100,...profile.water.flatMap(r=>[r.y,r.y+r.h])])].sort((a,b)=>a-b),out=[];let previous=new Map();
 for(let j=0;j<ys.length-1;j++){
  const runs=[],y=(ys[j]+ys[j+1])/2;let left=null;
  for(let i=0;i<xs.length-1;i++){
   const x=(xs[i]+xs[i+1])/2,inside=profile.water.some(r=>x>r.x&&x<r.x+r.w&&y>r.y&&y<r.y+r.h);
   if(inside===water){if(left===null)left=xs[i]}else if(left!==null){runs.push([left,xs[i]]);left=null}
  }
  if(left!==null)runs.push([left,100]);const next=new Map();
  for(const [x,end]of runs){const key=JSON.stringify([x,end]),old=previous.get(key);if(old!==undefined){out[old].h=ys[j+1]-out[old].y;next.set(key,old)}else{next.set(key,out.length);out.push({x,y:ys[j],w:end-x,h:ys[j+1]-ys[j]})}}previous=next;
 }
 return out;
}
function masks(profile,mobility){mode(mobility);if(profile===undefined){if(mobility==='water')fail();return []}validate(profile);return mobility==='air'?[]:partition(profile,mobility==='ground')}
// Presentation query for the entire rectangle, including holes and unions.
// Boundary-only contact has no area; sampling the center would miss islands.
function regionKind(profile,r){
 if(!object(r)||![r.x,r.y,r.w,r.h].every(Number.isFinite)||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x+r.w>100||r.y+r.h>100)fail();
 if(profile===undefined)return 'ground';
 const overlaps=b=>Math.min(r.x+r.w,b.x+b.w)>Math.max(r.x,b.x)&&Math.min(r.y+r.h,b.y+b.h)>Math.max(r.y,b.y);
 const water=partition(profile,true).some(overlaps),ground=partition(profile,false).some(overlaps);
 return water?(ground?'mixed':'water'):'ground';
}
function hit(a,b,r,padding){
 let lo=0,hi=1;for(const [start,delta,min,max]of [[a[0],b[0]-a[0],r.x-padding,r.x+r.w+padding],[a[1],b[1]-a[1],r.y-padding,r.y+r.h+padding]]){
  if(Math.abs(delta)<1e-12){if(start<min||start>max)return false}else{let t=(min-start)/delta,u=(max-start)/delta;if(t>u)[t,u]=[u,t];lo=Math.max(lo,t);hi=Math.min(hi,u);if(lo>hi)return false}
 }return lo<=hi&&hi>=0&&lo<=1;
}
function clearSegment(profile,mobility,a,b,radius=.8){
 mode(mobility);if(!Array.isArray(a)||!Array.isArray(b)||a.length!==2||b.length!==2||![...a,...b,radius].every(Number.isFinite)||radius<0||radius>5)fail();
 const blocks=masks(profile,mobility);if(profile===undefined||mobility==='air')return true;
 if([...a,...b].some(n=>n<radius||n>100-radius))return false;
 return !blocks.some(r=>hit(a,b,r,radius));
}
const worldBounds=()=>[{x:-100,y:-100,w:100,h:300},{x:100,y:-100,w:100,h:300},{x:0,y:-100,w:100,h:100},{x:0,y:100,w:100,h:100}];
function bodyFree(profile,mobility,at,radius=.8){
 mode(mobility);if(!Array.isArray(at)||at.length!==2||![...at,radius].every(Number.isFinite)||radius<=0||radius>5)fail();const blocks=masks(profile,mobility);if(profile===undefined||mobility==='air')return true;
 const tolerance=1e-4;if(at.some(n=>n<radius-tolerance||n>100-radius+tolerance))return false;
 return blocks.every(r=>Math.hypot(Math.max(r.x-at[0],0,at[0]-r.x-r.w),Math.max(r.y-at[1],0,at[1]-r.y-r.h))>=radius-tolerance);
}
function spawnArea(area,worldSize=100){
 if(!object(area)||Object.keys(area).length!==4||Object.keys(area).some(k=>!['x','y','w','h'].includes(k))||![area.x,area.y,area.w,area.h].every(Number.isFinite)||area.x<2||area.y<2||area.w<=0||area.h<=0||area.x+area.w>worldSize-2||area.y+area.h>worldSize-2)fail();return {x:area.x,y:area.y,w:area.w,h:area.h};
}
const offsets=[[1,0],[.8,.6],[.6,.8],[0,1],[-.6,.8],[-.8,.6],[-1,0],[-.8,-.6],[-.6,-.8],[0,-1],[.6,-.8],[.8,-.6]];
function approaches(goal,radius){return offsets.map(([x,y])=>[goal[0]+x*radius,goal[1]+y*radius])}
const api={regionKind,approaches,spawnArea,bodyFree,worldBounds,validate,normalize,masks,partition,clearSegment,free:(p,m,at,r=.8)=>clearSegment(p,m,at,at,r)};
if(typeof module!=='undefined')module.exports=api;else root.SandboxSurfaceDomain=api;
})(typeof globalThis!=='undefined'?globalThis:this);
