'use strict';
const assert=require('node:assert/strict'),D=require('../src/surface-domain'),Nav=require('../src/navigation');
const region=(id,x,y,w,h)=>({id,name:id,x,y,w,h}),profile=(...water)=>({water});
const ring=profile(region('north',20,20,60,10),region('south',20,70,60,10),region('west',20,30,10,40),region('east',70,30,10,40));
assert(D.free(ring,'water',[25,50]));assert(!D.free(ring,'water',[50,50]));assert(!D.clearSegment(ring,'water',[25,50],[75,50],0));assert(D.free(ring,'ground',[50,50]));assert(!D.clearSegment(ring,'ground',[10,50],[90,50],0));
const seam=profile(region('left',10,10,40,80),region('right',50,10,40,80));
assert(D.clearSegment(seam,'water',[20,50],[80,50],2));assert.deepEqual(D.masks(seam,'ground'),[{x:10,y:10,w:80,h:80}]);
const islands=profile(region('a',0,0,40,100),region('b',60,0,40,100));
assert.equal(Nav.plan([20,50],[80,50],D.masks(islands,'water')),null);assert(D.clearSegment(islands,'air',[20,50],[80,50],2));
const cove=profile(region('sea',50,0,50,100),region('bay',20,40,30,20));
const route=Nav.plan([70,20],[30,50],D.masks(cove,'water'));assert(route&&route.length>1);let previous=[70,20];for(const point of route){assert(D.clearSegment(cove,'water',previous,point,2));previous=point}
assert(D.free(undefined,'ground',[-10,120]));assert.throws(()=>D.free(undefined,'water',[20,50]));assert.throws(()=>D.masks(seam,'amphibious'));assert(!D.free(seam,'water',[10,50],0));assert(!D.clearSegment(seam,'water',[20,50],[100,50],.8));
const normalized=D.normalize(seam);normalized.water[0].x=2;assert.equal(seam.water[0].x,10);const masks=D.masks(seam,'water');masks[0].x=999;assert.notDeepEqual(masks,D.masks(seam,'water'));
for(const bad of [null,{},[],{water:[]},{water:seam.water,extra:1},profile({...seam.water[0],extra:true}),profile({...seam.water[0],name:''}),profile({...seam.water[0],w:Infinity}),profile({...seam.water[0],x:-1}),profile({...seam.water[0],w:101}),profile(...Array(17).fill(seam.water[0])),profile(seam.water[0],seam.water[0])])assert.throws(()=>D.validate(bad));
// An independent union-of-segment-intervals oracle, without arrangement cells.
function oracle(p,m,a,b){
 if(m==='air')return true;if([...a,...b].some(n=>n<0||n>100))return false;
 const intervals=[];for(const r of p.water){let lo=0,hi=1;for(const [s,d,min,max]of [[a[0],b[0]-a[0],r.x,r.x+r.w],[a[1],b[1]-a[1],r.y,r.y+r.h]]){if(Math.abs(d)<1e-12){if(s<min||s>max){lo=2;break}}else{const x=(min-s)/d,y=(max-s)/d;lo=Math.max(lo,Math.min(x,y));hi=Math.min(hi,Math.max(x,y))}}if(lo<=hi&&hi>=0&&lo<=1)intervals.push([Math.max(0,lo),Math.min(1,hi)])}
 if(m==='ground')return intervals.length===0;intervals.sort((a,b)=>a[0]-b[0]);let until=0;for(const [start,end]of intervals){if(start>until+1e-12)return false;until=Math.max(until,end)}return until>=1;
}
module.exports={region,profile,oracle};
console.log('Surface-domain JS: exact land/water union, holes, seams, disconnected islands, navigable bay, explicit absent-map behavior, detached geometry and validation passed');
