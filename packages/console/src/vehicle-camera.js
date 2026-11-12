/* Choose an observation camera without placing it behind a known facility. */
(function(root){
'use strict';
const Sensors=typeof module!=='undefined'?require('@42tr/3dbox4agent-world/sensors'):root.SandboxSensors;
function clear(from,to,obstacles,heightfield){return Sensors.visible(from,to,1000,obstacles,heightfield)}
function offset(position,angle,obstacles,scale=1,heightfield){
 for(const [x,y,z] of [[5,3.1,6],[-5,3.1,6],[5,4,-6],[-5,4,-6],[0,12,0]]){
  const dx=(x*Math.cos(angle)+z*Math.sin(angle))*scale,dz=(-x*Math.sin(angle)+z*Math.cos(angle))*scale,dy=y*scale;
  if(clear({x:position.x+dx,y:position.y+dz,z:position.z+dy},{x:position.x,y:position.y,z:position.z+.9},obstacles,heightfield))return {x:dx,y:dy,z:dz};
 }
 return {x:0,y:12*scale,z:0};
}
const api={clear,offset};if(typeof module!=='undefined')module.exports=api;else root.SandboxVehicleCamera=api;
})(typeof globalThis!=='undefined'?globalThis:this);
