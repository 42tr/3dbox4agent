(function(root){
'use strict';
const E=typeof module!=='undefined'&&module.exports?require('./engine'):root.SandboxEngine;
function validate(input){
 const obj=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
 const integer=(v,a,b)=>Number.isSafeInteger(v)&&v>=a&&v<=b;
 const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v);
 if(!obj(input,['format','sceneId','scene','seed','policy','physicsMode','maxTicks','interventions'])||input.format!=='3dbox-scheduled-experiment-v1'||(input.sceneId===undefined)===(input.scene===undefined)||!integer(input.seed,0,0xffffffff)||!['nearest','battery'].includes(input.policy)||!['kinematic','rapier'].includes(input.physicsMode)||!integer(input.maxTicks,1,10000)||!Array.isArray(input.interventions)||input.interventions.length>100)throw Error('invalid experiment plan');
 const scene=input.scene!==undefined?E.normalizeScene(input.scene):E.getScene(input.sceneId);
 const seen=new Set();let tick=-1;
 for(const action of input.interventions){
  if(!obj(action,['id','tick','type','agentId','duration','level','zoneId','speedFactor','energyFactor','rect'])||!id(action.id)||seen.has(action.id)||!integer(action.tick,0,input.maxTicks)||action.tick<tick)throw Error('invalid intervention ordering or id');
  seen.add(action.id);tick=action.tick;
  const fields={fault:['id','tick','type'],outage:['id','tick','type','agentId','duration'],low_energy:['id','tick','type','agentId','level'],roadblock:['id','tick','type','rect','duration'],terrain:['id','tick','type','zoneId','duration','speedFactor','energyFactor']}[action.type];
  if(!fields||Object.keys(action).some(k=>!fields.includes(k))||fields.some(k=>!Object.prototype.hasOwnProperty.call(action,k)))throw Error('invalid intervention fields');
  if(['outage','low_energy'].includes(action.type)&&!id(action.agentId))throw Error('invalid agent id');
  if(['outage','roadblock','terrain'].includes(action.type)&&!integer(action.duration,1,1000))throw Error('invalid duration');
  if(action.type==='low_energy'&&!integer(action.level,1,5))throw Error('invalid energy level');
  if(action.type==='terrain'&&(!id(action.zoneId)||!Number.isFinite(action.speedFactor)||action.speedFactor<.2||action.speedFactor>1||!Number.isFinite(action.energyFactor)||action.energyFactor<1||action.energyFactor>5))throw Error('invalid terrain intervention');
  if(action.type==='roadblock'){const r=action.rect;if(!obj(r,['x','y','w','h'])||!['x','y','w','h'].every(k=>Number.isFinite(r[k]))||r.x<0||r.y<0||r.w<2||r.h<2||r.x+r.w>100||r.y+r.h>100)throw Error('invalid roadblock');}
 }
 return {...input,scene,interventions:input.interventions.map(v=>structuredClone(v))};
}
const api={validate};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SandboxScheduledPlan=api;
})(typeof globalThis!=='undefined'?globalThis:this);
