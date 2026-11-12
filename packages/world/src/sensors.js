/* Deterministic point observations through axis-aligned building prisms. */
(function(root){
'use strict';
const Elevation=typeof module!=='undefined'?require('./elevation'):root.SandboxElevation;
function visible(from,to,range,obstacles,heightfield){
 if(Math.hypot(to.x-from.x,to.y-from.y)>range)return false;
 if(heightfield&&!Elevation.visible(heightfield,from,to))return false;
 for(const original of obstacles){const o=heightfield?Elevation.prism(heightfield,original):original;let lo=0,hi=1;
  for(const [start,delta,min,max] of [[from.x,to.x-from.x,o.x,o.x+o.w],[from.y,to.y-from.y,o.y,o.y+o.h],...(heightfield?[[from.z,to.z-from.z,o.base,o.height]]:[])]){
   if(Math.abs(delta)<1e-10){if(start<min||start>max){lo=2;break}}
   else {let a=(min-start)/delta,b=(max-start)/delta;if(a>b)[a,b]=[b,a];lo=Math.max(lo,a);hi=Math.min(hi,b);if(lo>hi)break}
  }
  if(lo<=hi&&hi>=0&&lo<=1){const a=Math.max(0,lo),b=Math.min(1,hi),ha=from.z+(to.z-from.z)*a,hb=from.z+(to.z-from.z)*b;if(Math.min(ha,hb)<=o.height)return false}
 }
 return true;
}
function isAir(a){return (a.mobility??(a.role==='drone'?'air':'ground'))==='air'}
function position(a,heightfield){return {x:a.x,y:a.y,z:isAir(a)?16:1.5+Elevation.height(heightfield,a.x,a.y)}}
const api={visible,position,isAir};if(typeof module!=='undefined')module.exports=api;else root.SandboxSensors=api;
})(typeof globalThis!=='undefined'?globalThis:this);
