'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine');
for(const mode of ['external','networked_reported']){
 const scene=E.getScene('industrial-park-parallel-v1');scene.communication.lossRate=0;
 const world=E.create(42,'nearest',scene,{dispatchMode:mode});
 if(mode==='networked_reported'){assert.equal(E.coordinatorObservation(world).tasks[0].candidates.length,0);for(let i=0;i<4;i++)E.step(world)}
 const obs=E.coordinatorObservation(world),task=obs.tasks[0],source=world.tasks.find(t=>t.id===task.id);
 assert.equal(task.duration,source.duration);assert.equal(task.behavior,source.behavior);assert(task.candidates.length);
 for(const candidate of task.candidates){const a=world.agents.find(a=>a.id===candidate.id);assert.equal(candidate.speed,a.speed);if(mode==='networked_reported')assert.equal(candidate.x,world.communication.reporting.reports[candidate.id].x)}
}
console.log('coordinator exposes static estimates with reported position');
