/* Piecewise planar, row-major heightfields over the published 100 x 100 map.
 * The diagonal joins each cell's upper-right and lower-left vertices. */
(function(root){
'use strict';
const MAX_SIDE=17,DEFAULT_SLOPE=20,cache=new WeakMap();
function validate(h){
 if(!h||typeof h!=='object'||Array.isArray(h)||Object.keys(h).some(k=>!['rows','cols','heights','maxSlopeDegrees'].includes(k))||!Number.isSafeInteger(h.rows)||!Number.isSafeInteger(h.cols)||h.rows<2||h.cols<2||h.rows>MAX_SIDE||h.cols>MAX_SIDE||!Array.isArray(h.heights)||h.heights.length!==h.rows*h.cols||h.heights.some(n=>!Number.isFinite(n)||n< -10||n>10)||h.maxSlopeDegrees!==undefined&&(!Number.isFinite(h.maxSlopeDegrees)||h.maxSlopeDegrees<1||h.maxSlopeDegrees>60))throw Error('invalid heightfield');
 return true;
}
function normalize(h){validate(h);return Object.freeze({rows:h.rows,cols:h.cols,heights:Object.freeze(h.heights.slice()),maxSlopeDegrees:h.maxSlopeDegrees??DEFAULT_SLOPE})}
function inside(x,y){return x>=0&&x<=100&&y>=0&&y<=100}
function location(h,x,y){const w=100/(h.cols-1),d=100/(h.rows-1),col=Math.min(h.cols-2,Math.floor(x/w)),row=Math.min(h.rows-2,Math.floor(y/d));return {w,d,col,row,u:(x-col*w)/w,v:(y-row*d)/d,index:row*h.cols+col}}
function surface(h,x,y){
 if(!h||!inside(x,y))return {height:0,dx:0,dy:0,slopeDegrees:0};
 const {w,d,index,u,v}=location(h,x,y),a=h.heights[index],b=h.heights[index+1],c=h.heights[index+h.cols],z=h.heights[index+h.cols+1];let height,dx,dy;
 if(u+v<=1){dx=(b-a)/w;dy=(c-a)/d;height=a+(b-a)*u+(c-a)*v}else{dx=(z-c)/w;dy=(z-b)/d;height=z+(c-z)*(1-u)+(b-z)*(1-v)}
 return {height,dx,dy,slopeDegrees:Math.atan(Math.hypot(dx,dy))*180/Math.PI};
}
const height=(h,x,y)=>surface(h,x,y).height;
function profile(h){
 if(!h)return [];if(cache.has(h))return cache.get(h);
 const cells=[],w=100/(h.cols-1),d=100/(h.rows-1);
 for(let row=0;row<h.rows-1;row++)for(let col=0;col<h.cols-1;col++){
  const i=row*h.cols+col,a=h.heights[i],b=h.heights[i+1],c=h.heights[i+h.cols],z=h.heights[i+h.cols+1],grade=Math.max(Math.hypot((b-a)/w,(c-a)/d),Math.hypot((z-c)/w,(z-b)/d)),slopeDegrees=Math.atan(grade)*180/Math.PI;
  cells.push(Object.freeze({id:`hf-cell-${row}-${col}`,name:`坡地单元 ${row+1}/${col+1}`,x:col*w,y:row*d,w,h:d,slopeDegrees,blocked:slopeDegrees>(h.maxSlopeDegrees??DEFAULT_SLOPE)+1e-9,speedFactor:1/Math.sqrt(1+grade*grade),energyFactor:1+2*grade}));
 }
 const result=Object.freeze(cells);if(Object.isFrozen(h)&&Object.isFrozen(h.heights))cache.set(h,result);return result;
}
function factor(h,x,y){if(!h||!inside(x,y))return {speedFactor:1,energyFactor:1,blocked:false};const {row,col}=location(h,x,y);return profile(h)[row*(h.cols-1)+col]}
const hasCosts=h=>profile(h).some(c=>!c.blocked&&c.energyFactor>1+1e-12);
function blockedCells(h){return profile(h).filter(c=>c.blocked).map(c=>({x:c.x,y:c.y,w:c.w,h:c.h}))}
function terrain(h){return profile(h).filter(c=>!c.blocked&&c.energyFactor>1+1e-12).map(({id,name,x,y,w,h,speedFactor,energyFactor})=>({id,name,x,y,w,h,speedFactor,energyFactor}))}
// Include grid lines, map boundaries and triangle diagonals, so each open span
// lies on exactly one affine surface. No arbitrary sampling interval is used.
function cuts(h,a,b){
 if(!h)return [0,1];const dx=b[0]-a[0],dy=b[1]-a[1],w=100/(h.cols-1),d=100/(h.rows-1),values=[0,1];
 const add=t=>{if(t>0&&t<1)values.push(t)};
 if(Math.abs(dx)>1e-12)for(let c=0;c<h.cols;c++)add((c*w-a[0])/dx);
 if(Math.abs(dy)>1e-12)for(let r=0;r<h.rows;r++)add((r*d-a[1])/dy);
 const delta=dx/w+dy/d;
 if(Math.abs(delta)>1e-12)for(let r=0;r<h.rows-1;r++)for(let c=0;c<h.cols-1;c++){
  const t=(1-(a[0]-c*w)/w-(a[1]-r*d)/d)/delta,x=a[0]+t*dx,y=a[1]+t*dy;
  if(x>=c*w-1e-9&&x<=(c+1)*w+1e-9&&y>=r*d-1e-9&&y<=(r+1)*d+1e-9)add(t);
 }
 values.sort((x,y)=>x-y);return values.filter((t,i)=>i===0||t-values[i-1]>1e-12);
}
function visible(h,from,to){
 if(!h)return true;const a=[from.x,from.y],b=[to.x,to.y],ts=cuts(h,a,b),at=t=>({x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t,z:from.z+(to.z-from.z)*t});
 for(let i=1;i<ts.length;i++){
  const mid=at((ts[i-1]+ts[i])/2);if(!inside(mid.x,mid.y))continue;
  const p=at(ts[i-1]),q=at(ts[i]),pa=p.z-height(h,p.x,p.y),pb=q.z-height(h,q.x,q.y);
  // A mesh has no interior: crossing or touching blocks; parallel rays below
  // the surface do not hit a fictitious solid volume.
  if(Math.abs(pa)<=1e-8||Math.abs(pb)<=1e-8||(pa<0)!==(pb<0))return false;
 }
 return true;
}
function mesh(h){
 const vertices=[],indices=[],w=100/(h.cols-1),d=100/(h.rows-1);
 for(let r=0;r<h.rows;r++)for(let c=0;c<h.cols;c++)vertices.push(c*w,h.heights[r*h.cols+c],r*d);
 for(let r=0;r<h.rows-1;r++)for(let c=0;c<h.cols-1;c++){const i=r*h.cols+c;indices.push(i,i+h.cols,i+1,i+1,i+h.cols,i+h.cols+1)}
 return {vertices,indices};
}
// Exact min/max of the piecewise affine mesh clipped to an obstacle footprint.
// The conservative prism covers uneven ground rather than leaving under-wall gaps.
function bounds(h,rect){
 if(!h)return [0,0];let low=Infinity,high=-Infinity;const w=100/(h.cols-1),d=100/(h.rows-1);
 const clip=(points,axis,bound,sign)=>{const out=[];for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],da=sign*(a[axis]-bound),db=sign*(b[axis]-bound),ina=da>=0,inb=db>=0;if(ina)out.push(a);if(ina!==inb){const t=da/(da-db);out.push(a.map((n,k)=>n+(b[k]-n)*t))}}return out};
 for(let r=0;r<h.rows-1;r++)for(let c=0;c<h.cols-1;c++){
  if((c+1)*w<rect.x||c*w>rect.x+rect.w||(r+1)*d<rect.y||r*d>rect.y+rect.h)continue;
  const i=r*h.cols+c,a=[c*w,r*d,h.heights[i]],b=[(c+1)*w,r*d,h.heights[i+1]],q=[c*w,(r+1)*d,h.heights[i+h.cols]],z=[(c+1)*w,(r+1)*d,h.heights[i+h.cols+1]];
  for(const tri of [[a,q,b],[b,q,z]]){let poly=tri;for(const [axis,bound,sign] of [[0,rect.x,1],[0,rect.x+rect.w,-1],[1,rect.y,1],[1,rect.y+rect.h,-1]])poly=clip(poly,axis,bound,sign);for(const p of poly){low=Math.min(low,p[2]);high=Math.max(high,p[2])}}
 }
 return Number.isFinite(low)?[low,high]:[0,0];
}
function proxyHeight(h,x,y){if(!h)return 1;const r=.8,rx=Math.max(0,x-r),ry=Math.max(0,y-r);return bounds(h,{x:rx,y:ry,w:Math.min(100,x+r)-rx,h:Math.min(100,y+r)-ry})[1]+1}
function traversable(h,a,b,radius=2){if(!h)return true;for(const p of [a,b])if(p[0]<radius||p[0]>100-radius||p[1]<radius||p[1]>100-radius)return false;for(const o of blockedCells(h)){let lo=0,hi=1;for(const [start,delta,min,max] of [[a[0],b[0]-a[0],o.x-radius,o.x+o.w+radius],[a[1],b[1]-a[1],o.y-radius,o.y+o.h+radius]]){if(Math.abs(delta)<1e-10){if(start<min||start>max){lo=2;break}}else{let t1=(min-start)/delta,t2=(max-start)/delta;if(t1>t2)[t1,t2]=[t2,t1];lo=Math.max(lo,t1);hi=Math.min(hi,t2);if(lo>hi)break}}if(lo<=hi&&hi>=0&&lo<=1)return false}return true}
function prism(h,o){if(!h)return o;const [base,top]=bounds(h,o);return {...o,base,height:top+o.height}}
function motion(field,p,u,d,minimum=0){
 if(!field)return {speed:1,energy:1,boundary:d,micro:false};
 let boundary=d;const end=[p[0]+u[0]*d,p[1]+u[1]*d];
 for(const t of cuts(field,p,end)){const length=t*d;if(length>1e-7&&length<boundary)boundary=length}
 let probe=factor(field,p[0]+u[0]*1e-7,p[1]+u[1]*1e-7),speed=probe.speedFactor,energy=probe.energyFactor;
 const micro=minimum>0&&boundary<d&&boundary<minimum;
 if(micro){boundary=Math.min(d,minimum);const target=[p[0]+u[0]*boundary,p[1]+u[1]*boundary],ts=cuts(field,p,target);for(let i=1;i<ts.length;i++){const t=(ts[i-1]+ts[i])/2,g=factor(field,p[0]+(target[0]-p[0])*t,p[1]+(target[1]-p[1])*t);speed=Math.min(speed,g.speedFactor);energy=Math.max(energy,g.energyFactor)}}
 return {speed,energy,boundary,micro};
}
const api={motion,MAX_SIDE,DEFAULT_SLOPE,validate,normalize,surface,height,profile,factor,hasCosts,blockedCells,terrain,cuts,visible,mesh,bounds,proxyHeight,traversable,prism};
if(typeof module!=='undefined')module.exports=api;else root.SandboxElevation=api;
})(typeof globalThis!=='undefined'?globalThis:this);
