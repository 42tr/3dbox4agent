'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Native=require('../rust/physics/target/release/box_physics.node'),RustPhysics=require('../server/rust-physics'),WasmPhysics=require('../server/physics');
const zones=[{x:10,y:0,w:30,h:100,speedFactor:.2,energyFactor:5},{x:39,y:0,w:3,h:100,speedFactor:.7,energyFactor:1.4}];
const input={x:40+5e-7,y:50,ux:-1,uy:0,distance:10,zones};
const old=JSON.parse(Native.terrainSegment(JSON.stringify(input))),fixed=JSON.parse(Native.terrainSegment(JSON.stringify({...input,minimumStep:2e-5})));
assert(old.boundary<1e-6);assert.equal(old.micro,undefined);assert.equal(fixed.boundary,2e-5);assert.equal(fixed.micro,true);assert.equal(fixed.speed,.2);assert.equal(fixed.energy,5);assert.deepEqual(fixed.inside,[0,1]);
for(const minimumStep of [-1,2.1e-5,null,'0.00002'])assert.throws(()=>Native.terrainSegment(JSON.stringify({...input,minimumStep})));
const tiny=JSON.parse(Native.terrainSegment(JSON.stringify({...input,zones:[{x:40-1e-7,y:0,w:1e-7,h:100,speedFactor:.2,energyFactor:5}],minimumStep:2e-5})));assert.equal(tiny.energy,5,'a narrow zone touched by a precision transition must not be skipped');
const budget=Native.motionBudget(10,fixed.boundary,3,fixed.speed,1e-5,1,fixed.energy,-1,0);assert(budget[0]<=1e-5/fixed.energy,'micro transitions remain limited by available energy');
(async()=>{
 await WasmPhysics.initialize();const results=[];
 for(const backend of ['kinematic','wasm','rust']){
  const scene=E.getScene('lunar-outpost-v1');scene.obstacles=[];scene.terrain=[{id:'soil',name:'Soil',x:20,y:20,w:40,h:40,speedFactor:.7,energyFactor:1.4}];scene.riskZones=[];scene.navigation='distance';scene.agents=[{role:'worker',label:'Worker',count:1,mobility:'ground',capabilities:['inspect'],speed:3}];scene.tasks=[{id:'work',name:'Work',behavior:'survey',role:'worker',capability:'inspect',target:[75,50],duration:2,dependsOn:[]}];
  const w=E.create(42,'nearest',scene,{dispatchMode:'external',physicsMode:backend==='kinematic'?'kinematic':'rapier'}),a=w.agents[0];Object.assign(a,{x:57.256125420331955,y:60.000000059604645});const energy=a.battery,p=backend==='kinematic'?null:(backend==='rust'?RustPhysics:WasmPhysics).createPhysics(w);
  try{assert(E.assign(w,'work',a.id).ok);for(let i=0;i<40&&!w.done;i++)E.step(w,p);assert(w.done&&!w.failed,backend+' must cross a sub-resolution terrain boundary');assert(a.y<60&&a.x>74.9);assert(a.battery<energy);assert(energy-a.battery>=a.distance*.045-1e-9);results.push({backend,tick:w.tick,x:a.x,y:a.y,energy:energy-a.battery,distance:a.distance})}finally{E.disposeWorld(w);p?.free()}
 }
 console.log(JSON.stringify({results}));console.log('Terrain precision: conservative <=20um transitions respect overlap/narrow-zone factors and energy limits; original boundary coordinate completes on JS kinematics, WASM and native Rapier without teleporting or free motion passed');
})().catch(e=>{console.error(e);process.exitCode=1});
