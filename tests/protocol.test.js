'use strict';const assert=require('node:assert/strict');const E=require('../src/engine');
const cyclic=structuredClone(E.scene);cyclic.tasks[0].dependsOn=['repair'];assert.throws(()=>E.validateScene(cyclic),/cyclic/);
const missing=structuredClone(E.scene);missing.tasks[0].dependsOn=['missing'];assert.throws(()=>E.validateScene(missing),/missing/);
let s=E.create(42);assert.equal(E.assign(s,'confirm','drone-1').reason,'task_not_ready');assert.equal(E.assign(s,'inspect','vehicle-1').reason,'missing_capability');assert(E.assign(s,'inspect','drone-1').ok);assert.equal(E.assign(s,'inspect','drone-2').reason,'task_not_ready');
const obs=E.observe(s,'vehicle-1');assert(!('tasks' in obs));assert(!('agents' in obs));assert(!('events' in obs));assert.equal(obs.visibleTargets.length,0);obs.self.x=999;assert.notEqual(s.agents.find(a=>a.id==='vehicle-1').x,999);assert.equal(E.observe(s,'unknown'),null);
const parallel=structuredClone(E.scene);parallel.tasks[1].dependsOn=[];s=E.create(42,'nearest',parallel);E.step(s);assert.equal(s.tasks.filter(t=>t.status==='active').length,2);
console.log('protocol tests passed');
