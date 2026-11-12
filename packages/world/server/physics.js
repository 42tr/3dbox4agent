'use strict';
// Rapier-backed collision queries for the server's fixed-step kinematic world.
const R=require('@dimforge/rapier3d-compat');
const Elevation=require('../src/elevation');
const SurfaceDomain=require('../src/surface-domain');
let ready;
function initialize(){return ready||(ready=R.init())}
function createPhysics(state){
 const heightfield=state.heightfield===undefined?null:Elevation.normalize(state.heightfield),air=new Set(state.agents.filter(a=>(a.mobility??(a.role==='drone'?'air':'ground'))==='air').map(a=>a.id));
 const domain=state.surfaceDomain===undefined?undefined:SurfaceDomain.normalize(state.surfaceDomain),water=new Set(state.agents.filter(a=>a.mobility==='water').map(a=>a.id));
 if(domain&&heightfield)throw Error('surface domains require a flat map');
 for(const a of state.agents){const mobility=a.mobility??(a.role==='drone'?'air':'ground');if(!['air','ground','water'].includes(mobility)||mobility==='water'&&!domain)throw Error('invalid surface mobility');if(domain&&!SurfaceDomain.bodyFree(domain,mobility,[a.x,a.y],.8))throw Error('agent outside surface domain')}
 let world=new R.World({x:0,y:0,z:0});world.timestep=1/20;
 if(heightfield){const {vertices,indices}=Elevation.mesh(heightfield);world.createCollider(R.ColliderDesc.trimesh(new Float32Array(vertices),new Uint32Array(indices)))}
 function block(o){const [base,upper]=heightfield?Elevation.bounds(heightfield,o):[0,0],top=upper+o.height;return R.ColliderDesc.cuboid(o.w/2,(top-base)/2,o.h/2).setTranslation(o.x+o.w/2,(top+base)/2,o.y+o.h/2)}
 for(const o of state.obstacles)world.createCollider(block(o));
 const domainColliders=new Map();if(domain)for(const waterForbidden of [false,true])for(const r of SurfaceDomain.partition(domain,!waterForbidden).concat(SurfaceDomain.worldBounds())){const c=world.createCollider(R.ColliderDesc.cuboid(r.w/2,2,r.h/2).setTranslation(r.x+r.w/2,1,r.y+r.h/2));domainColliders.set(c.handle,waterForbidden)}
 const roadblockColliders=new Map();
 function syncRoadblocks(blocks){let changed=false;const live=new Set(blocks.map(b=>b.id));for(const [id,collider] of roadblockColliders)if(!live.has(id)){world.removeCollider(collider,true);roadblockColliders.delete(id);changed=true}for(const b of blocks)if(!roadblockColliders.has(b.id)){const collider=world.createCollider(block(b));roadblockColliders.set(b.id,collider);changed=true}if(changed)world.step()}
 syncRoadblocks(state.roadblocks||[]);
 const colliders=new Map();for(const a of state.agents){const height=air.has(a.id)?16:heightfield?Elevation.proxyHeight(heightfield,a.x,a.y):1;const collider=world.createCollider(R.ColliderDesc.ball(.8).setTranslation(a.x,height,a.y));colliders.set(a.id,collider)}
 let controller=world.createCharacterController(.02);controller.setSlideEnabled(true);world.step();
 const points=new WeakMap();let closed=false;
 return {
  checkpoint(){if(closed)throw Error('physics world is closed');const point=Object.freeze({free(){points.delete(point)}});points.set(point,{bytes:world.takeSnapshot(),agents:[...colliders].map(([id,c])=>[id,c.handle]),roadblocks:[...roadblockColliders].map(([id,c])=>[id,c.handle]),domains:[...domainColliders]});return point},
  rollback(point){
   if(closed||!points.has(point))throw Error('physics checkpoint unavailable');
   const saved=points.get(point),restored=R.World.restoreSnapshot(saved.bytes);
   const nextAgents=saved.agents.map(([id,h])=>[id,restored.getCollider(h)]),nextRoadblocks=saved.roadblocks.map(([id,h])=>[id,restored.getCollider(h)]);
   if([...nextAgents,...nextRoadblocks,...saved.domains.map(([h,kind])=>[kind,restored.getCollider(h)])].some(([,c])=>!c)){restored.free();throw Error('physics checkpoint collider missing')}
   const nextController=restored.createCharacterController(.02);nextController.setSlideEnabled(true);
   world.free();world=restored;controller=nextController;colliders.clear();roadblockColliders.clear();for(const [id,c] of nextAgents)colliders.set(id,c);for(const [id,c] of nextRoadblocks)roadblockColliders.set(id,c);domainColliders.clear();for(const [h,kind]of saved.domains)domainColliders.set(h,kind);
  },
  syncRoadblocks,
  move(agent,dx,dy){const collider=colliders.get(agent.id);if(!collider)throw Error('missing physics collider');const pos=collider.translation();if(Math.hypot(pos.x-agent.x,pos.z-agent.y)>0.001)throw Error('physics and world positions diverged');
   if(heightfield&&!air.has(agent.id)){
    const a=[agent.x,agent.y],b=[agent.x+dx,agent.y+dy];if(!Elevation.traversable(heightfield,a,b))return {x:0,y:0,contacts:0};const cuts=Elevation.cuts(heightfield,a,b),count=Math.ceil(Math.hypot(dx,dy)/.2);for(let i=1;i<count;i++)cuts.push(i/count);cuts.sort((x,y)=>x-y);const ts=cuts.filter((t,i)=>!i||t-cuts[i-1]>1e-12);let contacts=0;
    for(const t of ts.slice(1)){const at=collider.translation(),tx=agent.x+dx*t,ty=agent.y+dy*t;controller.computeColliderMovement(collider,{x:tx-at.x,y:Elevation.proxyHeight(heightfield,tx,ty)-at.y,z:ty-at.z});const m=controller.computedMovement();contacts+=controller.numComputedCollisions();const x=at.x+m.x,y=at.z+m.z;collider.setTranslation({x,y:Elevation.proxyHeight(heightfield,x,y),z:y});world.step();if(Math.hypot(x-tx,y-ty)>.01)break}const end=collider.translation();return {x:end.x-pos.x,y:end.z-pos.z,contacts};
   }
   const filter=domain?c=>!domainColliders.has(c.handle)||(!air.has(agent.id)&&domainColliders.get(c.handle)===water.has(agent.id)):undefined;
   controller.computeColliderMovement(collider,{x:dx,y:0,z:dy},undefined,undefined,filter);const m=controller.computedMovement(),contacts=controller.numComputedCollisions();const actual={x:m.x,y:m.z,contacts};collider.setTranslation({x:pos.x+m.x,y:pos.y,z:pos.z+m.z});world.step();return actual},
  correctPosition(agent,x,y){if(domain&&!SurfaceDomain.bodyFree(domain,air.has(agent.id)?'air':water.has(agent.id)?'water':'ground',[x,y],.8))throw Error('position outside surface domain');const collider=colliders.get(agent.id);if(!collider)throw Error('missing physics collider');const pos=collider.translation();collider.setTranslation({x,y:heightfield&&!air.has(agent.id)?Elevation.proxyHeight(heightfield,x,y):pos.y,z:y});world.step()},
  surface(x,y){if(closed||![x,y].every(v=>Number.isFinite(v)&&v>=0&&v<=100))throw Error('invalid surface position');const p=Elevation.surface(heightfield,x,y);return [p.height,p.dx,p.dy,p.slopeDegrees]},
  bodyPosition(id){if(closed)throw Error('physics world is closed');const c=colliders.get(id);if(!c)throw Error('missing physics collider');const p=c.translation();return [p.x,p.z,p.y]},
  free(){if(!closed){world.removeCharacterController(controller);world.free();closed=true}}
 };
}
module.exports={initialize,createPhysics};
