'use strict';
const assert=require('node:assert/strict');
const E=require('../src/engine');
const P=require('../server/physics');
const Replay=require('../src/replay');

(async()=>{
 const mapping={inspect:'scan-a',survey:'scan-b',confirm:'diagnose',deliver:'transport',repair:'service',verify:'check'};
 const reversed=Object.fromEntries(Object.entries(mapping).map(([a,b])=>[b,a]));
 const original=E.getScene('industrial-park-parallel-v1'),renamed=structuredClone(original);
 for(const task of renamed.tasks){task.id=mapping[task.id];task.dependsOn=task.dependsOn.map(id=>mapping[id])}
 function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>{let normalized=canonical(item);if(key==='memory'&&Array.isArray(normalized))normalized.sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id,'en'));return [key,normalized]}));return typeof value==='string'?(reversed[value]||value):value}
 await P.initialize();
 for(const mode of ['kinematic','rapier'])for(const seed of [40,42,44]){
  const a=E.create(seed,'nearest',original,{physicsMode:mode}),b=E.create(seed,'nearest',renamed,{physicsMode:mode});
  const pa=mode==='rapier'?P.createPhysics(a):null,pb=mode==='rapier'?P.createPhysics(b):null;let fault=false;
  try{
   assert.deepEqual(canonical(b),a);
   while(!a.done&&a.tick<1000){E.step(a,pa);E.step(b,pb);assert.deepEqual(canonical(b),a);if(!fault&&a.part.location==='carried'){assert(E.fault(a));assert(E.fault(b));assert.deepEqual(canonical(b),a);fault=true}}
   assert(fault&&a.done&&!a.failed);assert.equal(a.asset.condition,'operational');assert.equal(a.part.location,'consumed');
  }finally{pa?.free();pb?.free()}
 }
 const invalid=structuredClone(original);invalid.tasks[0].behavior='unknown';assert.throws(()=>E.validateScene(invalid),/invalid task/);
 const world=E.create(42),frame=E.snapshot(world);for(const task of frame.tasks)delete task.behavior;
 const old={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest'},frames:[frame]};assert(Replay.validateArchive(old));
 const forged=structuredClone(old);forged.frames[0].tasks[0].behavior='repair';assert.throws(()=>Replay.validateArchive(forged));
 console.log('configured task behavior tests passed');
})().catch(error=>{console.error(error);process.exitCode=1});
