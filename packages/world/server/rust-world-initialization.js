'use strict';
const {initializeWorld}=require('../../../rust/physics/target/release/box_physics.node');
// The private seed request is retained only for the initial actual-physics ray
// query. Neither operation accepts a host-generated agent/task/runtime frame.
const requests=new WeakMap();
function create(seed=42,policy='nearest',scene,options={}){
 const request=JSON.stringify({seed,policy,scene,options:{dispatchMode:options.dispatchMode??'rule',physicsMode:options.physicsMode??'kinematic',executionMode:options.executionMode??'auto'}});
 const world=JSON.parse(initializeWorld(request));requests.set(world,request);return world;
}
function finishRay(world,physics){
 const request=requests.get(world);if(!request||typeof physics?.initializeWorldRays!=='function')throw Object.assign(Error('world_initialization_failed'),{status:503});
 let frame;try{frame=JSON.parse(physics.initializeWorldRays(request))}catch{throw Object.assign(Error('world_initialization_failed'),{status:503})}
 Object.assign(world,{sensorModel:frame.sensorModel,perceptions:frame.perceptions});requests.delete(world);
}
module.exports={version:1,create,finishRay};
