'use strict';
const assert=require('node:assert/strict'),D=require('../src/surface-domain'),{surfaceDomainGeometry}=require('../rust/physics/target/release/box_physics.node'),{region,profile,oracle}=require('./surface-domain.test');
let seed=42;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};let segments=0;
for(let sample=0;sample<128;sample++){
 const p=profile(...Array.from({length:1+sample%16},(_,i)=>{const x=Math.floor(random()*80),y=Math.floor(random()*80);return region('r'+i,x,y,1+Math.floor(random()*(99-x)),1+Math.floor(random()*(99-y)))}));
 const partitions=[D.partition(p,true),D.partition(p,false)];let area=0;
 for(const rectangles of partitions)for(let i=0;i<rectangles.length;i++){
  const r=rectangles[i];area+=r.w*r.h;for(const s of rectangles.slice(i+1))assert(Math.min(r.x+r.w,s.x+s.w)<=Math.max(r.x,s.x)||Math.min(r.y+r.h,s.y+s.h)<=Math.max(r.y,s.y));
 }
 assert.equal(area,10000);assert.deepEqual(D.masks(p,'water'),D.masks({water:p.water.slice().reverse()},'water'));
 for(let i=0;i<12;i++)for(const mobility of ['water','ground','air']){
  const start=[random()*100,random()*100],target=[random()*100,random()*100],radius=i%3===0?0:i%3===1?.8:2;
  const native=JSON.parse(surfaceDomainGeometry(JSON.stringify({profile:p,mobility,start,target,radius})));
  assert.deepEqual(native.masks,D.masks(p,mobility));assert.equal(native.clear,D.clearSegment(p,mobility,start,target,radius));if(!radius)assert.equal(native.clear,oracle(p,mobility,start,target));segments++;
 }
}
for(const p of [null,{},profile(),profile({...region('a',1,1,2,2),extra:3}),profile(region('a',-1,0,2,2))])assert.throws(()=>surfaceDomainGeometry(JSON.stringify({profile:p,mobility:'water',start:[2,2],target:[3,3],radius:0})));
console.log('Native surface-domain differential:128 maps, exact masks and '+segments+' swept segments; independent zero-radius interval oracle, partition area/disjointness and input-order invariance passed');
