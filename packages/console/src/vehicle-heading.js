/* Presentation yaw from a snapshot route, never a new authoritative pose. */
(function(root){
'use strict';
function yaw(agent,previous,fallback=0){
 if(agent.disabled)return fallback;
 for(const point of agent.route||[]){
  const dx=point[0]-agent.x,dz=point[1]-agent.y;
  if(Number.isFinite(dx)&&Number.isFinite(dz)&&Math.hypot(dx,dz)>.02)return Math.atan2(-dz,dx);
 }
 if(previous?.id===agent.id){
  const dx=agent.x-previous.x,dz=agent.y-previous.y;
  if(Number.isFinite(dx)&&Number.isFinite(dz)&&Math.hypot(dx,dz)>.001)return Math.atan2(-dz,dx);
 }
 return fallback;
}
const api={yaw};if(typeof module!=='undefined')module.exports=api;else root.SandboxVehicleHeading=api;
})(typeof globalThis!=='undefined'?globalThis:this);
