'use strict';
const assert=require('node:assert/strict'),H=require('../src/elevation'),Nav=require('../src/navigation'),Native=require('../server/rust-navigation');
const near=(a,b,e=1e-7)=>assert(Math.abs(a-b)<=e,`${a} != ${b}`),pathCost=(start,path,zones,metric,field)=>{let p=start,total=0;for(const q of path){total+=Nav.segmentCost(p,q,zones,metric,field);p=q}return total};
const ramp=H.normalize({rows:2,cols:2,heights:[0,10,0,10]}),a=[10,50],b=[90,50],zone=[{x:40,y:40,w:20,h:20,speedFactor:.5,energyFactor:2}];near(Nav.segmentCost(a,b,[],'energy',ramp),96);near(Nav.segmentCost(a,b,[],'time',ramp),80*Math.sqrt(1.01));near(Nav.segmentCost(a,b,zone,'energy',ramp),112);near(Nav.segmentCost(a,b,zone,'time',ramp),60*Math.sqrt(1.01)+40);near(Nav.segmentCost(a,b,zone,'distance',ramp),80);near(Nav.segmentCost(a,b,zone,'energy'),100);
const heights=Array.from({length:49},(_,i)=>i%7===3&&![3,4].includes(Math.floor(i/7))?10:0),steep=H.normalize({rows:7,cols:7,heights,maxSlopeDegrees:20}),gentle=H.normalize({...steep,maxSlopeDegrees:60}),start=[10,20],target=[90,20];
for(const field of [null,H.normalize({rows:2,cols:2,heights:[2,2,2,2]}),steep,gentle])for(const metric of ['distance','time','energy']){
 const expected=Nav.plan(start,target,[],[],metric,field),actual=Native.plan(start,target,[],[],metric,field);assert.deepEqual(actual,expected,JSON.stringify({field:field?.maxSlopeDegrees,metric,expected,actual}));assert(actual);let p=start;const blocks=H.blockedCells(field);for(const q of actual){assert(Nav.clearSegment(p,q,blocks));assert(H.traversable(field,p,q));p=q}near(pathCost(start,expected,[],metric,field),pathCost(start,actual,[],metric,field));
 if(field===steep)assert(actual.some(p=>p[1]>50));
}
const direct=Nav.plan(start,target,[],[],'distance',gentle),efficient=Nav.plan(start,target,[],[],'energy',gentle);assert(efficient.some(p=>p[1]>=50));assert(pathCost(start,efficient,[],'energy',gentle)<pathCost(start,direct,[],'energy',gentle)-1);
assert.equal(Nav.plan(start,[50,20],[],[],'distance',steep),null);assert.equal(Native.plan(start,[50,20],[],[],'distance',steep),null);
for(const invalid of [{...ramp,rows:99},{...ramp,heights:[0,Infinity,0,0]}]){assert.throws(()=>Nav.plan(start,target,[],[],'time',invalid));assert.throws(()=>Native.plan(start,target,[],[],'time',invalid))}
console.log('Heightfield routing: conservative steep-cell detour/blocked target, grade time/energy with existing overlap semantics, native/JS identical paths across three metrics and flat legacy equivalence passed');
